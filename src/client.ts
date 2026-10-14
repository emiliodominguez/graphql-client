import { ClientError, isClientError } from "./errors";
import {
	applyIncremental,
	createIncrementalState,
	getBoundary,
	normalizeErrors,
	INCREMENTAL_DIRECTIVE,
	MULTIPART_ACCEPT,
	readMultipartMixed,
	type IncrementalPayload,
	type IncrementalState,
} from "./incremental";
import { QueryRef, type QueryWatcher } from "./query-ref";
import { resolveRetryPolicy, rethrowNetworkFailure } from "./retry";
import { readServerSentEvents } from "./sse";
import type {
	CacheKey,
	CacheTarget,
	ClientConfiguration,
	FetchPolicy,
	GraphQLFormattedError,
	GraphQLResponse,
	MaybePromise,
	OperationContext,
	OptimisticUpdate,
	RequestOptions,
	SubscribeOptions,
	SubscriptionRequest,
	WatchOptions,
	WithVariables,
} from "./types";
import { containsFiles, createUploadBody } from "./upload";
import {
	createAbortScope,
	createCacheKey,
	matchesKeyPrefix,
	parseOperation,
	resolveValue,
	sha256,
	sleep,
	type OperationInfo,
} from "./utils";

/**
 * Accepted media types, preferring the GraphQL-over-HTTP response type.
 */
const ACCEPT = "application/graphql-response+json, application/json;q=0.9";

/**
 * The request payload sent to the server (as a JSON body or as GET search params).
 */
interface Payload {
	query?: string | undefined;
	variables?: unknown;
	operationName?: string | undefined;
	extensions?: Record<string, unknown> | undefined;
}

/**
 * The subset of request options the transport layer needs.
 */
type TransportOptions = Pick<RequestOptions<unknown, unknown>, "variables" | "operationName" | "headers">;

/**
 * State that must be shared by every client using the same cache.
 */
interface SharedState {
	/** Watched queries keyed by their cache key */
	watchers: Map<string, Set<QueryWatcher<unknown>>>;
	/** Number of in-flight cache-writing requests per cache key */
	active: Map<string, number>;
	/**
	 * Sequence of the newest applied response, write or invalidation per cache key (only tracked while requests
	 * are in flight). A response older than it neither overwrites the cache nor notifies watchers.
	 */
	applied: Map<string, number>;
	/** Recent invalidations, so inactive live queries can tell they missed one */
	invalidations: Array<{ prefix: CacheKey; epoch: number }>;
	/** Invalidations older than this epoch were dropped from the log: treat them as matching everything */
	floor: number;
	/** Pending optimistic layers per cache key, rendered on top of the entry's real (base) data */
	layers: Map<string, OptimisticEntry>;
}

/**
 * Optimistic state of a cache entry: its real data plus the pending optimistic updates applied on top of it.
 */
interface OptimisticEntry {
	/** The real data (from the server or explicit writes), or `undefined` when unknown */
	base: unknown;
	/** Pending optimistic updates, oldest first */
	layers: Array<OptimisticLayer>;
	/**
	 * Set when the entry was invalidated: the base is unknown until real data arrives, so nothing is rendered into
	 * the cache and successes are not folded into it.
	 */
	stale: boolean;
}

/**
 * One pending optimistic update.
 */
interface OptimisticLayer {
	/** Computes the optimistic data from the data below it */
	update(current: unknown): unknown;
}

/**
 * Maximum number of invalidations remembered per cache.
 */
const INVALIDATION_LOG_SIZE = 64;

/**
 * Shared state per cache (or per client when it has no cache).
 */
const sharedStates = new WeakMap<object, SharedState>();

/**
 * Monotonic counter ordering requests, writes and invalidations across every client.
 */
let sequence = 0;

/**
 * Returns the shared state of a cache, creating it on first use.
 *
 * @param owner - The cache, or the client itself when uncached
 * @returns The shared state
 */
function getSharedState(owner: object): SharedState {
	let state = sharedStates.get(owner);

	if (!state) {
		state = {
			watchers: new Map(),
			active: new Map(),
			applied: new Map(),
			invalidations: [],
			floor: 0,
			layers: new Map(),
		};
		sharedStates.set(owner, state);
	}

	return state;
}

/**
 * Lightweight, zero-dependency GraphQL client with caching, deduplication, retries, middleware,
 * persisted queries, uploads, incremental delivery, SSE subscriptions, live queries, timeouts and typed errors.
 */
export class Client {
	/**
	 * Pending queries keyed by their cache key, shared by identical concurrent calls.
	 */
	readonly #inFlight = new Map<string, { promise: Promise<unknown>; epoch: number }>();

	/**
	 * Memoized persisted-query hashes, keyed by document.
	 */
	readonly #hashes = new Map<string, Promise<string>>();

	/**
	 * Flipped off when the server reports it does not support persisted queries.
	 */
	#persistedQueriesSupported = true;

	/**
	 * Watchers and request ordering, shared by every client using the same cache (see {@link Client.extend}).
	 */
	readonly #shared: SharedState;

	/**
	 * The configuration.
	 */
	readonly #configuration: ClientConfiguration;

	/**
	 * @param configuration - Configuration for the client
	 */
	constructor(configuration: ClientConfiguration) {
		this.#configuration = configuration;
		this.#shared = getSharedState(configuration.cache ?? this);
	}

