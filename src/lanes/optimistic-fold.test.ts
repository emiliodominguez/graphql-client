import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { optimistic } from "../optimistic";
import type { OptimisticUpdate } from "../types";
import { ADD, URL, TODOS, type Todos, heldServer, parkedCache, releaseAll, take, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

function addTodo(title: string): OptimisticUpdate<unknown, unknown> {
	return optimistic<Todos, Record<string, unknown>>(TARGET, function add(current) {
		return { todos: [...(current?.todos ?? []), title] };
	});
}

describe("committed optimistic layers are folded into real data requested before the operation", function () {
	it("folds into a response whose request was the last sequenced event before the mutation (off-by-one)", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write<Todos>(TARGET, { todos: ["a"] });

		// A refetch of the list is sent BEFORE the mutation: its response cannot contain the mutation's effect.
		const refetch = client.gql<Todos>({ ...TARGET, fetchPolicy: "network-only" });
		await tick();

		const mutation = client.gql({ query: ADD, variables: { title: "new" }, optimistic: [addTodo("new")] });
		await tick();

		take(held, "Todos").respond({ data: { todos: ["a", "b"] } });
		await refetch;
		expect(await client.read<Todos>(TARGET)).toEqual({ todos: ["a", "b", "new"] });

		take(held, "Add").respond({ data: { add: true } });
		await mutation;

		// The mutation succeeded and nothing requested after it arrived: its effect must stay.
		expect(await client.read<Todos>(TARGET)).toEqual({ todos: ["a", "b", "new"] });
	});

	it("folds into fetchMore pages requested before the mutation (merge took a post-mutation order)", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const target = { ...TARGET, variables: { after: null } };

		await client.write<Todos>(target, { todos: ["a"] });

		const ref = client.watch<Todos>(target);
		const unsubscribe = ref.subscribe(function noop() {});
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["a"] });

		// Page 2 is requested before the mutation is sent.
		const more = ref.fetchMore({
			variables: { after: "a" },
			merge: function (previous, next) {
				return { todos: [...previous.todos, ...next.todos] };
			},
		});
		await tick();

		const mutation = client.gql({
			query: ADD,
			variables: { title: "new" },
			optimistic: [
				optimistic<Todos, Record<string, unknown>>(target, function add(current) {
					return { todos: [...(current?.todos ?? []), "new"] };
				}),
			],
		});
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["a", "new"] });

		take(held, "Todos").respond({ data: { todos: ["p"] } });
		await more;
		expect(ref.getState().data).toEqual({ todos: ["a", "p", "new"] });

		take(held, "Add").respond({ data: { add: true } });
		await mutation;
		await tick();

		// Neither the old base nor page 2 (requested before the mutation) contains "new": success keeps it.
		expect(await client.read<Todos>(target)).toEqual({ todos: ["a", "p", "new"] });
		expect(ref.getState().data).toEqual({ todos: ["a", "p", "new"] });
		unsubscribe();
	});

	it("rebases onto a response that arrived before the success, even when its store is still queued (async cache)", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, store, parked } = parkedCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });
		const seed = client.write<Todos>(TARGET, { todos: ["a"] });
		await releaseAll(parked);
		await seed;
		const cacheKey = [...store.keys()][0]!;

		// Refetch sent before the mutation.
		const refetch = client.gql<Todos>({ ...TARGET, fetchPolicy: "network-only" });
		await tick();
		// Something unrelated gets sequenced in between (rules out the off-by-one of the first test).
		const other = client.write({ key: ["other"], query: TODOS }, { todos: [] });
		await releaseAll(parked);
		await other;

		const mutation = client.gql({ query: ADD, variables: { title: "new" }, optimistic: [addTodo("new")] });
		await releaseAll(parked);
		expect(store.get(cacheKey)).toEqual({ todos: ["a", "new"] });

		// A second optimistic mutation on the entry: its render is slow (set pending), the lane is busy.
		const second = client.gql({ query: ADD, variables: { title: "new2" }, optimistic: [addTodo("new2")] });
		await tick();
		expect(
			parked.some(function (call) {
				return call.kind === "set";
			}),
		).toBe(true);

		// The refetch's response arrives during the first mutation (its store queues behind the pending set)...
		take(held, "Todos").respond({ data: { todos: ["a", "b"] } });
		await tick();
		// ...then the first mutation succeeds.
		take(held, "Add").respond({ data: { add: true } });
		await tick();

		await releaseAll(parked);
		await refetch;
		await mutation;
		await releaseAll(parked);

		// "Server responses arriving meanwhile rebase the layers, and a success keeps it."
		expect(store.get(cacheKey)).toEqual({ todos: ["a", "b", "new", "new2"] });

		take(held, "Add").respond({ data: { add: true } });
		await releaseAll(parked);
		await second;
	});
});
