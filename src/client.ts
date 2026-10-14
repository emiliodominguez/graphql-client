import { ClientError, isClientError } from "./errors";
import {
	applyIncremental,
	createIncrementalState,
	getBoundary,
	INCREMENTAL_DIRECTIVE,
	MULTIPART_ACCEPT,
	readMultipartMixed,
	type IncrementalPayload,
	type IncrementalState,
} from "./incremental";
import { QueryRef, type QueryWatcher } from "./query-ref";
import { resolveRetryPolicy } from "./retry";
import { readServerSentEvents } from "./sse";
import type {
	CacheKey,
	CacheTarget,
	ClientConfiguration,
	FetchPolicy,
	GraphQLFormattedError,
	GraphQLResponse,
	OperationContext,
	RequestOptions,
	SubscribeOptions,
	WatchOptions,
} from "./types";
import { createUploadBody } from "./upload";
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
	query?: string;
	variables?: unknown;
	operationName?: string;
	extensions?: Record<string, unknown>;
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
	/**
	 * Latest request sequence per cache key: a response superseded by a newer request for the same key
	 * neither overwrites the cache nor notifies watchers (last request wins).
	 */
	latest: Map<string, number>;
}

/**
 * Shared state per cache (or per client when it has no cache).
 */
const sharedStates = new WeakMap<object, SharedState>();

/**
 * Monotonic request counter feeding {@link SharedState.latest}.
 */
let requestSequence = 0;

/**
 * Returns the shared state of a cache, creating it on first use.
 *
 * @param owner - The cache, or the client itself when uncached
 * @returns The shared state
 */