	/**
	 * Executes a GraphQL query or mutation.
	 *
	 * Queries are served from the cache when available (`cache-first`) and deduplicated while in flight.
	 * Mutations always hit the network and are never cached unless another `fetchPolicy` is passed.
	 * Documents using `@defer` / `@stream` resolve once every incremental payload has been merged.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @template TVariables - The shape of the operation variables
	 * @param options - The request options
	 * @returns The `data` field of the GraphQL response
	 * @throws {ClientError} On a non-2xx status, GraphQL errors, an unparseable body or a missing `data` field
	 * @throws {DOMException} `AbortError` / `TimeoutError` when the request is aborted or times out
	 * @throws {Error} With `cache-only` when nothing is cached
	 */
	async gql<TData = unknown, TVariables extends object = Record<string, unknown>>(
		options: WithVariables<RequestOptions<TData, TVariables>, TVariables>,
	): Promise<TData> {
		const { cache } = this.#configuration;
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const isQuery = operation.type === "query";
		const cacheKey = createCacheKey(options.key ?? [], query, options.variables, options.operationName);
		// Files have no stable identity in a cache key: never cache nor dedupe requests that carry them.
		const hasFiles = containsFiles(options.variables);
		const fetchPolicy = hasFiles ? "no-cache" : (options.fetchPolicy ?? (isQuery ? "cache-first" : "no-cache"));
		const readsCache =
			fetchPolicy === "cache-first" || fetchPolicy === "cache-only" || fetchPolicy === "cache-and-network";

		if (cache && readsCache) {
			const cached = await cache.get<TData>(cacheKey);

			if (cached !== undefined) {
				this.#log(operation, "cache hit");

				// Stale-while-revalidate: answer now, refresh the entry (and every live query) in the background.
				// Failures are reported through `onError` by the request itself.
				if (fetchPolicy === "cache-and-network") {
					this.#request<TData, TVariables>(query, options, operation, cacheKey, "network-only", hasFiles).catch(
						ignoreError,
					);
				}

				return cached;
			}
		}

		const context: OperationContext = { ...operation, query, variables: options.variables, attempt: 0 };

		if (fetchPolicy === "cache-only") {
			const error = new Error(`No cached data for ${operation.type} ${operation.name ?? "(anonymous)"} (cache-only).`);

			this.#report(error, context, options.signal);
			throw error;
		}

		let settle: ((commit: boolean) => Promise<void>) | undefined;

		if (options.optimistic?.length) {
			try {
				settle = await this.#applyOptimistic(options.optimistic);
			} catch (error) {
				this.#report(error, context, options.signal);
				throw error;
			}
		}

		try {
			// On a miss, `cache-and-network` is a plain network request.
			const networkPolicy = fetchPolicy === "cache-and-network" ? "network-only" : fetchPolicy;
			const data = await this.#request<TData, TVariables>(
				query,
				options,
				operation,
				cacheKey,
				networkPolicy,
				hasFiles,
			);

			// The mutation succeeded: a failing cache write while settling is reported, never turned into a rejection
			// (callers could retry a non-idempotent mutation).
			try {
				await settle?.(true);
			} catch (settleError) {
				this.#report(settleError, context, options.signal);
			}

