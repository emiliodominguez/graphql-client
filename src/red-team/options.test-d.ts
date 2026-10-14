import { describe, it } from "vitest";
import { Client } from "../client";
import { optimistic } from "../optimistic";
import { useLazyQuery, useQuery, useSuspenseQuery } from "../react/index";
import type { TypedDocumentString } from "../types";

const client = new Client({ url: "https://test.dev/graphql" });

interface Todos {
	todos: string[];
}

const TODOS = "query Todos { todos }" as unknown as TypedDocumentString<Todos, Record<string, never>>;

describe("live queries accept mutation-only request options", function suite() {
	it("watch / useQuery / useSuspenseQuery / useLazyQuery reject `invalidates` (it loops: every refetch invalidates itself)", function check() {
		// @ts-expect-error `invalidates` runs after every fetch of a live query, including its own refetches
		client.watch({ key: ["todos"], query: TODOS, invalidates: [["todos"]] });
		// @ts-expect-error same through the hook
		useQuery({ key: ["todos"], query: TODOS, invalidates: [["todos"]] });
		// @ts-expect-error same through the hook
		useSuspenseQuery({ key: ["todos"], query: TODOS, invalidates: [["todos"]] });
		// @ts-expect-error same through the hook
		useLazyQuery(TODOS, { key: ["todos"], invalidates: [["todos"]] });
	});

	it("watch / useQuery reject `optimistic` (re-applied on every refetch, poll and fetchMore)", function check() {
		const layer = optimistic({ key: ["todos"], query: TODOS }, function add(current) {
			return { todos: [...(current?.todos ?? []), "temp"] };
		});

		// @ts-expect-error an optimistic layer belongs to a single operation
		client.watch({ query: TODOS, optimistic: [layer] });
		// @ts-expect-error same through the hook
		useQuery({ query: TODOS, optimistic: [layer] });
	});
});

describe("useSuspenseQuery accepts an option it ignores", function suite() {
	it("keepPreviousData is accepted but never honored (isPreviousData is always false)", function check() {
		// @ts-expect-error useSuspenseQuery never keeps previous data: it suspends (use startTransition instead)
		useSuspenseQuery({ query: TODOS, keepPreviousData: true });
	});
});
