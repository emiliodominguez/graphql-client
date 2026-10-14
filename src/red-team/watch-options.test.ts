import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { optimistic } from "../optimistic";

const URL = "https://test.dev/graphql";

function delay(ms: number) {
	return new Promise(function wait(resolve) {
		setTimeout(resolve, ms);
	});
}

describe("watch options inherited from RequestOptions", function suite() {
	it("a watched query carrying `invalidates` for its own key does not refetch in a loop", async function run() {
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			// Safety valve: without it the loop runs on microtasks only and starves every timer (the page freezes).
			if (fetchMock.mock.calls.length > 50) return new Promise<Response>(function never() {});
			return Response.json({ data: { todos: ["a"] } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		// Same options object reused for gql and watch (the type accepts it).
		const options = { key: ["todos"], query: "query Todos { todos }", invalidates: [["todos"]] } as const;
		const ref = client.watch(options);
		const stop = ref.subscribe(function listen() {});

		await delay(200);
		stop();

		expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
	});

	it("a watched query carrying `optimistic` does not re-apply the update on each refetch", async function run() {
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			return Response.json({ data: { count: 1 } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const TODOS = "query Todos { todos }";

		await client.write({ key: ["todos"], query: TODOS }, { todos: ["a"] });

		const ref = client.watch({
			query: "query C { count }",
			// @ts-expect-error not a watch option anymore: untyped callers may still pass it
			optimistic: [
				optimistic({ key: ["todos"], query: TODOS }, function add(current: any) {
					return { todos: [...(current?.todos ?? []), "temp"] };
				}),
			],
		});
		const stop = ref.subscribe(function listen() {});

		await delay(20);
		await ref.refetch();
		await ref.refetch();
		await delay(20);
		stop();

		// Polling / refetching a query must not keep appending optimistic "temp" items to another entry.
		expect(await client.read({ key: ["todos"], query: TODOS })).toEqual({ todos: ["a"] });
	});
});
