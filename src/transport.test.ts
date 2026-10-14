import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "./client";

const URL = "https://test.dev/graphql";
const QUERY = "query Q { a }";
const SUBSCRIPTION = "subscription S { a }";
const DEFERRED = "query D { a ... @defer { b } }";

/**
 * Normalizes the arguments `fetch` was called with into a Request (the client calls `fetch(url, init)`).
 *
 * @param input - The URL or request
 * @param init - The request init
 * @returns The request
 */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

/**
 * Builds a JSON Response.
 */
function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

/**
 * Builds a body stream from text chunks, optionally left open (never closes, ignores any signal).
 */
function streamOf(chunks: string[], close = true): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			if (close) controller.close();
		},
	});
}

/**
 * Settles with the promise's outcome (value or rejection reason), or "hung" after `ms`.
 */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
	return Promise.race([
		promise.catch(function (error: unknown) {
			return error;
		}),
		new Promise(function (resolve) {
			setTimeout(function () {
				resolve("hung");
			}, ms);
		}),
	]);
}

/**
 * A fetch that behaves like the native one: it consumes the Request body and rejects with the signal's reason.
 */
function nativeLikeFetch(respond: (call: number) => Response | Promise<Response>) {
	let calls = 0;

	return vi.fn<typeof fetch>(async function (input, init) {
		// Like native fetch: throws a TypeError for a Request whose body was already used, and consumes it.
		const request = new Request(toRequest(input, init));

		await request.text();
		request.signal.throwIfAborted();

		return respond(++calls);
	});
}

afterEach(function () {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("transport: retries", function () {
	it("does not retry when a middleware consumed the body and native fetch rejects with a deterministic TypeError", async function () {
		const reads = vi.fn();
		const client = new Client({
			url: URL,
			// A request built by middleware is passed to fetch as is: once its body was read, it can be neither cloned
			// nor sent ("Request object that has already been used"), which fails before any network I/O.
			fetch: globalThis.fetch,
			retry: { attempts: 3, delay: 0 },
			middleware: [
				async function (request, next) {
					const rebuilt = new Request(request);

					reads(await rebuilt.text());
					return next(rebuilt);
				},
			],
		});

		await expect(client.gql({ query: QUERY })).rejects.toBeInstanceOf(TypeError);
		expect(reads).toHaveBeenCalledTimes(1);
	});

	it("lets a middleware call next() again (e.g. refresh a token after a 401)", async function () {
		const client = new Client({
			url: URL,
			fetch: nativeLikeFetch(function (call: number) {
				return call === 1 ? json({}, { status: 401 }) : json({ data: { a: 1 } });
			}),
			middleware: [
				async function (_request, next) {
					const response = await next();

					return response.status === 401 ? next() : response;
				},
			],
		});

		expect(await client.gql({ query: QUERY })).toEqual({ a: 1 });
	});

	it("retries a query whose response body fails mid-read (connection reset), instead of reporting invalid JSON", async function () {
		const client = new Client({
			url: URL,
			retry: { attempts: 1, delay: 0 },
			fetch: nativeLikeFetch(function (call: number) {
				if (call > 1) return json({ data: { a: 1 } });

				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"data":'));
						controller.error(new TypeError("terminated"));
					},
				});

				return new Response(body, { headers: { "Content-Type": "application/json" } });
			}),
		});

		expect(await client.gql({ query: QUERY })).toEqual({ a: 1 });
	});

	it("reports a timeout that fires during the retry backoff to onError", async function () {
		const onError = vi.fn();
		const client = new Client({
			url: URL,
			onError,
			fetch: nativeLikeFetch(function () {
				return json({}, { status: 503 });
			}),
			retry: { attempts: 5, delay: 1_000 },
			timeout: 30,
		});

		await expect(client.gql({ query: QUERY })).rejects.toMatchObject({ name: "TimeoutError" });
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![0]).toMatchObject({ name: "TimeoutError" });
	});
});

describe("transport: timeouts", function () {
	it("does not fire a large finite timeout (> 2^31-1 ms) immediately", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(function (input, init) {
				const { signal } = toRequest(input, init);

				return new Promise<Response>(function (resolve, reject) {
					const timer = setTimeout(function () {
						resolve(json({ data: { a: 1 } }));
					}, 20);

					signal.addEventListener("abort", function () {
						clearTimeout(timer);
						reject(signal.reason);
					});
				});
			}),
		});

		expect(await client.gql({ query: QUERY, timeout: 2 ** 31 })).toEqual({ a: 1 });
	});

	it("times out while reading a JSON body that is not tied to the signal", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(streamOf(['{"data":'], false), { headers: { "Content-Type": "application/json" } });
			}),
		});

		expect(await settleWithin(client.gql({ query: QUERY, timeout: 20 }), 500)).toMatchObject({
			name: "TimeoutError",
		});
	});

	it("times out while a middleware stalls", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(),
			middleware: [
				function () {
					return new Promise<Response>(function () {});
				},
			],
		});

		expect(await settleWithin(client.gql({ query: QUERY, timeout: 20 }), 500)).toMatchObject({
			name: "TimeoutError",
		});
	});
});

describe("transport: streaming", function () {
	it("rejects an aborted @defer stream instead of completing with partial data (body not tied to the signal)", async function () {
		const controller = new AbortController();
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(
					streamOf(
						['event: next\ndata: {"data":{"a":1},"pending":[{"id":"0","path":[]}],"hasNext":true}\n\n'],
						false,
					),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		});
		const run = (async function () {
			for await (const _ of client.subscribe({ query: DEFERRED, signal: controller.signal })) {
				controller.abort(new DOMException("stop", "AbortError"));
			}

			return "completed";
		})();

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
	});

	it("surfaces invalid JSON in an SSE event as a ClientError", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(streamOf(["event: next\ndata: {oops\n\n"]), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}),
		});

		await expect(client.subscribe({ query: SUBSCRIPTION }).next()).rejects.toMatchObject({ name: "ClientError" });
	});

	it("parses a multipart boundary followed by optional whitespace before the next parameter", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(
					streamOf([
						'\r\n--graphql\r\nContent-Type: application/json\r\n\r\n{"data":{"a":1},"hasNext":false}\r\n--graphql--\r\n',
					]),
					{ headers: { "Content-Type": "multipart/mixed; boundary=graphql ; deferSpec=20220824" } },
				);
			}),
		});

		expect(await client.gql({ query: DEFERRED })).toEqual({ a: 1 });
	});

	it("matches response media types case-insensitively", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(
					streamOf([
						'\r\n---\r\nContent-Type: application/json\r\n\r\n{"data":{"a":1},"hasNext":false}\r\n-----\r\n',
					]),
					{ headers: { "Content-Type": 'Multipart/Mixed; boundary="-"' } },
				);
			}),
		});

		expect(await client.gql({ query: DEFERRED })).toEqual({ a: 1 });
	});
});
