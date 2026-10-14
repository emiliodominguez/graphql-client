import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { optimistic } from "./optimistic";
import type { Cache } from "./types";

/**
 * Regressions in the cache-layer hardening. Every test asserts the CORRECT behavior and fails while the bug exists.
 */

const URL = "https://attack2.test/graphql";
const TODOS = "query Todos { todos }";
const OTHER = "query Other($n: Int) { other(n: $n) }";
const ADD = "mutation Add { add }";

async function tick(ms = 0): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

function gate(): { promise: Promise<void>; open: () => void } {
	let open: () => void = function () {};
	const promise = new Promise<void>(function (resolve) {
		open = resolve;
	});

	return { promise, open };
}

describe("#store: late cleanup after a slow write", function () {
	it("does not delete data written AFTER the invalidation when an older slow write finishes", async function () {
		// Write-through adapter: the value is visible at once, persistence (the returned promise) is slow.
		const inner = new MemoryCache({ ttl: Infinity });
		const slow = gate();
		const cache: Cache = {
			get: function get<T>(key: string): T | undefined {
				return inner.get<T>(key);
			},
			set: function set<T>(key: string, value: T): Promise<void> | void {
				inner.set(key, value);
				if ((value as { todos?: string }).todos === "A") return slow.promise;
			},
			delete: function del(key: string): boolean {
				return inner.delete(key);
			},
			clear: function clear(): void {
				inner.clear();
			},
			keys: function keys(): string[] {
				return inner.keys();
			},
		};
		const client = new Client({ url: URL, cache, fetch: vi.fn<typeof fetch>() });
		const target = { key: ["todos"], query: TODOS };

		const writeA = client.write(target, { todos: "A" });

		await client.invalidate(["todos"]);
		await client.write(target, { todos: "B" });
		expect(await client.read(target)).toEqual({ todos: "B" });

		// A's persistence completes: its cleanup must only drop A, never the newer B.
		slow.open();
		await writeA;

		expect(await client.read(target)).toEqual({ todos: "B" });
	});
});

describe("#store vs optimistic layers", function () {
	it("a rollback never restores data older than a store that was in flight when the layer was applied", async function () {
		const inner = new MemoryCache({ ttl: Infinity });
		const slow = gate();
		const cache: Cache = {
			async get<T>(key: string): Promise<T | undefined> {
				return inner.get<T>(key);
			},
			async set<T>(key: string, value: T): Promise<void> {
				// A slow async store (IndexedDB-like) commits the value when its transaction completes.
				if ((value as { todos?: string }).todos === "NEW") await slow.promise;
				inner.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				return inner.delete(key);
			},
			async clear(): Promise<void> {
				inner.clear();
			},
			async keys(): Promise<string[]> {
				return inner.keys();
			},
		};
		const failMutation = gate();
		const fetchMock = vi.fn<typeof fetch>(async function () {
			await failMutation.promise;
			return Response.json({ errors: [{ message: "nope" }] });
		});
		const client = new Client({ url: URL, cache, fetch: fetchMock });
		const target = { key: ["todos"], query: TODOS };

		await client.write(target, { todos: "OLD" });

		// Real data NEW is being stored (slow adapter)...
		const writeNew = client.write(target, { todos: "NEW" });

		await tick();

		// ...when an optimistic mutation starts on the same entry.
		const mutation = client.gql({
			query: ADD,
			optimistic: [
				optimistic(target, function (current: { todos: string } | undefined) {
					return { todos: `${current?.todos}+optimistic` };
				}),
			],
		});

		await tick();
		slow.open();
		await writeNew;

		// The mutation fails: its layer is rolled back. NEW was written after OLD and must survive the rollback.
		failMutation.open();
		await expect(mutation).rejects.toThrow("nope");
		await tick();

		expect(await client.read(target)).toEqual({ todos: "NEW" });
	});

	it("applying an optimistic layer is not starved by unrelated stores completing on other entries", async function () {
		// Reads take a few milliseconds (async storage).
		const inner = new MemoryCache({ ttl: Infinity, maxSize: 10_000 });
		const cache: Cache = {
			async get<T>(key: string): Promise<T | undefined> {
				const value = inner.get<T>(key);
				await tick(5);
				return value;
			},
			async set<T>(key: string, value: T): Promise<void> {
				inner.set(key, value);
			},
			async delete(key: string): Promise<boolean> {
				return inner.delete(key);
			},
			async clear(): Promise<void> {
				inner.clear();
			},
			async keys(): Promise<string[]> {
				return inner.keys();
			},
		};
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { add: true } });
		});
		const client = new Client({ url: URL, cache, fetch: fetchMock });
		// Another, unrelated client (own cache) keeps storing data, e.g. a live ticker feeding `write`.
		const ticker = new Client({ url: URL, cache: new MemoryCache({ ttl: Infinity }), fetch: vi.fn<typeof fetch>() });
		let running = true;
		let n = 0;

		const feed = (async function () {
			while (running) {
				await ticker.write({ key: ["ticker"], query: OTHER, variables: { n: n % 3 } }, { other: n++ });
				await tick(1);
			}
		})();

		const mutation = client.gql({
			query: ADD,
			optimistic: [
				optimistic({ key: ["todos"], query: TODOS }, function () {
					return { todos: "optimistic" };
				}),
			],
		});

		await tick(150);
		const sentWhileTickerRuns = fetchMock.mock.calls.length;

		running = false;
		await feed;
		await mutation;

		// The mutation request must not wait for an unrelated client to stop writing.
		expect(sentWhileTickerRuns).toBe(1);
	});
});

