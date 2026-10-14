// Runtime red-team: degraded runtimes (polyfilled AbortController without `throwIfAborted`/`reason` — React Native's
// `abort-controller` polyfill, older jsdom; no global `DOMException` — Hermes). Real repro against a real server:
// scratchpad/runtimes/consumer/env.mjs (run all with env-all.sh).
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "./client";

const DEFER = "query P { product { id ... @defer { reviews } } }";

function multipartFetch(): Promise<Response> {
	const body =
		`\r\n---\r\nContent-Type: application/json\r\n\r\n` +
		JSON.stringify({ data: { product: { id: "1" } }, pending: [{ id: "0", path: ["product"] }], hasNext: true }) +
		`\r\n---\r\nContent-Type: application/json\r\n\r\n` +
		JSON.stringify({ incremental: [{ id: "0", data: { reviews: [] } }], completed: [{ id: "0" }], hasNext: false }) +
		`\r\n-----\r\n`;

	return Promise.resolve(
		new Response(body, { headers: { "Content-Type": 'multipart/mixed; boundary="-"; deferSpec=20220824' } }),
	);
}

const restore: Array<() => void> = [];

afterEach(function () {
	for (const fn of restore.splice(0)) fn();
});

describe("runtime: degraded globals", function () {
	it("completes a successful @defer query when AbortSignal has no throwIfAborted()", async function () {
		const original = AbortSignal.prototype.throwIfAborted;

		// @ts-expect-error emulate a polyfilled AbortSignal
		delete AbortSignal.prototype.throwIfAborted;
		restore.push(function restoreThrowIfAborted() {
			AbortSignal.prototype.throwIfAborted = original;
		});

		const client = new Client({ url: "https://x.test/graphql", fetch: multipartFetch as typeof fetch });

		await expect(client.gql({ query: DEFER })).resolves.toEqual({ product: { id: "1", reviews: [] } });
	});

	it("still times out (no uncaught ReferenceError, no hang) when DOMException is not a global", async function () {
		const original = globalThis.DOMException;
		const uncaught: unknown[] = [];
		function capture(error: unknown) {
			uncaught.push(error);
		}

		process.prependListener("uncaughtException", capture);
		// @ts-expect-error emulate a runtime without DOMException (e.g. Hermes)
		delete globalThis.DOMException;
		restore.push(function restoreGlobals() {
			globalThis.DOMException = original;
			process.removeListener("uncaughtException", capture);
		});

		// A server that never answers: only the timeout can end the request.
		const hanging = function hanging(input: RequestInfo | URL, init?: RequestInit) {
			return new Promise(function never(_resolve, reject) {
				const signal = input instanceof Request ? input.signal : init!.signal!;

				signal.addEventListener("abort", function onAbort() {
					reject(signal.reason);
				});
			});
		} as typeof fetch;
		const client = new Client({ url: "https://x.test/graphql", fetch: hanging });
		const outcome = await Promise.race([
			client.gql({ query: "query Q { x }", timeout: 30 }).then(
				function resolved() {
					return "resolved";
				},
				function rejected(error: unknown) {
					return (error as Error)?.name;
				},
			),
			new Promise(function hang(resolve) {
				setTimeout(function timeout() {
					resolve("HUNG");
				}, 1_000);
			}),
		]);

		expect(uncaught.map(String)).toEqual([]);
		expect(outcome).toBe("TimeoutError");
	});
});