			return data;
		} catch (error) {
			// A failing rollback must never mask the operation's error.
			await settle?.(false).catch(ignoreError);
			throw error;
		}
	}

	/**
	 * Runs a network request, sharing identical in-flight queries.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @template TVariables - The shape of the operation variables
	 * @param query - The GraphQL document
	 * @param options - The request options
	 * @param operation - The parsed operation info
	 * @param cacheKey - Key identifying the result
	 * @param fetchPolicy - The effective fetch policy
	 * @param hasFiles - Whether the variables carry files
	 * @returns The `data` field of the GraphQL response
	 */
	async #request<TData, TVariables>(
		query: string,
		options: RequestOptions<TData, TVariables>,
		operation: OperationInfo,
		cacheKey: string,
		fetchPolicy: FetchPolicy,
		hasFiles: boolean,
	): Promise<TData> {
		const { dedupe = true } = this.#configuration;
		const isQuery = operation.type === "query";

		// Calls carrying their own signal, headers, timeout or retry policy may legitimately diverge,
		// so they never share a request.
		const canDedupe =
			dedupe &&
			isQuery &&
			!hasFiles &&
			!options.signal &&
			!options.headers &&
			options.timeout === undefined &&
			options.retry === undefined;
		const writesCache = fetchPolicy !== "no-cache";
		// Requests that write the cache and requests that must not are never merged.
		const flightKey = writesCache ? cacheKey : `no-cache:${cacheKey}`;
		const flight = canDedupe ? this.#inFlight.get(flightKey) : undefined;
		// An invalidation issued through another client sharing the cache cannot clear this client's map.
		const pending = flight && !this.#invalidatedSince(cacheKey, flight.epoch) ? flight.promise : undefined;

		if (pending) {
			this.#log(operation, "deduplicated");
			return pending as Promise<TData>;
		}

		const epoch = sequence;
		const request = this.#execute<TData, TVariables>(query, options, operation, cacheKey, writesCache);

		if (!canDedupe) return request;

		const entry = { promise: request, epoch };

		this.#inFlight.set(flightKey, entry);

		try {
			return await request;
		} finally {
			// An invalidation may already have replaced this entry with a fresh request.
			if (this.#inFlight.get(flightKey) === entry) this.#inFlight.delete(flightKey);
		}
	}

	/**
	 * Streams an operation: subscriptions over Server-Sent Events (GraphQL over SSE, "distinct connections" mode),
	 * or `@defer` / `@stream` queries over SSE or `multipart/mixed`. Each yielded value is the merged result so far.
	 * Breaking out of the loop, or aborting `signal`, closes the connection.
	 * A server answering with a single JSON result yields it once.
	 *
	 * @example
	 * for await (const { messageAdded } of client.subscribe({ query: ON_MESSAGE })) {
	 *   render(messageAdded);
	 * }
	 *
	 * @template TData - The shape of each `data` payload
	 * @template TVariables - The shape of the operation variables
	 * @param options - The subscription options
	 * @yields Every `data` payload (or merged incremental result) sent by the server
	 * @throws {ClientError} On a non-2xx status or when a payload carries GraphQL errors
	 */
	async *subscribe<TData = unknown, TVariables extends object = Record<string, unknown>>(
		options: WithVariables<SubscribeOptions<TData, TVariables>, TVariables>,
	): AsyncGenerator<TData, void, undefined> {
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const scope = createAbortScope(options.signal);
		const context: OperationContext = { ...operation, query, variables: options.variables, attempt: 0 };

		try {
			const { subscriptionTransport } = this.#configuration;
			const { persistedQueries } = this.#configuration;
			const strict = typeof persistedQueries === "object" && persistedQueries.strict === true;
			// Trusted documents never send the document text, whatever the transport.
			const request: SubscriptionRequest = strict
				? {
						variables: options.variables,
						operationName: options.operationName,
						extensions: { persistedQuery: { version: 1, sha256Hash: await this.#hash(query) } },
					}
				: { query, variables: options.variables, operationName: options.operationName };
			let response: Response | undefined;
			let source: AsyncIterable<IncrementalPayload> | undefined;

			if (subscriptionTransport && operation.type === "subscription") {
				source = subscriptionTransport.subscribe(request, scope.signal);
			} else {
				const headers = await this.#createHeaders(query, options.headers);

				headers.set(
					"Accept",
					INCREMENTAL_DIRECTIVE.test(query) ? `text/event-stream, ${MULTIPART_ACCEPT}` : "text/event-stream",
				);

				response = await this.#run(this.#createRequest(request, "POST", headers, scope.signal), context);

				const contentType = response.headers.get("Content-Type") ?? "";
				const chunks =
					!response.ok || !response.body
						? undefined
						: contentType.includes("text/event-stream")
							? readServerSentEventData(response.body, scope.signal)
							: contentType.includes("multipart/mixed")
								? readMultipartMixed(response.body, getBoundary(contentType), scope.signal)
								: undefined;

				if (!chunks) {
					yield await this.#parseResponse<TData>(response, scope.signal);
					return;
				}

				source = parseChunks(chunks);
			}

			this.#log(operation, "streaming");

			const state = createIncrementalState();
			let last: unknown;

			for await (const payload of source) {
				// Payloads already buffered when the consumer aborted are dropped.
				if (scope.signal.aborted) break;

				const { data, errors } = applyIncremental(state, payload);

				if (errors.length) throw createGraphQLError(response, errors, data);

				// A trailing `completed`/`hasNext: false` payload changes nothing: don't yield the same result twice.
				if (data !== undefined && data !== last) {
					last = data;
					yield data as TData;
				}
			}

			if (state.hasNext && !scope.signal.aborted) throw incompleteError(response, state.data);
		} catch (error) {
			if (!scope.signal.aborted) this.#report(error, context, options.signal);

			throw error;
		} finally {
			scope.abort();
			scope.dispose();
		}
	}

	/**
	 * Creates an observable query (live query). See {@link QueryRef}: lazy activation, stale-while-revalidate,
	 * automatic refetch on invalidation, polling, focus and reconnect, and sync with other fetches of the same key.
	 *
	 * @example
	 * const ref = client.watch({ key: ["todos"], query: TODOS, pollInterval: 30_000 });
	 * const unsubscribe = ref.subscribe(function render({ data, error, loading }) { ... });
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @template TVariables - The shape of the operation variables
	 * @param options - The query and watch options
	 * @returns The observable query
	 */
	watch<TData = unknown, TVariables extends object = Record<string, unknown>>(
		options: WithVariables<WatchOptions<TData, TVariables>, TVariables>,
	): QueryRef<TData, TVariables> {
		const client = this;
		const query = String(options.query);
		const cacheKey = createCacheKey(options.key ?? [], query, options.variables, options.operationName);
		const readsCache =
			options.fetchPolicy === undefined ||
			options.fetchPolicy === "cache-first" ||
			options.fetchPolicy === "cache-only" ||
			options.fetchPolicy === "cache-and-network";

		return new QueryRef<TData, TVariables>(
			{
				async fetch(fetchPolicy: FetchPolicy): Promise<TData> {
					const data = await client.gql<TData, TVariables>({ ...options, fetchPolicy });

					// A superseded response is not stored: show what the entry holds now (optimistic layers included).
					if (fetchPolicy !== "no-cache") {
						const cached = await client.#configuration.cache?.get<TData>(cacheKey);

						if (cached !== undefined) return cached;
					}

					// Pending optimistic layers stay visible on top of freshly fetched data.
					return client.#overlay(cacheKey, data);
				},
				cached(): TData | undefined {
					const cached = client.#configuration.cache?.get<TData>(cacheKey);

					return cached instanceof Promise ? undefined : cached;
				},
				peek(): TData | undefined {
					const cached = readsCache ? client.#configuration.cache?.get<TData>(cacheKey) : undefined;

					return cached instanceof Promise ? undefined : cached;
				},
				hasCache(): boolean {
					return client.#configuration.cache !== undefined;
				},
				optimistic(): boolean {
					return (client.#shared.layers.get(cacheKey)?.layers.length ?? 0) > 0;
				},
				epoch(): number {
					return client.#epoch();
				},
				invalidatedSince(epoch: number): boolean {
					return client.#invalidatedSince(cacheKey, epoch);
				},
				register(watcher: QueryWatcher<TData>): () => void {
					return client.#register(cacheKey, watcher as QueryWatcher<unknown>);
				},
				fetchMore(variables: Partial<TVariables>): Promise<TData> {
					return client.gql<TData, TVariables>({
						...options,
						variables: { ...options.variables, ...variables } as TVariables,
						fetchPolicy: "no-cache",
						invalidates: undefined,
					});
				},
				write(data: TData): Promise<void> {
					return client.write<TData, TVariables>(options, data);
				},
				real(visible: TData | undefined): TData | undefined {
					return client.#real(cacheKey, visible);
				},
				overlay(data: TData): TData {
					return client.#overlay(cacheKey, data);
				},
			},
			options,
		);
	}

	/**
	 * Reads a cached result without touching the network.
	 *
	 * @template TData - The shape of the `data` field
	 * @template TVariables - The shape of the operation variables
	 * @param target - Identifies the entry (same fields as the request that produced it)
	 * @returns The cached data, or `undefined`
	 */
	async read<TData = unknown, TVariables extends object = Record<string, unknown>>(
		target: CacheTarget<TData, TVariables>,
	): Promise<TData | undefined> {
		return this.#configuration.cache?.get<TData>(this.#getCacheKey(target));
	}

	/**
	 * Writes a result into the cache and pushes it to every watcher of that entry.
	 * The building block for optimistic updates: write the expected data, then `invalidate` or roll back.
	 *
	 * @template TData - The shape of the `data` field
	 * @template TVariables - The shape of the operation variables
	 * @param target - Identifies the entry (same fields as the request that reads it)
	 * @param data - The data to store
	 */
	async write<TData = unknown, TVariables extends object = Record<string, unknown>>(
		target: CacheTarget<TData, TVariables>,
		data: TData,
	): Promise<void> {
		const cacheKey = this.#getCacheKey(target);

		// In-flight responses for this entry are now older than the written data.
		this.#supersede(cacheKey, ++sequence);
		await this.#store(cacheKey, data);
	}

	/**
	 * Serializes every result cached by this client, e.g. to hydrate a browser client after SSR.
	 *
	 * @returns A JSON-serializable snapshot
	 */
	async extract(): Promise<Record<string, unknown>> {
		const cache = this.#configuration.cache;
		const snapshot: Record<string, unknown> = {};

		if (!cache) return snapshot;

		// Snapshot the keys: reading may reorder a live iterator (e.g. a Map-backed LRU) and loop forever.
		for (const key of [...(await cache.keys())]) {
			if (!matchesKeyPrefix(key, [])) continue;

			// Never ship optimistic (unconfirmed) data in a snapshot: take the real data under pending layers.
			const entry = this.#shared.layers.get(key);
			const data = entry ? (entry.stale ? undefined : entry.base) : await cache.get(key);

			if (data !== undefined) snapshot[key] = data;
		}

		return snapshot;
	}

	/**
	 * Loads a snapshot produced by {@link Client.extract} into the cache.
	 *
	 * @param snapshot - The snapshot
	 */
	async restore(snapshot: Record<string, unknown>): Promise<void> {
		for (const [key, data] of Object.entries(snapshot)) await this.#store(key, data);
	}

	/**
	 * Removes cached results. Keys are hierarchical: `invalidate(["user"])` drops `["user"]`, `["user", 1]`, etc.
	 * Calling it without arguments drops every result cached by this client.
	 * Active watched queries under the prefix refetch automatically.
	 *
	 * @param prefix - The cache key prefix to invalidate. Defaults to `[]` (everything).
	 * @returns The number of removed cache entries
	 */
	async invalidate(prefix: CacheKey = []): Promise<number> {
		const cache = this.#configuration.cache;
		const keys = cache ? [...(await cache.keys())].filter(belongsTo(prefix)) : [];

		const shared = this.#shared;
		const inFlight = this.#inFlight;
		const epoch = ++sequence;

		// In-flight requests started before the invalidation must neither repopulate the cache nor be joined.
		for (const key of shared.active.keys()) {
			if (matchesKeyPrefix(key, prefix)) this.#supersede(key, epoch);
		}

		for (const key of [...inFlight.keys()]) {
			if (matchesKeyPrefix(key.replace(/^no-cache:/, ""), prefix)) inFlight.delete(key);
		}

		for (const [key, entry] of shared.layers) {
			// The last real data is kept for live queries to fall back on; it is never written back to the cache.
			if (matchesKeyPrefix(key, prefix)) entry.stale = true;
		}

		shared.invalidations.push({ prefix, epoch });

		if (shared.invalidations.length > INVALIDATION_LOG_SIZE) shared.floor = shared.invalidations.shift()!.epoch;

		await Promise.all(
			keys.map(function remove(key: string): unknown {
				return cache?.delete(key);
			}),
		);

		for (const [key, watchers] of shared.watchers) {
			if (!matchesKeyPrefix(key, prefix)) continue;

			for (const watcher of [...watchers]) watcher.invalidate();
		}

		return keys.length;
	}

	/**
	 * Creates a new client with the given configuration overrides. The cache instance is shared unless overridden.
	 * Clients sharing a cache also share live-query notifications and request ordering.
	 * Overrides replace values; they are not deep-merged.
	 *
	 * Cache keys do not include auth: when overriding `authToken`/`headers` per user (e.g. per SSR request),
	 * also pass a fresh `cache`, or users would see each other's data.
	 *
	 * @param overrides - Configuration values to replace
	 * @returns A new client
	 */
	extend(overrides: Partial<ClientConfiguration>): Client {
		return new Client({ ...this.#configuration, ...overrides });
	}

	/**
	 * Runs the request with retries, then populates the cache and applies invalidations.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @template TVariables - The shape of the operation variables
	 * @param query - The GraphQL document
	 * @param options - The request options
	 * @param operation - The parsed operation info
	 * @param cacheKey - Key identifying the result
	 * @param writesCache - Whether to store the result
	 * @returns The `data` field of the GraphQL response
	 */
	async #execute<TData, TVariables>(
		query: string,
		options: RequestOptions<TData, TVariables>,
		operation: OperationInfo,
		cacheKey: string,
		writesCache: boolean,
	): Promise<TData> {
		const scope = createAbortScope(options.signal, options.timeout ?? this.#configuration.timeout);
		const policy = resolveRetryPolicy(this.#configuration.retry, options.retry);
		const startedAt = Date.now();
		const order = writesCache ? this.#begin(cacheKey) : 0;

		try {
			for (let attempt = 0; ; attempt++) {
				const context: OperationContext = { ...operation, query, variables: options.variables, attempt };

				try {
					const data = await this.#send<TData>(query, options, context, scope.signal);

					this.#log(operation, `ok in ${Date.now() - startedAt}ms${attempt ? ` after ${attempt} retries` : ""}`);

					if (writesCache && this.#supersede(cacheKey, order)) await this.#store(cacheKey, data);

					for (const prefix of options.invalidates ?? []) {
						await this.invalidate(prefix);
					}

					return data;
				} catch (error) {
					if (scope.signal.aborted || !policy || attempt >= policy.attempts || !policy.retryIf(error, context)) {
						this.#report(error, context, options.signal);
						throw error;
					}

					const delay = policy.delay(attempt, error);

					this.#log(operation, `retry ${attempt + 1}/${policy.attempts} in ${Math.round(delay)}ms`);

					await sleep(delay, scope.signal);
				}
			}
		} finally {
			scope.dispose();

			if (writesCache) this.#end(cacheKey);
		}
	}

	/**
	 * Sends a single attempt, transparently handling the Automatic Persisted Queries handshake.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @param query - The GraphQL document
	 * @param options - The request options
	 * @param context - The operation metadata
	 * @param signal - The abort signal
	 * @returns The `data` field of the GraphQL response
	 */
	async #send<TData>(
		query: string,
		options: TransportOptions,
		context: OperationContext,
		signal: AbortSignal,
	): Promise<TData> {
		const { variables, operationName } = options;
		const { persistedQueries } = this.#configuration;
		const strict = typeof persistedQueries === "object" && persistedQueries.strict === true;
		const method = context.type === "query" ? (this.#configuration.method ?? "POST") : "POST";
		const hash = strict
			? await this.#hash(query)
			: persistedQueries && this.#persistedQueriesSupported
				? // A failing hash (e.g. no `crypto.subtle` on insecure origins) falls back to sending the full document.
					await this.#hash(query).catch(ignoreError)
				: undefined;
		const extensions = hash === undefined ? undefined : { persistedQuery: { version: 1, sha256Hash: hash } };

		if (extensions) {
			try {
				return await this.#dispatch<TData>(
					{ variables, operationName, extensions },
					method,
					options,
					context,
					signal,
				);
			} catch (error) {
				const miss = getPersistedQueryMiss(error);

				// Trusted documents never reveal the document: an unknown hash is an error, not a negotiation.
				if (!miss || strict) throw error;

				if (miss === "unsupported") {
					this.#persistedQueriesSupported = false;
				}

				const payload = {
					query,
					variables,
					operationName,
					extensions: miss === "unsupported" ? undefined : extensions,
				};

				return this.#dispatch<TData>(payload, method, options, context, signal);
			}
		}

		return this.#dispatch<TData>({ query, variables, operationName }, method, options, context, signal);
	}

	/**
	 * Builds the request, runs it through the middleware chain and parses the response.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @param payload - The GraphQL payload
	 * @param method - The HTTP method
	 * @param options - The request options
	 * @param context - The operation metadata
	 * @param signal - The abort signal
	 * @returns The `data` field of the GraphQL response
	 */
	async #dispatch<TData>(
		payload: Payload,
		method: "GET" | "POST",
		options: TransportOptions,
		context: OperationContext,
		signal: AbortSignal,
	): Promise<TData> {
		const headers = await this.#createHeaders(context.query, options.headers);
		const response = await this.#run(this.#createRequest(payload, method, headers, signal), context);

		return this.#parseResponse<TData>(response, signal);
	}

	/**
	 * Creates the `Request`. GET requests carry the payload as search params and drop `Content-Type`
	 * so they stay CORS-simple and CDN-cacheable. Variables containing files switch to a multipart POST
	 * (GraphQL multipart request spec).
	 *
	 * @param payload - The GraphQL payload
	 * @param method - The HTTP method
	 * @param headers - The request headers
	 * @param signal - The abort signal
	 * @returns The request
	 */
	#createRequest(payload: Payload, method: "GET" | "POST", headers: Headers, signal: AbortSignal): Request {
		const { url } = this.#configuration;
		const upload = createUploadBody(payload);

		if (upload) {
			// Let fetch set the multipart boundary.
			headers.delete("Content-Type");

			return new Request(url, { method: "POST", headers, body: upload, signal });
		}

		if (method === "POST") {
			return new Request(url, { method, headers, body: JSON.stringify(payload), signal });
		}

		const params = new URLSearchParams();

		for (const [name, value] of Object.entries(payload)) {
			if (value !== undefined) params.set(name, typeof value === "string" ? value : JSON.stringify(value));
		}

		headers.delete("Content-Type");

		// Params go before any `#fragment` (never sent to the server).
		const [base = url] = url.split("#", 1);

		return new Request(`${base}${base.includes("?") ? "&" : "?"}${params}`, { method, headers, signal });
	}

	/**
	 * Runs a request through the middleware chain, ending with `fetch`.
	 *
	 * @param request - The request
	 * @param context - The operation metadata
	 * @returns The response
	 */
	#run(request: Request, context: OperationContext): Promise<Response> {
		const middleware = this.#configuration.middleware ?? [];
		const fetchFn = this.#configuration.fetch ?? globalThis.fetch;

		/**
		 * Invokes the middleware at `index`, or `fetch` past the end of the chain.
		 *
		 * @param index - Middleware index
		 * @param current - The request at this point of the chain
		 * @returns The response
		 */
		function call(index: number, current: Request): Promise<Response> {
			const handler = middleware[index];

			if (!handler) return fetchFn(current).catch(rethrowNetworkFailure);

			return handler(
				current,
				function next(nextRequest: Request = current): Promise<Response> {
					return call(index + 1, nextRequest);
				},
				context,
			);
		}

		return call(0, request);
	}

	/**
	 * Resolves and memoizes the persisted-query hash of a document.
	 *
	 * @param query - The GraphQL document
	 * @returns The hash
	 */
	#hash(query: string): Promise<string> {
		let hash = this.#hashes.get(query);

		if (!hash) {
			const options = this.#configuration.persistedQueries;
			const custom = typeof options === "object" ? options.hash : undefined;

			const hashes = this.#hashes;

			hash = Promise.resolve()
				.then(function compute(): MaybePromise<string> {
					return custom ? custom(query) : sha256(query);
				})
				.catch(function forget(error: unknown): never {
					// Never memoize a failure: the next request retries the hash.
					hashes.delete(query);
					throw error;
				});
			hashes.set(query, hash);
		}

		return hash;
	}

	/**
	 * Builds the request headers. Precedence (lowest to highest): defaults, auth token, client headers, call headers.
	 * Documents using `@defer` / `@stream` also advertise `multipart/mixed`.
	 *
	 * @param query - The GraphQL document
	 * @param requestHeaders - Headers for this call only
	 * @returns The merged headers
	 */
	async #createHeaders(query: string, requestHeaders?: HeadersInit): Promise<Headers> {
		const { authToken, headers } = this.#configuration;
		const accept = INCREMENTAL_DIRECTIVE.test(query) ? `${MULTIPART_ACCEPT}, ${ACCEPT}` : ACCEPT;
		const merged = new Headers({ "Content-Type": "application/json", Accept: accept });
		const token = authToken === undefined ? undefined : await resolveValue(authToken);

		if (token) {
			merged.set("Authorization", `Bearer ${token}`);
		}

		for (const source of [headers === undefined ? undefined : await resolveValue(headers), requestHeaders]) {
			if (!source) continue;

			new Headers(source).forEach(function assign(value: string, name: string): void {
				merged.set(name, value);
			});
		}

		return merged;
	}

	/**
	 * Parses and validates a GraphQL response.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @param response - The fetch Response
	 * @param signal - The request signal, used to tell aborts apart from malformed bodies
	 * @returns The `data` field
	 * @throws {ClientError} When the response cannot be used
	 */
	async #parseResponse<TData>(response: Response, signal?: AbortSignal): Promise<TData> {
		const { status } = response;
		const contentType = response.headers.get("Content-Type") ?? "";
		let body: (GraphQLResponse<TData> & { incomplete?: boolean }) | undefined;

		try {
			body =
				response.ok && response.body && contentType.includes("multipart/mixed")
					? await collectIncremental<TData>(response.body, getBoundary(contentType), signal)
					: ((await response.json()) as GraphQLResponse<TData>);
		} catch (cause) {
			// Abort/timeout during body streaming must surface as-is, not as a parse error.
			if (signal?.aborted) throw cause;

			const message = response.ok ? "Invalid JSON in the GraphQL response." : describeStatus(response);

			throw new ClientError(message, { status, response, cause });
		}

		const errors = normalizeErrors(body?.errors);
		const data = body?.data ?? undefined;

		if (errors.length) throw createGraphQLError(response, errors, data);

		if (!response.ok) {
			throw new ClientError(describeStatus(response), { status, response, data });
		}

		if (data === undefined) {
			throw new ClientError("No data found in the GraphQL response.", { status, response });
		}

		if (body?.incomplete) throw incompleteError(response, data);

		return data;
	}

	/**
	 * Applies optimistic updates as layers on top of each entry's real data, and returns the function settling them.
	 * Settling removes this operation's layers only: on success they are folded into the real data (`commit`), on
	 * failure they are dropped. Real data arriving meanwhile replaces the base and the remaining layers re-apply on
	 * top, so concurrent optimistic operations, refetches and invalidations never clobber each other.
	 *
	 * @param updates - The optimistic updates
	 * @returns Settles the applied layers
	 * @throws When an update throws; layers applied so far are rolled back first
	 */
	async #applyOptimistic(
		updates: ReadonlyArray<OptimisticUpdate<unknown, unknown>>,
	): Promise<(commit: boolean) => Promise<void>> {
		const client = this;
		const { layers } = this.#shared;
		const applied: Array<{ cacheKey: string; layer: OptimisticLayer }> = [];

		/**
		 * Removes the applied layers (newest first), folding them into the real data when committing.
		 *
		 * @param commit - Whether the operation succeeded
		 */
		async function settle(commit: boolean): Promise<void> {
			for (const { cacheKey, layer } of applied.splice(0).reverse()) {
				const entry = layers.get(cacheKey);
				const index = entry ? entry.layers.indexOf(layer) : -1;

				if (!entry || index === -1) continue;

				entry.layers.splice(index, 1);

				// An invalidated base is unknown: never fold into it, the refetch brings the truth.
				if (commit && !entry.stale) entry.base = applyLayer(entry.base, layer);

				if (entry.layers.length === 0) layers.delete(cacheKey);

				// An invalidated entry is never rendered into the cache: show live queries the real data they fell
				// back on (without this layer), then let them refetch, joining a refetch already in flight.
				if (entry.stale) {
					client.#retract(cacheKey, entry.layers.reduce(applyLayer, entry.base), true);
					continue;
				}

				if (entry.layers.length > 0) {
					await client.#render(cacheKey, entry);
					continue;
				}

				// The last layer is gone: restore the real data. If the entry expired meanwhile, only live queries get
				// it back (they would otherwise keep showing the removed layer); nothing is written to the cache.
				const cache = client.#configuration.cache;
				const expired = cache !== undefined && (await cache.get(cacheKey)) === undefined;

				if (expired) client.#retract(cacheKey, entry.base, entry.base === undefined);
				else await client.#render(cacheKey, entry);
			}
		}

		try {
			for (const { target, update } of updates) {
				const cacheKey = this.#getCacheKey(target);
				const existing = layers.get(cacheKey);
				// Without a cache (or on a miss), live queries showing the entry still hold its current data.
				const cache = this.#configuration.cache;
				// With a cache, a miss means there is no real data: never adopt a live query's (possibly no-cache or
				// invalidated) data as the base, it would be written to the cache when the layer settles.
				const base = existing ? existing.base : cache ? await cache.get(cacheKey) : this.#peekWatchers(cacheKey);
				// Another optimistic operation may have created the entry while the cache was read.
				const entry = layers.get(cacheKey) ?? { base, layers: [], stale: false };
				const layer: OptimisticLayer = { update };

				// Validate the update before registering anything, so a throwing update leaves nothing behind.
				update(entry.layers.reduce(applyLayer, entry.base));
				layers.set(cacheKey, entry);
				entry.layers.push(layer);
				applied.push({ cacheKey, layer });
				await this.#render(cacheKey, entry);
			}
		} catch (error) {
			await settle(false);
			throw error;
		}

		return settle;
	}

	/**
	 * Stores real data for an entry. With pending optimistic layers, the data becomes their base and the layers are
	 * re-applied on top; otherwise it is written and pushed to watchers as-is.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param data - The real data
	 */
	async #store(cacheKey: string, data: unknown): Promise<void> {
		const entry = this.#shared.layers.get(cacheKey);

		if (entry) {
			entry.base = data;
			entry.stale = false;
			await this.#render(cacheKey, entry);
			return;
		}

		await this.#configuration.cache?.set(cacheKey, data);
		this.#notify(cacheKey, data);
	}

	/**
	 * Writes an entry's visible data (base plus optimistic layers) without superseding in-flight real responses,
	 * which keep updating the base. An entry left without any data is dropped and its watchers refetch.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param entry - The optimistic entry
	 */
	async #render(cacheKey: string, entry: OptimisticEntry): Promise<void> {
		// An invalidated entry waits for real data: its watchers are already refetching.
		if (entry.stale) return;

		const visible = entry.layers.reduce(applyLayer, entry.base);

		if (visible === undefined) {
			await this.#configuration.cache?.delete(cacheKey);
			this.#retract(cacheKey, undefined, true);

			return;
		}

		await this.#configuration.cache?.set(cacheKey, visible);
		this.#notify(cacheKey, visible);
	}

	/**
	 * Replaces what live queries show for an entry without touching the cache, so a removed optimistic layer never
	 * stays visible, even when the refetch meant to replace it fails.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param data - The data to show (`undefined` when no real data is known)
	 * @param refetch - Whether the live queries should refetch
	 */
	#retract(cacheKey: string, data: unknown, refetch: boolean): void {
		for (const watcher of [...(this.#shared.watchers.get(cacheKey) ?? [])]) {
			watcher.replace(data);
			if (refetch) watcher.invalidate();
		}
	}

	/**
	 * Applies the pending optimistic layers of an entry on top of real data.
	 *
	 * @template TData - The shape of the data
	 * @param cacheKey - The serialized cache key
	 * @param data - The real data
	 * @returns The visible data
	 */
	#overlay<TData>(cacheKey: string, data: TData): TData {
		const entry = this.#shared.layers.get(cacheKey);

		// Only ever called with real data (network results, no-cache fetches, merged pages): cache hits are read back
		// from the cache, which already holds the layers.
		return entry ? (entry.layers.reduce(applyLayer, data) as TData) : data;
	}

	/**
	 * Returns the real data under an entry's optimistic layers, or `visible` when it has none.
	 *
	 * @template TData - The shape of the data
	 * @param cacheKey - The serialized cache key
	 * @param visible - The data currently shown
	 * @returns The real data
	 */
	#real<TData>(cacheKey: string, visible: TData | undefined): TData | undefined {
		const entry = this.#shared.layers.get(cacheKey);

		return entry ? (entry.base as TData | undefined) : visible;
	}

	/**
	 * Returns the data held by the first watcher of a cache key that has some.
	 *
	 * @param cacheKey - The serialized cache key
	 * @returns The data, or `undefined`
	 */
	#peekWatchers(cacheKey: string): unknown {
		for (const watcher of this.#shared.watchers.get(cacheKey) ?? []) {
			const data = watcher.current();

			if (data !== undefined) return data;
		}

		return undefined;
	}

	/**
	 * Forwards a failure to the `onError` hook, unless the caller aborted the operation.
	 *
	 * @param error - The failure
	 * @param context - The operation metadata
	 * @param signal - The caller's abort signal
	 */
	#report(error: unknown, context: OperationContext, signal: AbortSignal | undefined): void {
		if (signal?.aborted || !this.#configuration.onError) return;

		try {
			this.#configuration.onError(error, context);
		} catch {
			// A failing error reporter must never mask the original error.
		}
	}

	/**
	 * Starts tracking a cache-writing request.
	 *
	 * @param cacheKey - The serialized cache key
	 * @returns The request's order
	 */
	#begin(cacheKey: string): number {
		const { active } = this.#shared;

		active.set(cacheKey, (active.get(cacheKey) ?? 0) + 1);

		return ++sequence;
	}

	/**
	 * Marks `order` as the newest state of a cache key, unless something newer was already applied.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param order - The order of the response, write or invalidation
	 * @returns Whether `order` is the newest (the caller may apply its data)
	 */
	#supersede(cacheKey: string, order: number): boolean {
		const { active, applied } = this.#shared;

		if (order <= (applied.get(cacheKey) ?? 0)) return false;

		// Ordering only matters while requests are in flight.
		if (active.has(cacheKey)) applied.set(cacheKey, order);

		return true;
	}

	/**
	 * Stops tracking a cache-writing request.
	 *
	 * @param cacheKey - The serialized cache key
	 */
	#end(cacheKey: string): void {
		const { active, applied } = this.#shared;
		const remaining = (active.get(cacheKey) ?? 1) - 1;

		if (remaining > 0) {
			active.set(cacheKey, remaining);
		} else {
			active.delete(cacheKey);
			applied.delete(cacheKey);
		}
	}

	/**
	 * Returns the current invalidation epoch.
	 *
	 * @returns The epoch
	 */
	#epoch(): number {
		return sequence;
	}

	/**
	 * Checks whether a cache key was invalidated after an epoch.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param since - The epoch to compare with
	 * @returns `true` when an invalidation matching the key happened after `since`
	 */
	#invalidatedSince(cacheKey: string, since: number): boolean {
		const { invalidations, floor } = this.#shared;

		if (since < floor) return true;

		return invalidations.some(function matches(entry: { prefix: CacheKey; epoch: number }): boolean {
			return entry.epoch > since && matchesKeyPrefix(cacheKey, entry.prefix);
		});
	}

	/**
	 * Registers a watcher for a cache key.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param watcher - The watcher
	 * @returns The unregister function
	 */
	#register(cacheKey: string, watcher: QueryWatcher<unknown>): () => void {
		const { watchers } = this.#shared;
		const set = watchers.get(cacheKey) ?? new Set();

		set.add(watcher);
		watchers.set(cacheKey, set);

		return function unregister(): void {
			set.delete(watcher);
			if (set.size === 0 && watchers.get(cacheKey) === set) watchers.delete(cacheKey);
		};
	}

	/**
	 * Pushes fresh data to every watcher of a cache key.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param data - The data
	 */
	#notify(cacheKey: string, data: unknown): void {
		for (const watcher of [...(this.#shared.watchers.get(cacheKey) ?? [])]) watcher.receive(data);
	}

	/**
	 * Computes the cache key of a read/write target.
	 *
	 * @template TData - The shape of the `data` field
	 * @template TVariables - The shape of the operation variables
	 * @param target - The target
	 * @returns The serialized cache key
	 */
	#getCacheKey<TData, TVariables>(target: CacheTarget<TData, TVariables>): string {
		return createCacheKey(target.key ?? [], String(target.query), target.variables, target.operationName);
	}

	/**
	 * Logs an operation event when debugging is enabled.
	 *
	 * @param operation - The parsed operation info
	 * @param detail - What happened
	 */
	#log(operation: OperationInfo, detail: string): void {
		if (!this.#configuration.debug) return;

		console.debug(`[lumenql] ${operation.type} ${operation.name ?? "(anonymous)"} → ${detail}`);
	}
}

