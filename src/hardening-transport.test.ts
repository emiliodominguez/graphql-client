import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";

/**
 * Regressions in the HTTP transport hardening (raceAbort). Every test asserts the CORRECT behavior.
 */

const URL = "https://attack2.test/graphql";

async function tick(ms = 0): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

describe("subscribe(): response arriving after the abort", function () {
	it("cancels the body of a streaming response that arrives after the subscription was aborted", async function () {
		let cancelled = false;
		let respond: (response: Response) => void = function () {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"data":{"tick":1}}\n\n'));
			},
			cancel() {
				cancelled = true;
			},
		});
		// e.g. a token-refresh middleware that rebuilds the Request (dropping its signal), or a custom fetch.
		const fetchMock = vi.fn<typeof fetch>(function () {
			return new Promise<Response>(function (resolve) {
				respond = resolve;
			});
		});
		const client = new Client({ url: URL, fetch: fetchMock });
		const controller = new AbortController();
		const iterator = client
			.subscribe({ query: "subscription { tick }", signal: controller.signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();

		await tick();
		controller.abort();
		await expect(first).rejects.toThrow();

		// The server answers late: nobody will ever read this event stream, so it must be closed.
		respond(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
		await tick(10);

		expect(cancelled).toBe(true);
	});
});
