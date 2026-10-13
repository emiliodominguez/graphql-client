import type { CacheKey, MaybePromise, OperationType } from "./types";

/**
 * Parsed metadata about the operation a document will execute.
 */
export interface OperationInfo {
	/** The operation type */
	type: OperationType;
	/** The operation name, if any */
	name?: string;
}

/**
 * A combined abort signal plus its teardown.
 */
export interface AbortScope {
	/** Signal to forward to `fetch`, or `undefined` when neither a signal nor a timeout applies */
	signal?: AbortSignal;
	/** Releases timers and listeners. Must be called once the request settles. */
	dispose(): void;
}

/**
 * Strings and comments are blanked out before scanning so keywords inside them are never matched.
 */
const IGNORED_TOKENS = /"""[\s\S]*?"""|"(?:[^"\\\n\r]|\\.)*"|#[^\n\r]*/g;

/**
 * Matches an operation definition at the start of the document or right after a previous definition.
 */
const OPERATION_DEFINITION = /(?:^|\})\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g;

/**
 * Detects the operation type and name of a GraphQL document without a full parser.
 * Anonymous shorthand documents (`{ ... }`) resolve to `query`.
 *
 * @param document - The GraphQL document
 * @param operationName - Operation to select when the document defines several
 * @returns The detected operation info
 */
export function parseOperation(document: string, operationName?: string): OperationInfo {
	const source = document.replace(IGNORED_TOKENS, " ").trim();
	let first: OperationInfo | undefined;

	for (const match of source.matchAll(OPERATION_DEFINITION)) {
		const info: OperationInfo = { type: match[1] as OperationType, name: match[2] };

		if (!operationName || info.name === operationName) return info;

		first ??= info;
	}

	return first ?? { type: "query" };
}

/**
 * JSON replacer that emits plain-object keys in sorted order.
 *
 * @param _key - Property name (unused)
 * @param value - Property value
 * @returns The value, with plain objects rebuilt using sorted keys
 */
function sortKeys(_key: string, value: unknown): unknown {
	if (!isPlainObject(value)) return value;

	const sorted: Record<string, unknown> = {};

	for (const key of Object.keys(value).sort()) {
		sorted[key] = value[key];
	}

	return sorted;
}

/**
 * Checks whether a value is a plain object literal.
 *
 * @param value - Any value
 * @returns `true` for `{}` / `Object.create(null)` objects
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;

	const prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

/**
 * Deterministic `JSON.stringify`: object key order does not affect the output.
 *
 * @param value - Any JSON-serializable value
 * @returns The serialized value
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, sortKeys);
}

/**
 * Builds the serialized cache key for a request.
 *
 * @param key - The user-defined hierarchical key
 * @param query - The GraphQL document
 * @param variables - The operation variables
 * @param operationName - The selected operation name
 * @returns A deterministic string key
 */
export function createCacheKey(key: CacheKey, query: string, variables?: unknown, operationName?: string): string {
	return stableStringify([key, query, variables ?? null, operationName ?? null]);
}

/**
 * Checks whether a serialized cache key was created with a user key starting with `prefix`.
 * Foreign keys (not produced by {@link createCacheKey}) never match.
 *
 * @param cacheKey - A serialized cache key
 * @param prefix - The user key prefix
 * @returns `true` when the entry belongs to the prefix
 */
export function matchesKeyPrefix(cacheKey: string, prefix: CacheKey): boolean {
	let parsed: unknown;

	try {
		parsed = JSON.parse(cacheKey);
	} catch {
		return false;
	}

	if (!Array.isArray(parsed) || parsed.length !== 4 || !Array.isArray(parsed[0])) return false;

	const key: unknown[] = parsed[0];

	return prefix.length <= key.length && prefix.every(isSameSegment, key);
}

/**
 * `Array.prototype.every` callback comparing a prefix segment with the key segment at the same index.
 *
 * @param this - The full key being tested
 * @param segment - The prefix segment
 * @param index - The segment index
 * @returns `true` when both segments are equal
 */
function isSameSegment(this: unknown[], segment: unknown, index: number): boolean {
	return this[index] === segment;
}

/**
 * Resolves a static value or a (possibly async) factory.
 *
 * @param resolver - A value or a function returning it
 * @returns The resolved value
 */
export async function resolveValue<T>(resolver: T | (() => MaybePromise<T>)): Promise<T> {
	return typeof resolver === "function" ? (resolver as () => MaybePromise<T>)() : resolver;
}

/**
 * Merges an external abort signal with an optional timeout into a single signal.
 * Avoids `AbortSignal.any` / `AbortSignal.timeout` to keep older runtimes supported.
 *
 * @param signal - External abort signal
 * @param timeout - Timeout in milliseconds
 * @returns The combined signal and its teardown
 */
export function createAbortScope(signal?: AbortSignal, timeout?: number): AbortScope {
	if (timeout === undefined || timeout === Infinity) return { signal, dispose: noop };

	const controller = new AbortController();
	const timer = setTimeout(abortOnTimeout, timeout);

	/**
	 * Aborts with the same `TimeoutError` reason `AbortSignal.timeout` would produce.
	 */
	function abortOnTimeout(): void {
		controller.abort(new DOMException(`The operation timed out after ${timeout}ms.`, "TimeoutError"));
	}

	/**
	 * Forwards the external signal's abort reason.
	 */
	function abortFromSignal(): void {
		controller.abort(signal?.reason);
	}

	if (signal?.aborted) {
		abortFromSignal();
	} else {
		signal?.addEventListener("abort", abortFromSignal, { once: true });
	}

	return {
		signal: controller.signal,
		dispose(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortFromSignal);
		},
	};
}

/**
 * No-op teardown.
 */
function noop(): void {}
