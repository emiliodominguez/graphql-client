import { readDelimited } from "./sse";
import type { GraphQLFormattedError } from "./types";
import { isObject } from "./utils";

/**
 * A response path: field names and list indices.
 */
type Path = ReadonlyArray<string | number>;

/**
 * One entry of an `incremental` list. Supports both the 2022 format (`path`) and the current one (`id` + `subPath`).
 */
interface IncrementalItem {
	id?: string | undefined;
	path?: Path | undefined;
	subPath?: Path | undefined;
	data?: Record<string, unknown> | null | undefined;
	items?: unknown[] | undefined;
	errors?: ReadonlyArray<GraphQLFormattedError> | undefined;
}

/**
 * An initial or subsequent incremental delivery payload. A plain GraphQL response is a valid payload too.
 */
export interface IncrementalPayload {
	data?: unknown | undefined;
	errors?: ReadonlyArray<GraphQLFormattedError> | undefined;
	hasNext?: boolean | undefined;
	pending?: ReadonlyArray<{ id: string; path: Path }> | undefined;
	incremental?: ReadonlyArray<IncrementalItem> | undefined;
	completed?: ReadonlyArray<{ id: string; errors?: ReadonlyArray<GraphQLFormattedError> }> | undefined;
}

/**
 * Accumulated result while incremental payloads arrive.
 */
export interface IncrementalState {
	/** The merged data so far (replaced immutably on every payload) */
	data: unknown;
	/** Every error received so far */
	errors: GraphQLFormattedError[];
	/** Whether more payloads are expected */
	hasNext: boolean;
	/** Pending deferred/streamed fragments, by id */
	pending: Map<string, Path>;
}

/**
 * Detects documents that may be delivered incrementally.
 */
export const INCREMENTAL_DIRECTIVE = /@(?:defer|stream)\b/;

/**
 * Accept value advertising incremental delivery support.
 */
export const MULTIPART_ACCEPT = "multipart/mixed;deferSpec=20220824";

/**
 * Creates an empty incremental state.
 *
 * @returns The state
 */
export function createIncrementalState(): IncrementalState {
	return { data: undefined, errors: [], hasNext: false, pending: new Map() };
}

/**
 * Applies an incremental payload to the state. `data` is updated immutably, so every payload yields a new reference
 * along the changed paths and untouched branches keep their identity.
 *
 * @param state - The state to update
 * @param payload - The received payload
 * @returns The same state, for chaining
 */
export function applyIncremental(state: IncrementalState, payload: IncrementalPayload): IncrementalState {
	// Not narrowed through `isObject`: the payload keeps its declared shape.
	if (payload === null || typeof payload !== "object") throw malformed();
	if (payload.data !== undefined && payload.data !== null) state.data = payload.data;

	for (const { id, path } of entries(payload.pending)) state.pending.set(id, list(path));

	for (const item of entries(payload.incremental)) {
		// A payload for an unknown id cannot be placed, so it is ignored rather than clobbering the root.
		if (item.id !== undefined && !state.pending.has(item.id)) continue;

		const base = item.id === undefined ? list(item.path) : [...state.pending.get(item.id)!, ...list(item.subPath)];

		if (item.items !== undefined && item.items !== null) {
			state.data =
				item.id === undefined
					? insertItems(state.data, base, list(item.items))
					: appendItems(state.data, base, list(item.items));
		} else if (isObject(item.data)) {
			state.data = updateIn(state.data, base, mergeWith(item.data));
		}

		addErrors(state, item.errors);
	}

	for (const { id, errors } of entries(payload.completed)) {
		state.pending.delete(id);
		addErrors(state, errors);
	}

	addErrors(state, payload.errors);
	state.hasNext = payload.hasNext === true;

	return state;
}

/**
 * Appends the normalized errors of a payload part, one by one: spreading a huge list as arguments overflows the stack.
 *
 * @param state - The state to update
 * @param errors - The raw `errors` value
 */
function addErrors(state: IncrementalState, errors: unknown): void {
	for (const error of normalizeErrors(errors)) state.errors.push(error);
}

/**
 * Validates an optional list sent by the server.
 *
 * @template T - The item type
 * @param value - The raw value
 * @returns The list (empty when absent)
 * @throws {TypeError} When the value is present but not a list
 */
function list<T>(value: ReadonlyArray<T> | null | undefined): ReadonlyArray<T> {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw malformed();

	return value;
}

/**
 * Validates an optional list of objects sent by the server.
 *
 * @template T - The item type
 * @param value - The raw value
 * @returns The list (empty when absent)
 * @throws {TypeError} When the value is not a list of objects
 */
function entries<T extends object>(value: ReadonlyArray<T> | null | undefined): ReadonlyArray<T> {
	const items = list(value);

	for (const item of items) if (!isObject(item)) throw malformed();

	return items;
}

/**
 * Creates the error thrown for a payload that does not follow the incremental delivery format.
 *
 * @returns The error
 */
function malformed(): TypeError {
	return new TypeError("Malformed incremental payload.");
}

/**
 * Normalizes the `errors` of a response, which a buggy or hostile server may send as a single object, a string or
 * a list with non-object entries.
 *
 * @param errors - The raw `errors` value
 * @returns Well-formed errors (empty when there are none)
 */
export function normalizeErrors(errors: unknown): GraphQLFormattedError[] {
	if (errors === undefined || errors === null) return [];

	return (Array.isArray(errors) ? errors : [errors]).map(toFormattedError);
}

