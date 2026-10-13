import { ClientError, isClientError } from "./errors";
import { resolveRetryPolicy } from "./retry";
import { readServerSentEvents } from "./sse";
import type {
	CacheKey,
	ClientConfiguration,
	GraphQLFormattedError,
	GraphQLResponse,
	OperationContext,
	RequestOptions,
	SubscribeOptions,
} from "./types";
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
 * Lightweight, zero-dependency GraphQL client with caching, deduplication, retries, middleware,
 * persisted queries, SSE subscriptions, timeouts and typed errors.
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
	 * @param configuration - Configuration for the client
	 */
	constructor(private readonly configuration: ClientConfiguration) {}

	/**
	 * Executes a GraphQL query or mutation.
	 *
	 * Queries are served from the cache when available and deduplicated while in flight.
	 * Mutations always hit the network and are never cached unless `cache: true` is passed.
	 *
	 * @template TData - The shape of the `data` field in the response
	 * @template TVariables - The shape of the operation variables
	 * @param options - The request options
	 * @returns The `data` field of the GraphQL response
	 * @throws {ClientError} On a non-2xx status, GraphQL errors, an unparseable body or a missing `data` field
	 * @throws {DOMException} `AbortError` / `TimeoutError` when the request is aborted or times out
	 */
	async gql<TData = unknown, TVariables extends object = Record<string, unknown>>(
		options: RequestOptions<TData, TVariables>,
	): Promise<TData> {
		const { cache, dedupe = true } = this.configuration;
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const isQuery = operation.type === "query";
		const cacheKey = createCacheKey(options.key ?? [], query, options.variables, options.operationName);
		const useCache = cache !== undefined && (options.cache ?? isQuery);

		if (useCache) {
			const cached = await cache.get<TData>(cacheKey);

			if (cached !== undefined) {
				this.log(operation, "cache hit");
				return cached;
			}
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

		const request = this.execute<TData, TVariables>(query, options, operation, useCache ? cacheKey : undefined);

		if (!canDedupe) return request;

		this.inFlight.set(cacheKey, request);

		try {
			return await request;
		} finally {
			this.inFlight.delete(cacheKey);
		}
	}

	/**
	 * Streams an operation over Server-Sent Events (GraphQL over SSE, "distinct connections" mode).
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
	 * @yields Every `data` payload sent by the server
	 * @throws {ClientError} On a non-2xx status or when an event carries GraphQL errors
	 */
	async *subscribe<TData = unknown, TVariables extends object = Record<string, unknown>>(
		options: SubscribeOptions<TData, TVariables>,
	): AsyncGenerator<TData, void, undefined> {
		const query = String(options.query);
		const operation = parseOperation(query, options.operationName);
		const scope = createAbortScope(options.signal);
		const context: OperationContext = { ...operation, query, variables: options.variables, attempt: 0 };

		try {
			const headers = await this.createHeaders(options.headers);

			headers.set("Accept", "text/event-stream");

			const payload: Payload = { query, variables: options.variables, operationName: options.operationName };
			const response = await this.run(this.createRequest(payload, "POST", headers, scope.signal), context);
			const isStream = response.headers.get("Content-Type")?.includes("text/event-stream");

			if (!response.ok || !isStream || !response.body) {
				yield await this.parseResponse<TData>(response, scope.signal);
				return;
			}

			this.log(operation, "subscribed");

			for await (const event of readServerSentEvents(response.body)) {
				if (event.event === "complete") return;
				if ((event.event !== "next" && event.event !== "message") || !event.data) continue;

				const { data, errors } = JSON.parse(event.data) as GraphQLResponse<TData>;

				if (errors?.length) throw createGraphQLError(response, errors, data ?? undefined);
				if (data !== undefined && data !== null) yield data;
			}
		} finally {
			scope.abort();
			scope.dispose();
		}
	}

	/**
	 * Removes cached results. Keys are hierarchical: `invalidate(["user"])` drops `["user"]`, `["user", 1]`, etc.
	 * Calling it without arguments drops every result cached by this client.
	 *
	 * @param prefix - The cache key prefix to invalidate. Defaults to `[]` (everything).
	 * @returns The number of removed entries
	 */
	async invalidate(prefix: CacheKey = []): Promise<number> {
		const cache = this.configuration.cache;

		if (!cache) return 0;

		const keys = [...(await cache.keys())].filter(function belongsToPrefix(key: string): boolean {
			return matchesKeyPrefix(key, prefix);
		});

		await Promise.all(
			keys.map(function remove(key: string): unknown {
				return cache.delete(key);
			}),
		);

		return keys.length;
	}

	/**
	 * Creates a new client with the given configuration overrides. The cache instance is shared unless overridden,
	 * which makes it handy for per-request headers in SSR. Overrides replace values; they are not deep-merged.
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
	 * @param cacheKey - Key to store the result under, or `undefined` to skip caching
	 * @returns The `data` field of the GraphQL response
	 */
	private async execute<TData, TVariables>(
		query: string,
		options: RequestOptions<TData, TVariables>,
		operation: OperationInfo,
		cacheKey?: string,
	): Promise<TData> {
		const scope = createAbortScope(options.signal, options.timeout ?? this.configuration.timeout);
		const policy = resolveRetryPolicy(this.configuration.retry, options.retry);
		const startedAt = Date.now();

		try {
			for (let attempt = 0; ; attempt++) {
				const context: OperationContext = { ...operation, query, variables: options.variables, attempt };

				try {
					const data = await this.send<TData>(query, options, context, scope.signal);

					this.log(operation, `ok in ${Date.now() - startedAt}ms${attempt ? ` after ${attempt} retries` : ""}`);

					if (cacheKey !== undefined) {
						await this.configuration.cache?.set(cacheKey, data);
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
		const headers = await this.createHeaders(options.headers);
		const response = await this.run(this.createRequest(payload, method, headers, signal), context);

		return this.parseResponse<TData>(response, signal);
	}

	/**
	 * Creates the `Request`. GET requests carry the payload as search params and drop `Content-Type`
	 * so they stay CORS-simple and CDN-cacheable.
	 *
	 * @param payload - The GraphQL payload
	 * @param method - The HTTP method
	 * @param headers - The request headers
	 * @param signal - The abort signal
	 * @returns The request
	 */
	private createRequest(payload: Payload, method: "GET" | "POST", headers: Headers, signal: AbortSignal): Request {
		const { url } = this.configuration;

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
	 *
	 * @param requestHeaders - Headers for this call only
	 * @returns The merged headers
	 */
	private async createHeaders(requestHeaders?: HeadersInit): Promise<Headers> {
		const { authToken, headers } = this.configuration;
		const merged = new Headers({ "Content-Type": "application/json", Accept: ACCEPT });
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
		let body: GraphQLResponse<TData> | undefined;

		try {
			body = (await response.json()) as GraphQLResponse<TData>;
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
 * Creates the ClientError for a response carrying GraphQL errors.
 *
 * @param response - The fetch Response
 * @param errors - The GraphQL errors
 * @param data - Partial data, if any
 * @returns The error
 */
function createGraphQLError(response: Response, errors: ReadonlyArray<GraphQLFormattedError>, data: unknown): ClientError {
	const summary = errors.map(getMessage).join("; ");
	const message = response.ok ? summary : `${describeStatus(response)}: ${summary}`;

	return new ClientError(message, { status: response.status, response, errors, data });
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
