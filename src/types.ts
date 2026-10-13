/**
 * A value that may or may not be wrapped in a Promise.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The GraphQL operation types defined by the spec.
 */
export type OperationType = "query" | "mutation" | "subscription";

/**
 * A user-defined cache key segment list (e.g. `["user", 42]`).
 * Keys are hierarchical: invalidating `["user"]` drops every entry whose key starts with `"user"`.
 */
export type CacheKey = ReadonlyArray<string | number | boolean | null>;

/**
 * A GraphQL document string branded with its result and variables types.
 * Structurally compatible with `TypedDocumentString` emitted by GraphQL Code Generator
 * (`client` preset with `documentMode: "string"`), so typed documents infer `TData` and `TVariables` for free.
 *
 * @template TData - The shape of the `data` field in the response
 * @template TVariables - The shape of the operation variables
 */
export interface TypedDocumentString<TData, TVariables> extends String {
	/**
	 * Phantom field used exclusively for type inference. Never read at runtime.
	 */
	__apiType?: (variables: TVariables) => TData;
}

/**
 * A GraphQL error as returned by a spec-compliant server.
 */
export interface GraphQLFormattedError {
	/** Human-readable description of the error */
	readonly message: string;
	/** Source locations in the document the error refers to */
	readonly locations?: ReadonlyArray<{ readonly line: number; readonly column: number }>;
	/** Path to the response field that produced the error */
	readonly path?: ReadonlyArray<string | number>;
	/** Implementation-specific metadata (error codes, etc.) */
	readonly extensions?: Record<string, unknown>;
}

/**
 * The raw GraphQL response envelope.
 *
 * @template TData - The shape of the `data` field
 */
export interface GraphQLResponse<TData> {
	/** The operation result, possibly partial when `errors` is present */
	data?: TData | null;
	/** Errors raised while executing the operation */
	errors?: ReadonlyArray<GraphQLFormattedError>;
	/** Implementation-specific metadata */
	extensions?: Record<string, unknown>;
}

/**
 * Contract for any cache the client can use. Every method may be sync or async,
 * so in-memory, `localStorage`, IndexedDB or Redis-backed adapters all fit.
 */
export interface Cache {
	/**
	 * Reads a value. Must resolve to `undefined` on a miss or an expired entry.
	 *
	 * @param key - The serialized cache key
	 */
	get<T>(key: string): MaybePromise<T | undefined>;

	/**
	 * Stores a value.
	 *
	 * @param key - The serialized cache key
	 * @param value - The value to store
	 */
	set<T>(key: string, value: T): MaybePromise<void>;

	/**
	 * Removes a single value.
	 *
	 * @param key - The serialized cache key
	 */
	delete(key: string): MaybePromise<unknown>;

	/**
	 * Removes every value.
	 */
	clear(): MaybePromise<void>;

	/**
	 * Lists the stored keys. Required for key-prefix invalidation.
	 */
	keys(): MaybePromise<Iterable<string>>;
}

/**
 * Static headers or a (possibly async) factory evaluated on every request.
 */
export type HeadersResolver = HeadersInit | (() => MaybePromise<HeadersInit | undefined>);

/**
 * Static token or a (possibly async) factory evaluated on every request.
 */
export type AuthTokenResolver = string | (() => MaybePromise<string | null | undefined>);

/**
 * Configuration for {@link Client}.
 */
export interface ClientConfiguration {
	/** GraphQL endpoint URL */
	url: string;
	/** Bearer token sent as `Authorization: Bearer <token>`. Use a function to refresh tokens lazily. */
	authToken?: AuthTokenResolver;
	/** Extra headers for every request. Use a function for dynamic values. */
	headers?: HeadersResolver;
	/** Cache used for query results. Caching is disabled when omitted. */
	cache?: Cache;
	/** Custom `fetch` implementation (SSR, testing, instrumentation). Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
	/** Default request timeout in milliseconds. Disabled when omitted. */
	timeout?: number;
	/** Share a single network request between identical in-flight queries. Defaults to `true`. */
	dedupe?: boolean;
	/** Logs operations, cache hits and timings through `console.debug`. */
	debug?: boolean;
	/** Retry policy for failed requests. Disabled by default. A number sets the attempts with default backoff. */
	retry?: number | RetryOptions;
	/** Fetch-level middleware, run in order around every request (including retries). */
	middleware?: ReadonlyArray<Middleware>;
	/** HTTP method for queries. `GET` enables CDN/browser caching. Mutations always use `POST`. Defaults to `POST`. */
	method?: "GET" | "POST";
	/** Automatic Persisted Queries: send a SHA-256 hash first and the full document only when the server asks. */
	persistedQueries?: boolean | PersistedQueriesOptions;
}

