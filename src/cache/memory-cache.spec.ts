import { MemoryCache } from "./memory-cache";

describe("MemoryCache", () => {
	const configuration = Object.freeze({ ttl: 1000, maxSize: 3 });
	const memoryCache = new MemoryCache(configuration);

	afterEach(() => {
		memoryCache.clear();
	});

	it("set and get methods", () => {
		// Given
		const key = "key";
		const data = { foo: "bar" };

		// When
		memoryCache.set(key, data);

		const cachedData = memoryCache.get(key);

		// Then
		expect(cachedData).toBeDefined();
		expect(cachedData!.data).toEqual(data);
	});

	it("should return undefined if node has expired", async () => {
		// Given
		for (let i = 0; i < configuration.maxSize; i++) {
			memoryCache.set(`key_${i}`, { foo: `bar_${i}` });
		}

		await new Promise((resolve) => setTimeout(resolve, configuration.ttl));

		// When
		// Then
		expect(memoryCache.get(`key_0`)).toBeUndefined();
	});

	it("should evict nodes when size exceeds the configured max size", () => {
		// Given
		// When
		// Only the last {{ configuration.maxSize }} should remain after eviction
		for (let i = 0; i < configuration.maxSize + 2; i++) {
			memoryCache.set(`key_${i}`, { foo: `bar_${i}` });
		}

		// Then
		expect(memoryCache.get("key_0")).toBeUndefined();
		expect(memoryCache.get("key_1")).toBeUndefined();
		expect(memoryCache.get("key_2")).toBeDefined();
		expect(memoryCache.get("key_3")).toBeDefined();
		expect(memoryCache.get("key_4")).toBeDefined();
	});

	it("should delete a specific item from the cache", () => {
		// Given
		const key = "key";
		const data = { foo: "bar" };

		memoryCache.set(key, data);

		// When
		memoryCache.delete(key);

		// Then
		expect(memoryCache.get(key)).toBeUndefined();
	});

	it("should clear the entire cache", () => {
		// Given
		memoryCache.set("key_1", { foo: "bar" });
		memoryCache.set("key_2", { foo: "bar" });

		// When
		memoryCache.clear();

		// Then
		expect(memoryCache.get("key_1")).toBeUndefined();
		expect(memoryCache.get("key_2")).toBeUndefined();
	});
});
