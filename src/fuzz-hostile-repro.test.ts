import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { StorageCache, type StorageLike } from "./cache/storage-cache";
import { Client } from "./client";
import { optimistic } from "./optimistic";
import type { Cache } from "./types";

/**
 * Deterministic reproductions of the bugs found by the hostile fuzzer (src/attack2/fuzz-hostile.test.ts), shrunk by
 * hand. Each test asserts the CORRECT behavior and fails while the bug exists.
 *
 * Most use a benign async cache: every call takes effect when it is made, in call order (FIFO, like an IndexedDB
 * transaction queue), and its promise settles later, when the test releases it. Unless a test says otherwise, calls
 * are released in call order.
 */

const URL = "https://repro.test/graphql";
const TODOS = "query Todos { todos }";
const COUNT = "query Count { count }";
const ADD = "mutation Add($title: String!) { add(title: $title) }";
const INC = "mutation Inc { inc }";
const TODOS_TARGET = { key: ["todos"], query: TODOS };
const COUNT_TARGET = { key: ["count"], query: COUNT };

type Todos = { todos: string[] };
type Count = { count: number };

interface ParkedCall {
	kind: "get" | "set" | "delete" | "keys" | "clear";
	key: string | undefined;
	release(): void;
}

/**
 * An async cache whose calls apply immediately (in call order) and settle when released.
 *
 * @returns The cache, its backing map and its parked calls
 */
function parkedCache(): { cache: Cache; store: Map<string, unknown>; parked: ParkedCall[] } {
	const store = new Map<string, unknown>();
	const parked: ParkedCall[] = [];

	/**
	 * Parks a call whose result is already computed.
	 *
	 * @param kind - The call
	 * @param key - The key
	 * @param result - The result
	 * @returns A promise settled on release
	 */
	function park<T>(kind: ParkedCall["kind"], key: string | undefined, result: T): Promise<T> {
		return new Promise<T>(function (resolve) {
			parked.push({
				kind,
				key,
				release: function () {
					resolve(result);
				},
			});
		});
	}

	const cache: Cache = {
		get: function <T>(key: string) {
			return park("get", key, store.get(key) as T | undefined);
		},
		set: function <T>(key: string, value: T) {
			store.set(key, value);
			return park("set", key, undefined);
		},
		delete: function (key: string) {
			return park("delete", key, store.delete(key));
		},
		clear: function () {
			store.clear();
			return park("clear", undefined, undefined);
		},
		keys: function () {
			return park("keys", undefined, [...store.keys()]);
		},
	};

	return { cache, store, parked };
}

/**
 * Lets promises and 0ms timers run.
 */
async function tick(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise(function (resolve) {
			setTimeout(resolve, 0);
		});
	}
}

/**
 * Releases parked calls in call order (the ones they trigger too) until none is left.
 *
 * @param parked - The parked calls
 * @param keep - Calls to leave parked
 */
async function releaseAll(parked: ParkedCall[], keep: (call: ParkedCall) => boolean = never): Promise<void> {
	for (let i = 0; i < 200; i++) {
		await tick();

		const index = parked.findIndex(function (call) {
			return !keep(call);
		});

		if (index === -1) return;
		parked.splice(index, 1)[0]!.release();
	}
}

/**
 * Releases parked calls in call order until a promise settles.
 *
 * @param promise - The promise
 * @param parked - The parked calls
 * @returns The promise's outcome
 */
async function until<T>(promise: Promise<T>, parked: ParkedCall[]): Promise<T> {
	let settled = false;

	promise.then(
		function () {
			settled = true;
		},
		function () {
			settled = true;
		},
	);

	for (let i = 0; i < 200 && !settled; i++) {
		await tick();
		if (!settled && parked.length) parked.shift()!.release();
	}

	return promise;
}

/**
 * Releases the first parked call matching a predicate.
 *
 * @param parked - The parked calls
 * @param match - The predicate
 */
async function releaseFirst(parked: ParkedCall[], match: (call: ParkedCall) => boolean): Promise<void> {
	const index = parked.findIndex(match);

	expect(index, "expected a parked cache call").not.toBe(-1);
	parked.splice(index, 1)[0]!.release();
	await tick();
}

/**
 * Matches nothing.
 *
 * @returns false
 */
function never(): boolean {
	return false;
}

/**
 * Matches a call kind.
 *
 * @param kind - The kind
 * @returns The predicate
 */
