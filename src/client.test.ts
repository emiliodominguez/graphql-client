import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { ClientError, isClientError } from "./errors";
import type { ClientConfiguration } from "./types";

const URL = "https://test.dev/graphql";

const GET_USER = /* GraphQL */ `
	query GetUser($id: Int!) {
		user(id: $id) {
			id
			name
		}
	}
`;

const UPDATE_USER = /* GraphQL */ `
	mutation UpdateUser($id: Int!, $name: String!) {
		updateUser(id: $id, name: $name) {
			id
		}
	}
`;

const USER = { user: { id: 1, name: "Rick" } };

/**
 * Builds a JSON Response.
 *
 * @param body - The JSON body
 * @param init - Response init overrides
 * @returns A fresh Response
 */
function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

/**
 * Creates a fetch mock answering every call with a fresh copy of the given body.
 *
 * @param body - The JSON body
 * @param init - Response init overrides
 * @returns The fetch mock
 */
function mockFetch(body: unknown = { data: USER }, init?: ResponseInit) {
	return vi.fn<typeof fetch>(async function () {
		return json(body, init);
	});
}

/**
 * Creates a client wired to a fetch mock.
 *
 * @param configuration - Configuration overrides
 * @param fetchMock - The fetch mock to use
 * @returns The client and its fetch mock
 */
function setup(configuration: Partial<ClientConfiguration> = {}, fetchMock = mockFetch()) {
	const client = new Client({ url: URL, fetch: fetchMock, ...configuration });

	return { client, fetchMock };
}

/**
 * Reads the Request of a fetch mock call.
 *
 * @param fetchMock - The fetch mock
 * @param call - Call index
 * @returns The Request passed to fetch
 */
function getRequest(fetchMock: ReturnType<typeof mockFetch>, call = 0): Request {
	return fetchMock.mock.calls[call]![0] as Request;
}

/**
 * Reads the JSON body of a fetch mock call.
 *
 * @param fetchMock - The fetch mock
 * @param call - Call index
 * @returns The parsed body
 */
async function getBody(fetchMock: ReturnType<typeof mockFetch>, call = 0): Promise<Record<string, unknown>> {
	return getRequest(fetchMock, call).clone().json();
}

/**
 * Reads the request headers of a fetch mock call as a plain object.
 *
 * @param fetchMock - The fetch mock
 * @param call - Call index
 * @returns Lower-cased header names mapped to values
 */
function getHeaders(fetchMock: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
	return Object.fromEntries(getRequest(fetchMock, call).headers);
}

