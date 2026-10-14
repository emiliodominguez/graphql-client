import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import type { ClientConfiguration, Middleware } from "./types";
import { sha256 } from "./utils";

const URL = "https://test.dev/graphql";
const GET_USER = "query GetUser($id: Int!) { user(id: $id) { id } }";
const UPDATE_USER = "mutation UpdateUser($id: Int!) { updateUser(id: $id) { id } }";
const USER = { user: { id: 1 } };

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
 * Creates a fetch mock answering calls with the given responses in order, repeating the last one.
 *
 * @param responses - Response factories, or thrown errors
 * @returns The fetch mock
 */
function sequence(...responses: Array<(() => Response) | Error>) {
	let index = 0;

	return vi.fn<typeof fetch>(async function () {
		const next = responses[Math.min(index++, responses.length - 1)]!;

		if (next instanceof Error) throw next;

		return next();
	});
}

/**
 * Factory for a successful response.
 *
 * @returns The response
 */
function ok(): Response {
	return json({ data: USER });
}

/**
 * Factory for a 503 response.
 *
 * @returns The response
 */
function unavailable(): Response {
	return json({}, { status: 503 });
}

/**
 * Creates a client wired to a fetch mock.
 *
 * @param fetchMock - The fetch mock
 * @param configuration - Configuration overrides
 * @returns The client
 */
function createClient(fetchMock: typeof fetch, configuration: Partial<ClientConfiguration> = {}): Client {
	return new Client({ url: URL, fetch: fetchMock, ...configuration });
}

/**
 * Reads the Request of a fetch mock call.
 *
 * @param fetchMock - The fetch mock
 * @param call - Call index
 * @returns The Request passed to fetch
 */
function requestOf(fetchMock: ReturnType<typeof sequence>, call = 0): Request {
	return fetchMock.mock.calls[call]![0] as Request;
}

/**
 * Creates an SSE Response streaming the given chunks.
 *
 * @param chunks - Raw event-stream chunks
 * @param onCancel - Called when the consumer cancels the stream
 * @returns The response
 */
function eventStream(chunks: string[], onCancel?: () => void): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (!onCancel) controller.close();
		},
		...(onCancel ? { cancel: onCancel } : {}),
	});

	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

