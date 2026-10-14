import { isClientError } from "./errors";
import type { OperationContext, RetryOptions } from "./types";

/**
 * A fully resolved retry policy.
 */
export interface RetryPolicy {
	/** Maximum number of retries after the first attempt */
	attempts: number;
	/** Delay before a retry */
	delay: (retry: number, error: unknown) => number;
	/** Whether an error is retryable */
	retryIf: (error: unknown, context: OperationContext) => boolean;
}

/**
 * Errors raised by `fetch` itself, as opposed to errors thrown while preparing the request.
 */
const networkFailures: WeakSet<object> = ((globalThis as Record<symbol, unknown>)[Symbol.for("lumenql.networkFailures")] ??=
	new WeakSet<object>()) as WeakSet<object>;

/**
 * Marks an error raised by `fetch` as a network failure (retryable by default) and rethrows it.
 *
 * @param error - The error thrown by `fetch`
 * @returns Never: always rethrows
 */
export function rethrowNetworkFailure(error: unknown): never {
	if (error !== null && typeof error === "object") networkFailures.add(error);

	throw error;
}

/**
 * Upper bound for the default backoff, in milliseconds.
 */
const MAX_DELAY = 30_000;

/**
 * Resolves the effective retry policy. The call option wins over the client option.
 *
 * @param clientRetry - The client-level option
 * @param callRetry - The call-level option
 * @returns The policy, or `undefined` when retries are disabled
 */
export function resolveRetryPolicy(
	clientRetry: number | RetryOptions | undefined,
	callRetry: number | RetryOptions | false | undefined,
): RetryPolicy | undefined {
	const option = callRetry === undefined ? clientRetry : callRetry;

	if (option === undefined || option === false || option === 0) return undefined;

	const options: RetryOptions = typeof option === "number" ? { attempts: option } : option;
	const { delay } = options;

	return {
		attempts: toCount(options.attempts ?? 2),
		delay: typeof delay === "function" ? delay : delay === undefined ? defaultDelay : constant(delay),
		retryIf: options.retryIf ?? isRetryable,
	};
}

/**
 * Default retry predicate: network failures and HTTP 408/429/5xx, for queries only.
 *
 * @param error - The failure
 * @param context - The operation metadata
 * @returns `true` when the request should be retried
 */
export function isRetryable(error: unknown, context: OperationContext): boolean {
	if (context.type !== "query") return false;

	// `fetch` rejects with a TypeError on network failures in every runtime. Other TypeErrors (an invalid URL,
	// a body already read by middleware) are deterministic and would fail again.
	if (error instanceof TypeError) return networkFailures.has(error);

	return isClientError(error) && (error.status === 408 || error.status === 429 || error.status >= 500);
}

/**
 * Exponential backoff with equal jitter, honoring the `Retry-After` response header.
 *
 * @param retry - Zero-based retry index
 * @param error - The failure
 * @returns Delay in milliseconds
 */
function defaultDelay(retry: number, error: unknown): number {
	const retryAfter = isClientError(error)
		? parseRetryAfter(error.response?.headers.get("Retry-After") ?? null)
		: undefined;

	if (retryAfter !== undefined) return Math.min(retryAfter, MAX_DELAY);

	const base = Math.min(1_000 * 2 ** retry, MAX_DELAY);

	return base / 2 + Math.random() * (base / 2);
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP date).
 *
 * @param value - The header value
 * @returns Delay in milliseconds, or `undefined` when absent or invalid
 */
export function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;

	const seconds = Number(value);

	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

	const date = Date.parse(value);

	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Creates a constant delay function.
 *
 * @param ms - Delay in milliseconds
 * @returns The delay function
 */
function constant(ms: number): () => number {
	return function constantDelay(): number {
		return ms;
	};
}

/**
 * Normalizes a retry count: invalid values (e.g. `NaN` from an unset environment variable) mean no retries.
 *
 * @param value - The configured count
 * @returns A non-negative integer
 */
function toCount(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
