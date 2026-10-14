import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { optimistic } from "./optimistic";

/**
 * Deterministic reproductions of the bugs found by the model-based fuzzer (see fuzz.test.ts). Each test replays the
 * shrunk failing scenario and asserts the correct behavior.
 */

const URL = "https://test.dev/graphql";
const TODOS = "query Todos($page: Int) { todos(page: $page) }";
const ADD = "mutation Add($title: String!) { add(title: $title) }";
const TARGET = { key: ["todos"], query: TODOS, variables: {} };

type Todos = { todos: string[] };

interface HeldRequest {
	name: string;
	release(): void;
}

/**
 * Lets pending promises and 0ms timers run.
 */
async function tick(): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}

/**
 * Server keeping a todo list. Every request is held until released; queries answer with the server state at request
 * time, mutations with a title starting with "boom" are rejected.
 *
 * @returns The fetch mock, the server's todos and the held requests (in arrival order)
 */
function server() {
	const todos = ["a"];
	const held: HeldRequest[] = [];
	const fetchMock = vi.fn<typeof fetch>(async function (input) {
		const { query, variables } = await (input as Request).clone().json();
		const snapshot = [...todos];

		await new Promise<void>(function (resolve) {
			held.push({ name: query.split("(")[0], release: resolve });
		});

		if (query.startsWith("mutation")) {
			if (variables.title.startsWith("boom")) return Response.json({ errors: [{ message: "rejected" }] });

			todos.push(variables.title);

			return Response.json({ data: { add: true } });
		}

		return Response.json({ data: { todos: snapshot } });
	});

	return { fetchMock, todos, held };
}

/**
 * Releases every held request (and the ones they trigger) until nothing is in flight.
 *
 * @param held - The held requests
 */
async function drain(held: HeldRequest[]): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await tick();

		const next = held.shift();

		if (!next) return;

		next.release();
	}
}

/**
 * Optimistically appends a todo.
 *
 * @param title - The todo title
 * @returns The optimistic update
 */
function append(title: string) {
	return optimistic<Todos, unknown>(TARGET, function (current) {
		return { todos: [...(current?.todos ?? []), title] };
	});
}

/**
 * Appends a page's new todos to the known ones.
 *
 * @param previous - The current data
 * @param next - The fetched page
 * @returns The merged data
 */
function mergePages(previous: Todos, next: Todos): Todos {
	return {
		todos: [
			...previous.todos,
			...next.todos.filter(function (item) {
				return !previous.todos.includes(item);
			}),
		],
	};
}

/**
 * Starts a mutation adding a todo with an optimistic update, ignoring its outcome.
 *
 * @param client - The client
 * @param title - The todo title ("boom…" is rejected)
 * @returns Resolves once the mutation settled
 */
function addOptimistically(client: Client, title: string): Promise<unknown> {
	return client.gql({ query: ADD, variables: { title }, optimistic: [append(title)] }).catch(function () {});
}

describe("B1: invalidation through another client sharing the cache", function () {
	it("never lets live queries join the stale in-flight request", async function () {
		const { fetchMock, todos, held } = server();
		const cache = new MemoryCache();
		const client1 = new Client({ url: URL, fetch: fetchMock, cache });
		const client2 = client1.extend({});
		const ref = client1.watch<Todos>(TARGET);

		ref.subscribe(function () {});
		await tick(); // request #0 in flight, will answer ["a"]

		todos.push("b");
		await client2.invalidate(["todos"]);
		await tick();

		held.shift()!.release();
		await drain(held);

		// Before the fix the refetch joined request #0: a single request, and ["a"] shown forever.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });
	});
});

describe("B2: live query showing a superseded response", function () {
	it("shows the cache entry when a write supersedes its in-flight fetch", async function () {
		const { fetchMock, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos>(TARGET);

		ref.subscribe(function () {});
		await tick();

		await client.write(TARGET, { todos: ["a", "local"] });
		held.shift()!.release();
		await tick();

		// Before the fix: the ref showed the superseded ["a"] while the cache held ["a", "local"].
		expect(ref.getState().data).toEqual({ todos: ["a", "local"] });
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "local"] });
	});

	it("shows the newest response with two clients sharing a cache and out-of-order responses", async function () {
		const { fetchMock, todos, held } = server();
		const client1 = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const client2 = client1.extend({});
		const ref = client1.watch<Todos>({ ...TARGET, fetchPolicy: "network-only" });

		ref.subscribe(function () {});
		await tick(); // #0 answers ["a"]

		todos.push("b");
		const other = client2.gql<Todos>({ ...TARGET, fetchPolicy: "network-only" });

		await tick(); // #1 answers ["a", "b"] (not deduplicated across clients)
		held[1]!.release();
		await other;
		held[0]!.release();
		await tick();

		// Before the fix: the ref showed ["a"] while the cache held ["a", "b"].
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });
		expect(await client1.read(TARGET)).toEqual({ todos: ["a", "b"] });
	});
});