function getSharedState(owner: object): SharedState {
	let state = sharedStates.get(owner);

	if (!state) {
		state = { watchers: new Map(), latest: new Map() };
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
	private readonly inFlight = new Map<string, Promise<unknown>>();

	/**
	 * Memoized persisted-query hashes, keyed by document.
	 */
	private readonly hashes = new Map<string, Promise<string>>();

	/**
	 * Flipped off when the server reports it does not support persisted queries.
	 */
	private persistedQueriesSupported = true;

	/**
	 * Watchers and request ordering, shared by every client using the same cache (see {@link Client.extend}).
	 */
	private readonly shared: SharedState;

	/**
	 * @param configuration - Configuration for the client
	 */
	constructor(private readonly configuration: ClientConfiguration) {
		this.shared = getSharedState(configuration.cache ?? this);
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
		options: RequestOptions<TData, TVariables>,
	): Promise<TData> {
		const { cache, dedupe = true } = this.configuration;
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const isQuery = operation.type === "query";
		const cacheKey = createCacheKey(options.key ?? [], query, options.variables, options.operationName);
		const fetchPolicy = options.fetchPolicy ?? (isQuery ? "cache-first" : "no-cache");
		const readsCache = fetchPolicy === "cache-first" || fetchPolicy === "cache-only";

		if (cache && readsCache) {
			const cached = await cache.get<TData>(cacheKey);

			if (cached !== undefined) {
				this.log(operation, "cache hit");
				return cached;
			}
		}

		if (fetchPolicy === "cache-only") {
			throw new Error(`No cached data for ${operation.type} ${operation.name ?? "(anonymous)"} (cache-only).`);
		}

		// Calls carrying their own signal, headers, timeout or retry policy may legitimately diverge,
		// so they never share a request.
		const canDedupe =
			dedupe &&
			isQuery &&
			!options.signal &&
			!options.headers &&
			options.timeout === undefined &&
			options.retry === undefined;
		const pending = canDedupe ? this.inFlight.get(cacheKey) : undefined;

		if (pending) {
			this.log(operation, "deduplicated");
			return pending as Promise<TData>;
		}

		const request = this.execute<TData, TVariables>(query, options, operation, cacheKey, fetchPolicy !== "no-cache");

		if (!canDedupe) return request;

		this.inFlight.set(cacheKey, request);

		try {
			return await request;
		} finally {
			this.inFlight.delete(cacheKey);
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
		options: SubscribeOptions<TData, TVariables>,
	): AsyncGenerator<TData, void, undefined> {
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const scope = createAbortScope(options.signal);
		const context: OperationContext = { ...operation, query, variables: options.variables, attempt: 0 };

		try {
			const { subscriptionTransport } = this.configuration;
			const request = { query, variables: options.variables, operationName: options.operationName };
			let response: Response | undefined;
			let source: AsyncIterable<IncrementalPayload> | undefined;

			if (subscriptionTransport && operation.type === "subscription") {
				source = subscriptionTransport.subscribe(request, scope.signal);
			} else {
				const headers = await this.createHeaders(query, options.headers);

				headers.set(
					"Accept",
					INCREMENTAL_DIRECTIVE.test(query) ? `text/event-stream, ${MULTIPART_ACCEPT}` : "text/event-stream",
				);

				response = await this.run(this.createRequest(request, "POST", headers, scope.signal), context);

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
					yield await this.parseResponse<TData>(response, scope.signal);
					return;
				}

				source = parseChunks(chunks);
			}

			this.log(operation, "streaming");

			const state = createIncrementalState();

			for await (const payload of source) {
				const { data, errors } = applyIncremental(state, payload);

				if (errors.length) throw createGraphQLError(response, errors, data);
				if (data !== undefined) yield data as TData;
			}
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
		options: WatchOptions<TData, TVariables>,
	): QueryRef<TData, TVariables> {
		const client = this;
		const query = String(options.query);
		const cacheKey = createCacheKey(options.key ?? [], query, options.variables, options.operationName);
		const readsCache =
			options.fetchPolicy === undefined ||
			options.fetchPolicy === "cache-first" ||
			options.fetchPolicy === "cache-only";

		return new QueryRef<TData, TVariables>(
			{
				fetch(fetchPolicy: FetchPolicy): Promise<TData> {
					return client.gql<TData, TVariables>({ ...options, fetchPolicy });
				},
				peek(): TData | undefined {
					const cached = readsCache ? client.configuration.cache?.get<TData>(cacheKey) : undefined;

					return cached instanceof Promise ? undefined : cached;
				},
				hasCache(): boolean {
					return client.configuration.cache !== undefined;
				},
				register(watcher: QueryWatcher<TData>): () => void {
					return client.register(cacheKey, watcher as QueryWatcher<unknown>);
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
		return this.configuration.cache?.get<TData>(this.getCacheKey(target));
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
		const cacheKey = this.getCacheKey(target);

		await this.configuration.cache?.set(cacheKey, data);
		this.notify(cacheKey, data);
	}

	/**
	 * Serializes every result cached by this client, e.g. to hydrate a browser client after SSR.
	 *
	 * @returns A JSON-serializable snapshot
	 */
	async extract(): Promise<Record<string, unknown>> {
		const cache = this.configuration.cache;
		const snapshot: Record<string, unknown> = {};

		if (!cache) return snapshot;

		for (const key of await cache.keys()) {
			if (!matchesKeyPrefix(key, [])) continue;

			const data = await cache.get(key);

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
			await this.configuration.cache?.set(key, data);
			this.notify(key, data);
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
		const cache = this.configuration.cache;
		const keys = cache ? [...(await cache.keys())].filter(belongsTo(prefix)) : [];

		await Promise.all(
			keys.map(function remove(key: string): unknown {
				return cache?.delete(key);
			}),
		);

		for (const [key, watchers] of this.shared.watchers) {
			if (!matchesKeyPrefix(key, prefix)) continue;

			for (const watcher of [...watchers]) watcher.invalidate();
		}

		return keys.length;
	}

	/**
	 * Creates a new client with the given configuration overrides. The cache instance is shared unless overridden,
	 * which makes it handy for per-request headers in SSR. Clients sharing a cache also share live-query
	 * notifications and request ordering. Overrides replace values; they are not deep-merged.
	 *
	 * @param overrides - Configuration values to replace
	 * @returns A new client
	 */
	extend(overrides: Partial<ClientConfiguration>): Client {
		return new Client({ ...this.configuration, ...overrides });
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
	private async execute<TData, TVariables>(
		query: string,
		options: RequestOptions<TData, TVariables>,
		operation: OperationInfo,
		cacheKey: string,
		writesCache: boolean,
	): Promise<TData> {
		const scope = createAbortScope(options.signal, options.timeout ?? this.configuration.timeout);
		const policy = resolveRetryPolicy(this.configuration.retry, options.retry);
		const startedAt = Date.now();
		const { latest } = this.shared;
		const sequence = ++requestSequence;

		latest.set(cacheKey, sequence);

		try {
			for (let attempt = 0; ; attempt++) {
				const context: OperationContext = { ...operation, query, variables: options.variables, attempt };

				try {
					const data = await this.send<TData>(query, options, context, scope.signal);

					this.log(operation, `ok in ${Date.now() - startedAt}ms${attempt ? ` after ${attempt} retries` : ""}`);

					if (latest.get(cacheKey) === sequence) {
						latest.delete(cacheKey);

						if (writesCache) await this.configuration.cache?.set(cacheKey, data);

						this.notify(cacheKey, data);
					}

					for (const prefix of options.invalidates ?? []) {
						await this.invalidate(prefix);
					}

					return data;
				} catch (error) {
					if (scope.signal.aborted || !policy || attempt >= policy.attempts || !policy.retryIf(error, context)) {
						throw error;
					}

					const delay = policy.delay(attempt, error);

					this.log(operation, `retry ${attempt + 1}/${policy.attempts} in ${Math.round(delay)}ms`);

					await sleep(delay, scope.signal);
				}
			}
		} finally {
			scope.dispose();

			if (latest.get(cacheKey) === sequence) latest.delete(cacheKey);
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
	private async send<TData>(
		query: string,
		options: TransportOptions,
		context: OperationContext,
		signal: AbortSignal,
	): Promise<TData> {
		const { variables, operationName } = options;
		const method = context.type === "query" ? (this.configuration.method ?? "POST") : "POST";
		const hash =
			this.configuration.persistedQueries && this.persistedQueriesSupported ? await this.hash(query) : undefined;
		const extensions = hash === undefined ? undefined : { persistedQuery: { version: 1, sha256Hash: hash } };

		if (extensions) {
			try {
				return await this.dispatch<TData>(
					{ variables, operationName, extensions },
					method,
					options,
					context,
					signal,
				);
			} catch (error) {
				const miss = getPersistedQueryMiss(error);

				if (!miss) throw error;

				if (miss === "unsupported") {
					this.persistedQueriesSupported = false;
				}

				const payload = {
					query,
					variables,
					operationName,
					extensions: miss === "unsupported" ? undefined : extensions,
				};

				return this.dispatch<TData>(payload, method, options, context, signal);
			}
		}

		return this.dispatch<TData>({ query, variables, operationName }, method, options, context, signal);
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
	private async dispatch<TData>(
		payload: Payload,
		method: "GET" | "POST",
		options: TransportOptions,
		context: OperationContext,
		signal: AbortSignal,
	): Promise<TData> {
		const headers = await this.createHeaders(context.query, options.headers);
		const response = await this.run(this.createRequest(payload, method, headers, signal), context);

		return this.parseResponse<TData>(response, signal);
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
	private createRequest(payload: Payload, method: "GET" | "POST", headers: Headers, signal: AbortSignal): Request {
		const { url } = this.configuration;
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

		return new Request(`${url}${url.includes("?") ? "&" : "?"}${params}`, { method, headers, signal });
	}

	/**
	 * Runs a request through the middleware chain, ending with `fetch`.
	 *
	 * @param request - The request
	 * @param context - The operation metadata
	 * @returns The response
	 */
	private run(request: Request, context: OperationContext): Promise<Response> {
		const middleware = this.configuration.middleware ?? [];
		const fetchFn = this.configuration.fetch ?? globalThis.fetch;

		/**
		 * Invokes the middleware at `index`, or `fetch` past the end of the chain.
		 *
		 * @param index - Middleware index
		 * @param current - The request at this point of the chain
		 * @returns The response
		 */
		function call(index: number, current: Request): Promise<Response> {
			const handler = middleware[index];

			if (!handler) return fetchFn(current);

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
	private hash(query: string): Promise<string> {
		let hash = this.hashes.get(query);

		if (!hash) {
			const options = this.configuration.persistedQueries;
			const custom = typeof options === "object" ? options.hash : undefined;

			hash = Promise.resolve(custom ? custom(query) : sha256(query));
			this.hashes.set(query, hash);
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
	private async createHeaders(query: string, requestHeaders?: HeadersInit): Promise<Headers> {
		const { authToken, headers } = this.configuration;
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
	private async parseResponse<TData>(response: Response, signal?: AbortSignal): Promise<TData> {
		const { status } = response;
		const contentType = response.headers.get("Content-Type") ?? "";
		let body: GraphQLResponse<TData> | undefined;

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

		const errors = body?.errors;
		const data = body?.data ?? undefined;

		if (errors?.length) throw createGraphQLError(response, errors, data);

		if (!response.ok) {
			throw new ClientError(describeStatus(response), { status, response, data });
		}

		if (data === undefined) {
			throw new ClientError("No data found in the GraphQL response.", { status, response });
		}

		return data;
	}

	/**
	 * Registers a watcher for a cache key.
	 *
	 * @param cacheKey - The serialized cache key
	 * @param watcher - The watcher
	 * @returns The unregister function
	 */
	private register(cacheKey: string, watcher: QueryWatcher<unknown>): () => void {
		const { watchers } = this.shared;
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
	private notify(cacheKey: string, data: unknown): void {
		for (const watcher of [...(this.shared.watchers.get(cacheKey) ?? [])]) watcher.receive(data);
	}

	/**
	 * Computes the cache key of a read/write target.
	 *
	 * @template TData - The shape of the `data` field
	 * @template TVariables - The shape of the operation variables
	 * @param target - The target
	 * @returns The serialized cache key
	 */
	private getCacheKey<TData, TVariables>(target: CacheTarget<TData, TVariables>): string {
		return createCacheKey(target.key ?? [], String(target.query), target.variables, target.operationName);
	}

	/**
	 * Logs an operation event when debugging is enabled.
	 *
	 * @param operation - The parsed operation info
	 * @param detail - What happened
	 */
	private log(operation: OperationInfo, detail: string): void {
		if (!this.configuration.debug) return;

		console.debug(`[graphql-client] ${operation.type} ${operation.name ?? "(anonymous)"} → ${detail}`);
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
 * Consumes a whole `multipart/mixed` incremental response and returns the merged result.
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
): Promise<GraphQLResponse<TData>> {
	const state: IncrementalState = createIncrementalState();

	for await (const chunk of readMultipartMixed(body, boundary, signal)) {
		applyIncremental(state, JSON.parse(chunk) as IncrementalPayload);
	}

	return { data: state.data as TData | undefined, errors: state.errors.length ? state.errors : undefined };
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
