import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { graphql } from "./document";
import { optimistic } from "./optimistic";
import type { OperationContext } from "./types";

const URL = "https://test.dev/graphql";
const TODOS = graphql<{ todos: string[] }, Record<string, never>>`
	query Todos {
		todos
	}
`;
const ADD = "mutation Add($title: String!) { add(title: $title) }";
const TARGET = { key: ["todos"], query: TODOS };

/**
 * Normalizes the arguments `fetch` was called with into a Request (the client calls `fetch(url, init)`).
 *
 * @param input - The URL or request
 * @param init - The request init
 * @returns The request
 */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

/**
 * Server keeping a todo list; mutations with title "boom" fail. Responses are released manually when gated.
 *
 * @param gated - Hold mutation responses until `release` is called
 * @returns The fetch mock, the server state and the release function
 */
function server(gated = false) {
	const todos = ["a"];
	let release: () => void = function noop() {};
	const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
		const { query, variables } = await toRequest(input, init).clone().json();

		if (!query.startsWith("mutation")) return Response.json({ data: { todos: [...todos] } });

		if (gated) {
			await new Promise<void>(function (resolve) {
				release = resolve;
			});
		}

		if (variables.title === "boom") return Response.json({ errors: [{ message: "rejected" }] });

		todos.push(variables.title);

		return Response.json({ data: { add: true } });
	});

	return {
		fetchMock,
		todos,
		release() {
			release();
		},
	};
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
 * Optimistically appends a todo.
 *
 * @param title - The todo title
 * @returns The optimistic update
 */
function append(title: string) {
	return optimistic(TARGET, function (current) {
		return { todos: [...(current?.todos ?? []), title] };
	});
}

describe("optimistic updates", function () {
	it("shows the optimistic data immediately and reconciles through invalidates", async function () {
		const { fetchMock, release } = server(true);
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch(TARGET);
		const stop = ref.subscribe(function () {});

		await tick();

		const mutation = client.gql({
			query: ADD,
			variables: { title: "b" },
			optimistic: [append("b")],
			invalidates: [["todos"]],
		});

		await tick();
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });

		release();
		await mutation;
		await tick();

		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });
		expect(fetchMock).toHaveBeenCalledTimes(3);
		stop();
	});

	it("rolls back to the previous data when the mutation fails", async function () {
		const { fetchMock } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch(TARGET);
		const states: Array<string[] | undefined> = [];
		const stop = ref.subscribe(function (state) {
			states.push(state.data?.todos);
		});

		await tick();
		await expect(client.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })).rejects.toThrow(
			"rejected",
		);

		expect(states).toContainEqual(["a", "boom"]);
		expect(ref.getState().data).toEqual({ todos: ["a"] });
		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
		stop();
	});

	it("drops an entry that did not exist and lets its watchers refetch", async function () {
		const { fetchMock } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await expect(
			client.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] }),
		).rejects.toThrow();

		expect(await client.read(TARGET)).toBeUndefined();
	});

	it("applies several updates and rolls them back newest first", async function () {
		const { fetchMock } = server();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });
		await expect(
			client.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("x"), append("y")] }),
		).rejects.toThrow();

		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
	});

	it("works without a cache by pushing to watchers", async function () {
		const { fetchMock, release } = server(true);
		const client = new Client({ url: URL, fetch: fetchMock });
		const ref = client.watch(TARGET);
		const stop = ref.subscribe(function () {});

		await tick();

		const mutation = client.gql({ query: ADD, variables: { title: "b" }, optimistic: [append("b")] });

		await tick();
		expect(ref.getState().data).toEqual({ todos: ["a", "b"] });

		release();
		await mutation;
		stop();
	});
});

