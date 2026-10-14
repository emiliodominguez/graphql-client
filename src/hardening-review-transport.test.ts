import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { isClientError } from "./errors";

/**
 * transport / incremental classification. Every test asserts the CORRECT behavior.
 */

const URL = "https://hardening.test/graphql";

function multipart(parts: string[]): Response {
	const body = parts.map(function (part) {
		return `\r\n--graphql\r\nContent-Type: application/json\r\n\r\n${part}`;
	});

	return new Response(`${body.join("")}\r\n--graphql--\r\n`, {
		headers: { "Content-Type": 'multipart/mixed; boundary="graphql"; deferSpec=20220824' },
	});
}

describe("response body consumed by middleware", function () {
	it("is a deterministic failure: it is not retried as a network failure", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { a: 1 } });
		});
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			retry: { attempts: 2, delay: 0 },
			middleware: [
				async function logBody(request, next) {
					const response = await next(request);

					// A logging middleware reading the response without cloning it.
					await response.text();

					return response;
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).rejects.toBeDefined();
		// "Body is unusable" fails the same way on every attempt: the CHANGELOG says such bodies "fail fast".
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("hostile incremental payloads (multipart/mixed)", function () {
	it("a non-iterable `incremental` surfaces as a ClientError, not a raw TypeError", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return multipart([
				'{"data":{"a":1},"pending":[{"id":"0","path":[]}],"hasNext":true}',
				'{"incremental":5,"hasNext":false}',
			]);
		});
		const client = new Client({ url: URL, fetch: fetchMock });
		const error = await client.gql({ query: "{ a ... @defer { b } }" }).catch(function (caught: unknown) {
			return caught;
		});

		expect(isClientError(error)).toBe(true);
	});

	it("a malformed `pending` entry is not retried as a network failure", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return multipart(['{"data":{"a":1},"pending":[null],"hasNext":true}', '{"hasNext":false}']);
		});
		const client = new Client({ url: URL, fetch: fetchMock, retry: { attempts: 2, delay: 0 } });

		await expect(client.gql({ query: "{ a ... @defer { b } }" })).rejects.toBeDefined();
		// Deterministic garbage from the server: retrying it sends the same request again for nothing.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("hostile incremental payloads (SSE subscribe)", function () {
	it("a null `incremental` item surfaces as a ClientError", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return new Response(
				'event: next\ndata: {"data":{"a":1},"hasNext":true}\n\nevent: next\ndata: {"incremental":[null],"hasNext":false}\n\n',
				{
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		});
		const client = new Client({ url: URL, fetch: fetchMock });
		let error: unknown;

		try {
			for await (const data of client.subscribe({ query: "{ a ... @defer { b } }" })) void data;
		} catch (caught) {
			error = caught;
		}

		expect(isClientError(error)).toBe(true);
	});
});

describe("custom fetch contract: fetch(url, init)", function () {
	it("the README tracing middleware (`next(new Request(request, { headers }))`) still calls fetch with a URL string", async function () {
		const calls: unknown[] = [];
		// A node-fetch / cross-fetch style implementation: it only understands `fetch(url, init)`.
		const fetchMock = vi.fn(async function (input: unknown) {
			calls.push(input);

			if (typeof input !== "string") throw new TypeError(`Invalid URL: ${String(input)}`);

			return Response.json({ data: { a: 1 } });
		}) as unknown as typeof fetch;
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			middleware: [
				async function tracing(request, next) {
					const headers = new Headers(request.headers);

					headers.set("traceparent", "00-abc-def-01");

					return next(new Request(request, { headers }));
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 1 });
		expect(typeof calls[0]).toBe("string");
	});
});

describe("custom fetch contract: middleware-built requests", function () {
	it("forwards the body, method, headers and non-default credentials of a request built by middleware", async function () {
		const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
		const fetchMock = vi.fn(async function nodeFetchLike(url: unknown, init?: RequestInit) {
			calls.push({ url, init });

			return Response.json({ data: { a: 1 } });
		}) as unknown as typeof fetch;
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			middleware: [
				function rewrite(request, next) {
					return next(new Request(request, { credentials: "include" }));
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 1 });

		const { url, init } = calls[0]!;

		expect(url).toBe(URL);
		expect(init?.method).toBe("POST");
		expect(init?.credentials).toBe("include");
		expect(init?.redirect).toBeUndefined();
		expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
		expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({ query: "{ a }" });
	});

	it("lets middleware call next() twice with its own request (the body is read from a clone)", async function () {
		const bodies: string[] = [];
		const client = new Client({
			url: URL,
			fetch: async function record(_url: unknown, init?: RequestInit) {
				bodies.push(new TextDecoder().decode(init?.body as ArrayBuffer));

				return Response.json({ data: { a: bodies.length } });
			} as unknown as typeof fetch,
			middleware: [
				async function twice(request, next) {
					const rebuilt = new Request(request);

					await next(rebuilt);

					return next(rebuilt);
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 2 });
		expect(bodies).toEqual(['{"query":"{ a }"}', '{"query":"{ a }"}']);
	});

	it("never retries a consumed middleware-built request as a network failure", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { a: 1 } });
		});
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			retry: { attempts: 2, delay: 0 },
			middleware: [
				async function consume(request, next) {
					const rebuilt = new Request(request);

					await rebuilt.text();

					return next(rebuilt);
				},
			],
		});

		await expect(client.gql({ query: "{ a }" })).rejects.toBeInstanceOf(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("response body failures", function () {
	it("retries a multipart body failing mid-read as a network failure", async function () {
		let calls = 0;
		const client = new Client({
			url: URL,
			retry: { attempts: 1, delay: 0 },
			fetch: async function flaky() {
				if (++calls > 1) return Response.json({ data: { a: 1 } });

				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'\r\n--graphql\r\nContent-Type: application/json\r\n\r\n{"data":{"a":0},',
							),
						);
						controller.error(new TypeError("terminated"));
					},
				});

				return new Response(stream, { headers: { "Content-Type": 'multipart/mixed; boundary="graphql"' } });
			} as typeof fetch,
		});

		await expect(client.gql({ query: "{ a ... @defer { b } }" })).resolves.toEqual({ a: 1 });
		expect(calls).toBe(2);
	});

	it("reports a non-object incremental payload as a ClientError", async function () {
		const client = new Client({
			url: URL,
			fetch: async function hostile() {
				return multipart(['{"data":{"a":1},"hasNext":true}', "5"]);
			} as typeof fetch,
		});
		const error = await client.gql({ query: "{ a ... @defer { b } }" }).catch(function capture(caught: unknown) {
			return caught;
		});

		expect(isClientError(error)).toBe(true);
	});
});
