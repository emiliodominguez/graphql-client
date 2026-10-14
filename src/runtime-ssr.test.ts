// Runtime red-team: streaming SSR in plain Node (no window/document) with useSuspenseQuery.
// Real repro against a real server: scratchpad/runtimes/consumer/ssr.mjs (basic | poll | memory):
// the process stays alive ~10 s after every streaming render, and a pollInterval keeps polling the API meanwhile.
import { createElement, Suspense } from "react";
import { renderToPipeableStream } from "react-dom/server";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { MemoryCache } from "./cache/memory-cache";
import { GraphQLProvider, useSuspenseQuery } from "./react";

afterEach(function () {
	vi.restoreAllMocks();
});

function Todos() {
	const { data } = useSuspenseQuery<{ n: number }>({ key: ["todos"], query: "query T { n }", pollInterval: 25 });

	return createElement("p", null, `n=${data.n}`);
}

function render(client: Client): Promise<string> {
	return new Promise(function (resolve, reject) {
		let html = "";
		const sink = new Writable({
			write(chunk, _encoding, callback) {
				html += chunk;
				callback();
			},
			final(callback) {
				resolve(html);
				callback();
			},
		});
		const { pipe } = renderToPipeableStream(
			createElement(
				GraphQLProvider,
				{ client },
				createElement(Suspense, { fallback: "loading" }, createElement(Todos)),
			),
			{
				onAllReady: function onAllReady() {
					pipe(sink);
				},
				onShellError: reject,
				onError: reject,
			},
		);
	});
}

describe("runtime: streaming SSR with useSuspenseQuery", function () {
	it("stops all background work once the server render finished (no polling, no process-holding timers)", async function () {
		let requests = 0;
		const client = new Client({
			url: "https://x.test/graphql",
			cache: new MemoryCache(),
			fetch: function countingFetch() {
				return Promise.resolve(Response.json({ data: { n: ++requests } }));
			} as typeof fetch,
		});
		const timers: Array<{ delay: number | undefined; handle: NodeJS.Timeout }> = [];
		const realSetTimeout = globalThis.setTimeout;

		vi.spyOn(globalThis, "setTimeout").mockImplementation(function (
			callback: (...args: unknown[]) => void,
			delay?: number,
			...rest: unknown[]
		) {
			const handle = realSetTimeout(callback, delay, ...rest);

			timers.push({ delay, handle });
			return handle;
		} as typeof setTimeout);

		expect(await render(client)).toContain("n=1");
		vi.restoreAllMocks();

		await new Promise(function wait(resolve) {
			realSetTimeout(resolve, 300);
		});

		// The render needed one request; the server must not keep polling the API after the response was sent.
		expect(requests).toBe(1);
		// Nothing scheduled by the render may keep the Node process alive (SUSPENSE_RETENTION = 10 s).
		expect(
			timers
				.filter(function isLongLived(t) {
					return (t.delay ?? 0) >= 1_000 && t.handle.hasRef();
				})
				.map(function delayOf(t) {
					return t.delay;
				}),
		).toEqual([]);

		for (const { handle } of timers) clearTimeout(handle);
	});
});
