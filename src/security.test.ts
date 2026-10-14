import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { dedupeFragments, graphql, minify } from "./document";
import { isClientError } from "./errors";
import { applyIncremental, createIncrementalState, readMultipartMixed } from "./incremental";
import { readServerSentEvents } from "./sse";
import { createUploadBody } from "./upload";
import { parseOperation } from "./utils";

const URL = "https://test.dev/graphql";

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
 *
 * @param body - The JSON body
 * @returns A fresh Response
 */
function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/**
 * Times a synchronous function.
 *
 * @param fn - The function
 * @returns Elapsed milliseconds
 */
function time(fn: () => unknown): number {
	const start = performance.now();

	fn();

	return performance.now() - start;
}

/**
 * A stream emitting `head`, then `chunks` chunks of `size` filler bytes, then `tail`.
 *
 * @param chunks - Number of filler chunks
 * @param size - Bytes per filler chunk
 * @param head - Leading text
 * @param tail - Trailing text
 * @returns The stream
 */
function chunkedStream(chunks: number, size: number, head: string, tail: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const filler = encoder.encode("x".repeat(size));
	let index = 0;

	return new ReadableStream({
		pull: function pull(controller): void {
			if (index === 0) controller.enqueue(encoder.encode(head));

			if (index < chunks) {
				controller.enqueue(filler);
			} else {
				controller.enqueue(encoder.encode(tail));
				controller.close();
			}

			index++;
		},
	});
}

describe("ReDoS", function () {
	it("dedupeFragments: a '#####' banner comment before a definition does not backtrack exponentially", function () {
		// Each extra '#' doubles the time of /^(?:#[^\n\r]*\s*)*fragment.../ (src/document.ts:85). 26 => ~1s, 40 => hours.
		const document = `${"#".repeat(26)}\nquery Q { a }`;

		expect(
			time(function run() {
				dedupeFragments(document);
			}),
		).toBeLessThan(100);
	});

	it("graphql tag: a banner comment inside a template does not hang", function () {
		const banner = "#".repeat(25);

		expect(
			time(function run() {
				graphql`
					${banner}
					query Q {
						a
					}
				`;
			}),
		).toBeLessThan(100);
	});

	it("parseOperation: a document of escaped quotes is scanned in linear time", function () {
		// Every '"' in '\"\"\"...' starts a string literal that scans to the end of the line: O(n^2) in IGNORED_TOKENS.
		const document = `{ a(s: ${'\\"'.repeat(20_000)}) }`;

		expect(
			time(function run() {
				parseOperation(document);
			}),
		).toBeLessThan(150);
	});

	it("minify: a document of escaped quotes is tokenized in linear time", function () {
		const document = `{ a(s: ${'\\"'.repeat(20_000)}) }`;

		expect(
			time(function run() {
				minify(document);
			}),
		).toBeLessThan(150);
	});
});

describe("streaming readers", function () {
	it("multipart/mixed: an 8MB part split into 16KB chunks is read in linear time", async function () {
		const stream = chunkedStream(
			512,
			16_384,
			'\r\n---\r\nContent-Type: application/json\r\n\r\n{"data":{"a":"',
			'"},"hasNext":false}\r\n-----\r\n',
		);
		const start = performance.now();
		let length = 0;

		for await (const part of readMultipartMixed(stream, "-")) length += part.length;

		expect(length).toBeGreaterThan(8_000_000);
		// The whole buffer is re-normalized and re-searched on every chunk (src/incremental.ts:239-241): ~3s here.
		expect(performance.now() - start).toBeLessThan(1_000);
	}, 60_000);

	it("SSE: an 8MB event split into 16KB chunks is read in linear time", async function () {
		const stream = chunkedStream(512, 16_384, 'event: next\ndata: {"data":{"a":"', '"}}\n\n');
		const start = performance.now();
		let length = 0;

		for await (const event of readServerSentEvents(stream)) length += event.data.length;

		expect(length).toBeGreaterThan(8_000_000);
		// Same quadratic re-scan in src/sse.ts:34-36.
		expect(performance.now() - start).toBeLessThan(1_000);
	}, 60_000);
});

