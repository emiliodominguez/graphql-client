import type { CacheKey, MaybePromise, OperationType } from "./types";

/**
 * Parsed metadata about the operation a document will execute.
 */
export interface OperationInfo {
	/** The operation type */
	type: OperationType;
	/** The operation name, if any */
	name?: string | undefined;
}

/**
 * A combined abort signal plus its teardown.
 */
export interface AbortScope {
	/** Signal to forward to `fetch` */
	signal: AbortSignal;
	/** Aborts the scope */
	abort(reason?: unknown): void;
	/** Releases timers and listeners. Must be called once the request settles. */
	dispose(): void;
}

/**
 * Strings and comments are blanked out before scanning so keywords inside them are never matched.
 */
const IGNORED_TOKENS = /"""(?:\\"""|[\s\S])*?"""|"(?:[^"\\\n\r]|\\.)*"|#[^\n\r]*/g;

/**
 * Matches an operation definition at the start of the document or right after a previous definition.
 */
const OPERATION_DEFINITION = /(?:^|\})\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g;

/**
 * Memoized facts about a document.
 */
interface DocumentInfo {
	/** Operations defined by the document, in order (an anonymous `query` when none is found) */
	operations: OperationInfo[];
	/** See {@link hashDocument} */
	hash: string;
}

/**
 * Recently seen documents. Bounded: documents are usually static, but generated ones must not leak memory.
 */
const documents = new Map<string, DocumentInfo>();

/**
 * Parses and hashes a document once, then serves it from the memo.
 *
 * @param document - The GraphQL document
 * @returns The document facts
 */
function inspectDocument(document: string): DocumentInfo {
	let info = documents.get(document);

	if (info === undefined) {
		const operations: OperationInfo[] = [];
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;

		for (const match of document.replace(IGNORED_TOKENS, " ").trim().matchAll(OPERATION_DEFINITION)) {
			operations.push({ type: match[1] as OperationType, name: match[2] });
		}

		if (operations.length === 0) operations.push({ type: "query" });

		// Two independent multiply-xor lanes: 64 bits keep collisions negligible for any realistic document count.
		for (let index = 0; index < document.length; index++) {
			const code = document.charCodeAt(index);

			h1 = Math.imul(h1 ^ code, 2654435761);
			h2 = Math.imul(h2 ^ code, 1597334677);
		}

		if (documents.size >= 500) documents.clear();

		info = { operations, hash: (h1 >>> 0).toString(36) + "." + (h2 >>> 0).toString(36) };
		documents.set(document, info);
	}

	return info;
}

/**
 * Detects the operation type and name of a GraphQL document without a full parser.
 * Anonymous shorthand documents (`{ ... }`) resolve to `query`.
 *
 * @param document - The GraphQL document
 * @param operationName - Operation to select when the document defines several
 * @returns The detected operation info (shared: never mutate it)
 */
export function parseOperation(document: string, operationName?: string): OperationInfo {
	const { operations } = inspectDocument(document);

	return (operationName && operations.find(hasName, operationName)) || operations[0]!;
}

/**
 * Computes a non-cryptographic 64-bit hash of a document. Cache keys embed it instead of the full text, so building,
 * hashing and storing keys no longer scales with document size.
 *
 * @param document - The GraphQL document
 * @returns Two base-36 numbers joined by a dot
 */
export function hashDocument(document: string): string {
	return inspectDocument(document).hash;
}

/**
 * `Array.prototype.find` callback matching the operation named `this`.
 *
 * @param this - The operation name
 * @param info - A parsed operation
 * @returns `true` when the names match
 */
function hasName(this: string, info: OperationInfo): boolean {
	return info.name === this;
}

/**
 * JSON replacer that emits plain-object keys in sorted order.
 *
 * @param _key - Property name (unused)
 * @param value - Property value
 * @returns The value, with plain objects rebuilt using sorted keys
 */
function sortKeys(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;

	const prototype = Object.getPrototypeOf(value);

	if (prototype !== Object.prototype && prototype !== null) return value;

	// Null prototype: a `__proto__` key stays a regular property instead of replacing the prototype.
	const sorted: Record<string, unknown> = Object.create(null);

	for (const key of Object.keys(value).sort()) {
		sorted[key] = (value as Record<string, unknown>)[key];
	}

	return sorted;
}

/**
 * Deterministic `JSON.stringify`: plain-object key order does not affect the output.
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
 * @param query - The GraphQL document (embedded as its {@link hashDocument} hash)
 * @param variables - The operation variables
 * @param operationName - The selected operation name
 * @returns A deterministic string key
 */
export function createCacheKey(key: CacheKey, query: string, variables?: unknown, operationName?: string): string {
	return stableStringify([key, hashDocument(query), variables ?? null, operationName ?? null]);
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
 * Merges an external abort signal with an optional timeout into a single, internally controllable signal.
 * Avoids `AbortSignal.any` / `AbortSignal.timeout` to keep older runtimes supported.
 *
 * @param signal - External abort signal
 * @param timeout - Timeout in milliseconds
 * @returns The combined signal, a way to abort it and its teardown
 */
export function createAbortScope(signal?: AbortSignal, timeout?: number): AbortScope {
	const controller = new AbortController();
	// Only finite, positive timeouts arm a timer: `0`, `Infinity` and `NaN` mean "no timeout".
	const timer =
		timeout !== undefined && timeout > 0 && timeout < Infinity ? setTimeout(abortOnTimeout, timeout) : undefined;

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
		abort(reason?: unknown): void {
			controller.abort(reason);
		},
		dispose(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortFromSignal);
		},
	};
}

/**
 * Waits for a delay, rejecting early with the signal's reason when aborted.
 *
 * @param ms - Delay in milliseconds
 * @param signal - Abort signal
 * @returns A promise resolved after the delay
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(function wait(resolve, reject): void {
		if (signal.aborted) return reject(signal.reason);

		const timer = setTimeout(done, ms);

		/**
		 * Resolves once the delay elapsed.
		 */
		function done(): void {
			signal.removeEventListener("abort", cancel);
			resolve();
		}

		/**
		 * Rejects as soon as the signal aborts.
		 */
		function cancel(): void {
			clearTimeout(timer);
			reject(signal.reason);
		}

		signal.addEventListener("abort", cancel, { once: true });
	});
}

/**
 * Hashes a string with SHA-256 through Web Crypto.
 *
 * @param text - The input text
 * @returns The lowercase hex digest
 */
export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

	return Array.from(new Uint8Array(digest), toHex).join("");
}

/**
 * Formats a byte as two hex characters.
 *
 * @param byte - A byte value
 * @returns The hex pair
 */
function toHex(byte: number): string {
	return byte.toString(16).padStart(2, "0");
}
