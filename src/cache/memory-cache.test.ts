import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./memory-cache";

describe("MemoryCache", function () {
	beforeEach(function () {
		vi.useFakeTimers();
	});

	afterEach(function () {
		vi.useRealTimers();
	});

	it("stores and reads values", function () {
		const cache = new MemoryCache();

		cache.set("key", { foo: "bar" });

		expect(cache.get("key")).toEqual({ foo: "bar" });
		expect(cache.has("key")).toBe(true);
		expect(cache.size).toBe(1);
	});

	it("returns undefined on a miss", function () {
		expect(new MemoryCache().get("missing")).toBeUndefined();
	});

	it("expires entries after the TTL and prunes them on read", function () {
		const cache = new MemoryCache({ ttl: 1_000 });

		cache.set("key", 1);
		vi.advanceTimersByTime(999);
		expect(cache.get("key")).toBe(1);

		vi.advanceTimersByTime(1);
		expect(cache.has("key")).toBe(false);
		expect(cache.get("key")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("never expires entries with an infinite TTL", function () {
		const cache = new MemoryCache({ ttl: Infinity });

		cache.set("key", 1);
		vi.advanceTimersByTime(Number.MAX_SAFE_INTEGER);

		expect(cache.get("key")).toBe(1);
	});

	it("evicts the oldest entry when full", function () {
		const cache = new MemoryCache({ maxSize: 3 });

		for (let i = 0; i < 5; i++) cache.set(`key_${i}`, i);

		expect(cache.keys()).toEqual(["key_2", "key_3", "key_4"]);
	});

	it("evicts the least recently used entry, not the oldest written one", function () {
		const cache = new MemoryCache({ maxSize: 3 });

		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		cache.get("a");
		cache.set("d", 4);

		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
		expect(cache.keys()).toEqual(["c", "a", "d"]);
	});

	it("refreshes recency and TTL when overwriting a key", function () {
		const cache = new MemoryCache({ ttl: 1_000, maxSize: 2 });

		cache.set("a", 1);
		cache.set("b", 2);
		vi.advanceTimersByTime(500);
		cache.set("a", 10);
		cache.set("c", 3);

		expect(cache.keys()).toEqual(["a", "c"]);

		vi.advanceTimersByTime(600);
		expect(cache.get("a")).toBe(10);
	});

	it("caches falsy values", function () {
		const cache = new MemoryCache();

		cache.set("zero", 0);
		cache.set("null", null);

		expect(cache.get("zero")).toBe(0);
		expect(cache.get("null")).toBeNull();
	});

	it("deletes a single entry", function () {
		const cache = new MemoryCache();

		cache.set("key", 1);

		expect(cache.delete("key")).toBe(true);
		expect(cache.delete("key")).toBe(false);
		expect(cache.get("key")).toBeUndefined();
	});

	it("clears every entry", function () {
		const cache = new MemoryCache();

		cache.set("a", 1);
		cache.set("b", 2);
		cache.clear();

		expect(cache.size).toBe(0);
	});

	it("prunes expired entries when listing keys", function () {
		const cache = new MemoryCache({ ttl: 1_000 });

		cache.set("old", 1);
		vi.advanceTimersByTime(600);
		cache.set("new", 2);
		vi.advanceTimersByTime(600);

		expect(cache.keys()).toEqual(["new"]);
		expect(cache.size).toBe(1);
	});

	it.each([
		[{ ttl: -1 }, /ttl/],
		[{ ttl: Number.NaN }, /ttl/],
		[{ maxSize: 0 }, /maxSize/],
		[{ maxSize: 1.5 }, /maxSize/],
	])("rejects invalid configuration %o", function (configuration, message) {
		expect(function () {
			return new MemoryCache(configuration);
		}).toThrow(message);
	});
});