function kindIs(kind: ParkedCall["kind"]): (call: ParkedCall) => boolean {
	return function (call: ParkedCall): boolean {
		return call.kind === kind;
	};
}

interface Held {
	query: string;
	respond(body: unknown): void;
}

/**
 * Fetch mock holding every request until the test answers it.
 *
 * @returns The mock and the held requests (arrival order)
 */
function heldServer(): { fetchMock: typeof fetch; held: Held[] } {
	const held: Held[] = [];
	const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
		// Accept both calling conventions: fetch(request) and fetch(url, init).
		const request = input instanceof Request ? input.clone() : new Request(input, init);
		const { query } = (await request.json()) as { query: string };

		return new Promise<Response>(function (resolve) {
			held.push({
				query,
				respond: function (body: unknown) {
					resolve(Response.json(body));
				},
			});
		});
	});

	return { fetchMock, held };
}

/**
 * Answers the first held request whose document starts with `prefix`.
 *
 * @param held - The held requests
 * @param prefix - Document prefix (e.g. "mutation Add")
 * @param body - The response body
 */
async function answer(held: Held[], prefix: string, body: unknown): Promise<void> {
	const index = held.findIndex(function (request) {
		return request.query.startsWith(prefix);
	});

	expect(index, `expected a held ${prefix} request`).not.toBe(-1);
	held.splice(index, 1)[0]!.respond(body);
	await tick();
}

/**
 * Appends an item optimistically to the todo list.
 *
 * @param item - The item
 * @returns The optimistic update
 */
function append(item: string) {
	return optimistic<Todos, unknown>(TODOS_TARGET, function (current) {
		return { todos: [...(current?.todos ?? []), item] };
	});
}

describe("H1: optimistic base read racing invalidate()", function () {
	it("never writes invalidated data back when the mutation starts while invalidate() is deleting", async function () {
		const { cache, store, parked } = parkedCache();
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, cache, fetch: fetchMock });

		const written = client.write(TODOS_TARGET, { todos: ["old"] });

		await releaseAll(parked);
		await written;

		// invalidate() lists the keys; the optimistic base is read before the entry is deleted.
		const invalidated = client.invalidate(["todos"]);
		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("temp")] })
			.catch(function (error: unknown) {
				return error;
			});

		await until(invalidated, parked);
		await releaseAll(parked);
		await answer(held, "mutation Add", { errors: [{ message: "rejected" }] });
		await until(mutation, parked);

		// The entry was invalidated: the rollback must not restore the data the invalidation dropped.
		expect([...store.values()]).toEqual([]);
	});
});

describe("H3: committed optimistic layer folded into data that already contains the mutation", function () {
	it("does not leave the placeholder of a successful mutation in the list (documented placeholder pattern)", async function () {
		const { cache, store, parked } = parkedCache();
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, cache, fetch: fetchMock });
		const ref = client.watch<Todos>(TODOS_TARGET);

		ref.subscribe(function () {});
		await releaseAll(parked);
		await answer(held, "query Todos", { data: { todos: ["a"] } });
		await releaseAll(parked);
		expect(ref.getState().data).toEqual({ todos: ["a"] });

		// Placeholder + invalidates, as documented. It also invalidates an unrelated prefix.
		const mutation = client.gql({
			query: ADD,
			variables: { title: "b" },
			optimistic: [append("temp")],
			invalidates: [["todos"], ["stats"]],
		});

		await releaseAll(parked);
		expect(ref.getState().data).toEqual({ todos: ["a", "temp"] });

		await answer(held, "mutation Add", { data: { add: true } });
		// The first prefix is invalidated: the live query refetches. The second invalidation lists keys slowly...
		await releaseAll(parked, kindIs("keys"));
		await releaseFirst(parked, kindIs("keys"));
		await releaseAll(parked, kindIs("keys"));

		// ...while the refetch answers with the real list, which already contains "b".
		await answer(held, "query Todos", { data: { todos: ["a", "b"] } });
		await releaseAll(parked, kindIs("keys"));
		await until(mutation, parked);
		await releaseAll(parked);

		// The server list is ["a", "b"]: the placeholder of the confirmed mutation must be gone, everywhere.
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });
		expect([...store.values()]).toEqual([{ todos: ["a", "b"] }]);
	});
});

