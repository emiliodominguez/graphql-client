import { ClientError } from "./errors";
import type { CacheKey, ClientConfiguration, GraphQLResponse, RequestOptions } from "./types";
import {
	createAbortScope,
	createCacheKey,
	matchesKeyPrefix,
	parseOperation,
	resolveValue,
	type OperationInfo,
} from "./utils";

/**
 * Accepted media types, preferring the GraphQL-over-HTTP response type.
 */
const ACCEPT = "application/graphql-response+json, application/json;q=0.9";

/**
 * Lightweight, zero-dependency GraphQL client with caching, in-flight deduplication, timeouts and typed errors.
 */
export class Client {
	/**
	 * Pending queries keyed by their cache key, shared by identical concurrent calls.
	 */
	private readonly inFlight = new Map<string, Promise<unknown>>();

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

		// Calls carrying their own signal, headers or timeout may legitimately diverge, so they never share a request.
		const canDedupe = dedupe && isQuery && !options.signal && !options.headers && options.timeout === undefined;
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
	 * Performs the network request, validates the response and populates the cache.
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
		const fetchFn = this.configuration.fetch ?? globalThis.fetch;
		const scope = createAbortScope(options.signal, options.timeout ?? this.configuration.timeout);
		const startedAt = Date.now();

		try {
			const response = await fetchFn(this.configuration.url, {
				method: "POST",
				headers: await this.createHeaders(options.headers),
				body: JSON.stringify({ query, variables: options.variables, operationName: options.operationName }),
				signal: scope.signal,
			});

			const data = await this.parseResponse<TData>(response, scope.signal);

			this.log(operation, `${response.status} in ${Date.now() - startedAt}ms`);

			if (cacheKey !== undefined) {
				await this.configuration.cache?.set(cacheKey, data);
			}

			return data;
		} finally {
			scope.dispose();
		}
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

		if (errors?.length) {
			const summary = errors.map(getMessage).join("; ");

			throw new ClientError(response.ok ? summary : `${describeStatus(response)}: ${summary}`, {
				status,
				response,
				errors,
				data,
			});
		}

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
