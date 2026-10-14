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
	Cache as CacheAdapter,
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
	HeadersLike,
	NoInference,
	WithVariables,
} from "./types";
import { containsFiles, createUploadBody } from "./upload";
import {
	createAbortScope,
	deepFreeze,
	createCacheKey,
	matchesKeyPrefix,
	parseOperation,
	resolveValue,
	sha256,
	raceAbort,
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
	/**
	 * Per-key lanes: every cache operation on a key (stores, optimistic renders and rollbacks, invalidation deletes,
	 * consistent reads) runs after the previous one settled. The cache and the live queries therefore always go
	 * through the same states in the same order, whatever order an async cache adapter completes calls in.
	 */
	lanes: Map<string, Lane>;
	/** Invalidations whose keys are still being listed or deleted */
	invalidating: Set<CacheKey>;
	/** While invalidations are in progress: sequence at which each key was last stored (newer data is kept) */
	stored: Map<string, number>;
	/**
	 * Keys whose cache entry could not be cleaned up (a failed delete, e.g. while rolling back an optimistic layer):
	 * what the cache holds for them is not trusted, they read as misses until a write or delete succeeds.
	 */
	untrusted: Set<string>;
}

/**
 * Serializes the cache operations of one key.
 */
interface Lane {
	/** Settles once every queued operation settled */
	tail: Promise<void>;
	/** Number of queued operations */
	size: number;
	/** Order of the newest data written by the lane */
	order: number;
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
	/** Order of the request (or write) that produced the base: `0` when it predates every pending operation */
	order: number;
}

/**
 * One pending optimistic update.
 */
interface OptimisticLayer {
	/** Computes the optimistic data from the data below it */
	update(current: unknown): unknown;
	/** Sequence when its operation started: real data requested later may already contain the operation's effect */
	since: number;
}

/**
 * Maximum number of invalidations remembered per cache.
 */
const INVALIDATION_LOG_SIZE = 64;

/**
 * State shared by every copy of the library loaded in the process (e.g. its ESM and CJS builds, or two bundled
 * copies), so clients sharing a cache always share notifications and ordering:
 * - `states`: shared state per cache (or per client when it has no cache);
 * - `sequence`: monotonic counter ordering requests, writes and invalidations across every client.
 */
const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("lumenql.shared")] ??= {
	states: new WeakMap(),
	sequence: 0,
}) as { states: WeakMap<object, SharedState>; sequence: number };

/**
 * Shared state per cache (or per client when it has no cache).
 */
const sharedStates = registry.states;

/**
 * Init of every Request the client built, so `fetch` can be called as `fetch(url, init)`: fetch implementations
 * other than the global one (node-fetch, cross-fetch, an npm `undici`) do not recognize the global Request class.
 */