describe("Client", function () {
	afterEach(function () {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	describe("requests", function () {
		it("posts the operation and returns data", async function () {
			const { client, fetchMock } = setup();

			const data = await client.gql({ query: GET_USER, variables: { id: 1 } });

			expect(data).toEqual(USER);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(getRequest(fetchMock)).toMatchObject({ url: URL, method: "POST" });
			expect(await getBody(fetchMock)).toEqual({ query: GET_USER, variables: { id: 1 } });
		});

		it("sends operationName when provided", async function () {
			const { client, fetchMock } = setup();

			await client.gql({ query: GET_USER, operationName: "GetUser" });

			expect(await getBody(fetchMock)).toEqual({ query: GET_USER, operationName: "GetUser" });
		});

		it("falls back to the global fetch", async function () {
			const fetchMock = mockFetch();

			vi.stubGlobal("fetch", fetchMock);

			await new Client({ url: URL }).gql({ query: GET_USER });

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("accepts typed document objects", async function () {
			const { client, fetchMock } = setup();

			await client.gql({ query: new String(GET_USER) });

			expect((await getBody(fetchMock)).query).toBe(GET_USER);
		});
	});

	describe("headers", function () {
		it("sends JSON defaults and no Authorization header without a token", async function () {
			const { client, fetchMock } = setup();

			await client.gql({ query: GET_USER });

			expect(getHeaders(fetchMock)).toEqual({
				"content-type": "application/json",
				accept: "application/graphql-response+json, application/json;q=0.9",
			});
		});

		it("adds a bearer token", async function () {
			const { client, fetchMock } = setup({ authToken: "JWT123" });

			await client.gql({ query: GET_USER });

			expect(getHeaders(fetchMock).authorization).toBe("Bearer JWT123");
		});

		it("resolves async token factories on every request", async function () {
			let version = 0;
			const { client, fetchMock } = setup({
				authToken: async function () {
					return `token-${++version}`;
				},
			});

			await client.gql({ query: GET_USER, variables: { id: 1 } });
			await client.gql({ query: GET_USER, variables: { id: 2 } });

			expect(getHeaders(fetchMock, 0).authorization).toBe("Bearer token-1");
			expect(getHeaders(fetchMock, 1).authorization).toBe("Bearer token-2");
		});

		it("skips Authorization when the token factory returns nothing", async function () {
			const { client, fetchMock } = setup({
				authToken: function () {
					return null;
				},
			});

			await client.gql({ query: GET_USER });

			expect(getHeaders(fetchMock)).not.toHaveProperty("authorization");
		});

		it("merges every HeadersInit shape with call headers taking precedence", async function () {
			const { client, fetchMock } = setup({
				authToken: "JWT123",
				headers: new Headers({ "X-Client": "a", "X-Shared": "client" }),
			});

			await client.gql({
				query: GET_USER,
				headers: [
					["X-Shared", "call"],
					["Authorization", "Basic xyz"],
				],
			});

			expect(getHeaders(fetchMock)).toMatchObject({
				"x-client": "a",
				"x-shared": "call",
				authorization: "Basic xyz",
			});
		});

		it("resolves header factories", async function () {
			const { client, fetchMock } = setup({
				headers: async function () {
					return { "X-Request-Id": "42" };
				},
			});

			await client.gql({ query: GET_USER });

			expect(getHeaders(fetchMock)["x-request-id"]).toBe("42");
		});
	});

	describe("errors", function () {
		it("throws a ClientError with GraphQL errors and partial data", async function () {
			const errors = [{ message: "Error 1" }, { message: "Error 2", path: ["user"] }];
			const { client } = setup({}, mockFetch({ data: { user: null }, errors }));

			const error = await client.gql({ query: GET_USER }).catch(function (reason: unknown) {
				return reason;
			});

			expect(isClientError(error)).toBe(true);
			expect(error).toBeInstanceOf(ClientError);
			expect(error).toMatchObject({
				message: "Error 1; Error 2",
				status: 200,
				errors,
				data: { user: null },
			});
		});

		it("includes the HTTP status and GraphQL errors on non-2xx responses", async function () {
			const { client } = setup({}, mockFetch({ errors: [{ message: "Syntax Error" }] }, { status: 400 }));

			await expect(client.gql({ query: "{" })).rejects.toMatchObject({
				message: "HTTP 400: Syntax Error",
				status: 400,
				errors: [{ message: "Syntax Error" }],
			});
		});

		it("handles non-JSON error bodies", async function () {
			const fetchMock = vi.fn<typeof fetch>(async function () {
				return new Response("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" });
			});
			const { client } = setup({}, fetchMock);

			await expect(client.gql({ query: GET_USER })).rejects.toMatchObject({
				name: "ClientError",
				message: "HTTP 502 Bad Gateway",
				status: 502,
				errors: [],
			});
		});

		it("handles non-2xx JSON bodies without errors", async function () {
			const { client } = setup({}, mockFetch({}, { status: 503 }));

			await expect(client.gql({ query: GET_USER })).rejects.toMatchObject({ message: "HTTP 503", status: 503 });
		});

		it("rejects invalid JSON on 2xx responses", async function () {
			const fetchMock = vi.fn<typeof fetch>(async function () {
				return new Response("not json");
			});
			const { client } = setup({}, fetchMock);

			await expect(client.gql({ query: GET_USER })).rejects.toThrow("Invalid JSON in the GraphQL response.");
		});

		it("rejects responses without data", async function () {
			const { client } = setup({}, mockFetch({ data: null }));

			await expect(client.gql({ query: GET_USER })).rejects.toThrow("No data found in the GraphQL response.");
		});

		it("propagates transport errors untouched and does not log", async function () {
			const failure = new TypeError("fetch failed");
			const consoleError = vi.spyOn(console, "error");
			const fetchMock = vi.fn<typeof fetch>(async function () {
				throw failure;
			});
			const { client } = setup({}, fetchMock);

			await expect(client.gql({ query: GET_USER })).rejects.toBe(failure);
			expect(consoleError).not.toHaveBeenCalled();
		});

		it("does not treat plain errors as ClientErrors", function () {
			expect(isClientError(new Error("nope"))).toBe(false);
			expect(isClientError("nope")).toBe(false);
		});
	});

	describe("abort and timeout", function () {
		/**
		 * fetch mock that never settles until its signal aborts, like the real thing.
		 */
		const hangingFetch = vi.fn<typeof fetch>(function (input) {
			const { signal } = input as Request;

			return new Promise<Response>(function (_resolve, reject) {
				if (signal.aborted) return reject(signal.reason);

				signal.addEventListener("abort", function () {
					reject(signal.reason);
				});
			});
		});

		it("forwards the caller's signal", async function () {
			const { client } = setup({}, hangingFetch);
			const controller = new AbortController();
			const request = client.gql({ query: GET_USER, signal: controller.signal });

			controller.abort(new DOMException("Aborted", "AbortError"));

			await expect(request).rejects.toMatchObject({ name: "AbortError" });
		});

		it("times out using the client default", async function () {
			vi.useFakeTimers();

			const { client } = setup({ timeout: 50 }, hangingFetch);
			const request = client.gql({ query: GET_USER });
			const assertion = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

			await vi.advanceTimersByTimeAsync(50);
			await assertion;
		});

		it("surfaces aborts during body streaming as-is", async function () {
			const controller = new AbortController();
			const fetchMock = vi.fn<typeof fetch>(async function () {
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					async json() {
						controller.abort("stop");
						throw controller.signal.reason;
					},
				} as unknown as Response;
			});
			const { client } = setup({}, fetchMock);

			await expect(client.gql({ query: GET_USER, signal: controller.signal })).rejects.toBe("stop");
		});

		it("lets a call override the default timeout", async function () {
			vi.useFakeTimers();

			const { client } = setup({ timeout: 10_000 }, hangingFetch);
			const request = client.gql({ query: GET_USER, timeout: 10 });
			const assertion = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

			await vi.advanceTimersByTimeAsync(10);
			await assertion;
		});
	});

	describe("caching", function () {
		it("serves repeated queries from the cache", async function () {
			const { client, fetchMock } = setup({ cache: new MemoryCache() });

			await client.gql({ key: ["user", 1], query: GET_USER, variables: { id: 1 } });
			const data = await client.gql({ key: ["user", 1], query: GET_USER, variables: { id: 1 } });

			expect(data).toEqual(USER);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("works without an explicit key and ignores variable order", async function () {
			const { client, fetchMock } = setup({ cache: new MemoryCache() });

			await client.gql({ query: GET_USER, variables: { id: 1, locale: "en" } });
			await client.gql({ query: GET_USER, variables: { locale: "en", id: 1 } });

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("separates entries by variables", async function () {
			const { client, fetchMock } = setup({ cache: new MemoryCache() });

			await client.gql({ query: GET_USER, variables: { id: 1 } });
			await client.gql({ query: GET_USER, variables: { id: 2 } });

			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("never caches mutations by default", async function () {
			const cache = new MemoryCache();
			const { client, fetchMock } = setup({ cache });

			await client.gql({ query: UPDATE_USER, variables: { id: 1, name: "Morty" } });
			await client.gql({ query: UPDATE_USER, variables: { id: 1, name: "Morty" } });

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(cache.size).toBe(0);
		});

		it("honors per-call fetch policies", async function () {
			const { client, fetchMock } = setup({ cache: new MemoryCache() });

			await client.gql({ query: GET_USER, fetchPolicy: "no-cache" });
			await client.gql({ query: GET_USER, fetchPolicy: "no-cache" });
			await client.gql({ query: UPDATE_USER, fetchPolicy: "cache-first" });
			await client.gql({ query: UPDATE_USER, fetchPolicy: "cache-first" });

			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it("does not cache failed responses", async function () {
			const cache = new MemoryCache();
			const { client } = setup({ cache }, mockFetch({ errors: [{ message: "nope" }] }));

			await expect(client.gql({ query: GET_USER })).rejects.toThrow("nope");
			expect(cache.size).toBe(0);
		});

		it("supports async cache adapters", async function () {
			const store = new Map<string, unknown>();
			const { client, fetchMock } = setup({
				cache: {
					async get<T>(key: string) {
						return store.get(key) as T | undefined;
					},
					async set(key: string, value: unknown) {
						store.set(key, value);
					},
					async delete(key: string) {
						return store.delete(key);
					},
					async clear() {
						store.clear();
					},
					async keys() {
						return store.keys();
					},
				},
			});

			await client.gql({ query: GET_USER });
			await client.gql({ query: GET_USER });

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(await client.invalidate()).toBe(1);
			expect(store.size).toBe(0);
		});
	});

	describe("invalidation", function () {
		it("drops entries by hierarchical key prefix", async function () {
			const cache = new MemoryCache();
			const { client, fetchMock } = setup({ cache });

			await client.gql({ key: ["user", 1], query: GET_USER, variables: { id: 1 } });
			await client.gql({ key: ["user", 2], query: GET_USER, variables: { id: 2 } });
			await client.gql({ key: ["posts"], query: "{ posts { id } }" });

			expect(await client.invalidate(["user", 1])).toBe(1);
			expect(await client.invalidate(["user"])).toBe(1);
			expect(cache.size).toBe(1);

			await client.gql({ key: ["user", 1], query: GET_USER, variables: { id: 1 } });
			expect(fetchMock).toHaveBeenCalledTimes(4);
		});

		it("drops every client entry but keeps foreign keys", async function () {
			const cache = new MemoryCache();
			const { client } = setup({ cache });

			cache.set("foreign", 1);
			await client.gql({ key: ["a"], query: GET_USER });
			await client.gql({ query: "{ b }" });

			expect(await client.invalidate()).toBe(2);
			expect(cache.keys()).toEqual(["foreign"]);
		});

		it("is a no-op without a cache", async function () {
			expect(await setup().client.invalidate()).toBe(0);
		});
	});

	describe("deduplication", function () {
		it("shares one request between identical concurrent queries", async function () {
			const { client, fetchMock } = setup();

			const results = await Promise.all([
				client.gql({ query: GET_USER, variables: { id: 1 } }),
				client.gql({ query: GET_USER, variables: { id: 1 } }),
				client.gql({ query: GET_USER, variables: { id: 2 } }),
			]);

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(results[0]).toBe(results[1]);
		});

		it("releases the in-flight slot after settling, even on failure", async function () {
			const { client, fetchMock } = setup({}, mockFetch({ errors: [{ message: "nope" }] }));

			await Promise.allSettled([client.gql({ query: GET_USER }), client.gql({ query: GET_USER })]);
			await client.gql({ query: GET_USER }).catch(function () {
				return undefined;
			});

			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it("never dedupes mutations, calls with signals, headers or timeouts, or when disabled", async function () {
			const { client, fetchMock } = setup();
			const { client: plainClient, fetchMock: plainFetch } = setup({ dedupe: false });

			await Promise.all([client.gql({ query: UPDATE_USER }), client.gql({ query: UPDATE_USER })]);
			await Promise.all([
				client.gql({ query: GET_USER, signal: new AbortController().signal }),
				client.gql({ query: GET_USER, headers: { "X-A": "1" } }),
				client.gql({ query: GET_USER, timeout: 1_000 }),
			]);
			await Promise.all([plainClient.gql({ query: GET_USER }), plainClient.gql({ query: GET_USER })]);

			expect(fetchMock).toHaveBeenCalledTimes(5);
			expect(plainFetch).toHaveBeenCalledTimes(2);
		});
	});

	describe("debug", function () {
		it("logs operations, cache hits and dedupes when enabled", async function () {
			const consoleDebug = vi.spyOn(console, "debug").mockImplementation(function () {});
			const { client } = setup({ debug: true, cache: new MemoryCache() });

			await Promise.all([client.gql({ query: GET_USER }), client.gql({ query: GET_USER })]);
			await client.gql({ query: GET_USER });
			await client.gql({ query: "{ anonymous }" });

			const lines = consoleDebug.mock.calls.map(function (call) {
				return String(call[0]);
			});

			expect(lines[0]).toBe("[graphql-client] query GetUser → deduplicated");
			expect(lines[1]).toMatch(/^\[graphql-client\] query GetUser → ok in \d+ms$/);
			expect(lines[2]).toBe("[graphql-client] query GetUser → cache hit");
			expect(lines[3]).toMatch(/^\[graphql-client\] query \(anonymous\) → ok/);
		});

		it("stays silent by default", async function () {
			const consoleDebug = vi.spyOn(console, "debug");

			await setup().client.gql({ query: GET_USER });

			expect(consoleDebug).not.toHaveBeenCalled();
		});
	});
});
