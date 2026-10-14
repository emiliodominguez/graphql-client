import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import type { Cache } from "./types";

/**
 * Attack tests: async cache reads the live-query bridge fires and forgets (`peek()` / `cached()`).
 * Kept in their own file because the first one produces an unhandled rejection, which vitest also reports globally.
 */

const URL = "https://attack.test/graphql";
const TODOS = "query Todos { todos }";

/**
 * Lets pending promises and 0ms timers run.
 */
async function tick(ms = 0): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, ms);
	});
}

describe("async cache reads discarded by live queries", function () {
	const unhandled: unknown[] = [];

	/**
	 * Records unhandled rejections.
	 */
	function record(reason: unknown): void {
		unhandled.push(reason);
	}

	beforeEach(function () {
		unhandled.length = 0;
		process.on("unhandledRejection", record);
	});

	afterEach(function () {
		process.off("unhandledRejection", record);
	});

	it("a rejecting async cache read never surfaces as an unhandled rejection from watch()", async function () {
		const cache: Cache = {
			get: async function () {
				throw new Error("IndexedDB read failed");
			},
			set: async function () {},
			delete: async function () {
				return true;
			},
			clear: async function () {},
			keys: async function () {
				return [];
			},
		};
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: 1 } });
			}),
		});
		const ref = client.watch({ key: ["todos"], query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		await tick(10);
		unsubscribe();
		await tick(10);

		expect(unhandled).toEqual([]);
	});

	it("a cache answering with a Promise from another realm is awaited, not shown as data", async function () {
		const inner = new MemoryCache();
		const cache: Cache = {
			get: function <T>(key: string): Promise<T | undefined> {
				// e.g. a cache bridged from an iframe / vm context: a genuine Promise, but not `instanceof Promise` here.
				return runInNewContext("Promise.resolve(value)", { value: inner.get<T>(key) }) as Promise<T | undefined>;
			},
			set: function <T>(key: string, value: T): void {
				inner.set(key, value);
			},
			delete: function (key: string): boolean {
				return inner.delete(key);
			},
			clear: function (): void {
				inner.clear();
			},
			keys: function (): string[] {
				return inner.keys();
			},
		};
		const client = new Client({
			url: URL,
			cache,
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { todos: 1 } });
			}),
		});
		const ref = client.watch<{ todos: number }>({ key: ["todos"], query: TODOS });

		ref.subscribe(function () {});
		await tick(10);

		expect(ref.getState().data).toEqual({ todos: 1 });
	});
});