describe("incremental delivery: __proto__ in server-controlled paths/patches", function () {
	it("a path segment '__proto__' does not strip Array methods from a list in the result", function () {
		const state = createIncrementalState();

		applyIncremental(state, { data: { list: [1, 2, 3] }, hasNext: true });
		applyIncremental(state, { incremental: [{ path: ["list", "__proto__"], data: {} }], hasNext: false });

		const { list } = state.data as { list: number[] };

		// `copy["__proto__"] = ...` in updateIn (src/incremental.ts:188) replaces the array's prototype with `{}`.
		expect(Object.getPrototypeOf(list)).toBe(Array.prototype);
		expect(typeof list.map).toBe("function");
	});

	it("a '__proto__' key in a deferred patch is not turned into the object's prototype", function () {
		const state = createIncrementalState();

		applyIncremental(state, JSON.parse('{"data":{"user":{"name":"a"}},"hasNext":true}'));
		applyIncremental(
			state,
			JSON.parse('{"incremental":[{"path":["user"],"data":{"__proto__":{"isAdmin":true}}}],"hasNext":false}'),
		);

		const { user } = state.data as { user: Record<string, unknown> };

		// deepMerge (src/incremental.ts:168) assigns result["__proto__"], swapping the prototype: `user.isAdmin` is
		// true yet invisible to JSON.stringify / Object.keys / hasOwnProperty.
		expect(Object.getPrototypeOf(user)).toBe(Object.prototype);
		expect(user.isAdmin).toBeUndefined();
	});
});

describe("GET requests", function () {
	it("keeps the GraphQL params in the query string when the endpoint URL has a #fragment", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return json({ data: { a: 1 } });
		});
		const client = new Client({ url: `${URL}#main`, method: "GET", fetch: fetchMock });

		await client.gql({ query: "query Q { a }" }).catch(function ignore() {});

		const request = toRequest(...fetchMock.mock.calls[0]!);

		// `${url}?${params}` (src/client.ts:838) puts the params after '#': they are never sent to the server.
		expect(new globalThis.URL(request.url).searchParams.get("query")).toBe("query Q { a }");
	});
});

describe("malformed responses", function () {
	it("a non-array `errors` string yields a ClientError, not a TypeError", async function () {
		const client = new Client({
			url: URL,
			fetch: async function () {
				return json({ data: null, errors: "Internal server error" });
			},
		});
		const error = await client.gql({ query: "{ a }" }).catch(function capture(caught: unknown) {
			return caught;
		});

		// `errors?.length` passes for a string, then `errors.map` throws (src/client.ts:966, 1333).
		expect(isClientError(error)).toBe(true);
	});

	it("a null entry in `errors` yields a ClientError, not a TypeError", async function () {
		const client = new Client({
			url: URL,
			fetch: async function () {
				return json({ data: null, errors: [null] });
			},
		});
		const error = await client.gql({ query: "{ a }" }).catch(function capture(caught: unknown) {
			return caught;
		});

		expect(isClientError(error)).toBe(true);
	});

	it("a non-array `errors` object is not silently treated as success", async function () {
		const client = new Client({
			url: URL,
			fetch: async function () {
				return json({ data: { a: 1 }, errors: { message: "Not authorized" } });
			},
		});

		// No `.length`: the errors are dropped and the data returned as if the request succeeded.
		await expect(client.gql({ query: "{ a }" })).rejects.toSatisfy(isClientError);
	});
});

describe("uploads", function () {
	it("rejects a file under a variable key containing '.' (spec paths cannot express it)", function () {
		const file = new Blob(["x"]);

		expect(function () {
			createUploadBody({ query: "mutation($f: Upload) { a }", variables: { "a.b": file } } as never);
		}).toThrow(TypeError);
		expect(createUploadBody({ query: "mutation { a }", variables: { "a.b": 1, c: file } } as never)).toBeDefined();
	});
});

describe("retries", function () {
	it("a retry delay above the 32-bit timer limit does not turn into an immediate retry", async function () {
		const controller = new AbortController();
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return new Response("", { status: 503 });
		});
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			// e.g. a custom delay honoring `Retry-After: 2592000` (30 days) without capping it.
			retry: { attempts: 1, delay: 30 * 24 * 3_600_000 },
		});
		const pending = client.gql({ query: "{ a }", signal: controller.signal }).catch(function ignore() {});

		await new Promise(function wait(resolve) {
			setTimeout(resolve, 100);
		});

		const calls = fetchMock.mock.calls.length;

		controller.abort();
		await pending;

		// setTimeout clamps delays > 2^31-1 ms to 1ms (src/utils.ts:280 `sleep`): the 30-day wait becomes ~0.
		expect(calls).toBe(1);
	});
});