/**
 * Creates the ClientError for a result carrying GraphQL errors.
 *
 * @param response - The fetch Response, absent for non-HTTP transports
 * @param errors - The GraphQL errors
 * @param data - Partial data, if any
 * @returns The error
 */
function createGraphQLError(
	response: Response | undefined,
	errors: ReadonlyArray<GraphQLFormattedError>,
	data: unknown,
): ClientError {
	const summary = errors.map(getMessage).join("; ");
	const message = !response || response.ok ? summary : `${describeStatus(response)}: ${summary}`;

	return new ClientError(message, { status: response?.status ?? 0, response, errors, data });
}

/**
 * `reduce` callback applying an optimistic layer, keeping the data unchanged when the update throws (e.g. on data
 * it did not expect).
 *
 * @param current - The data below the layer
 * @param layer - The optimistic layer
 * @returns The data with the layer applied
 */
function applyLayer(current: unknown, layer: OptimisticLayer): unknown {
	try {
		return layer.update(current);
	} catch {
		return current;
	}
}

/**
 * Creates the error for an incremental response that ended before its last payload.
 *
 * @param response - The fetch Response, absent for non-HTTP transports
 * @param data - The data merged so far
 * @returns The error
 */
function incompleteError(response: Response | undefined, data: unknown): ClientError {
	return new ClientError("Incomplete incremental response.", {
		status: response?.status ?? 0,
		response,
		data,
	});
}