describe("B3: optimistic base adopted from a live query on a cache miss", function () {
	it("does not resurrect invalidated data when the layer rolls back", async function () {
		const { fetchMock, todos, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos>(TARGET);
		const stop = ref.subscribe(function () {});

		await tick();
		held.shift()!.release();
		await tick(); // cached ["a"]

		stop(); // deactivation is deferred by a tick: the watcher stays registered meanwhile
		todos.push("b");
		await client.invalidate(["todos"]); // the entry is dropped, nobody listens so nothing refetches
		const mutation = addOptimistically(client, "boom");

		await tick();
		held.shift()!.release();
		await mutation;
		await tick();

		// Before the fix: the watcher's ["a"] became the layer's base and was written back on rollback.
		expect(await client.read(TARGET)).toBeUndefined();

		const read = client.gql(TARGET);

		await drain(held);
		expect(await read).toEqual({ todos: ["a", "b"] });
	});

	it("never writes a no-cache live query's data to the cache through a rollback", async function () {
		const { fetchMock, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos>({ ...TARGET, fetchPolicy: "no-cache" });

		ref.subscribe(function () {});
		await tick();
		held.shift()!.release();
		await tick();
		expect(await client.read(TARGET)).toBeUndefined();

		const mutation = addOptimistically(client, "boom");

		await tick();
		held.shift()!.release();
		await mutation;

		// Before the fix: the cache held the no-cache ref's ["a"].
		expect(await client.read(TARGET)).toBeUndefined();
	});
});

describe("B4: rolled-back layer on an invalidated entry", function () {
	it("disappears from a no-cache live query", async function () {
		const { fetchMock, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos>({ ...TARGET, fetchPolicy: "no-cache" });

		ref.subscribe(function () {});
		await tick();
		held.shift()!.release();
		await tick(); // the ref shows ["a"]

		const mutation = addOptimistically(client, "boom");

		await tick();
		await client.invalidate(["todos"]); // e.g. another mutation's `invalidates`
		await tick();
		held.pop()!.release(); // the refetch, overlaid with the pending layer
		await tick();
		held.shift()!.release(); // the mutation fails
		await mutation;
		await drain(held);

		// Before the fix: ["a", "boom"] stayed visible forever.
		expect(ref.getState().data).toEqual({ todos: ["a"] });
	});

	it("disappears from a cache-first live query whose refetch failed", async function () {
		const { fetchMock, held } = server();
		let failNext = false;
		const failing = vi.fn<typeof fetch>(async function (input) {
			if (failNext) {
				failNext = false;

				return Response.json({ errors: [{ message: "down" }] });
			}

			return fetchMock(input);
		});
		const client = new Client({ url: URL, fetch: failing, cache: new MemoryCache() });
		const ref = client.watch<Todos>(TARGET);

		ref.subscribe(function () {});
		await tick();
		held.shift()!.release();
		await tick();

		const mutation = addOptimistically(client, "boom");

		await tick();
		failNext = true;
		await client.invalidate(["todos"]); // the refetch fails
		await tick();
		held.shift()!.release();
		await mutation;
		await drain(held);

		// Before the fix: ["a", "boom"] stayed visible.
		expect(ref.getState().data).toEqual({ todos: ["a"] });
	});
});

describe("B5: fetchMore merging onto outdated data", function () {
	it("drops its page when the entry was invalidated meanwhile, so the refetch wins", async function () {
		const { fetchMock, todos, held } = server();

		todos.push("x");
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<Todos, { page?: number }>(TARGET);

		ref.subscribe(function () {});
		await tick();
		held.shift()!.release();
		await tick(); // ["a", "x"]

		todos.splice(todos.indexOf("x"), 1); // "x" is deleted on the server
		await client.invalidate(["todos"]); // a refetch is in flight, it will answer ["a"]
		await tick();
		const more = ref.fetchMore({ variables: { page: 2 }, merge: mergePages });

		await tick();
		held.pop()!.release(); // the page
		await more;
		held.shift()!.release(); // the refetch started by the invalidation
		await drain(held);

		// Before the fix: the page merged onto ["a", "x"] superseded the refetch, resurrecting "x".
		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
		expect(ref.getState().data).toEqual({ todos: ["a"] });
	});

	it("merges onto the entry's current data, not a rolled-back layer the ref still holds", async function () {
		const { fetchMock, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });
		const mutation = addOptimistically(client, "boom");

		await tick();
		const ref = client.watch<Todos, { page?: number }>(TARGET); // created showing ["a", "boom"]

		held.shift()!.release();
		await mutation; // rolled back: the cache holds ["a"]
		const more = ref.fetchMore({ variables: { page: 2 }, merge: mergePages });

		await tick();
		held.shift()!.release();
		await more;

		// Before the fix: the page was merged onto ["a", "boom"] and written to the cache.
		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
	});
});

describe("B6: no-cache live query under a pending optimistic layer", function () {
	it("applies the layer on top of its own response instead of discarding it", async function () {
		const { fetchMock, todos, held } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });
		const ref = client.watch<Todos>({ ...TARGET, fetchPolicy: "no-cache" });

		ref.subscribe(function () {});
		await tick();
		held.shift()!.release();
		await tick(); // the ref shows ["a"]

		todos.push("b"); // the server changes, the cache entry still holds ["a"]
		const mutation = addOptimistically(client, "c");

		await tick();
		const refetch = ref.refetch();

		await tick();
		held.pop()!.release(); // the refetch answers ["a", "b"] while the mutation is pending
		await refetch;

		// Before the fix: the layer was rendered on the cache's ["a"], discarding the response.
		expect(ref.getState().data).toEqual({ todos: ["a", "b", "c"] });

		held.shift()!.release();
		await mutation;
		await drain(held);
	});
});

