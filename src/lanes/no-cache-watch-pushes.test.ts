import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { URL, TODOS, type Todos, heldServer, take, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

describe("no-cache live queries and pushed data", function () {
	it("shows its own fresh fetch result, not an older response pushed while it was fetching", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos>({ ...TARGET, fetchPolicy: "no-cache" });
		const unsubscribe = ref.subscribe(function noop() {});

		await tick();
		take(held, "Todos").respond({ data: { todos: ["v0"] } });
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["v0"] });

		// Some other consumer requests the entry first (cache-first, miss)...
		const older = client.gql<Todos>(TARGET);
		await tick();
		// ...then the live query refetches: its request is strictly newer.
		const refetch = ref.refetch();
		await tick();

		// The older request lands first and is pushed to the live query (fine at that point)...
		held.shift()!.respond({ data: { todos: ["v1"] } });
		await older;
		expect(ref.getState().data).toEqual({ todos: ["v1"] });

		// ...then the live query's own, newer result arrives.
		held.shift()!.respond({ data: { todos: ["v2"] } });
		const state = await refetch;

		// The refetch resolved with v1, older than what it fetched (v2), and nothing will ever bring v2 back.
		expect(state.data).toEqual({ todos: ["v2"] });
		unsubscribe();
	});
});
