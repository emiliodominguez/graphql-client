import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { StorageCache, type StorageLike } from "./cache/storage-cache";
import { Client } from "./client";
import { optimistic } from "./optimistic";
import type { Cache } from "./types";

/**
 * Attack tests: hostile / async cache adapters, re-entrant listeners and optimistic-layer bookkeeping.
 * Every test asserts the CORRECT behavior and fails while the bug exists.
 */

const URL = "https://attack.test/graphql";
const TODOS = "query Todos { todos }";
const OTHER = "query Other { other }";
const FEED = "query Feed($page: Int) { feed(page: $page) }";
const ADD = "mutation Add { add }";

/**
 * Lets pending promises and 0ms timers run.
 */
async function tick(ms = 0): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * A promise and its resolver.
 */
function gate(): { promise: Promise<void>; open: () => void } {
	let open: () => void = function () {};
	const promise = new Promise<void>(function (resolve) {
		open = resolve;
	});

	return { promise, open };
}

/**
 * Fetch mock answering `{ data: { todos: counter } }`, incrementing the counter on each call.
 */
function counterServer(): { fetchMock: ReturnType<typeof vi.fn<typeof fetch>>; calls: () => number } {
	let count = 0;
	const fetchMock = vi.fn<typeof fetch>(async function () {
		count++;
		return Response.json({ data: { todos: count } });
	});

	return {
		fetchMock,
		calls: function () {
			return count;
		},
	};
}

/**
 * Wraps a MemoryCache with optional hooks, making every operation async. Reads snapshot the store when called and
 * resolve after the hook (like an IndexedDB transaction); writes apply after the hook.
 */
function asyncCache(hooks: {
	beforeGet?: (key: string) => Promise<void> | void;
	beforeSet?: (key: string, value: unknown) => Promise<void> | void;
	beforeKeys?: () => Promise<void> | void;
}): Cache & { inner: MemoryCache } {
	const inner = new MemoryCache({ ttl: Infinity });

	return {
		inner,
		async get<T>(key: string): Promise<T | undefined> {
			// Like a real async store, the value is read when the call is made and delivered later.
			const value = inner.get<T>(key);
			await hooks.beforeGet?.(key);
			return value;
		},
		async set<T>(key: string, value: T): Promise<void> {
			await hooks.beforeSet?.(key, value);
			inner.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return inner.delete(key);
		},
		async clear(): Promise<void> {
			inner.clear();
		},
		async keys(): Promise<string[]> {
			const snapshot = inner.keys();
			await hooks.beforeKeys?.();
			return snapshot;
		},
	};
}

describe("re-entrant / throwing listeners", function () {
	it("a throwing watch listener neither breaks an unrelated gql() call nor starves other listeners", async function () {
		const { fetchMock } = counterServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<{ todos: number }>({ key: ["todos"], query: TODOS });
		const seen: Array<number | undefined> = [];

		ref.subscribe(function buggy(state) {
			if (state.data?.todos === 2) throw new Error("render bug");
		});
		ref.subscribe(function healthy(state) {
			seen.push(state.data?.todos);
		});
		await tick();
		expect(ref.getState().data).toEqual({ todos: 1 });

		// An independent caller refreshing the same entry: the network answered fine.
		await expect(client.gql({ key: ["todos"], query: TODOS, fetchPolicy: "network-only" })).resolves.toEqual({
			todos: 2,
		});
		// The healthy listener must still be told about the new data.
		expect(seen).toContain(2);
	});

	it("a throwing listener does not turn a successful refetch into a query error", async function () {
		const { fetchMock } = counterServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<{ todos: number }>({ key: ["todos"], query: TODOS, fetchPolicy: "no-cache" });
		let thrown = false;

		ref.subscribe(function buggy(state) {
			if (state.data?.todos === 1 && !thrown) {
				thrown = true;
				throw new Error("render bug");
			}
		});
		await tick();

		// The fetch succeeded: the ref must not report the listener's exception as the query's error.
		expect(ref.getState()).toEqual({ data: { todos: 1 }, error: undefined, loading: false });
	});
});

