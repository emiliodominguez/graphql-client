import { expect, it } from "vitest";
import { Client } from "../client";
import { isClientError } from "../errors";
import { applyIncremental, createIncrementalState } from "../incremental";

/**
 * `state.errors.push(...list)` and `copy.splice(start, n, ...items)` pass every element as a call argument: past
 * ~150k elements V8 throws "Maximum call stack size exceeded". A list field failing per item (e.g. a nullable field
 * whose resolver throws for each of 200k rows) produces that many errors in one payload.
 */
const COUNT = 200_000;

it("keeps every error of a large incremental payload", function () {
	const errors = Array.from({ length: COUNT }, function make(_, index) {
		return { message: "boom", path: ["rows", index, "price"] };
	});
	const state = applyIncremental(createIncrementalState(), { data: { rows: [] }, errors, hasNext: false });

	expect(state.errors).toHaveLength(COUNT);
});

it("writes a large batch of streamed items (2022 format)", function () {
	const items = Array.from({ length: COUNT }, function make(_, index) {
		return index;
	});
	const state = createIncrementalState();

	applyIncremental(state, { data: { rows: [] }, hasNext: true });
	applyIncremental(state, { incremental: [{ path: ["rows", 0], items }], hasNext: false });

	expect((state.data as { rows: unknown[] }).rows).toHaveLength(COUNT);
});

it("surfaces the GraphQL errors (with partial data) of a large multipart @defer response, not 'Invalid GraphQL response.'", async function () {
	const errors = Array.from({ length: COUNT }, function make(_, index) {
		return { message: "boom", path: ["rows", index, "price"] };
	});
	const part = JSON.stringify({ data: { rows: [] }, errors, hasNext: false });
	const client = new Client({
		url: "https://large.test/graphql",
		fetch: async function serve() {
			return new Response(`\r\n---\r\nContent-Type: application/json\r\n\r\n${part}\r\n-----\r\n`, {
				headers: { "Content-Type": 'multipart/mixed; boundary="-"' },
			});
		} as typeof fetch,
	});
	const error = await client.gql({ query: "{ rows { price } ... @defer { b } }" }).catch(function capture(
		caught: unknown,
	) {
		return caught;
	});

	expect(isClientError(error) && error.errors.length).toBe(COUNT);
});
