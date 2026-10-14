import type { Cache } from "../types";

/**
 * Configuration for {@link MemoryCache}.
 */
export interface MemoryCacheConfiguration {
	/** Time-to-live in milliseconds. Use `Infinity` to disable expiration. Defaults to 60 000 (1 minute). */
	ttl: number;
	/** Maximum number of entries before the least recently used one is evicted. Defaults to 100. */
	maxSize: number;
}

/**
 * Internal cache entry.
 */
interface Entry {
	/** The cached value */
	value: unknown;
	/** Absolute expiration time in epoch milliseconds */
	expiresAt: number;
}

/**
 * In-memory LRU cache with per-entry TTL. All operations are O(1).
 *
 * Relies on `Map` insertion order: the first key is always the least recently used one,
 * and every read or write moves the touched key to the end.
 */
export class MemoryCache implements Cache {
	/**
	 * Entries in LRU order (oldest first).
	 */
	readonly #entries = new Map<string, Entry>();

	/**
	 * Resolved configuration.
	 */
	readonly #configuration: MemoryCacheConfiguration;

	/**
	 * @param configuration - Optional configuration overrides
	 * @throws {RangeError} When `ttl` is negative or `maxSize` is not a positive integer
	 */
	constructor(configuration?: Partial<MemoryCacheConfiguration>) {
		const ttl = configuration?.ttl ?? 60_000;
		const maxSize = configuration?.maxSize ?? 100;

		if (Number.isNaN(ttl) || ttl < 0) {
			throw new RangeError(`MemoryCache: "ttl" must be a non-negative number. Received ${ttl}.`);
		}

		if (!Number.isInteger(maxSize) || maxSize < 1) {
			throw new RangeError(`MemoryCache: "maxSize" must be a positive integer. Received ${maxSize}.`);
		}

		this.#configuration = { ttl, maxSize };
	}

	/**
	 * Number of stored entries, including expired ones not yet pruned.
	 */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Reads a value and marks it as most recently used. Expired entries are removed on access.
	 *
	 * @template T - The stored value type
	 * @param key - The cache key
	 * @returns The value, or `undefined` on a miss or when expired
	 */
	get<T>(key: string): T | undefined {
		const entry = this.#entries.get(key);

		if (!entry) return undefined;

		this.#entries.delete(key);

		if (this.#isExpired(entry)) return undefined;

		this.#entries.set(key, entry);

		return entry.value as T;
	}

	/**
	 * Stores a value as most recently used, evicting the least recently used entry when full.
	 *
	 * @template T - The value type
	 * @param key - The cache key
	 * @param value - The value to store
	 */
	set<T>(key: string, value: T): void {
		this.#entries.delete(key);
		this.#entries.set(key, { value, expiresAt: Date.now() + this.#configuration.ttl });

		if (this.#entries.size > this.#configuration.maxSize) {
			this.#entries.delete(this.#entries.keys().next().value as string);
		}
	}

	/**
	 * Checks for a live entry without affecting its recency.
	 *
	 * @param key - The cache key
	 * @returns `true` when a non-expired entry exists
	 */
	has(key: string): boolean {
		const entry = this.#entries.get(key);

		return entry !== undefined && !this.#isExpired(entry);
	}

	/**
	 * Removes a single entry.
	 *
	 * @param key - The cache key
	 * @returns `true` when an entry was removed
	 */
	delete(key: string): boolean {
		return this.#entries.delete(key);
	}

	/**
	 * Removes every entry.
	 */
	clear(): void {
		this.#entries.clear();
	}

	/**
	 * Lists live keys, pruning expired entries along the way.
	 *
	 * @returns The keys in LRU order (oldest first)
	 */
	keys(): string[] {
		const keys: string[] = [];

		for (const [key, entry] of this.#entries) {
			if (this.#isExpired(entry)) {
				this.#entries.delete(key);
			} else {
				keys.push(key);
			}
		}

		return keys;
	}

	/**
	 * Checks whether an entry outlived its TTL.
	 *
	 * @param entry - The cache entry
	 * @returns `true` when expired
	 */
	#isExpired(entry: Entry): boolean {
		return Date.now() >= entry.expiresAt;
	}
}