const requestInits = new WeakMap<Request, RequestInit>();

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
			lanes: new Map(),
			invalidating: new Set(),
			stored: new Map(),
			untrusted: new Set(),
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
			const cached = await this.#read<TData>(cacheKey);

			if (cached !== undefined) {
				this.#log(operation, "cache hit");

				// Stale-while-revalidate: answer now, refresh the entry (and every live query) in the background.
				// Failures are reported through `onError` by the request itself.
				if (fetchPolicy === "cache-and-network") {
					const client = this;

					this.#request<TData, TVariables>(query, options, operation, cacheKey, "network-only", hasFiles).then(
						function invalidateAfterRefresh(): Promise<void> {
							return client.#applyInvalidates(options, {
								...operation,
								query,
								variables: options.variables,
								attempt: 0,
							});
						},
						ignoreError,
					);
				}

				// Adapters may hand out fresh objects (e.g. StorageCache parses JSON): results are always frozen.
				return deepFreeze(cached);
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

			// Only now: a refetch triggered by the invalidation must find the optimistic layers settled, or it would
			// bring data already containing the mutation under a layer applying it again.
			await this.#applyInvalidates(options, context);

			return data;
		} catch (error) {
			// A failing rollback is reported, but never masks the operation's error.
			try {
				await settle?.(false);
			} catch (settleError) {
				this.#report(settleError, context, options.signal);
			}

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
		// Never join a request older than an invalidation (issued through another client sharing the cache, it cannot
		// clear this client's map) or than data applied since (a write): its response will not be stored.
		const pending =
			flight &&
			!this.#invalidatedSince(cacheKey, flight.epoch) &&
			(this.#shared.applied.get(cacheKey) ?? 0) <= flight.epoch
				? flight.promise
				: undefined;

		if (pending) {
			this.#log(operation, "deduplicated");
			return pending as Promise<TData>;
		}

		const epoch = registry.sequence;
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
		// Whether an incremental (`@defer` / `@stream`) result is still expecting payloads.
		let incomplete = false;

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

				const pending = this.#run(this.#createRequest(request, "POST", headers, scope.signal), context);

				try {
					response = await raceAbort(pending, scope.signal);
				} catch (error) {
					// A response landing after the abort (fetch or middleware ignoring the signal) is never read: release it.
					pending.then(discardBody, ignoreError);
					throw error;
				}

				const contentType = response.headers.get("Content-Type") ?? "";
				// Media types are case-insensitive (the boundary value is not).
				const mediaType = contentType.toLowerCase();
				const chunks =
					!response.ok || !response.body
						? undefined
						: mediaType.includes("text/event-stream")
							? readServerSentEventData(response.body, scope.signal)
							: mediaType.includes("multipart/mixed")
								? readMultipartMixed(response.body, getBoundary(contentType), scope.signal)
								: undefined;

				if (!chunks) {
					yield await this.#parseResponse<TData>(response, scope.signal);
					return;
				}

				source = parseChunks(chunks, response);
			}

			this.#log(operation, "streaming");

			const state = createIncrementalState();
			let last: unknown;

			for await (const payload of source) {
				// Payloads already buffered when the consumer aborted are dropped.
				if (scope.signal.aborted) break;

				const { data, errors } = applyIncremental(state, payload);

				incomplete = state.hasNext;

				if (errors.length) throw createGraphQLError(response, errors, data);

				// A trailing `completed`/`hasNext: false` payload changes nothing: don't yield the same result twice.
				if (data !== undefined && data !== last) {
					last = data;
					yield data as TData;
				}
			}

			if (state.hasNext) {
				// An aborted incremental result never completes as if it succeeded with partial data.
				if (scope.signal.aborted) throw scope.signal.reason;

				throw incompleteError(response, state.data);
			}
		} catch (error) {
			// The caller stopping a stream ends it quietly (like breaking out of the loop), whatever the transport,
			// unless an incremental result would be left partial.
			if (scope.signal.aborted && !incomplete) return;

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
					const cache = client.#configuration.cache;

					// A superseded response is not stored: show what the entry holds now (optimistic layers included),
					// read in its lane, after the operations queued before.
					if (fetchPolicy !== "no-cache" && cache) {
						const cached = await client.#lane(cacheKey, async function read(): Promise<TData | undefined> {
							return client.#read<TData>(cacheKey);
						});

						if (cached !== undefined) return deepFreeze(cached);
					}

					// Pending optimistic layers stay visible on top of freshly fetched data.
					return client.#overlay(cacheKey, data);
				},
				merge(next: TData, merge: (current: TData, next: TData) => TData, since: number, expected: boolean) {
					const cache = client.#configuration.cache;
					// Ordered when queued: a write queued after the merge is newer, whenever the merge runs.
					const order = ++registry.sequence;

					// Read, merge and write in one step of the entry's lane: the pages are merged onto the newest real
					// data (under any optimistic layers), never onto a snapshot another write replaced meanwhile.
					return client.#lane(cacheKey, async function mergeInLane(): Promise<TData | undefined> {
						const entry = client.#shared.layers.get(cacheKey);
						const current = (entry ? entry.base : await client.#read(cacheKey)) as TData | undefined;

						// Invalidated since the page was requested (or the real data under optimistic layers was), or
						// expired while data was shown: the pages are no longer trusted, let a refetch win.
						if (
							client.#invalidatedSince(cacheKey, since) ||
							entry?.stale ||
							(current === undefined && expected && !entry)
						) {
							return undefined;
						}

						const merged = deepFreeze(current === undefined ? next : merge(current, next));

						// In-flight responses for the entry are now older than the merged pages.
						client.#supersede(cacheKey, order);

						return (await client.#write(cacheKey, merged, since, order)) ? merged : undefined;
					});
				},
				peek(): TData | undefined {
					if (!readsCache) return undefined;

					try {
						if (client.#shared.untrusted.has(cacheKey)) return undefined;

						return deepFreeze(syncValue(client.#configuration.cache?.get<TData>(cacheKey)));
					} catch {
						// A cache failing synchronously (e.g. Web Storage throwing) is a miss, like a rejected read.
						return undefined;
					}
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
				fetchMore(variables: Partial<TVariables> | undefined): Promise<TData> {
					return client.gql<TData, TVariables>({
						...options,
						variables: { ...options.variables, ...variables } as TVariables,
						fetchPolicy: "no-cache",
						invalidates: undefined,
					});
				},
				real(visible: TData | undefined): TData | undefined {
					return client.#real(cacheKey, visible);
				},
				overlay(data: TData): TData {
					return client.#overlay(cacheKey, data);
				},
				report(error: unknown): void {
					const context = { ...parseOperation(query, options.operationName), query, variables: options.variables };

					if (client.#configuration.onError) client.#report(error, { ...context, attempt: 0 }, undefined);
					else console.error(error);
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
		target: WithVariables<CacheTarget<TData, TVariables>, TVariables>,
	): Promise<TData | undefined> {
		return this.#read<TData>(this.#getCacheKey(target));
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
		target: WithVariables<CacheTarget<TData, TVariables>, TVariables>,
		data: NoInference<TData>,
	): Promise<void> {
		const cacheKey = this.#getCacheKey(target);

		const order = ++registry.sequence;

		// In-flight responses for this entry are now older than the written data.
		this.#supersede(cacheKey, order);
		await this.#store(cacheKey, data, order);
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
			const data = entry ? (entry.stale ? undefined : entry.base) : await this.#read(key);

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
		for (const [key, data] of Object.entries(snapshot)) {
			const order = ++registry.sequence;

			// Like `write`: in-flight responses for the entry are now older than the restored data.
			this.#supersede(key, order);
			await this.#store(key, data, order);
		}
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
		const shared = this.#shared;
		const inFlight = this.#inFlight;
		const epoch = ++registry.sequence;

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

		// Read after recording the invalidation: a response landing meanwhile is already superseded.
		const client = this;
		let removed = 0;
		let failure: { error: unknown } | undefined;

		shared.invalidating.add(prefix);

		/**
		 * Deletes one key in its lane, unless data was stored for it after the invalidation was issued.
		 *
		 * @param key - The cache key
		 * @returns Settles once deleted (or kept)
		 */
		function remove(key: string): Promise<void> {
			return client.#lane(key, async function deleteKey(): Promise<void> {
				if ((shared.stored.get(key) ?? -1) >= epoch) return;

				await client.#drop(key);
				removed++;
			});
		}

		try {
			const keys = cache ? [...(await cache.keys())].filter(belongsTo(prefix)) : [];

			for (const result of await Promise.allSettled(keys.map(remove))) {
				if (result.status === "rejected") failure ??= { error: result.reason };
			}
		} catch (error) {
			failure = { error };
		} finally {
			shared.invalidating.delete(prefix);

			if (shared.invalidating.size === 0) shared.stored.clear();
		}

		// Live queries refetch even when the cache failed to drop their entries.
		for (const [key, watchers] of shared.watchers) {
			if (!matchesKeyPrefix(key, prefix)) continue;

			for (const watcher of [...watchers]) watcher.invalidate();
		}

		if (failure) throw failure.error;

		return removed;
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
	 * Applies the `invalidates` prefixes of a successful operation. Each prefix is applied even when another one
	 * fails; failures are reported, never turned into a rejection (the server already applied the operation).
	 *
	 * @param options - The request options
	 * @param context - The operation metadata
	 */
	async #applyInvalidates(
		options: Pick<RequestOptions<unknown, unknown>, "invalidates" | "signal">,
		context: OperationContext,
	): Promise<void> {
		for (const prefix of options.invalidates ?? []) {
			try {
				await this.invalidate(prefix);
			} catch (error) {
				this.#report(error, context, options.signal);
			}
		}
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
				let data: TData;

				try {
					// Raced against the signal: a stalled middleware, header resolver or body must not outlive the timeout.
					data = deepFreeze(
						await raceAbort(this.#send<TData>(query, options, context, scope.signal), scope.signal),
					);
				} catch (error) {
					if (scope.signal.aborted || !policy || attempt >= policy.attempts || !policy.retryIf(error, context)) {
						this.#report(error, context, options.signal);
						throw error;
					}

					const delay = policy.delay(attempt, error);

					this.#log(operation, `retry ${attempt + 1}/${policy.attempts} in ${Math.round(delay)}ms`);

					try {
						await sleep(delay, scope.signal);
					} catch (sleepError) {
						this.#report(sleepError, context, options.signal);
						throw sleepError;
					}

					continue;
				}

				this.#log(operation, `ok in ${Date.now() - startedAt}ms${attempt ? ` after ${attempt} retries` : ""}`);

				// The request succeeded: a failing cache is reported, never retried nor turned into a rejection (a
				// mutation the server applied must not look failed and invite a non-idempotent retry).
				try {
					if (writesCache && this.#supersede(cacheKey, order)) await this.#store(cacheKey, data, order);
				} catch (error) {
					this.#report(error, context, options.signal);
				}

				return data;
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

			return built(url, { method: "POST", headers, body: upload, signal });
		}

		if (method === "POST") {
			return built(url, { method, headers, body: JSON.stringify(payload), signal });
		}

		const params = new URLSearchParams();

		for (const [name, value] of Object.entries(payload)) {
			if (value !== undefined) params.set(name, typeof value === "string" ? value : JSON.stringify(value));
		}

		headers.delete("Content-Type");

		// Params go before any `#fragment` (never sent to the server).
		const [base = url] = url.split("#", 1);

		return built(`${base}${base.includes("?") ? "&" : "?"}${params}`, { method, headers, signal });
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

			if (!handler) {
				const init = requestInits.get(current);

				// Requests the client built go out as `fetch(url, init)`, the call every fetch implementation supports
				// (node-fetch, cross-fetch, an npm `undici` with a proxy agent...), with the request's live headers.
				// The body comes from the init, so middleware may read the request or call `next()` again.
				if (init) {
					const headers = new Headers(current.headers);

					// The Request added a multipart boundary for its own serialization of the FormData: fetch serializes
					// the body again, with a new boundary, so it must set the header itself.
					if (typeof FormData !== "undefined" && init.body instanceof FormData) headers.delete("Content-Type");

					return fetchFn(current.url, { ...init, method: current.method, headers, signal: current.signal }).catch(
						rethrowNetworkFailure,
					);
				}

				// A request built by middleware is passed as is. `fetch` consumes the body: a clone lets middleware
				// call `next()` again. Cloning a consumed request throws: that deterministic error is never mistaken
				// for a network failure.
				try {
					// Some polyfilled Request classes cannot clone: send the request itself then.
					if (typeof current.clone === "function") current = current.clone();
				} catch (error) {
					return Promise.reject(error);
				}

				return fetchFn(current).catch(rethrowNetworkFailure);
			}

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
	async #createHeaders(query: string, requestHeaders?: HeadersLike): Promise<Headers> {
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
				response.ok && response.body && contentType.toLowerCase().includes("multipart/mixed")
					? await collectIncremental<TData>(response.body, getBoundary(contentType), signal)
					: ((await response.json()) as GraphQLResponse<TData>);
		} catch (cause) {
			// Abort/timeout during body streaming must surface as-is, not as a parse error.
			if (signal?.aborted) throw cause;

			// A body failing mid-read (connection reset) is a network failure, retryable like one.
			if (!(cause instanceof SyntaxError)) rethrowNetworkFailure(cause);

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
			const touched = new Map<string, OptimisticEntry>();
			let failure: { error: unknown } | undefined;

			// Every layer is removed first (synchronously): a cache failing while rendering one entry must never
			// strand the operation's other layers.
			for (const { cacheKey, layer } of applied.splice(0).reverse()) {
				const entry = layers.get(cacheKey);
				const index = entry ? entry.layers.indexOf(layer) : -1;

				if (!entry || index === -1) continue;

				entry.layers.splice(index, 1);

				// The operation succeeded: fold its layer into the real data, unless that data may already contain the
				// effect (requested after the operation was sent: folding would apply it twice) or is unknown (never
				// cached, or invalidated: a placeholder must never become real data, the refetch brings the truth).
				if (commit && !entry.stale && entry.base !== undefined && entry.order < layer.since) {
					entry.base = deepFreeze(applyLayer(entry.base, layer));
				}

				// The entry stays registered until its rollback ran in the lane: stores queued meanwhile must keep
				// updating its base, or the rollback would render data older than theirs.
				touched.set(cacheKey, entry);
			}

			for (const [cacheKey, entry] of touched) {
				try {
					await client.#lane(cacheKey, function rollBack(): Promise<void> {
						return client.#settleEntry(cacheKey, entry);
					});
				} catch (error) {
					failure ??= { error };
				}
			}

			if (failure) throw failure.error;
		}

		/**
		 * Applies one optimistic update in its entry's lane: reading the real data, registering the layer and rendering
		 * it are one step no store, rollback or invalidation delete of the entry can interleave with.
		 *
		 * @param cacheKey - The serialized cache key
		 * @param update - The optimistic update
		 * @param since - The sequence when the operation started
		 */
		async function apply(cacheKey: string, update: OptimisticLayer["update"], since: number): Promise<void> {
			const cache = client.#configuration.cache;
			let entry = layers.get(cacheKey);

			if (!entry) {
				// With a cache, a miss means there is no real data: never adopt a live query's (possibly no-cache or
				// invalidated) data as the base, it would be written to the cache when the layer settles. Without a
				// cache, live queries showing the entry hold its current data.
				const base = cache ? await client.#read(cacheKey) : client.#peekWatchers(cacheKey);
				// Data read while (or before) an invalidation of the entry is deleted is no longer real: wait for the
				// refetch instead of ever writing it back.
				const stale = client.#isInvalidating(cacheKey) || client.#invalidatedSince(cacheKey, since);

				// Data cached before the operation started cannot contain its effect (order `0`).
				entry = { base: stale ? undefined : deepFreeze(base), layers: [], stale, order: 0 };
			}

			const layer: OptimisticLayer = { update, since };

			// Validate the update before registering anything, so a throwing update leaves nothing behind.
			update(entry.layers.reduce(applyLayer, entry.base));
			layers.set(cacheKey, entry);
			entry.layers.push(layer);
			applied.push({ cacheKey, layer });
			await client.#render(cacheKey, entry);
		}

		try {
			const since = registry.sequence;

			for (const { target, update } of updates) {
				const cacheKey = this.#getCacheKey(target);

				await this.#lane(cacheKey, function applyLayerInLane(): Promise<void> {
					return apply(cacheKey, update, since);
				});
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
	 * @param order - The order of the response or write: older data than the lane already wrote is dropped
	 */
	#store(cacheKey: string, data: unknown, order: number): Promise<void> {
		const client = this;
		const epoch = registry.sequence;

		deepFreeze(data);

		return this.#lane(cacheKey, function store(): Promise<boolean> {
			return client.#write(cacheKey, data, epoch, order);
		}).then(ignoreError);
	}

	/**
	 * Stores real data for an entry, in its lane.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param data - The (frozen) real data
	 * @param epoch - The sequence when the data was issued: an invalidation after it drops the data
	 * @param order - The order of the response or write
	 * @returns Whether the data was stored
	 */
	async #write(cacheKey: string, data: unknown, epoch: number, order: number): Promise<boolean> {
		const cache = this.#configuration.cache;
		const entry = this.#shared.layers.get(cacheKey);
		const lane = this.#shared.lanes.get(cacheKey)!;

		// Invalidated after this store was issued: the data it carries is outdated, the refetch brings the truth.
		if (this.#invalidatedSince(cacheKey, epoch)) return false;

		// Queued before newer data (e.g. a response that passed its ordering check before a merge took a newer order)
		// that the lane already wrote: older data never overwrites it.
		if (order < lane.order) return false;

		lane.order = order;

		if (entry) {
			entry.base = data;
			entry.stale = false;
			entry.order = order;
			await this.#render(cacheKey, entry);
			this.#landed(cacheKey, epoch);
			return true;
		}

		await this.#put(cacheKey, data);

		// Invalidated while a slow cache was writing (possibly after the invalidation listed the keys).
		if (cache && this.#invalidatedSince(cacheKey, epoch)) {
			await this.#drop(cacheKey);
			return false;
		}

		this.#landed(cacheKey, epoch);
		this.#notify(cacheKey, data);
		return true;
	}

	/**
	 * Records that newer data landed for a key while invalidations are listing keys, so they keep it.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param epoch - The sequence when the data was issued
	 */
	#landed(cacheKey: string, epoch: number): void {
		const { invalidating, stored } = this.#shared;

		if (invalidating.size > 0) stored.set(cacheKey, Math.max(stored.get(cacheKey) ?? -1, epoch));
	}

	/**
	 * Runs a cache operation in its key's lane, once every previously queued operation on the key settled.
	 * Operations running in a lane must never queue (and await) another operation on the same key.
	 *
	 * @template T - The result type
	 * @param cacheKey - The serialized cache key
	 * @param operation - The operation
	 * @returns The operation's result
	 */
	#lane<T>(cacheKey: string, operation: () => Promise<T>): Promise<T> {
		const { lanes } = this.#shared;
		const lane = lanes.get(cacheKey) ?? { tail: Promise.resolve(), size: 0, order: 0 };
		const result = lane.tail.then(operation);

		lane.size++;
		lane.tail = result.then(ignoreError, ignoreError).then(function release(): void {
			if (--lane.size === 0 && lanes.get(cacheKey) === lane) lanes.delete(cacheKey);
		});
		lanes.set(cacheKey, lane);

		return result;
	}

	/**
	 * Writes a value to the cache. A failed write drops the entry (best effort): the cache must never keep serving
	 * the previous value, e.g. an optimistic layer being rolled back.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param value - The value
	 */
	async #put(cacheKey: string, value: unknown): Promise<void> {
		const cache = this.#configuration.cache;

		try {
			await cache?.set(cacheKey, value);
			this.#shared.untrusted.delete(cacheKey);
		} catch (error) {
			// Best effort; when even that fails, the key reads as a miss until a write to it succeeds.
			await this.#drop(cacheKey).catch(ignoreError);

			throw error;
		}
	}

	/**
	 * Reads a cache entry. Keys whose cleanup failed read as misses: the cache may still hold data the client meant
	 * to remove (e.g. a rolled-back optimistic layer).
	 *
	 * @template T - The value type
	 * @param cacheKey - The serialized cache key
	 * @returns The cached value
	 */
	async #read<T>(cacheKey: string): Promise<T | undefined> {
		if (this.#shared.untrusted.has(cacheKey)) return undefined;

		return this.#configuration.cache?.get<T>(cacheKey);
	}

	/**
	 * Deletes a cache entry. A failed delete leaves the key untrusted (read as a miss) until a write or delete of it
	 * succeeds.
	 *
	 * @param cacheKey - The serialized cache key
	 */
	async #drop(cacheKey: string): Promise<void> {
		const { untrusted } = this.#shared;

		try {
			await this.#configuration.cache?.delete(cacheKey);
			untrusted.delete(cacheKey);
		} catch (error) {
			untrusted.add(cacheKey);
			throw error;
		}
	}

	/**
	 * Shows an entry's state once optimistic layers were removed from it (in its lane).
	 *
	 * @param cacheKey - The serialized cache key
	 * @param entry - The optimistic entry
	 */
	async #settleEntry(cacheKey: string, entry: OptimisticEntry): Promise<void> {
		const { layers } = this.#shared;

		// Another settlement already showed this entry's final state and handed it back to the cache: rendering the
		// detached entry again would overwrite whatever was stored since.
		if (layers.get(cacheKey) !== entry) return;

		// Whether this rollback shows the entry's final state (another settlement may empty it while this one renders:
		// that one then shows the final state).
		const final = entry.layers.length === 0;

		try {
			await this.#showSettled(cacheKey, entry);
		} finally {
			// Unless a new layer was applied meanwhile, the entry holds real data only: the cache takes over.
			if (final && entry.layers.length === 0 && layers.get(cacheKey) === entry) layers.delete(cacheKey);
		}
	}

	/**
	 * Renders (or retracts) an entry whose layers were just removed.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param entry - The optimistic entry
	 */
	async #showSettled(cacheKey: string, entry: OptimisticEntry): Promise<void> {
		// An invalidated entry is never rendered into the cache: show live queries the real data they fell back on
		// (without the removed layers), then let them refetch, joining a refetch already in flight.
		if (entry.stale) {
			this.#retract(cacheKey, entry.layers.reduce(applyLayer, entry.base), true);
			return;
		}

		if (entry.layers.length > 0) {
			await this.#render(cacheKey, entry);
			return;
		}

		// The last layer is gone: restore the real data. If the entry expired meanwhile, only live queries get it
		// back (they would otherwise keep showing the removed layer); nothing is written to the cache.
		const cache = this.#configuration.cache;
		const expired = cache !== undefined && (await this.#read(cacheKey)) === undefined;

		if (expired) this.#retract(cacheKey, entry.base, entry.base === undefined);
		else await this.#render(cacheKey, entry);
	}

	/**
	 * Whether an invalidation covering a key is still listing or deleting keys.
	 *
	 * @param cacheKey - The serialized cache key
	 * @returns `true` while such an invalidation is in progress
	 */
	#isInvalidating(cacheKey: string): boolean {
		for (const prefix of this.#shared.invalidating) if (matchesKeyPrefix(cacheKey, prefix)) return true;

		return false;
	}

	/**
	 * Writes an entry's visible data (base plus optimistic layers) without superseding in-flight real responses,
	 * which keep updating the base. An entry left without any data is dropped and its watchers refetch.
	 * Runs in the entry's lane.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param entry - The optimistic entry
	 */
	async #render(cacheKey: string, entry: OptimisticEntry): Promise<void> {
		// An invalidated entry waits for real data: its watchers are already refetching.
		if (entry.stale) return;

		const visible = deepFreeze(entry.layers.reduce(applyLayer, entry.base));

		if (visible === undefined) {
			await this.#drop(cacheKey);
			this.#retract(cacheKey, undefined, true);

			return;
		}

		await this.#put(cacheKey, visible);

		// Invalidated while the cache was writing: the invalidation may have listed the keys before this write landed.
		if (entry.stale) {
			await this.#drop(cacheKey);
			return;
		}

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
		deepFreeze(data);

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
		return deepFreeze(entry ? (entry.layers.reduce(applyLayer, data) as TData) : data);
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

		return ++registry.sequence;
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
		return registry.sequence;
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
 * @param response - The response they come from
 * @yields The parsed payloads
 */
