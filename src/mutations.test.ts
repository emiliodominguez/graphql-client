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
 * Server keeping a todo list; mutations with title "boom" fail. Responses are released manually when gated.
 *
 * @param gated - Hold mutation responses until `release` is called
 * @returns The fetch mock, the server state and the release function
 */
function server(gated = false) {
	const todos = ["a"];
	let release: () => void = function noop() {};
	const fetchMock = vi.fn<typeof fetch>(async function (input) {
		const { query, variables } = await (input as Request).clone().json();

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
			fetch: vi.fn<typeof fetch>(async function (input) {
				const { signal } = input as Request;

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