/**
 * Swallows an error.
 *
 * @returns `undefined`
 */
function ignoreError(): undefined {
	return undefined;
}

/**
 * Parses streamed JSON chunks.
 *
 * @param chunks - Raw JSON strings
 * @yields The parsed payloads
 */
async function* parseChunks(chunks: AsyncIterable<string>): AsyncGenerator<IncrementalPayload> {
	for await (const chunk of chunks) yield JSON.parse(chunk) as IncrementalPayload;
}

/**
 * Creates a filter matching serialized cache keys under a prefix.
 *
 * @param prefix - The key prefix
 * @returns The filter
 */
function belongsTo(prefix: CacheKey): (key: string) => boolean {
	return function belongsToPrefix(key: string): boolean {
		return matchesKeyPrefix(key, prefix);
	};
}

/**
 * Yields the data of SSE `next`/`message` events until `complete`.
 *
 * @param body - The response body
 * @param signal - The abort signal
 * @yields Each event payload
 */
async function* readServerSentEventData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
	for await (const event of readServerSentEvents(body, signal)) {
		if (event.event === "complete") return;
		if ((event.event === "next" || event.event === "message") && event.data) yield event.data;
	}
}

/**
 * Consumes a whole `multipart/mixed` incremental response and returns the merged result, flagged `incomplete` when
 * the stream ended while the server still announced more payloads.
 *
 * @template TData - The shape of the `data` field
 * @param body - The response body
 * @param boundary - The multipart boundary
 * @param signal - The abort signal
 * @returns The merged response
 */