describe("H4: invalidate() deletes data stored after it was called", function () {
	it("keeps a write() made while invalidate() lists the keys", async function () {
		const { cache, parked } = parkedCache();
		const client = new Client({ url: URL, cache, fetch: vi.fn<typeof fetch>() });

		const first = client.write(TODOS_TARGET, { todos: ["old"] });

		await releaseAll(parked);
		await first;

		const invalidated = client.invalidate(["todos"]);
		const second = client.write(TODOS_TARGET, { todos: ["new"] });

		await until(invalidated, parked);
		await until(second, parked);

		// The write happened after the invalidation: it is the newest data and must survive.
		expect(await until(client.read(TODOS_TARGET), parked)).toEqual({ todos: ["new"] });
	});
});

describe("H6: results handed to consumers are frozen", function () {
	/**
	 * In-memory Web Storage.
	 *
	 * @returns The storage
	 */
	function memoryStorage(): StorageLike {
		const map = new Map<string, string>();

		return {
			getItem: function (key: string) {
				return map.get(key) ?? null;
			},
			setItem: function (key: string, value: string) {
				map.set(key, value);
			},
			removeItem: function (key: string) {
				map.delete(key);
			},
			key: function (index: number) {
				return [...map.keys()][index] ?? null;
			},
			get length() {
				return map.size;
			},
		};
	}

	it("a cache hit from the built-in StorageCache is frozen, like the network result", async function () {
		const client = new Client({
			url: URL,
			cache: new StorageCache({ storage: memoryStorage() }),
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: ["a"] } });
			}),
		});

		const fromNetwork = await client.gql<Todos>(TODOS_TARGET);
		const fromCache = await client.gql<Todos>(TODOS_TARGET);

		expect(Object.isFrozen(fromNetwork)).toBe(true);
		expect(Object.isFrozen(fromCache)).toBe(true);
	});

	it("a live query backed by StorageCache shares frozen data between its listeners", async function () {
		const client = new Client({
			url: URL,
			cache: new StorageCache({ storage: memoryStorage() }),
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: ["a"] } });
			}),
		});

		await client.gql<Todos>(TODOS_TARGET);

		const ref = client.watch<Todos>(TODOS_TARGET);

		ref.subscribe(function () {});
		await tick();

		expect(ref.getState().data).toEqual({ todos: ["a"] });
		expect(Object.isFrozen(ref.getState().data)).toBe(true);
	});

	it("optimistic data shown to a live query is frozen (MemoryCache, no async adapter needed)", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, cache: new MemoryCache(), fetch: fetchMock });
		const ref = client.watch<Todos>({ ...TODOS_TARGET, fetchPolicy: "no-cache" });

		ref.subscribe(function () {});
		await tick();
		await answer(held, "query Todos", { data: { todos: ["a"] } });

		const mutation = client.gql({ query: ADD, variables: { title: "b" }, optimistic: [append("temp")] });

		await tick();
		const refetched = ref.refetch();

		await tick();
		await answer(held, "query Todos", { data: { todos: ["a"] } });
		await refetched;

		expect(ref.getState().data).toEqual({ todos: ["a", "temp"] });
		expect(Object.isFrozen(ref.getState().data)).toBe(true);

		await answer(held, "mutation Add", { data: { add: true } });
		await mutation;
	});
});

describe("H7: restore() vs a response already in flight", function () {
	it("restored data is not overwritten by an older in-flight response (like write())", async function () {
		const { fetchMock, held } = heldServer();
		const client = new Client({ url: URL, cache: new MemoryCache(), fetch: fetchMock });
		const pending = client.gql<Count>({ ...COUNT_TARGET, fetchPolicy: "network-only" });

		await tick();

		// A snapshot taken later (e.g. pushed by the server) is restored while the old request is in flight.
		const probe = new Client({ url: URL, cache: new MemoryCache(), fetch: fetchMock });

		await probe.write(COUNT_TARGET, { count: 2 });
		await client.restore(await probe.extract());
		await answer(held, "query Count", { data: { count: 1 } });
		await pending;

		expect(await client.read(COUNT_TARGET)).toEqual({ count: 2 });
	});
});