describe("StorageCache with a failing storage", function () {
	/**
	 * In-memory Web Storage whose setItem throws (quota exceeded) for values longer than `limit` characters.
	 */
	function quotaStorage(limit: number): StorageLike {
		const map = new Map<string, string>();

		return {
			getItem(key: string): string | null {
				return map.get(key) ?? null;
			},
			setItem(key: string, value: string): void {
				if (value.length > limit) throw new DOMException("quota", "QuotaExceededError");
				map.set(key, value);
			},
			removeItem(key: string): void {
				map.delete(key);
			},
			key(index: number): string | null {
				return [...map.keys()][index] ?? null;
			},
			get length(): number {
				return map.size;
			},
		};
	}

	it("a write rejected by the storage never leaves the previous (now outdated) entry in place", async function () {
		const cache = new StorageCache({ storage: quotaStorage(40) });
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: "a much longer and newer value that exceeds quota" } });
			}),
		});

		await client.write({ key: ["todos"], query: TODOS }, { todos: "old" });

		const fresh = await client.gql({ key: ["todos"], query: TODOS, fetchPolicy: "network-only" });

		expect(fresh).toEqual({ todos: "a much longer and newer value that exceeds quota" });
		// "degrades to a miss": a later cache-first read must not serve the outdated value.
		expect(await client.read({ key: ["todos"], query: TODOS })).not.toEqual({ todos: "old" });
	});

	it("a live query shows the freshly fetched data even when the storage rejects the write", async function () {
		const cache = new StorageCache({ storage: quotaStorage(40) });
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: "a much longer and newer value that exceeds quota" } });
			}),
		});

		await client.write({ key: ["todos"], query: TODOS }, { todos: "old" });

		const ref = client.watch<{ todos: string }>({ key: ["todos"], query: TODOS });

		ref.subscribe(function () {});
		await ref.refetch();

		expect(ref.getState().data).toEqual({ todos: "a much longer and newer value that exceeds quota" });
	});
});

describe("async cache adapters", function () {
	it("fetchMore merges pages with an async cache", async function () {
		const cache = asyncCache({});
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function (input) {
				const body = (await (input as Request).json()) as { variables?: { page?: number } };
				const page = body.variables?.page ?? 0;

				return Response.json({ data: { feed: [page] } });
			}),
		});
		const ref = client.watch<{ feed: number[] }, { page?: number }>({
			key: ["feed"],
			query: FEED,
			variables: { page: 0 },
		});

		ref.subscribe(function () {});
		await tick(5);
		expect(ref.getState().data).toEqual({ feed: [0] });

		await ref.fetchMore({
			variables: { page: 1 },
			merge(previous, next) {
				return { feed: [...previous.feed, ...next.feed] };
			},
		});
		await tick(5);

		expect(ref.getState().data).toEqual({ feed: [0, 1] });
	});

	it("an in-flight response never repopulates the cache after invalidate() was called (slow keys())", async function () {
		const keysGate = gate();
		const responseGate = gate();
		let slowKeys = false;
		const cache = asyncCache({
			beforeKeys() {
				return slowKeys ? keysGate.promise : undefined;
			},
		});
		let version = 0;
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				const v = ++version;
				await responseGate.promise;
				return Response.json({ data: { todos: v } });
			}),
		});

		// Request started before the invalidation (server state v1).
		const pending = client.gql({ key: ["todos"], query: TODOS });

		await tick();

		slowKeys = true;
		const invalidated = client.invalidate(["todos"]);

		// The old response lands while invalidate() is listing keys.
		responseGate.open();
		await pending;
		keysGate.open();
		await invalidated;

		// The entry was produced by a request started before the invalidation: it must not survive it.
		expect(await client.read({ key: ["todos"], query: TODOS })).toBeUndefined();
	});

	it("a write() issued before invalidate() does not survive the invalidation (slow set())", async function () {
		const setGate = gate();
		const cache = asyncCache({
			beforeSet() {
				return setGate.promise;
			},
		});
		const client = new Client({ url: URL, cache, fetch: vi.fn<typeof fetch>() });

		const written = client.write({ key: ["todos"], query: TODOS }, { todos: "written" });
		const invalidated = client.invalidate(["todos"]);

		await invalidated;
		setGate.open();
		await written;

		expect(await client.read({ key: ["todos"], query: TODOS })).toBeUndefined();
	});

	it("an optimistic update never rolls back to data older than a write made while its base was read", async function () {
		let slowGet = false;
		const getGate = gate();
		const cache = asyncCache({
			beforeGet() {
				return slowGet ? getGate.promise : undefined;
			},
		});
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ errors: [{ message: "nope" }] });
			}),
		});
		const target = { key: ["todos"], query: TODOS };

		await client.write(target, { todos: ["v1"] });

		slowGet = true;
		const mutation = client
			.gql({
				query: ADD,
				optimistic: [
					optimistic<{ todos: string[] }, Record<string, unknown>>(target, function (current) {
						return { todos: [...(current?.todos ?? []), "temp"] };
					}),
				],
			})
			.catch(function (error: unknown) {
				return error;
			});

		await tick();
		// Real data arrives while the optimistic base is being read.
		await client.write(target, { todos: ["v2"] });
		slowGet = false;
		getGate.open();
		await mutation;

		// The mutation failed: the layer is rolled back onto the NEWEST real data.
		expect(await client.read(target)).toEqual({ todos: ["v2"] });
	});
});

