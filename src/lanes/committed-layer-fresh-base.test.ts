import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { optimistic } from "../optimistic";
import type { Cache } from "../types";
import { ADD, URL, TODOS, type Todos, heldServer, parkedCache, releaseAll, releaseFirst, take, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

describe("committed optimistic layers", function () {
	it("drop a succeeded layer when the real data under it was requested after the operation started", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write<Todos>(TARGET, { todos: ["a"] });

		const ref = client.watch<Todos>(TARGET);
		const unsubscribe = ref.subscribe(function noop() {});
		const mutation = client.gql({
			query: ADD,
			variables: { title: "b" },
			optimistic: [
				optimistic<Todos, Record<string, unknown>>(TARGET, function add(current) {
					return { todos: [...(current?.todos ?? []), "placeholder"] };
				}),
			],
		});

		await tick();
		// Newer real data (it may already contain the operation's effect) lands while the mutation is pending.
		await client.write<Todos>(TARGET, { todos: ["a", "b"] });
		take(held, "Add").respond({ data: { add: "b" } });
		await mutation;
		await tick();

		// The placeholder never stays on top of data requested after the operation started.
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });
		expect(await client.read<Todos>(TARGET)).toEqual({ todos: ["a", "b"] });
		unsubscribe();
	});
});

describe("a store dropped because an invalidation overtook it", function () {
	it("makes live queries that read it meanwhile refetch", async function () {
		const { fetchMock, held } = heldServer();
		const parked = parkedCache();
		// The invalidation fails to list the keys: only the store's own check can drop its outdated data.
		const cache: Cache = {
			...parked.cache,
			keys: function failingKeys() {
				throw new Error("keys failed");
			},
		};
		const client = new Client({ url: URL, fetch: fetchMock, cache, onError: function ignore() {} });
		const write = client.write<Todos>(TARGET, { todos: ["outdated"] });

		await tick();
		await expect(client.invalidate([])).rejects.toThrow("keys failed");

		// A live query reads the value while the (now outdated) store is still being written.
		const ref = client.watch<Todos>(TARGET);
		const unsubscribe = ref.subscribe(function noop() {});

		await tick();
		await releaseFirst(parked.parked, "get");
		// The store lands, sees the invalidation and drops its data.
		await releaseAll(parked.parked);
		await write;
		await tick();

		expect(parked.store.size).toBe(0);
		// The live query does not keep showing the dropped value as if it were cached: it refetches.
		expect(held.length).toBe(1);
		unsubscribe();
	});
});
