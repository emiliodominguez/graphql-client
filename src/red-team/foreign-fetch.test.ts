import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../client";
import { isClientError } from "../errors";

/**
 * Behaviors of fetch implementations other than the platform's: node-fetch / cross-fetch (a `FetchError` that is not
 * a `TypeError`, a Node.js `Readable` body, `json()` failures that are not `SyntaxError`s) and React Native's
 * whatwg-fetch (a `Request` without `body`).
 */

const URL = "https://foreign.test/graphql";

/**
 * node-fetch's error class: an `Error`, not a `TypeError`.
 */
class FetchError extends Error {
	override name = "FetchError";
}

/**
 * A node-fetch-like response: its body is a Node.js `Readable` (async-iterable, no `getReader`).
 *
 * @param text - The body
 * @param contentType - The Content-Type header
 * @returns The response
 */
function nodeResponse(text: string, contentType: string): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers({ "Content-Type": contentType }),
		body: Readable.from([Buffer.from(text)]),
		bodyUsed: false,
		text: function readText() {
			return Promise.resolve(text);
		},
	} as unknown as Response;
}

describe("node-fetch / cross-fetch", function () {
	it("retries a network failure rejected as a FetchError", async function () {
		let calls = 0;
		const client = new Client({
			url: URL,
			retry: { attempts: 1, delay: 0 },
			fetch: async function nodeFetch() {
				if (++calls === 1) throw new FetchError("request to x failed, reason: socket hang up");

				return Response.json({ data: { a: 1 } });
			} as typeof fetch,
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 1 });
		expect(calls).toBe(2);
	});

	it("never retries an abort, whatever marks it", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function aborted() {
			throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
		});
		const client = new Client({ url: URL, retry: { attempts: 2, delay: 0 }, fetch: fetchMock });

		await expect(client.gql({ query: "{ a }" })).rejects.toThrow("aborted");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports an HTML error page as a ClientError with its status, not as a network failure", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function proxy() {
			const response = new Response("<html>Service Unavailable</html>", { status: 503 });

			// node-fetch's json() rejects with a FetchError, not a SyntaxError: it must never be needed.
			response.json = function json() {
				return Promise.reject(new FetchError("invalid json response body"));
			};

			return response;
		});
		const client = new Client({ url: URL, retry: { attempts: 1, delay: 0 }, fetch: fetchMock });
		const error = await client.gql({ query: "{ a }" }).catch(function capture(caught: unknown) {
			return caught;
		});

		expect(isClientError(error) && error.status).toBe(503);
		// 5xx is retryable: the retry happened because it is a ClientError with a status.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reads a multipart @defer response whose body is a Node.js Readable", async function () {
		const body =
			'\r\n---\r\nContent-Type: application/json\r\n\r\n{"data":{"a":1},"pending":[{"id":"0","path":[]}],"hasNext":true}' +
			'\r\n---\r\nContent-Type: application/json\r\n\r\n{"incremental":[{"id":"0","data":{"b":2}}],"completed":[{"id":"0"}],"hasNext":false}' +
			"\r\n-----\r\n";
		const client = new Client({
			url: URL,
			fetch: async function nodeFetch() {
				return nodeResponse(body, 'multipart/mixed; boundary="-"');
			} as typeof fetch,
		});

		await expect(client.gql({ query: "{ a ... @defer { b } }" })).resolves.toEqual({ a: 1, b: 2 });
	});

	it("streams an SSE subscription whose body is a Node.js Readable", async function () {
		const client = new Client({
			url: URL,
			fetch: async function nodeFetch() {
				return nodeResponse(
					'event: next\ndata: {"data":{"n":1}}\n\nevent: next\ndata: {"data":{"n":2}}\n\nevent: complete\ndata:\n\n',
					"text/event-stream",
				);
			} as typeof fetch,
		});
		const received: unknown[] = [];

		for await (const data of client.subscribe({ query: "subscription { n }" })) received.push(data);

		expect(received).toEqual([{ n: 1 }, { n: 2 }]);
	});
});

describe("React Native (whatwg-fetch)", function () {
	it("hands a middleware-built polyfilled Request (no `body`) to fetch as is", async function () {
		const calls: unknown[] = [];
		// whatwg-fetch's Request keeps its body privately: there is no `body` property to read bytes from.
		const polyfilled = {
			url: URL,
			method: "POST",
			headers: new Headers({ "Content-Type": "application/json" }),
			clone: function clone() {
				return polyfilled;
			},
		};
		const client = new Client({
			url: URL,
			fetch: async function rnFetch(input: unknown) {
				calls.push(input);

				return Response.json({ data: { a: 1 } });
			} as unknown as typeof fetch,
			middleware: [
				function rebuild(_request, next) {
					return next(polyfilled as unknown as Request);
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 1 });
		expect(calls).toEqual([polyfilled]);
	});
});
