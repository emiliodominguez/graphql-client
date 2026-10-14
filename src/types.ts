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
	 * Phantom member used exclusively for type inference. Never read at runtime.
	 * Declared as a method so it is bivariant: generic code can accept any typed document.
	 */
	__apiType?(variables: TVariables): TData;
}

/**
 * A GraphQL error as returned by a spec-compliant server.
 */
export interface GraphQLFormattedError {
	/** Human-readable description of the error */
	readonly message: string;
	/** Source locations in the document the error refers to */
	readonly locations?: ReadonlyArray<{ readonly line: number; readonly column: number }> | undefined;
	/** Path to the response field that produced the error */
	readonly path?: ReadonlyArray<string | number> | undefined;
	/** Implementation-specific metadata (error codes, etc.) */
	readonly extensions?: Record<string, unknown> | undefined;
}

/**
 * The raw GraphQL response envelope.
 *
 * @template TData - The shape of the `data` field
 */
export interface GraphQLResponse<TData> {
	/** The operation result, possibly partial when `errors` is present */
	data?: TData | null | undefined;
	/** Errors raised while executing the operation */
	errors?: ReadonlyArray<GraphQLFormattedError> | undefined;
	/** Implementation-specific metadata */
	extensions?: Record<string, unknown> | undefined;
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
	authToken?: AuthTokenResolver | undefined;
	/** Extra headers for every request. Use a function for dynamic values. */
	headers?: HeadersResolver | undefined;
	/** Cache used for query results. Caching is disabled when omitted. */
	cache?: Cache | undefined;
	/** Custom `fetch` implementation (SSR, testing, instrumentation). Defaults to `globalThis.fetch`. */
	fetch?: typeof fetch | undefined;
	/** Default request timeout in milliseconds. Disabled when omitted, `0` or not finite. */
	timeout?: number | undefined;
	/** Share a single network request between identical in-flight queries. Defaults to `true`. */
	dedupe?: boolean | undefined;
	/** Logs operations, cache hits and timings through `console.debug`. */
	debug?: boolean | undefined;
	/** Retry policy for failed requests. Disabled by default. A number sets the attempts with default backoff. */
	retry?: number | RetryOptions | undefined;
	/** Fetch-level middleware, run in order around every request (including retries). */
	middleware?: ReadonlyArray<Middleware> | undefined;
	/** HTTP method for queries. `GET` enables CDN/browser caching. Mutations always use `POST`. Defaults to `POST`. */
	method?: "GET" | "POST" | undefined;
	/** Automatic Persisted Queries: send a SHA-256 hash first and the full document only when the server asks. */
	persistedQueries?: boolean | PersistedQueriesOptions | undefined;
	/**
	 * Called once for every failed operation (after retries), e.g. to report errors or sign out on 401.
	 * Not called when the caller aborted the operation. Errors thrown by the hook are ignored.
	 */
	onError?: ((error: unknown, context: OperationContext) => void) | undefined;
	/**
	 * Transport for `subscription` operations (e.g. the WebSocket transport from `/ws`).
	 * Defaults to GraphQL over SSE through `fetch`.
	 */
	subscriptionTransport?: SubscriptionTransport | undefined;
}

/**
 * The operation sent through a {@link SubscriptionTransport}.
 */
export interface SubscriptionRequest {
	/** The GraphQL document. Absent with strict persisted queries, which only send `extensions.persistedQuery`. */
	query?: string | undefined;
	/** Protocol extensions (e.g. `persistedQuery`) */
	extensions?: Record<string, unknown> | undefined;
	/** Operation variables */
	variables?: unknown | undefined;
	/** The selected operation name */
	operationName?: string | undefined;
}

/**
 * Pluggable streaming transport (WebSocket, Phoenix channels, Ably...). It yields raw GraphQL results (or
 * incremental payloads); the client merges them and turns GraphQL errors into `ClientError`s.
 */
export interface SubscriptionTransport {
	/**
	 * Starts an operation. The iterable must stop and release resources when `signal` aborts.
	 *
	 * @param request - The operation
	 * @param signal - Aborted when the consumer stops listening
	 * @returns The results
	 */
	subscribe(request: SubscriptionRequest, signal: AbortSignal): AsyncIterable<GraphQLResponse<unknown>>;
}

/**
 * Metadata about the operation being executed, exposed to middleware and retry predicates.
 */
export interface OperationContext {
	/** The operation type */
	type: OperationType;
	/** The operation name, if any */
	name?: string | undefined;
	/** The GraphQL document */
	query: string;
	/** Operation variables */
	variables?: unknown | undefined;
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
	attempts?: number | undefined;
	/**
	 * Delay before a retry, in milliseconds, or a function of the retry index (0-based) and the error.
	 * Defaults to exponential backoff with jitter (≈1s, 2s, 4s… capped at 30s), honoring `Retry-After`.
	 */
	delay?: (number | ((retry: number, error: unknown) => number)) | undefined;
	/**
	 * Decides whether an error is retryable.
	 * Defaults to network failures and HTTP 408/429/5xx, for queries only (mutations are not idempotent).
	 */
	retryIf?: ((error: unknown, context: OperationContext) => boolean) | undefined;
}

/**
 * Automatic Persisted Queries options.
 */
