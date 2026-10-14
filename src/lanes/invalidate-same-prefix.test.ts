import { describe, expect, it } from "vitest";
import { Client } from "../client";
import type { CacheKey } from "../types";
import { URL, TODOS, type Todos, heldServer, parkedCache, releaseAll, releaseFirst, tick } from "./lanes.helpers";

const TARGET = { key: ["todos"], query: TODOS };

/**
 * Runs two concurrent invalidations of the ["todos"] prefix and a write issued after both, with the first
 * invalidation finishing before the second one lists the keys.
 *
 * @param first - Prefix of the first invalidation
 * @param second - Prefix of the second invalidation
 * @returns What the cache holds for the written entry afterwards
 */
async function scenario(first: CacheKey, second: CacheKey): Promise<unknown> {
	const { fetchMock } = heldServer();
	const { cache, store, parked } = parkedCache();
	const client = new Client({ url: URL, fetch: fetchMock, cache });
	const seed = client.write<Todos>(TARGET, { todos: ["old"] });

	await releaseAll(parked);
	await seed;

	const cacheKey = [...store.keys()][0]!;
	const one = client.invalidate(first);
	const two = client.invalidate(second);
	await tick();

	// Written after both invalidations were issued: it must survive both.
	const write = client.write<Todos>(TARGET, { todos: ["fresh"] });
	await tick();
	await releaseFirst(parked, "set");
	await write;

	// The first invalidation lists the keys and keeps the newer data, then finishes.
	await releaseFirst(parked, "keys");
	await releaseAll(parked, function (call) {
		return call.kind === "keys";
	});
	await one;

	// The second one lists the keys now.
	await releaseAll(parked);
	await two;

	return store.get(cacheKey);
}

describe("concurrent invalidations of the same prefix array", function () {
	it("control: distinct prefix arrays keep data written after both invalidations", async function () {
		expect(await scenario(["todos"], ["todos"])).toEqual({ todos: ["fresh"] });
	});

	it("keep data written after both invalidations when the prefix is the SAME array (a shared constant)", async function () {
		const TODOS_KEY: CacheKey = ["todos"];

		// e.g. two mutations with `invalidates: [TODOS_KEY]` finishing close together.
		expect(await scenario(TODOS_KEY, TODOS_KEY)).toEqual({ todos: ["fresh"] });
	});
});