describe("invalidate(): failing deletes", function () {
	it("still deletes every other key when one delete throws synchronously", async function () {
		const inner = new MemoryCache({ ttl: Infinity });
		const cache: Cache = {
			get: function get<T>(key: string): T | undefined {
				return inner.get<T>(key);
			},
			set: function set<T>(key: string, value: T): void {
				inner.set(key, value);
			},
			delete: function del(key: string): boolean {
				// e.g. a storage-backed adapter whose removeItem throws (SecurityError) for one entry.
				if (key.includes('"a"')) throw new Error("delete failed");
				return inner.delete(key);
			},
			clear: function clear(): void {
				inner.clear();
			},
			keys: function keys(): string[] {
				return inner.keys();
			},
		};
		const client = new Client({ url: URL, cache, fetch: vi.fn<typeof fetch>() });

		await client.write({ key: ["list", "a"], query: TODOS }, { todos: 1 });
		await client.write({ key: ["list", "b"], query: TODOS }, { todos: 2 });

		await expect(client.invalidate(["list"])).rejects.toThrow("delete failed");

		// The failure of "a" must not keep "b" (and anything after it) in the cache.
		expect(await client.read({ key: ["list", "b"], query: TODOS })).toBeUndefined();
	});

	it("applies every `invalidates` prefix of a successful request even when one of them fails", async function () {
		const inner = new MemoryCache({ ttl: Infinity });
		const cache: Cache = {
			get: function get<T>(key: string): T | undefined {
				return inner.get<T>(key);
			},
			set: function set<T>(key: string, value: T): void {
				inner.set(key, value);
			},
			delete: async function del(key: string): Promise<boolean> {
				if (key.includes('"a"')) throw new Error("delete failed");
				return inner.delete(key);
			},
			clear: function clear(): void {
				inner.clear();
			},
			keys: function keys(): string[] {
				return inner.keys();
			},
		};
		const onError = vi.fn();
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { add: true } });
		});
		const client = new Client({ url: URL, cache, fetch: fetchMock, onError });

		await client.write({ key: ["a"], query: TODOS }, { todos: 1 });
		await client.write({ key: ["b"], query: TODOS }, { todos: 2 });

		await client.gql({ query: ADD, invalidates: [["a"], ["b"]] });

		expect(onError).toHaveBeenCalledTimes(1);
		// ["b"] is unrelated to the failure of ["a"]: it must still be invalidated.
		expect(await client.read({ key: ["b"], query: TODOS })).toBeUndefined();
	});
});

describe("deepFreeze", function () {
	it("deeply freezes written data even when its root was already (shallowly) frozen", async function () {
		const client = new Client({ url: URL, cache: new MemoryCache(), fetch: vi.fn<typeof fetch>() });
		const target = { key: ["todos"], query: TODOS };

		await client.write(target, Object.freeze({ todos: [1, 2] }));

		const shared = (await client.read<{ todos: number[] }>(target))!;

		// A consumer mutating the shared result must not corrupt the cache.
		expect(Object.isFrozen(shared.todos)).toBe(true);
	});
});