describe("optimistic settle with a failing cache", function () {
	it("a cache write failing while settling one layer never strands the operation's other layers", async function () {
		const inner = new MemoryCache({ ttl: Infinity });
		let failSetFor: string | undefined;
		const cache: Cache = {
			get: function <T>(key: string) {
				return inner.get<T>(key);
			},
			set: function <T>(key: string, value: T) {
				if (failSetFor !== undefined && key.includes(failSetFor)) {
					failSetFor = undefined;
					throw new Error("disk full");
				}
				inner.set(key, value);
			},
			delete: function (key: string) {
				return inner.delete(key);
			},
			clear: function () {
				inner.clear();
			},
			keys: function () {
				return inner.keys();
			},
		};
		const release = gate();
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				await release.promise;
				return Response.json({ errors: [{ message: "nope" }] });
			}),
		});
		const a = { key: ["a"], query: TODOS };
		const b = { key: ["b"], query: OTHER };

		await client.write(a, { todos: "real-a" });
		await client.write(b, { other: "real-b" });

		const mutation = client
			.gql({
				query: ADD,
				optimistic: [
					optimistic<{ todos: string }, Record<string, unknown>>(a, function () {
						return { todos: "optimistic-a" };
					}),
					optimistic<{ other: string }, Record<string, unknown>>(b, function () {
						return { other: "optimistic-b" };
					}),
				],
			})
			.catch(function (error: unknown) {
				return error;
			});

		await tick();
		expect(await client.read(a)).toEqual({ todos: "optimistic-a" });

		// Settling processes the newest layer (b) first: make that one cache write fail once.
		failSetFor = '["b"]';
		release.open();
		await mutation;

		// Real data written afterwards must not be overlaid with the failed mutation's optimistic data.
		await client.write(a, { todos: "real-a2" });
		expect(await client.read(a)).toEqual({ todos: "real-a2" });
	});
});

describe("cache failures after a successful mutation", function () {
	it("a cache failing during `invalidates` does not reject a mutation the server applied", async function () {
		const inner = new MemoryCache();
		const cache: Cache = {
			get: function <T>(key: string) {
				return inner.get<T>(key);
			},
			set: function <T>(key: string, value: T) {
				inner.set(key, value);
			},
			delete: function (key: string) {
				return inner.delete(key);
			},
			clear: function () {
				inner.clear();
			},
			keys: async function () {
				throw new Error("IndexedDB connection lost");
			},
		};
		let mutations = 0;
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				mutations++;
				return Response.json({ data: { add: mutations } });
			}),
		});

		const result = await client.gql({ query: ADD, invalidates: [["todos"]] }).catch(function (error: unknown) {
			return error;
		});

		// The server applied the mutation once: the caller must get its data, not an error inviting a retry.
		expect(mutations).toBe(1);
		expect(result).toEqual({ add: 1 });
	});
});

