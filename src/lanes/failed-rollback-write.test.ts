import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { optimistic } from "../optimistic";
import type { Cache } from "../types";
import { ADD, URL, TODOS, type Todos, heldServer, take, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

/**
 * A memory cache whose writes (or deletes) can be made to fail.
 *
 * @returns The cache and its fault switches
 */
function faultyCache(): { cache: Cache; faults: { get: boolean; set: boolean; delete: boolean; keys: boolean } } {
	const memory = new MemoryCache();
	const faults = { get: false, set: false, delete: false, keys: false };
	const cache: Cache = {
		get: function <T>(key: string) {
			if (faults.get) throw new Error("get failed");
			return memory.get<T>(key);
		},
		set: function <T>(key: string, value: T) {
			if (faults.set) throw new Error("quota exceeded");
			return memory.set(key, value);
		},
		delete: function (key: string) {
			if (faults.delete) throw new Error("delete failed");
			return memory.delete(key);
		},
		clear: function () {
			return memory.clear();
		},
		keys: function () {
			if (faults.keys) throw new Error("keys failed");
			return memory.keys();
		},
	};

	return { cache, faults };
}

function addNew(): ReturnType<typeof optimistic> {
	return optimistic<Todos, Record<string, unknown>>(TARGET, function add(current) {
		return { todos: [...(current?.todos ?? []), "optimistic"] };
	});
}

describe("a rollback whose cache write fails", function () {
	it("never leaves the rolled-back optimistic data on screen (the cache write of the real data failed)", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, faults } = faultyCache();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache,
			onError: function ignore() {},
		});

		await client.write<Todos>(TARGET, { todos: ["a"] });

		const ref = client.watch<Todos>(TARGET);
		const unsubscribe = ref.subscribe(function noop() {});
		await tick();

		const mutation = client.gql({ query: ADD, variables: { title: "x" }, optimistic: [addNew()] });
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["a", "optimistic"] });

		// The cache starts failing writes (storage full), then the mutation fails.
		faults.set = true;
		take(held, "Add").respond({ errors: [{ message: "nope" }] });
		await expect(mutation).rejects.toThrow("nope");
		await tick();

		// The cache entry was dropped (reads as a miss), but the live query must not keep showing the rolled-back
		// optimistic item: either the real data or a refetch.
		const shown = ref.getState().data;
		const refetching = held.length > 0;

		expect(shown?.todos.includes("optimistic") && !refetching).toBe(false);
		unsubscribe();
	});

	it("never leaves the rolled-back optimistic data on screen (the entry had no real data and its delete failed)", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, faults } = faultyCache();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache,
			onError: function ignore() {},
		});
		// A no-cache live query: the cache entry is empty, the optimistic placeholder is rendered into it.
		const ref = client.watch<Todos>({ ...TARGET, fetchPolicy: "no-cache" });
		const unsubscribe = ref.subscribe(function noop() {});
		await tick();
		take(held, "Todos").respond({ data: { todos: ["server"] } });
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["server"] });

		const mutation = client.gql({ query: ADD, variables: { title: "x" }, optimistic: [addNew()] });
		await tick();
		expect(ref.getState().data).toEqual({ todos: ["optimistic"] });

		faults.delete = true;
		take(held, "Add").respond({ errors: [{ message: "nope" }] });
		await expect(mutation).rejects.toThrow("nope");
		await tick();

		const shown = ref.getState().data;

		expect(shown?.todos.includes("optimistic") ?? false).toBe(false);
		unsubscribe();
	});

	it("never leaves the rolled-back optimistic data in the cache when the invalidation could not list the keys", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, faults } = faultyCache();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache,
			onError: function ignore() {},
		});

		await client.write<Todos>(TARGET, { todos: ["a"] });

		const mutation = client.gql({ query: ADD, variables: { title: "x" }, optimistic: [addNew()] });
		await tick();
		expect(await client.read<Todos>(TARGET)).toEqual({ todos: ["a", "optimistic"] });

		// The invalidation fails before deleting anything; then the mutation fails.
		faults.keys = true;
		await expect(client.invalidate([])).rejects.toThrow("keys failed");
		faults.keys = false;
		take(held, "Add").respond({ errors: [{ message: "nope" }] });
		await expect(mutation).rejects.toThrow("nope");
		await tick();

		// Read later (e.g. by a fetchMore merge), the rolled-back item would become real data.
		expect(await client.read<Todos>(TARGET)).toBeUndefined();
	});

	it("restores the real data in the cache when the rollback cannot read the cache", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, faults } = faultyCache();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache,
			onError: function ignore() {},
		});

		await client.write<Todos>(TARGET, { todos: ["a"] });

		const mutation = client.gql({ query: ADD, variables: { title: "x" }, optimistic: [addNew()] });
		await tick();

		// Reads fail while the mutation fails and rolls back.
		faults.get = true;
		take(held, "Add").respond({ errors: [{ message: "nope" }] });
		await expect(mutation).rejects.toThrow("nope");
		await tick();
		faults.get = false;

		// The optimistic item would otherwise become the real data of the next optimistic operation.
		expect(await client.read<Todos>(TARGET)).toEqual({ todos: ["a"] });
	});
});