describe("rolled-back layers never survive a failed refetch", function () {
	const TODOS = "query Todos { todos }";
	const ADD = "mutation Add($title: String!) { add(title: $title) }";
	const TARGET = { key: ["todos"], query: TODOS };

	/**
	 * Server whose mutations wait for `reject()` and are then rejected; queries fail once `failQueries` is set.
	 *
	 * @returns The fetch mock and its controls
	 */
	function server() {
		const controls = { failQueries: false, reject: function noop(): void {} };
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			const { query } = await (input as Request).clone().json();

			if (query.startsWith("mutation")) {
				await new Promise<void>(function (resolve) {
					controls.reject = resolve;
				});

				return Response.json({ errors: [{ message: "rejected" }] });
			}

			return controls.failQueries
				? Response.json({ errors: [{ message: "query failed" }] })
				: Response.json({ data: { todos: ["a"] } });
		});

		return { fetchMock, controls };
	}

	/**
	 * Appends a todo optimistically.
	 *
	 * @param title - The todo title
	 * @returns The optimistic update
	 */
	function append(title: string) {
		return optimistic(TARGET, function (current: { readonly todos: readonly string[] } | undefined) {
			return { todos: [...(current?.todos ?? []), title] };
		});
	}

	/**
	 * Lets pending promises and 0ms timers run.
	 */
	async function settle(): Promise<void> {
		for (let index = 0; index < 3; index++) {
			await new Promise(function (resolve) {
				setTimeout(resolve, 0);
			});
		}
	}

	it("an active live query drops the rolled-back data when its refetch fails", async function () {
		const { fetchMock, controls } = server();
		const client = new Client({ url: "https://test.dev/graphql", fetch: fetchMock, cache: new MemoryCache() });
		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function () {});

		await settle();

		const ref = client.watch(TARGET);
		const stop = ref.subscribe(function () {});

		expect(ref.getState().data).toEqual({ todos: ["boom"] });

		controls.failQueries = true;
		controls.reject();
		await mutation;
		await settle();

		expect(ref.getState().data).toBeUndefined();
		expect(ref.getState().error).toBeDefined();
		stop();
	});

	it("an inactive live query created during a pending layer drops it once the layer settled", async function () {
		const { fetchMock, controls } = server();
		const client = new Client({ url: "https://test.dev/graphql", fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function () {});

		await settle();

		const ref = client.watch(TARGET);

		expect(ref.getState().data).toEqual({ todos: ["a", "boom"] });

		controls.reject();
		await mutation;
		await client.invalidate(["todos"]);
		controls.failQueries = true;

		const stop = ref.subscribe(function () {});

		await settle();

		expect(JSON.stringify(ref.getState().data ?? null)).not.toContain("boom");
		stop();
	});
});