async function collectIncremental<TData>(
	body: ReadableStream<Uint8Array>,
	boundary: string,
	signal?: AbortSignal,
): Promise<GraphQLResponse<TData> & { incomplete?: boolean }> {
	const state: IncrementalState = createIncrementalState();

	for await (const chunk of readMultipartMixed(body, boundary, signal)) {
		applyIncremental(state, JSON.parse(chunk) as IncrementalPayload);
	}

	// A cancelled reader ends like a finished stream: an abort or timeout must still reject.
	signal?.throwIfAborted();

	return {
		data: state.data as TData | undefined,
		errors: state.errors.length ? state.errors : undefined,
		incomplete: state.hasNext,
	};
}

/**
 * Detects the Automatic Persisted Queries negotiation errors.
 *
 * @param error - Any thrown value
 * @returns `"missing"` when the server needs the full document, `"unsupported"` when APQ is unavailable
 */
function getPersistedQueryMiss(error: unknown): "missing" | "unsupported" | undefined {
	if (!isClientError(error)) return undefined;

	for (const { message, extensions } of error.errors) {
		if (message === "PersistedQueryNotFound" || extensions?.code === "PERSISTED_QUERY_NOT_FOUND") return "missing";
		if (message === "PersistedQueryNotSupported" || extensions?.code === "PERSISTED_QUERY_NOT_SUPPORTED") {
			return "unsupported";
		}
	}

	return undefined;
}

/**
 * Extracts the message of a GraphQL error.
 *
 * @param error - A GraphQL error
 * @returns Its message
 */
function getMessage(error: { message: string }): string {
	return error.message;
}

/**
 * Formats an HTTP status line.
 *
 * @param response - The fetch Response
 * @returns E.g. `HTTP 500 Internal Server Error`
 */
function describeStatus(response: Response): string {
	return response.statusText ? `HTTP ${response.status} ${response.statusText}` : `HTTP ${response.status}`;
}