describe("onError", function () {
	it("is called once per failed operation with its context", async function () {
		const onError = vi.fn<(error: unknown, context: OperationContext) => void>();
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ errors: [{ message: "denied" }] }, { status: 401 });
		});
		const client = new Client({ url: URL, fetch: fetchMock, onError });

		await Promise.allSettled([client.gql({ query: TODOS }), client.gql({ query: TODOS })]);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![0]).toMatchObject({ status: 401 });
		expect(onError.mock.calls[0]![1]).toMatchObject({ type: "query", name: "Todos", attempt: 0 });
	});

	it("reports after the last retry only", async function () {
		const onError = vi.fn();
		const client = new Client({
			url: URL,
			onError,
			retry: { attempts: 2, delay: 0 },
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({}, { status: 503 });
			}),
		});

		await expect(client.gql({ query: TODOS })).rejects.toThrow();

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![1]).toMatchObject({ attempt: 2 });
	});

	it("skips caller aborts and survives a throwing hook", async function () {
		const onError = vi.fn(function () {
			throw new Error("reporter down");
		});
		const client = new Client({
			url: URL,
			onError,
			fetch: vi.fn<typeof fetch>(async function (input, init) {
				const { signal } = toRequest(input, init);

				if (signal.aborted) throw signal.reason;

				return Response.json({ errors: [{ message: "nope" }] });
			}),
		});

		await expect(client.gql({ query: TODOS, signal: AbortSignal.abort("stop") })).rejects.toBe("stop");
		expect(onError).not.toHaveBeenCalled();

		await expect(client.gql({ query: TODOS, fetchPolicy: "no-cache" })).rejects.toThrow("nope");
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("reports cache-only misses and subscription failures", async function () {
		const onError = vi.fn();
		const client = new Client({
			url: URL,
			onError,
			cache: new MemoryCache(),
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ errors: [{ message: "stream failed" }] }, { status: 400 });
			}),
		});

		await expect(client.gql({ query: TODOS, fetchPolicy: "cache-only" })).rejects.toThrow("cache-only");
		await expect(client.subscribe({ query: "subscription S { s }" }).next()).rejects.toThrow("stream failed");

		expect(onError).toHaveBeenCalledTimes(2);
		expect(onError.mock.calls[1]![1]).toMatchObject({ type: "subscription", name: "S" });
	});
});

describe("optimistic layers (concurrency)", function () {
	/**
	 * Server whose mutations are released manually; titles starting with "boom" fail.
	 *
	 * @returns The fetch mock, release functions (in call order) and server state
	 */
	function gatedMutations() {
		const todos = ["a"];
		const releases: Array<() => void> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
			const { query, variables } = await toRequest(input, init).clone().json();

			if (!query.startsWith("mutation")) return Response.json({ data: { todos: [...todos] } });

			await new Promise<void>(function (resolve) {
				releases.push(resolve);
			});

			if (variables.title.startsWith("boom")) return Response.json({ errors: [{ message: "rejected" }] });

			todos.push(variables.title);

			return Response.json({ data: { add: true } });
		});

		return { fetchMock, releases, todos };
	}

	/**
	 * Fires a mutation with an optimistic append.
	 *
	 * @param client - The client
	 * @param title - The todo title
	 * @returns The settled outcome
	 */
	function add(client: Client, title: string): Promise<unknown> {
		return client.gql({ query: ADD, variables: { title }, optimistic: [append(title)] }).catch(function (
			error: unknown,
		) {
			return error;
		});
	}

	it("rolls back only the failed layer when two optimistic mutations fail", async function () {
		const { fetchMock, releases } = gatedMutations();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const first = add(client, "boom1");
		const second = add(client, "boom2");

		await tick();
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "boom1", "boom2"] });

		releases[0]!();
		await first;
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "boom2"] });

		releases[1]!();
		await second;
		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
	});

	it("keeps a newer success when an older optimistic mutation fails", async function () {
		const { fetchMock, releases } = gatedMutations();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const failing = add(client, "boom");
		const succeeding = add(client, "b");

		await tick();
		releases[0]!();
		await failing;
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "b"] });

		releases[1]!();
		await succeeding;
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "b"] });
	});

	it("rebases pending layers on fresh server data and rolls back onto it", async function () {
		const { fetchMock, releases, todos } = gatedMutations();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch(TARGET);
		const stop = ref.subscribe(function () {});

		await tick();

		const pending = add(client, "boom");

		await tick();
		todos.push("fromServer");
		await client.invalidate(["todos"]);
		await tick();

		expect(ref.getState().data).toEqual({ todos: ["a", "fromServer", "boom"] });

		releases[0]!();
		await pending;

		expect(ref.getState().data).toEqual({ todos: ["a", "fromServer"] });
		expect(await client.read(TARGET)).toEqual({ todos: ["a", "fromServer"] });
		stop();
	});

	it("rolls back earlier updates when a later update throws, and reports it", async function () {
		const { fetchMock } = gatedMutations();
		const onError = vi.fn();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache(), onError });
		const OTHER = { key: ["other"], query: "query Other { other }" };

		await client.write(TARGET, { todos: ["a"] });

		await expect(
			client.gql({
				query: ADD,
				variables: { title: "b" },
				optimistic: [
					append("b"),
					optimistic(OTHER, function (current: { readonly other: readonly string[] } | undefined) {
						return { other: [...current!.other] };
					}),
				],
			}),
		).rejects.toBeInstanceOf(TypeError);

		expect(await client.read(TARGET)).toEqual({ todos: ["a"] });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(1);
	});
});