async function* parseChunks(chunks: AsyncIterable<string>, response: Response): AsyncGenerator<IncrementalPayload> {
	for await (const chunk of chunks) {
		let payload: IncrementalPayload;

		try {
			payload = JSON.parse(chunk) as IncrementalPayload;
		} catch (cause) {
			throw new ClientError("Invalid JSON in the GraphQL response.", { status: response.status, response, cause });
		}

		yield payload;
	}
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
	if (signal?.aborted) throw signal.reason;

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

/**
 * Returns a cache read when it is synchronous. A pending (possibly rejecting) async read is discarded safely.
 * Thenables are detected structurally: a promise from another realm (iframe, `vm`) is not an `instanceof Promise`.
 *
 * @template T - The value type
 * @param value - The cache read
 * @returns The value, or `undefined` for an async read
 */
function syncValue<T>(value: T | Promise<T> | undefined): T | undefined {
	if (typeof (value as { then?: unknown } | undefined)?.then !== "function") return value as T | undefined;

	Promise.resolve(value).catch(ignoreError);

	return undefined;
}

/**
 * Cancels the body of a response that will never be read, releasing its connection.
 *
 * @param response - The unwanted response
 */
function discardBody(response: Response): void {
	response.body?.cancel().catch(ignoreError);
}

/**
 * Creates a Request and remembers its init.
 *
 * @param url - The URL
 * @param init - The init
 * @returns The request
 */
function built(url: string, init: RequestInit): Request {
	const request = new Request(url, init);

	requestInits.set(request, init);

	return request;
}
