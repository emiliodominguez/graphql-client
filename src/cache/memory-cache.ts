import { BaseCache, CacheNode, MemoryCacheConfiguration } from "./memory-cache.d";

export class MemoryCache implements BaseCache {
	/**
	 * The internal Map that stores cached data with their corresponding keys
	 */
	private readonly _cache: Map<string, CacheNode<unknown>>;

	/**
	 * The configuration options for the MemoryCache instance
	 */
	private readonly configuration: MemoryCacheConfiguration;

	/**
	 * The internal Map that stores cached data with their corresponding keys
	 */
	get cache() {
		return this._cache;
	}

	/**
	 * @constructor
	 * @param configuration - Optional configuration for the cache
	 */
	constructor(configuration?: Partial<MemoryCacheConfiguration>) {
		this._cache = new Map();

		this.configuration = {
			...configuration,
			ttl: configuration?.ttl ?? 60 * 1000, // Cache time-to-live in milliseconds (1 minute)
			maxSize: configuration?.maxSize ?? 100, // Maximum cache size (100 items)
		};
	}

	/**
	 * Retrieves the cached data associated with the given key if it exists and is still valid
	 * If the data is expired based on the TTL, it will be considered invalid, and the method returns undefined
	 *
	 * @param key - The key associated with the cached data to be retrieved
	 * @returns The cached data payload or undefined if the data has expired or does not exist in the cache
	 */
	get<Data>(key: string): CacheNode<Data> | undefined {
		const payload = this._cache.get(key) as CacheNode<Data>;

		if (payload && this.isValid(payload)) {
			this.moveToFront<Data>(payload);
			return payload;
		}
	}

	/**
	 * Sets a value in the cache with the given key
	 *
	 * @param key - The key to associate with the cached data
	 * @param data - The partial cache payload containing the data to be cached
	 */
	set<Data>(key: string, data: Data): void {
		this._cache.set(key, { key, data, timestamp: Date.now() });
		this.evictLeastRecentlyUsed();
	}

	/**
	 * Removes a specific item from the cache based on its key
	 *
	 * @param key - The key associated with the item to be removed from the cache
	 */
	delete(key: string): void {
		this._cache.delete(key);
	}

	/**
	 * Clears the entire cache, removing all cached data.
	 */
	clear(): void {
		this._cache.clear();
	}

	/**
	 * Checks if the cached data is still valid based on the time-to-live (TTL) configuration
	 *
	 * @param payload - The cache payload containing the data and its timestamp
	 * @returns True if the data is still valid; false if it has expired based on the TTL
	 */
	isValid<Data>(payload: CacheNode<Data>): boolean {
		return Date.now() - payload.timestamp < this.configuration.ttl!;
	}

	/**
	 * This method is called after every successful get or set operation
	 * It checks the cache size and evicts the least recently used item when necessary
	 */
	private evictLeastRecentlyUsed(): void {
		if (this._cache.size <= this.configuration.maxSize!) return;

		let lruKey: string | null = null;
		let lruTimestamp = Number.MAX_VALUE;

		for (const [key, node] of this._cache.entries()) {
			if (node.timestamp < lruTimestamp) {
				lruKey = key;
				lruTimestamp = node.timestamp;
			}
		}

		if (lruKey) {
			this._cache.delete(lruKey);
		}
	}

	/**
	 * Moves the accessed payload to the front of the LRU list
	 * This ensures that the most recently accessed item is closer to the front of the list
	 *
	 * @param payload - The cache payload to be moved to the front
	 */
	private moveToFront<Data>(payload: CacheNode<Data>): void {
		// If there's only one item in the cache or the payload is already at the front, no need to move it
		if (this._cache.size === 1 || JSON.stringify(payload) === JSON.stringify(this._cache.values().next().value)) return;

		this._cache.delete(payload.key);
		this._cache.set(payload.key, payload);
	}
}