export interface PersistedQueriesOptions {
	/** Custom document hash (e.g. precomputed ids from a manifest). Defaults to SHA-256 via Web Crypto. */
	hash?: ((query: string) => MaybePromise<string>) | undefined;
	/**
	 * Trusted documents: only ever send the hash, never the document, and fail instead of falling back.
	 * For servers that only execute an allow-list of registered operations.
	 */
	strict?: boolean | undefined;
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
	variables?: TVariables | undefined;
	/** Selects the operation to run when the document contains several */
	operationName?: string | undefined;
	/** Hierarchical cache key used for grouping and invalidation. Defaults to `[]`. */
	key?: CacheKey | undefined;
	/**
	 * How the cache is used. Defaults to `cache-first` for queries and `no-cache` for mutations.
	 * - `cache-first`: serve from the cache, fetch on a miss and store the result
	 * - `cache-and-network`: serve from the cache and refresh it in the background (stale-while-revalidate);
	 *   fetch like `network-only` on a miss
	 * - `network-only`: always fetch, store the result
	 * - `cache-only`: serve from the cache, throw on a miss
	 * - `no-cache`: always fetch, never read nor write the cache
	 */
	fetchPolicy?: FetchPolicy | undefined;
	/** Extra headers merged on top of the client headers */
	headers?: HeadersInit | undefined;
	/** Abort signal for this call */
	signal?: AbortSignal | undefined;
	/** Timeout in milliseconds for this call, covering every retry. Overrides the client default; `0` disables it. */
	timeout?: number | undefined;
	/** Retry policy for this call. Overrides the client default; `false` disables retries. */
	retry?: number | RetryOptions | false | undefined;
	/** Cache key prefixes to invalidate once the operation succeeds (typically after a mutation). */
	invalidates?: ReadonlyArray<CacheKey> | undefined;
	/**
	 * Cache entries to update immediately, before the server answers. Every update is rolled back if the operation
	 * fails. Build entries with {@link optimistic} for full typing; pair with `invalidates` to reconcile.
	 */
	optimistic?: ReadonlyArray<OptimisticUpdate<unknown, unknown>> | undefined;
}

/**
 * An optimistic cache update. See {@link RequestOptions.optimistic}.
 *
 * @template TData - The shape of the entry's data
 * @template TVariables - The shape of the entry's variables
 */
export interface OptimisticUpdate<TData, TVariables> {
	/** The cache entry to update */
	target: CacheTarget<TData, TVariables>;
	/**
	 * Computes the optimistic data.
	 *
	 * @param current - The cached data, or `undefined` when the entry is not cached
	 * @returns The data to show until the server answers
	 */
	update(current: TData | undefined): TData;
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

/**
 * Cache usage strategy for a request. See {@link RequestOptions.fetchPolicy}.
 */
export type FetchPolicy = "cache-first" | "cache-and-network" | "network-only" | "cache-only" | "no-cache";

/**
 * Snapshot of a watched query.
 *
 * @template TData - The shape of the `data` field
 */
export interface QueryState<TData> {
	/** Latest data. Kept while refetching or after an error (stale-while-revalidate). */
	data: TData | undefined;
	/** Error of the latest fetch, cleared by the next successful one */
	error: unknown;
	/** Whether a fetch is in progress */
	loading: boolean;
}

/**
 * Options for {@link Client.watch}.
 *
 * @template TData - The shape of the `data` field in the response
 * @template TVariables - The shape of the operation variables
 */
export interface WatchOptions<TData, TVariables> extends RequestOptions<TData, TVariables> {
	/** Refetch every N milliseconds while observed */
	pollInterval?: number | undefined;
	/** Refetch when the page becomes visible again */
	refetchOnFocus?: boolean | undefined;
	/** Refetch when the network comes back online */
	refetchOnReconnect?: boolean | undefined;
	/** Data to start from when the cache has none, treated as fresh (e.g. server-provided or suspense data) */
	initialData?: TData | undefined;
}

/**
 * Identifies a cache entry for {@link Client.read} / {@link Client.write}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type CacheTarget<TData, TVariables> = Pick<
	RequestOptions<TData, TVariables>,
	"query" | "variables" | "operationName" | "key"
>;

/**
 * Options for {@link QueryRef.fetchMore}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface FetchMoreOptions<TData, TVariables> {
	/** Variables merged over the query's own (e.g. the next cursor or offset) */
	variables: Partial<TVariables>;
	/**
	 * Combines the current data with the newly fetched page.
	 *
	 * @param previous - The current data
	 * @param next - The fetched page
	 * @returns The merged data
	 */
	merge(previous: TData, next: TData): TData;
}

/**
 * Keys of `T` that are not optional. Distributes over unions: a key required by any member counts.
 *
 * @template T - An object type
 */
export type RequiredKeys<T> = T extends unknown ? { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T] : never;

/**
 * Blocks inference from a position (like TypeScript 5.4's `NoInfer`, compatible with older compilers).
 *
 * @template T - The type
 */
export type NoInference<T> = [T][T extends unknown ? 0 : never];

/**
 * Makes `variables` required on `TOptions` when the document declares required variables, so forgetting them is a
 * compile error. Documents without variables (or with only optional ones) keep `variables` optional.
 * Variables are not inferred from the `variables` property itself, so passing `undefined` cannot erase the
 * requirement.
 *
 * @template TOptions - The options type
 * @template TVariables - The shape of the operation variables
 */
export type WithVariables<TOptions, TVariables> = [RequiredKeys<TVariables>] extends [never]
	? TOptions
	: TOptions & { variables: NoInference<TVariables> };

/**
 * Like {@link WithVariables} for options that can be skipped (`skip: true`): `variables` must be present but may be
 * `undefined`, for the `variables: id ? { id } : undefined, skip: !id` pattern.
 *
 * @template TOptions - The options type
 * @template TVariables - The shape of the operation variables
 */
export type WithSkippableVariables<TOptions, TVariables> = [RequiredKeys<TVariables>] extends [never]
	? TOptions
	: TOptions & { variables: NoInference<TVariables> | undefined };