describe("cache failures inside the request pipeline", function () {
	/**
	 * A MemoryCache-backed cache whose chosen operations fail.
	 */
	function failingCache(fail: { set?: boolean; delete?: boolean }): Cache {
		const inner = new MemoryCache();

		return {
			get: function <T>(key: string) {
				return inner.get<T>(key);
			},
			set: async function <T>(key: string, value: T) {
				if (fail.set) throw new Error("disk full");
				inner.set(key, value);
			},
			delete: async function (key: string) {
				if (fail.delete) throw new Error("disk busy");
				return inner.delete(key);
			},
			clear: function () {
				inner.clear();
			},
			keys: function () {
				return inner.keys();
			},
		};
	}

	it("a failing cache write is never retried as if the network request had failed", async function () {
		const { fetchMock, calls } = counterServer();
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache: failingCache({ set: true }),
			// e.g. "retry everything except aborts"
			retry: {
				attempts: 3,
				delay: 0,
				retryIf: function () {
					return true;
				},
			},
		});

		await client.gql({ key: ["todos"], query: TODOS }).catch(function (error: unknown) {
			return error;
		});

		// The server answered the first request successfully: re-sending it is wrong (and for a mutation, harmful).
		expect(calls()).toBe(1);
	});

	it("a failing cache delete during invalidate() still makes active live queries refetch", async function () {
		const { fetchMock, calls } = counterServer();
		const flags = { delete: false };
		const client = new Client({ url: URL, fetch: fetchMock, cache: failingCache(flags) });
		const ref = client.watch<{ todos: number }>({ key: ["todos"], query: TODOS });

		ref.subscribe(function () {});
		await tick();
		expect(ref.getState().data).toEqual({ todos: 1 });

		flags.delete = true;
		await client.invalidate(["todos"]).catch(function (error: unknown) {
			return error;
		});
		await tick();

		// The invalidation was recorded (in-flight requests dropped, epoch logged) but watchers were never told.
		expect(calls()).toBe(2);
		expect(ref.getState().data).toEqual({ todos: 2 });
	});
});

describe("shared results are immutable", function () {
	const TODOS = "query Todos { todos { id title } }";

	/**
	 * Creates a client whose server always answers the same todo list.
	 *
	 * @returns The client and its fetch mock
	 */
	function todoClient(): { client: Client; fetchMock: ReturnType<typeof vi.fn<typeof fetch>> } {
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			return Response.json({
				data: {
					todos: [
						{ id: 2, title: "b" },
						{ id: 1, title: "a" },
					],
				},
			});
		});

		return { client: new Client({ url: URL, cache: new MemoryCache(), fetch: fetchMock }), fetchMock };
	}

	it("a consumer mutating a result cannot corrupt the cache or other consumers", async function () {
		const { client, fetchMock } = todoClient();
		const [first, second] = await Promise.all([
			client.gql<{ todos: Array<{ id: number; title: string }> }>({ key: ["todos"], query: TODOS }),
			client.gql<{ todos: Array<{ id: number; title: string }> }>({ key: ["todos"], query: TODOS }),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(function sortInPlace() {
			first.todos.sort(function byId(a, b) {
				return a.id - b.id;
			});
		}).toThrow(TypeError);
		expect(function rename() {
			first.todos[0]!.title = "hacked";
		}).toThrow(TypeError);
		expect(second.todos[0]).toEqual({ id: 2, title: "b" });
		expect(await client.read({ key: ["todos"], query: TODOS })).toEqual({
			todos: [
				{ id: 2, title: "b" },
				{ id: 1, title: "a" },
			],
		});
	});

	it("an optimistic update mutating its input is rejected without touching the real data", async function () {
		const { client } = todoClient();
		const target = { key: ["todos"], query: TODOS };

		await client.gql(target);

		const mutation = client.gql({
			query: "mutation Add { add }",
			optimistic: [
				optimistic<{ todos: Array<{ id: number; title: string }> }, Record<string, unknown>>(
					target,
					function push(current) {
						// Bypasses the readonly types on purpose: the runtime freeze is what is under test.
						(current!.todos as Array<{ id: number; title: string }>).push({ id: 3, title: "c" });
						return current!;
					},
				),
			],
		});

		await expect(mutation).rejects.toThrow(TypeError);
		expect(await client.read(target)).toEqual({
			todos: [
				{ id: 2, title: "b" },
				{ id: 1, title: "a" },
			],
		});
	});

	it("data written with write() or restore() is frozen too", async function () {
		const { client } = todoClient();
		const written = { todos: [{ id: 9, title: "w" }] };

		await client.write({ key: ["todos"], query: TODOS }, written);

		expect(Object.isFrozen(written.todos[0])).toBe(true);
	});
});
