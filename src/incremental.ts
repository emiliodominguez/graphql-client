import { cancelOnAbort, normalizeLineEndings } from "./sse";
import type { GraphQLFormattedError } from "./types";

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
	if (payload.data !== undefined && payload.data !== null) state.data = payload.data;

	for (const { id, path } of payload.pending ?? []) state.pending.set(id, path);

	for (const item of payload.incremental ?? []) {
		// A payload for an unknown id cannot be placed, so it is ignored rather than clobbering the root.
		if (item.id !== undefined && !state.pending.has(item.id)) continue;

		const base =
			item.id === undefined ? (item.path ?? []) : [...(state.pending.get(item.id) ?? []), ...(item.subPath ?? [])];

		if (item.items) {
			state.data =
				item.id === undefined
					? insertItems(state.data, base, item.items)
					: appendItems(state.data, base, item.items);
		} else if (item.data) {
			state.data = updateIn(state.data, base, mergeWith(item.data));
		}

		state.errors.push(...(item.errors ?? []));
	}

	for (const { id, errors } of payload.completed ?? []) {
		state.pending.delete(id);
		state.errors.push(...(errors ?? []));
	}

	state.errors.push(...(payload.errors ?? []));
	state.hasNext = payload.hasNext ?? false;

	return state;
}

/**
 * Appends streamed items to the list at `path` (current format).
 *
 * @param root - The data root
 * @param path - Path to the list
 * @param items - Items to append
 * @returns The new root
 */
function appendItems(root: unknown, path: Path, items: unknown[]): unknown {
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
function insertItems(root: unknown, path: Path, items: unknown[]): unknown {
	const start = Number(path.at(-1));

	return updateIn(root, path.slice(0, -1), function insert(list: unknown): unknown {
		const copy = Array.isArray(list) ? [...list] : [];

		copy.splice(start, items.length, ...items);

		return copy;
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
	if (!isContainer(target) || !isContainer(patch) || Array.isArray(target) !== Array.isArray(patch)) return patch;

	const result: Record<string, unknown> = Array.isArray(target) ? ([...target] as never) : { ...target };

	for (const [key, value] of Object.entries(patch)) {
		result[key] = deepMerge(result[key], value);
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

	copy[head] = updateIn(copy[head], rest, updater);

	return copy;
}

/**
 * Checks whether a value is an object or an array.
 *
 * @param value - Any value
 * @returns `true` for non-null objects
 */
function isContainer(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Extracts the boundary of a `multipart/mixed` content type.
 *
 * @param contentType - The Content-Type header
 * @returns The boundary (defaults to `-`)
 */
export function getBoundary(contentType: string): string {
	return /boundary="?([^";,]+)"?/i.exec(contentType)?.[1] ?? "-";
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
	const reader = stream.getReader();
	const release = cancelOnAbort(reader, signal);
	const decoder = new TextDecoder();
	const delimiter = `\n--${boundary}`;
	let buffer = "\n";
	let finished = false;

	try {
		while (!finished) {
			const { done, value } = await reader.read();

			finished = done;
			buffer = normalizeLineEndings(buffer + decoder.decode(value, { stream: !done }), done);

			let index = buffer.indexOf(delimiter);

			while (index !== -1) {
				const body = getPartBody(buffer.slice(0, index));
				const rest = buffer.slice(index + delimiter.length);

				if (body) yield body;
				if (rest.startsWith("--")) return;

				buffer = rest;
				index = buffer.indexOf(delimiter);
			}
		}
	} finally {
		release();

		if (!finished) await reader.cancel().catch(ignore);

		reader.releaseLock();
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

/**
 * Swallows a rejection.
 */
function ignore(): void {}