describe("optimistic layers (review 4)", function () {
	/**
	 * Mutation server: mutations wait for `release`; titles starting with "boom" fail.
	 *
	 * @returns The fetch mock, release functions and server state
	 */
	function gated() {
		const todos = ["a"];
		const releases: Array<() => void> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
			const { query, variables } = await toRequest(input, init).clone().json();

			if (!query.startsWith("mutation")) return Response.json({ data: { todos: [...todos] } });

			await new Promise<void>(function (resolve) {
				releases.push(resolve);
			});

			if (variables.title.startsWith("boom")) return Response.json({ errors: [{ message: "rejected" }] });

			todos.push(variables.title);

			return Response.json({ data: { add: true } });
		});

		return { fetchMock, releases, todos };
	}

	it("a successful mutation's own invalidates is not undone by its optimistic layer", async function () {
		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client.gql({
			query: ADD,
			variables: { title: "b" },
			optimistic: [append("temp")],
			invalidates: [["todos"]],
		});

		await tick();
		releases[0]!();
		await mutation;

		expect(await client.read(TARGET)).toBeUndefined();
	});

	it("an invalidation during a pending layer is not undone by the rollback", async function () {
		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function () {});

		await tick();
		await client.invalidate(["todos"]);
		releases[0]!();
		await mutation;

		expect(await client.read(TARGET)).toBeUndefined();
	});

	it("a throwing update leaves no orphan layer behind", async function () {
		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["old"] });
		await expect(
			client.gql({
				query: ADD,
				variables: { title: "x" },
				optimistic: [
					optimistic(TARGET, function () {
						throw new TypeError("bad update");
					}),
				],
			}),
		).rejects.toThrow("bad update");

		await client.invalidate(["todos"]);

		const mutation = client.gql({ query: ADD, variables: { title: "new" }, optimistic: [append("new")] });

		await tick();
		expect(await client.read(TARGET)).toEqual({ todos: ["new"] });

		releases[0]!();
		await mutation;
	});

	it("fetchMore keeps pending layers as layers", async function () {
		const { releases } = gated();
		const pages = vi.fn<typeof fetch>(async function (input, init) {
			const { query, variables } = await toRequest(input, init).clone().json();

			if (query.startsWith("mutation")) {
				await new Promise<void>(function (resolve) {
					releases.push(resolve);
				});

				return Response.json({ errors: [{ message: "rejected" }] });
			}

			return Response.json({ data: { todos: variables?.page ? ["b"] : ["a"] } });
		});
		const client = new Client({ url: URL, fetch: pages, cache: new MemoryCache() });
		const ref = client.watch<{ todos: string[] }, { page?: number }>({ ...TARGET, variables: {} });
		const stop = ref.subscribe(function () {});

		await tick();

		const target = { ...TARGET, variables: {} };
		const failing = client
			.gql({
				query: ADD,
				variables: { title: "boom" },
				optimistic: [
					optimistic(target, function (current: { readonly todos: readonly string[] } | undefined) {
						return { todos: [...(current?.todos ?? []), "temp"] };
					}),
				],
			})
			.catch(function () {});

		await tick();
		await ref.fetchMore({
			variables: { page: 2 },
			merge(previous, next) {
				return { todos: [...previous.todos, ...next.todos] };
			},
		});

		expect(ref.getState().data).toEqual({ todos: ["a", "b", "temp"] });
		expect(await client.read(target)).toEqual({ todos: ["a", "b", "temp"] });

		releases[0]!();
		await failing;

		expect(await client.read(target)).toEqual({ todos: ["a", "b"] });
		stop();
	});

	it("never applies layers twice over cached visible data", async function () {
		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("t")] })
			.catch(function () {});

		await tick();

		const ref = client.watch({ ...TARGET, fetchPolicy: "cache-only" });
		const stop = ref.subscribe(function () {});

		await ref.refetch();
		expect(ref.getState().data).toEqual({ todos: ["a", "t"] });

		releases[0]!();
		await mutation;
		stop();
	});

	it("extract() never ships optimistic data", async function () {
		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function () {});

		await tick();
		expect(Object.values(await client.extract())).toEqual([{ todos: ["a"] }]);

		releases[0]!();
		await mutation;
	});

	it("does not resurrect data that expired while a layer was pending", async function () {
		vi.useFakeTimers();

		const { fetchMock, releases } = gated();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache({ ttl: 1_000 }) });

		await client.write(TARGET, { todos: ["a"] });

		const mutation = client
			.gql({ query: ADD, variables: { title: "boom" }, optimistic: [append("boom")] })
			.catch(function () {});

		await vi.advanceTimersByTimeAsync(2_000);
		releases[0]!();
		await mutation;

		expect(await client.read(TARGET)).toBeUndefined();
		vi.useRealTimers();
	});
});
