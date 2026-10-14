// Runtime red-team: dual package hazard. An ESM app and a CJS dependency (or two bundled copies) each load lumenql
// and share one MemoryCache. Real repro with the packed tarball: scratchpad/runtimes/consumer/dual.mjs
import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { MemoryCache } from "./cache/memory-cache";
import { isRetryable } from "./retry";

const QUERY = "query Todos { todos }";

async function loadSecondCopy(): Promise<typeof import("./client")> {
	vi.resetModules();

	return import("./client");
}

function fetchCounter() {
	let n = 0;

	return function fetchMock(): Promise<Response> {
		return Promise.resolve(Response.json({ data: { todos: ++n } }));
	} as typeof fetch;
}

/**
 * Waits for pending timers and microtasks to run.
 *
 * @param ms - The delay in milliseconds
 * @returns A promise that resolves after the delay
 */
function tick(ms = 20) {
	return new Promise(function wait(resolve) {
		setTimeout(resolve, ms);
	});
}

describe("runtime: two module copies sharing a cache", function () {
	it("loads a genuinely separate module copy", async function () {
		const copy = await loadSecondCopy();

		expect(copy.Client).not.toBe(Client);
	});

	it("pushes write() from one copy to live queries of the other copy", async function () {
		const { Client: OtherClient } = await loadSecondCopy();
		const cache = new MemoryCache();
		const app = new Client({ url: "https://x.test/graphql", cache, fetch: fetchCounter() });
		const lib = new OtherClient({ url: "https://x.test/graphql", cache, fetch: fetchCounter() });
		const ref = lib.watch({ key: ["todos"], query: QUERY });
		const unsubscribe = ref.subscribe(function ignore() {});

		await tick();
		await app.write({ key: ["todos"], query: QUERY }, { todos: 999 });
		await tick();

		expect(await app.read({ key: ["todos"], query: QUERY })).toEqual({ todos: 999 });
		expect(ref.getState().data).toEqual({ todos: 999 });
		unsubscribe();
	});

	it("refetches live queries of the other copy on invalidate()", async function () {
		const { Client: OtherClient } = await loadSecondCopy();
		const cache = new MemoryCache();
		const app = new Client({ url: "https://x.test/graphql", cache, fetch: fetchCounter() });
		const lib = new OtherClient({ url: "https://x.test/graphql", cache, fetch: fetchCounter() });
		const ref = lib.watch({ key: ["todos"], query: QUERY });
		const unsubscribe = ref.subscribe(function ignore() {});

		await tick();
		expect(ref.getState().data).toEqual({ todos: 1 });

		await app.invalidate(["todos"]);
		await tick();

		// The entry is gone from the shared cache, but the other copy's live query was never told.
		expect(ref.getState().data).toEqual({ todos: 2 });
		unsubscribe();
	});

	it("isRetryable() from one copy recognizes network failures raised through the other copy", async function () {
		const { Client: OtherClient } = await loadSecondCopy();
		const failing = new OtherClient({
			url: "https://x.test/graphql",
			fetch: function failingFetch() {
				return Promise.reject(new TypeError("fetch failed"));
			} as typeof fetch,
		});
		const error = await failing.gql({ query: QUERY }).catch(function identity(e: unknown) {
			return e;
		});

		// README: `retryIf(error, ctx) { return isRetryable(error, ctx) || ... }` with the app's copy of isRetryable.
		expect(isRetryable(error, { type: "query", query: QUERY, variables: undefined, attempt: 0 })).toBe(true);
	});
});
