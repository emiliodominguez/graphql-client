import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";

/**
 * abort semantics of `subscribe()` and hostile incremental paths. Every test asserts the CORRECT
 * behavior.
 */

const URL = "https://hardening.test/graphql";

function race<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
	return Promise.race([
		promise,
		new Promise<"timed out">(function (resolve) {
			setTimeout(function () {
				resolve("timed out");
			}, ms);
		}),
	]);
}

describe("subscribe(): abort while a header resolver is stalled", function () {
	it("ends quietly as soon as the signal aborts (like gql, whose header resolution is raced)", async function () {
		const fetchMock = vi.fn<typeof fetch>();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			// e.g. a token refresh hanging on a dead auth server
			authToken: function () {
				return new Promise<string>(function () {});
			},
		});
		const controller = new AbortController();
		const iterator = client
			.subscribe({ query: "subscription { tick }", signal: controller.signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();

		await new Promise(function (resolve) {
			setTimeout(resolve, 5);
		});
		controller.abort();

		await expect(race(first, 100)).resolves.toEqual({ done: true, value: undefined });
	});

	it("gql: the same stalled resolver does not outlive the abort (control)", async function () {
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(),
			authToken: function () {
				return new Promise<string>(function () {});
			},
		});
		const controller = new AbortController();
		const pending = client.gql({ query: "{ a }", signal: controller.signal }).catch(function (error: unknown) {
			return error;
		});

		controller.abort();

		expect(await race(pending, 100)).not.toBe("timed out");
	});
});

describe("hostile incremental paths", function () {
	it("a deferred payload pointing far past the end of a list does not create a 4-billion-element array", async function () {
		const body =
			'\r\n--graphql\r\nContent-Type: application/json\r\n\r\n{"data":{"list":[]},"hasNext":true}' +
			'\r\n--graphql\r\nContent-Type: application/json\r\n\r\n{"incremental":[{"path":["list",4294967294],"data":{"x":1}}],"hasNext":false}' +
			"\r\n--graphql--\r\n";
		const client = new Client({
			url: URL,
			fetch: vi.fn<typeof fetch>(async function () {
				return new Response(body, { headers: { "Content-Type": 'multipart/mixed; boundary="graphql"' } });
			}),
		});
		const data = await client.gql<{ list: unknown[] }>({ query: "{ list { ... @defer { x } } }" }).catch(function () {
			return { list: [] };
		});

		// 60 bytes from the server must not make every `data.list.map(...)` iterate 2^32 holes.
		expect(data.list.length).toBeLessThan(1_000);
	});
});