/**
 * Metadata about the operation being executed, exposed to middleware and retry predicates.
 */
export interface OperationContext {
	/** The operation type */
	type: OperationType;
	/** The operation name, if any */
	name?: string;
	/** The GraphQL document */
	query: string;
	/** Operation variables */
	variables?: unknown;
	/** Zero-based attempt number (`0` is the first try) */
	attempt: number;
}

/**
 * Calls the next middleware, or `fetch` at the end of the chain.
 *
 * @param request - The request to forward. Defaults to the incoming one.
 */
export type MiddlewareNext = (request?: Request) => Promise<Response>;

/**
 * Wraps a request: inspect or replace the `Request`, then inspect or replace the `Response`.
 *
 * @param request - The outgoing request
 * @param next - Forwards the request down the chain
 * @param context - The operation metadata
 * @returns The response
 */
export type Middleware = (request: Request, next: MiddlewareNext, context: OperationContext) => Promise<Response>;

/**
 * Retry policy.
 */
export interface RetryOptions {
	/** Maximum number of retries after the first attempt. Defaults to `2`. */
	attempts?: number;
	/**
	 * Delay before a retry, in milliseconds, or a function of the retry index (0-based) and the error.
	 * Defaults to exponential backoff with jitter (≈1s, 2s, 4s… capped at 30s), honoring `Retry-After`.
	 */
	delay?: number | ((retry: number, error: unknown) => number);
	/**
	 * Decides whether an error is retryable.
	 * Defaults to network failures and HTTP 408/429/5xx, for queries only (mutations are not idempotent).
	 */
	retryIf?: (error: unknown, context: OperationContext) => boolean;
}

/**
 * Automatic Persisted Queries options.
 */
export interface PersistedQueriesOptions {
	/** Custom document hash. Defaults to SHA-256 via Web Crypto. */
	hash?: (query: string) => MaybePromise<string>;
}

/**
 * Options for a single {@link Client.gql} call.
 *
 * @template TData - The shape of the `data` field in the response
 * @template TVariables - The shape of the operation variables
 */
export interface RequestOptions<TData, TVariables> {
	/** The GraphQL document, as a plain string or a typed document */
	query: string | TypedDocumentString<TData, TVariables>;
	/** Operation variables */
	variables?: TVariables;
	/** Selects the operation to run when the document contains several */
	operationName?: string;
	/** Hierarchical cache key used for grouping and invalidation. Defaults to `[]`. */
	key?: CacheKey;
	/** Overrides caching for this call. Defaults to `true` for queries and `false` for mutations. */
	cache?: boolean;
	/** Extra headers merged on top of the client headers */
	headers?: HeadersInit;
	/** Abort signal for this call */
	signal?: AbortSignal;
	/** Timeout in milliseconds for this call, covering every retry. Overrides the client default. */
	timeout?: number;
	/** Retry policy for this call. Overrides the client default; `false` disables retries. */
	retry?: number | RetryOptions | false;
	/** Cache key prefixes to invalidate once the operation succeeds (typically after a mutation). */
	invalidates?: ReadonlyArray<CacheKey>;
}

/**
 * Options for a single {@link Client.subscribe} call.
 *
 * @template TData - The shape of each `data` payload
 * @template TVariables - The shape of the operation variables
 */
export type SubscribeOptions<TData, TVariables> = Pick<
	RequestOptions<TData, TVariables>,
	"query" | "variables" | "operationName" | "headers" | "signal"
>;
