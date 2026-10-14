import { describe, expect, it } from "vitest";
import { Client } from "../client";
import { optimistic } from "../optimistic";
import { ADD, URL, TODOS, type Todos, heldServer, parkedCache, releaseAll, take, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };
const OTHER = { key: ["other"], query: TODOS };

describe("optimistic updates while an invalidation is still deleting OTHER keys", function () {
	it("apply on fresh data stored after the invalidation, and never blank the live query on success", async function () {
		const { fetchMock, held } = heldServer();
		const { cache, store, parked } = parkedCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });

		const seeds = Promise.all([
			client.write<Todos>(TARGET, { todos: ["a"] }),
			client.write<Todos>(OTHER, { todos: ["x"] }),
		]);
		await releaseAll(parked);
		await seeds;
		const [todosKey, otherKey] = [...store.keys()];

		const ref = client.watch<Todos>(TARGET);
		const states: Array<Todos | undefined> = [];
		const unsubscribe = ref.subscribe(function record(state) {
			states.push(state.data);
		});
		await releaseAll(parked);
		expect(ref.getState().data).toEqual({ todos: ["a"] });

		// e.g. a logout/refresh: invalidate everything. The delete of an unrelated key is slow (an IndexedDB
		// transaction, a remote KV...); the todos entry is already deleted.
		const invalidation = client.invalidate();
		function slowDelete(call: { kind: string; key: string | undefined }): boolean {
			return call.kind === "delete" && call.key === otherKey;
		}
		await releaseAll(parked, slowDelete);
		expect(store.has(todosKey!)).toBe(false);

		// Fresh todos are fetched and stored after the invalidation: the invalidation keeps them (by design).
		const fresh = client.gql<Todos>({ ...TARGET, fetchPolicy: "network-only" });
		await tick();
		take(held, "Todos").respond({ data: { todos: ["fresh"] } });
		await releaseAll(parked, slowDelete);
		await fresh;
		expect(store.get(todosKey!)).toEqual({ todos: ["fresh"] });
		expect(ref.getState().data).toEqual({ todos: ["fresh"] });

		// An optimistic mutation on the todos entry.
		const mutation = client.gql({
			query: ADD,
			variables: { title: "new" },
			optimistic: [
				optimistic<Todos, Record<string, unknown>>(TARGET, function add(current) {
					return { todos: [...(current?.todos ?? []), "new"] };
				}),
			],
		});
		await releaseAll(parked, slowDelete);

		// "The optimistic option updates the UI immediately."
		expect.soft(ref.getState().data).toEqual({ todos: ["fresh", "new"] });

		take(held, "Add").respond({ data: { add: true } });
		await releaseAll(parked, slowDelete);
		await mutation;

		// The mutation SUCCEEDED: the live query must never be blanked out.
		expect.soft(states.at(-1)).not.toBeUndefined();

		await releaseAll(parked);
		await invalidation.catch(function ignore() {});
		unsubscribe();
	});
});
