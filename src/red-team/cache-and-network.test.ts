import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import type { QueryState } from "../types";

const URL = "https://test.dev/graphql";
const TODOS = "query Todos { todos }";

function delay(ms: number) {
	return new Promise(function wait(resolve) {
		setTimeout(resolve, ms);
	});
}

describe("cache-and-network live query on a cache hit", function suite() {
	it("surfaces the failure of its network half in `error` (like any refetch)", async function run() {
		let fail = false;
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			await delay(10);
			if (fail) return Response.json({ errors: [{ message: "server down" }] });
			return Response.json({ data: { todos: ["a"] } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.gql({ query: TODOS });
		fail = true;

		const states: QueryState<unknown>[] = [];
		const ref = client.watch({ query: TODOS, fetchPolicy: "cache-and-network" });
		const stop = ref.subscribe(function listen(state) {
			states.push(state);
		});

		await delay(50);
		stop();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The revalidation failed: the stale data stays, and the error shows (refetch() does exactly this).
		expect(ref.getState().data).toEqual({ todos: ["a"] });
		expect(ref.getState().error).toBeDefined();
	});

	it("reports `loading` while the background request runs", async function run() {
		let release!: () => void;
		let calls = 0;
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			if (++calls > 1) {
				await new Promise<void>(function hold(resolve) {
					release = resolve;
				});
			}
			return Response.json({ data: { todos: ["a"] } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.gql({ query: TODOS });

		const ref = client.watch({ query: TODOS, fetchPolicy: "cache-and-network" });
		const stop = ref.subscribe(function listen() {});

		await delay(20);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const during = ref.getState().loading;
		release();
		await delay(20);
		stop();

		expect(during).toBe(true);
	});
});