afterEach(function () {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("retries", function () {
	it("retries retryable query failures until success", async function () {
		const fetchMock = sequence(new TypeError("fetch failed"), unavailable, ok);
		const client = createClient(fetchMock, { retry: { attempts: 3, delay: 0 } });

		expect(await client.gql({ query: GET_USER })).toEqual(USER);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("gives up after the configured attempts", async function () {
		const fetchMock = sequence(unavailable);
		const client = createClient(fetchMock, { retry: { attempts: 2, delay: 0 } });

		await expect(client.gql({ query: GET_USER })).rejects.toMatchObject({ status: 503 });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry mutations or non-retryable errors by default", async function () {
		const fetchMock = sequence(unavailable);
		const client = createClient(fetchMock, { retry: { attempts: 3, delay: 0 } });

		await expect(client.gql({ query: UPDATE_USER })).rejects.toMatchObject({ status: 503 });
		await expect(
			createClient(
				sequence(function () {
					return json({ errors: [{ message: "bad" }] }, { status: 400 });
				}),
				{ retry: 3 },
			).gql({ query: GET_USER }),
		).rejects.toMatchObject({ status: 400 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("supports custom predicates and per-call overrides", async function () {
		const fetchMock = sequence(unavailable, ok);
		const retryIf = vi.fn(function () {
			return true;
		});
		const client = createClient(fetchMock, { retry: { attempts: 1, delay: 0, retryIf } });

		expect(await client.gql({ query: UPDATE_USER })).toEqual(USER);
		expect(retryIf).toHaveBeenCalledWith(
			expect.objectContaining({ status: 503 }),
			expect.objectContaining({ type: "mutation", attempt: 0 }),
		);

		const noRetry = sequence(unavailable, ok);

		await expect(createClient(noRetry, { retry: 3 }).gql({ query: GET_USER, retry: false })).rejects.toThrow();
		expect(noRetry).toHaveBeenCalledTimes(1);
	});

	it("waits for the backoff delay, honoring Retry-After", async function () {
		vi.useFakeTimers();

		const fetchMock = sequence(function () {
			return json({}, { status: 429, headers: { "Retry-After": "2" } });
		}, ok);
		const request = createClient(fetchMock, { retry: 1 }).gql({ query: GET_USER });

		await vi.advanceTimersByTimeAsync(1_999);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(await request).toEqual(USER);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("stops retrying when aborted during the backoff", async function () {
		vi.useFakeTimers();

		const controller = new AbortController();
		const fetchMock = sequence(unavailable);
		const request = createClient(fetchMock, { retry: { attempts: 5, delay: 1_000 } }).gql({
			query: GET_USER,
			signal: controller.signal,
		});
		const assertion = expect(request).rejects.toBe("cancelled");

		await vi.advanceTimersByTimeAsync(10);
		controller.abort("cancelled");
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("bounds every retry with a single timeout", async function () {
		vi.useFakeTimers();

		const fetchMock = sequence(unavailable);
		const request = createClient(fetchMock, { retry: { attempts: 10, delay: 100 }, timeout: 250 }).gql({
			query: GET_USER,
		});
		const assertion = expect(request).rejects.toMatchObject({ name: "TimeoutError" });

		await vi.advanceTimersByTimeAsync(250);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("logs retries in debug mode", async function () {
		const consoleDebug = vi.spyOn(console, "debug").mockImplementation(function () {});

		await createClient(sequence(unavailable, ok), { retry: { attempts: 1, delay: 0 }, debug: true }).gql({
			query: GET_USER,
		});

		expect(consoleDebug).toHaveBeenCalledWith("[graphql-client] query GetUser → retry 1/1 in 0ms");
		expect(consoleDebug).toHaveBeenLastCalledWith(expect.stringMatching(/ok in \d+ms after 1 retries$/));
	});
});

describe("middleware", function () {
	it("runs in order around fetch and can rewrite requests and responses", async function () {
		const calls: string[] = [];
		const fetchMock = sequence(ok);

		const first: Middleware = async function (request, next) {
			calls.push("first:before");
			const headers = new Headers(request.headers);

			headers.set("X-Trace", "abc");

			const response = await next(new Request(request, { headers }));

			calls.push("first:after");

			return response;
		};

		const second: Middleware = async function (request, next, context) {
			calls.push(`second:${context.type}:${context.name}:${context.attempt}`);

			return next();
		};

		await createClient(fetchMock, { middleware: [first, second] }).gql({ query: GET_USER });

		expect(calls).toEqual(["first:before", "second:query:GetUser:0", "first:after"]);
		expect(requestOf(fetchMock).headers.get("X-Trace")).toBe("abc");
	});

	it("can short-circuit the network", async function () {
		const fetchMock = sequence(ok);
		const mock: Middleware = async function () {
			return json({ data: { mocked: true } });
		};

		expect(await createClient(fetchMock, { middleware: [mock] }).gql({ query: GET_USER })).toEqual({ mocked: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("runs again on every retry with the attempt number", async function () {
		const attempts: number[] = [];
		const track: Middleware = async function (request, next, context) {
			attempts.push(context.attempt);

			return next(request);
		};

		await createClient(sequence(unavailable, unavailable, ok), { middleware: [track], retry: { delay: 0 } }).gql({
			query: GET_USER,
		});

		expect(attempts).toEqual([0, 1, 2]);
	});
});

describe("GET queries", function () {
	it("sends queries as GET with search params and no Content-Type", async function () {
		const fetchMock = sequence(ok);

		await createClient(fetchMock, { method: "GET" }).gql({
			query: GET_USER,
			variables: { id: 1 },
			operationName: "GetUser",
		});

		const request = requestOf(fetchMock);
		const params = new globalThis.URL(request.url).searchParams;

		expect(request.method).toBe("GET");
		expect(request.headers.has("Content-Type")).toBe(false);
		expect(params.get("query")).toBe(GET_USER);
		expect(params.get("variables")).toBe('{"id":1}');
		expect(params.get("operationName")).toBe("GetUser");
	});

	it("appends to URLs that already have search params", async function () {
		const fetchMock = sequence(ok);

		await createClient(fetchMock, { method: "GET", url: `${URL}?tenant=a` }).gql({ query: GET_USER });

		expect(requestOf(fetchMock).url).toMatch(/\?tenant=a&query=/);
	});

	it("keeps mutations on POST", async function () {
		const fetchMock = sequence(ok);

		await createClient(fetchMock, { method: "GET" }).gql({ query: UPDATE_USER });

		expect(requestOf(fetchMock).method).toBe("POST");
	});
});

describe("persisted queries", function () {
	/**
	 * Fake APQ server: answers PersistedQueryNotFound for unknown hashes, then remembers them.
	 *
	 * @returns The fetch mock
	 */
	function apqServer() {
		const known = new Set<string>();

		return vi.fn<typeof fetch>(async function (input) {
			const request = input as Request;
			const payload =
				request.method === "GET"
					? Object.fromEntries(new globalThis.URL(request.url).searchParams)
					: await request.clone().json();
			const extensions = typeof payload.extensions === "string" ? JSON.parse(payload.extensions) : payload.extensions;
			const hash: string = extensions.persistedQuery.sha256Hash;

			if (!payload.query && !known.has(hash)) {
				return json({ errors: [{ message: "PersistedQueryNotFound" }] });
			}

			known.add(hash);

			return json({ data: USER });
		});
	}

	it("sends the hash first, falls back to the full document once, then hash only", async function () {
		const fetchMock = apqServer();
		const client = createClient(fetchMock, { persistedQueries: true });

		await client.gql({ query: GET_USER, variables: { id: 1 } });
		await client.gql({ query: GET_USER, variables: { id: 2 } });

		const bodies = await Promise.all(
			[0, 1, 2].map(function (call) {
				return requestOf(fetchMock, call).clone().json();
			}),
		);
		const extensions = { persistedQuery: { version: 1, sha256Hash: await sha256(GET_USER) } };

		expect(bodies).toEqual([
			{ variables: { id: 1 }, extensions },
			{ query: GET_USER, variables: { id: 1 }, extensions },
			{ variables: { id: 2 }, extensions },
		]);
	});

	it("pairs with GET for CDN-cacheable requests", async function () {
		const fetchMock = apqServer();
		const client = createClient(fetchMock, { persistedQueries: true, method: "GET" });

		await client.gql({ query: GET_USER });
		await client.gql({ query: GET_USER });

		const last = new globalThis.URL(requestOf(fetchMock, 2).url).searchParams;

		expect(requestOf(fetchMock, 2).method).toBe("GET");
		expect(last.has("query")).toBe(false);
		expect(last.get("extensions")).toContain(await sha256(GET_USER));
	});

	it("disables itself when the server does not support it", async function () {
		const fetchMock = sequence(function () {
			return json({ errors: [{ message: "x", extensions: { code: "PERSISTED_QUERY_NOT_SUPPORTED" } }] });
		}, ok);
		const client = createClient(fetchMock, { persistedQueries: true });

		await client.gql({ query: GET_USER });
		await client.gql({ query: GET_USER, variables: { id: 2 } });

		expect(await requestOf(fetchMock, 1).json()).toEqual({ query: GET_USER });
		expect(await requestOf(fetchMock, 2).json()).toEqual({ query: GET_USER, variables: { id: 2 } });
	});

	it("uses a custom hash and memoizes it", async function () {
		const hash = vi.fn(function (query: string) {
			return `custom-${query.length}`;
		});
		const fetchMock = sequence(ok);
		const client = createClient(fetchMock, { persistedQueries: { hash } });

		await client.gql({ query: GET_USER, variables: { id: 1 } });
		await client.gql({ query: GET_USER, variables: { id: 2 } });

		expect(hash).toHaveBeenCalledTimes(1);
		expect(await requestOf(fetchMock).json()).toMatchObject({
			extensions: { persistedQuery: { sha256Hash: `custom-${GET_USER.length}` } },
		});
	});

	it("propagates unrelated errors", async function () {
		const client = createClient(sequence(unavailable), { persistedQueries: true });

		await expect(client.gql({ query: GET_USER })).rejects.toMatchObject({ status: 503 });
	});
});

describe("invalidates", function () {
	it("invalidates cache prefixes after a successful operation", async function () {
		const cache = new MemoryCache();
		const fetchMock = sequence(ok);
		const client = createClient(fetchMock, { cache });

		await client.gql({ key: ["user", 1], query: GET_USER });
		await client.gql({ key: ["posts"], query: "{ posts }" });
		await client.gql({ query: UPDATE_USER, invalidates: [["user"]] });

		expect(cache.size).toBe(1);

		await client.gql({ key: ["user", 1], query: GET_USER });
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("keeps the cache when the operation fails", async function () {
		const cache = new MemoryCache();
		const client = createClient(sequence(ok, unavailable), { cache });

		await client.gql({ key: ["user"], query: GET_USER });
		await expect(client.gql({ query: UPDATE_USER, invalidates: [["user"]] })).rejects.toThrow();

		expect(cache.size).toBe(1);
	});
});

describe("extend", function () {
	it("derives a client with overrides and a shared cache", async function () {
		const cache = new MemoryCache();
		const fetchMock = sequence(ok);
		const base = createClient(fetchMock, { cache, headers: { "X-App": "web" } });
		const scoped = base.extend({ authToken: "user-token" });

		await scoped.gql({ query: GET_USER });
		await base.gql({ query: GET_USER });

		expect(scoped).not.toBe(base);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(Object.fromEntries(requestOf(fetchMock).headers)).toMatchObject({
			"x-app": "web",
			authorization: "Bearer user-token",
		});
	});
});

describe("subscribe", function () {
	const SUBSCRIPTION = "subscription OnMessage { message }";

	it("streams SSE `next` events until `complete`", async function () {
		const fetchMock = sequence(function () {
			return eventStream([
				'event: next\ndata: {"data":{"message":"a"}}\n\n',
				': ping\n\nevent: next\ndata: {"data":{"message":"b"}}\n\n',
				"event: next\ndata:\n\n",
				'data: {"data":{"message":"c"}}\n\n',
				"event: other\ndata: {}\n\n",
				"event: complete\ndata:\n\n",
				'event: next\ndata: {"data":{"message":"ignored"}}\n\n',
			]);
		});
		const messages: unknown[] = [];

		for await (const data of createClient(fetchMock, { authToken: "t" }).subscribe({ query: SUBSCRIPTION })) {
			messages.push(data);
		}

		const request = requestOf(fetchMock);

		expect(messages).toEqual([{ message: "a" }, { message: "b" }, { message: "c" }]);
		expect(request.headers.get("Accept")).toBe("text/event-stream");
		expect(request.headers.get("Authorization")).toBe("Bearer t");
		expect(await request.json()).toEqual({ query: SUBSCRIPTION });
	});

	it("throws a ClientError on GraphQL errors in an event", async function () {
		const client = createClient(
			sequence(function () {
				return eventStream(['event: next\ndata: {"errors":[{"message":"denied"}]}\n\n']);
			}),
		);
		const iterator = client.subscribe({ query: SUBSCRIPTION });

		await expect(iterator.next()).rejects.toMatchObject({ name: "ClientError", message: "denied" });
	});

	it("closes the connection when the consumer breaks", async function () {
		const onCancel = vi.fn();
		const client = createClient(
			sequence(function () {
				return eventStream(['data: {"data":{"message":"a"}}\n\n'], onCancel);
			}),
		);

		for await (const data of client.subscribe({ query: SUBSCRIPTION })) {
			expect(data).toEqual({ message: "a" });
			break;
		}

		expect(onCancel).toHaveBeenCalled();
	});

	it("yields a single JSON result when the server does not stream", async function () {
		const results: unknown[] = [];

		for await (const data of createClient(sequence(ok)).subscribe({ query: SUBSCRIPTION })) results.push(data);

		expect(results).toEqual([USER]);
	});

	it("rejects non-2xx responses", async function () {
		const iterator = createClient(sequence(unavailable)).subscribe({ query: SUBSCRIPTION });

		await expect(iterator.next()).rejects.toMatchObject({ status: 503 });
	});

	it("logs the subscription in debug mode", async function () {
		const consoleDebug = vi.spyOn(console, "debug").mockImplementation(function () {});
		const client = createClient(
			sequence(function () {
				return eventStream(["event: complete\n\n"]);
			}),
			{ debug: true },
		);

		for await (const _ of client.subscribe({ query: SUBSCRIPTION })) {
			// drain
		}

		expect(consoleDebug).toHaveBeenCalledWith("[graphql-client] subscription OnMessage → streaming");
	});
});

describe("strict persisted queries", function () {
	it("only ever sends the hash and fails on unknown documents", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			const body = await (input as Request).clone().json();

			return body.extensions.persistedQuery.sha256Hash === "known"
				? json({ data: USER })
				: json({ errors: [{ message: "PersistedQueryNotFound" }] });
		});
		const client = createClient(fetchMock, {
			persistedQueries: {
				strict: true,
				hash(query: string) {
					return query.includes("GetUser") ? "known" : "unknown";
				},
			},
		});

		expect(await client.gql({ query: GET_USER })).toEqual(USER);
		await expect(client.gql({ query: "{ secret }" })).rejects.toThrow("PersistedQueryNotFound");

		const bodies = await Promise.all(
			fetchMock.mock.calls.map(function (call) {
				return (call[0] as Request).json();
			}),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const body of bodies) expect(body).not.toHaveProperty("query");
	});

	it("propagates hash failures instead of sending the document", async function () {
		const fetchMock = sequence(ok);
		const client = createClient(fetchMock, {
			persistedQueries: {
				strict: true,
				hash() {
					throw new Error("not in manifest");
				},
			},
		});

		await expect(client.gql({ query: GET_USER })).rejects.toThrow("not in manifest");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
