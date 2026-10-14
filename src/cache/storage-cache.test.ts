import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageCache, type StorageLike } from "./storage-cache";

/**
 * Minimal in-memory Web Storage implementation.
 *
 * @returns The storage and its backing map
 */
function createStorage(): StorageLike & { map: Map<string, string> } {
	const map = new Map<string, string>();

	return {
		map,
		get length() {
			return map.size;
		},
		key(index: number) {
			return [...map.keys()][index] ?? null;
		},
		getItem(key: string) {
			return map.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			map.set(key, value);
		},
		removeItem(key: string) {
			map.delete(key);
		},
	};
}

describe("StorageCache", function () {
	afterEach(function () {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("stores namespaced JSON entries and reads them back", function () {
		const storage = createStorage();
		const cache = new StorageCache({ storage });

		cache.set("a", { x: 1 });

		expect(cache.get("a")).toEqual({ x: 1 });
		expect([...storage.map.keys()]).toEqual(["gql:a"]);
	});

	it("expires entries and supports infinite TTLs", function () {
		vi.useFakeTimers();

		const storage = createStorage();
		const short = new StorageCache({ storage, ttl: 100 });
		const forever = new StorageCache({ storage, prefix: "keep:", ttl: Infinity });

		short.set("a", 1);
		forever.set("b", 2);
		vi.advanceTimersByTime(1_000_000);

		expect(short.get("a")).toBeUndefined();
		expect(storage.map.has("gql:a")).toBe(false);
		expect(forever.get("b")).toBe(2);
	});

	it("drops corrupted entries", function () {
		const storage = createStorage();

		storage.setItem("gql:bad", "{not json");

		expect(new StorageCache({ storage }).get("bad")).toBeUndefined();
		expect(storage.map.size).toBe(0);
	});

	it("lists, deletes and clears only its own namespace", function () {
		const storage = createStorage();
		const cache = new StorageCache({ storage });

		storage.setItem("other", "1");
		cache.set("a", 1);
		cache.set("b", 2);

		expect(cache.keys()).toEqual(["a", "b"]);

		cache.delete("a");
		expect(cache.keys()).toEqual(["b"]);

		cache.clear();
		expect([...storage.map.keys()]).toEqual(["other"]);
	});

	it("swallows quota errors", function () {
		const storage = createStorage();

		storage.setItem = function () {
			throw new DOMException("full", "QuotaExceededError");
		};

		expect(function () {
			new StorageCache({ storage }).set("a", 1);
		}).not.toThrow();
	});

	it("defaults to localStorage and fails loudly without storage", function () {
		const storage = createStorage();

		vi.stubGlobal("localStorage", storage);
		new StorageCache().set("a", 1);
		expect(storage.map.has("gql:a")).toBe(true);

		vi.stubGlobal("localStorage", undefined);
		expect(function () {
			return new StorageCache();
		}).toThrow(/no storage available/);
	});
});