/**
 * Normalizes one GraphQL error.
 *
 * @param error - The raw error
 * @returns The error, or a placeholder carrying its text
 */
function toFormattedError(error: unknown): GraphQLFormattedError {
	if (isObject(error) && typeof error.message === "string") return error as unknown as GraphQLFormattedError;

	return { message: typeof error === "string" ? error : "Unknown error" };
}

/**
 * Appends streamed items to the list at `path` (current format).
 *
 * @param root - The data root
 * @param path - Path to the list
 * @param items - Items to append
 * @returns The new root
 */
function appendItems(root: unknown, path: Path, items: ReadonlyArray<unknown>): unknown {
	return updateIn(root, path, function append(list: unknown): unknown {
		return [...(Array.isArray(list) ? list : []), ...items];
	});
}

/**
 * Writes streamed items starting at the index ending `path` (2022 format).
 *
 * @param root - The data root
 * @param path - Path to the first item
 * @param items - Items to write
 * @returns The new root
 */
function insertItems(root: unknown, path: Path, items: ReadonlyArray<unknown>): unknown {
	const start = Number(path.at(-1));

	return updateIn(root, path.slice(0, -1), function insert(list: unknown): unknown {
		const current: unknown[] = Array.isArray(list) ? list : [];
		// `slice` clamps `start` like `splice` would; no argument spreading (a huge batch would overflow the stack).
		const head = current.slice(0, start);

		return head.concat(items, current.slice(head.length + items.length));
	});
}

/**
 * Creates an updater deep-merging `patch` into its input.
 *
 * @param patch - The data to merge
 * @returns The updater
 */
function mergeWith(patch: unknown): (target: unknown) => unknown {
	return function merge(target: unknown): unknown {
		return deepMerge(target, patch);
	};
}

/**
 * Immutably deep-merges two JSON values. Objects and arrays merge by key/index; anything else is replaced.
 *
 * @param target - The existing value
 * @param patch - The incoming value
 * @returns The merged value
 */
export function deepMerge(target: unknown, patch: unknown): unknown {
	if (!isObject(target) || !isObject(patch) || Array.isArray(target) !== Array.isArray(patch)) return patch;

	const result: Record<string, unknown> = Array.isArray(target) ? ([...target] as never) : { ...target };

	for (const [key, value] of Object.entries(patch)) {
		setOwn(result, key, deepMerge(getOwn(result, key), value));
	}

	return result;
}

/**
 * Immutably replaces the value at `path`, copying every container along the way.
 *
 * @param root - The data root
 * @param path - Path to the value
 * @param updater - Computes the new value from the old one
 * @returns The new root
 */
function updateIn(root: unknown, path: Path, updater: (value: unknown) => unknown): unknown {
	if (path.length === 0) return updater(root);

	const [head, ...rest] = path as [string | number, ...Path];
	const copy: Record<string | number, unknown> = Array.isArray(root) ? ([...root] as never) : { ...(root as object) };

	setOwn(copy, String(head), updateIn(getOwn(copy, String(head)), rest, updater));

	return copy;
}

/**
 * Reads an own property, never an inherited one (`__proto__` from a hostile server reads as missing).
 *
 * @param container - An object or array
 * @param key - The property
 * @returns The own value, if any
 */
function getOwn(container: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(container, key) ? container[key] : undefined;
}

/**
 * Writes an own data property: a `__proto__` key from a hostile server stays data instead of replacing the
 * prototype. Arrays only accept indices up to their length.
 *
 * @param container - An object or array
 * @param key - The property
 * @param value - The value
 */
function setOwn(container: Record<string, unknown>, key: string, value: unknown): void {
	// Arrays only grow by one: an index far past the end would create a huge sparse array (`[...list]` hangs).
	if (Array.isArray(container) && !(/^\d+$/.test(key) && Number(key) <= container.length)) return;

	Object.defineProperty(container, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Extracts the boundary of a `multipart/mixed` content type.
 *
 * @param contentType - The Content-Type header
 * @returns The boundary (defaults to `-`)
 */
export function getBoundary(contentType: string): string {
	const match = /boundary=(?:"([^"]+)"|([^\s;,]+))/i.exec(contentType);

	return match?.[1] ?? match?.[2] ?? "-";
}

/**
 * Reads a `multipart/mixed` body (incremental delivery over HTTP) and yields each part's body.
 * JSON bodies never contain raw line breaks, so line endings are normalized safely.
 *
 * @param stream - The response body
 * @param boundary - The multipart boundary
 * @param signal - Cancels the stream when aborted, even if the body is not tied to a fetch
 * @yields Each non-empty part body
 */
export async function* readMultipartMixed(
	stream: ReadableStream<Uint8Array>,
	boundary: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	for await (const [part, rest] of readDelimited(stream, `\n--${boundary}`, signal, "\n")) {
		const body = getPartBody(part);

		if (body) yield body;
		if (rest.startsWith("--")) return;
	}
}

/**
 * Extracts the body of a part, skipping its headers.
 *
 * @param part - Raw part text (headers, blank line, body)
 * @returns The trimmed body, or an empty string for the preamble
 */
function getPartBody(part: string): string {
	const separator = part.indexOf("\n\n");
	const body = separator === -1 ? part : part.slice(separator + 2);

	return body.trim().startsWith("{") ? body.trim() : "";
}