describe("H10: a cache read throwing synchronously", function () {
	/**
	 * A synchronous cache (MemoryCache) whose reads throw while `broken` is set, like a Web Storage that throws
	 * SecurityError when access is blocked.
	 *
	 * @returns The cache and its switch
	 */
	function flakyCache(): { cache: Cache; state: { broken: boolean } } {
		const inner = new MemoryCache();
		const state = { broken: false };

		return {
			state,
			cache: {
				get: function <T>(key: string) {
					if (state.broken) throw new Error("storage unavailable");
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
				keys: function () {
					return inner.keys();
				},
			},
		};
	}

	it("client.watch() does not throw (gql() turns the same failure into a rejection)", async function () {
		const { cache, state } = flakyCache();
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: ["a"] } });
			}),
		});

		state.broken = true;
		await expect(client.gql(TODOS_TARGET)).rejects.toThrow("storage unavailable");
		expect(function () {
			client.watch(TODOS_TARGET);
		}).not.toThrow();
	});

	it("a failed subscribe() does not leave the live query half-activated (stuck loading, leaked watcher)", async function () {
		const { cache, state } = flakyCache();
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { todos: ["a"] } });
		});
		const client = new Client({ url: URL, cache, fetch: fetchMock });
		const ref = client.watch<Todos>(TODOS_TARGET);

		state.broken = true;
		let threw = false;

		try {
			ref.subscribe(function () {});
		} catch {
			threw = true;
		}
		state.broken = false;

		// Whether or not the first subscribe() threw, the live query must not be stuck: the read failure may show as
		// an error, but it settles and recovers on the next fetch.
		const unsubscribe = ref.subscribe(function () {});

		await tick();
		expect(threw).toBe(false);
		expect(ref.getState().loading).toBe(false);
		await ref.refetch();
		expect(ref.getState()).toEqual({ data: { todos: ["a"] }, error: undefined, loading: false });

		unsubscribe();
	});
});

describe("H12: a failed rollback write leaks into later operations", function () {
	it("a later successful optimistic mutation never commits data a failed mutation rolled back", async function () {
		const inner = new MemoryCache();
		const failNextSet = { on: false };
		const cache: Cache = {
			get: function <T>(key: string) {
				return inner.get<T>(key);
			},
			set: function <T>(key: string, value: T) {
				if (failNextSet.on) {
					failNextSet.on = false;
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
		const { fetchMock, held } = heldServer();
		const errors: unknown[] = [];
		const client = new Client({
			url: URL,
			cache,
			fetch: fetchMock,
			onError: function (error) {
				errors.push(error);
			},
		});

		await client.write(TODOS_TARGET, { todos: ["a"] });

		const rejected = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function (error: unknown) {
				return error;
			});

		await tick();
		expect(await client.read(TODOS_TARGET)).toEqual({ todos: ["a", "boom"] });

		// The server rejects "boom"; writing the rollback fails once (the failing operation).
		failNextSet.on = true;
		await answer(held, "mutation Add", { errors: [{ message: "rejected" }] });
		await rejected;

		// A later mutation succeeds: its optimistic base must not be the rolled-back data.
		const accepted = client.gql({ query: ADD, variables: { title: "b" }, optimistic: [append("b")] });

		await tick();
		await answer(held, "mutation Add", { data: { add: true } });
		await accepted;

		expect(await client.read(TODOS_TARGET)).not.toEqual({ todos: ["a", "boom", "b"] });
		expect(JSON.stringify(await client.read(TODOS_TARGET)) ?? "").not.toContain("boom");
	});
});

describe("H11: fetchMore overwriting newer data pushed while it wrote its merge (MemoryCache)", function () {
	it("a live query shows the entry's newest data after two refs of it paginate concurrently", async function () {
		const { fetchMock, held } = heldServer();
		const cache = new MemoryCache();
		const client = new Client({ url: URL, cache, fetch: fetchMock });
		const refA = client.watch<Todos & { by?: string }>(TODOS_TARGET);
		const refB = client.watch<Todos & { by?: string }>(TODOS_TARGET);

		refA.subscribe(function () {});
		await tick();
		await answer(held, "query Todos", { data: { todos: ["a"] } });

		/**
		 * Merges a page, stamping who merged it.
		 *
		 * @param by - The merging ref
		 * @returns The merge function
		 */
		function mergeBy(by: string) {
			return function (previous: Todos, next: Todos): Todos & { by: string } {
				return { todos: [...previous.todos, ...next.todos], by };
			};
		}

		// Two components showing the same list both load the next page.
		const moreA = refA.fetchMore({ variables: {}, merge: mergeBy("A") });
		const moreB = refB.fetchMore({ variables: {}, merge: mergeBy("B") });

		await tick();
		while (held.length) await answer(held, "query Todos", { data: { todos: ["p2"] } });
		await moreA;
		await moreB;
		await tick();

		// Whatever merge won, the subscribed live query must show what its cache entry holds.
		expect(refA.getState().data).toEqual(await client.read(TODOS_TARGET));
	});
});
