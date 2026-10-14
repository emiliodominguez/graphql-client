import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { URL, TODOS, type Todos, heldServer } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

describe("client.write() with a synchronous cache", function () {
	it("is visible to a live query created right after it (no loading flash, no network request)", function () {
		const { fetchMock } = heldServer();
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		// e.g. seeding the entry from a mutation result in an event handler, then navigating to the page
		// that renders it: with a synchronous cache the write used to be applied synchronously.
		void client.write<Todos>(TARGET, { todos: ["seeded"] });

		const ref = client.watch<Todos>(TARGET);

		expect(ref.getState()).toMatchObject({ data: { todos: ["seeded"] }, loading: false });
	});
});
