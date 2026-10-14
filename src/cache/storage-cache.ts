import type { Cache } from "../types";

/**
 * The subset of the Web Storage API the cache needs (`localStorage`, `sessionStorage` or any compatible store).
 */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Configuration for {@link StorageCache}.
 */
export interface StorageCacheConfiguration {
	/** Backing storage. Defaults to `globalThis.localStorage`. */
	storage: StorageLike;
	/**
	 * Namespace prepended to every key, so the cache never touches unrelated entries. Defaults to `"gql:"`.
	 * Namespaces must not nest: with `"gql:"` and `"gql:admin:"`, clearing the first would clear the second.
	 */
	prefix: string;
	/** Time-to-live in milliseconds. Use `Infinity` to disable expiration. Defaults to 24 hours. */
	ttl: number;
}

/**
 * Serialized entry.
 */
interface StoredEntry {
	/** The cached value */
	v: unknown;
	/** Absolute expiration time in epoch milliseconds, or `null` for no expiration */
	e: number | null;
}

/**
 * Persistent cache backed by Web Storage: survives reloads, enabling instant cache-first renders and offline reads.
 * Values must be JSON-serializable. Write failures (quota exceeded, private mode) are swallowed: the cache degrades
 * to a miss instead of breaking requests.
 */
export class StorageCache implements Cache {
	/**
	 * Resolved configuration.
	 */
	private readonly configuration: StorageCacheConfiguration;

	/**
	 * @param configuration - Optional configuration overrides
	 * @throws {Error} When no storage is available and none is provided
	 * @throws {RangeError} When `ttl` is negative or `NaN`
	 */
	constructor(configuration?: Partial<StorageCacheConfiguration>) {
		const storage = configuration?.storage ?? globalThis.localStorage;

		if (!storage) throw new Error("StorageCache: no storage available. Pass one through the `storage` option.");

		const ttl = configuration?.ttl ?? 86_400_000;

		if (Number.isNaN(ttl) || ttl < 0) {
			throw new RangeError(`StorageCache: "ttl" must be a non-negative number. Received ${ttl}.`);
		}

		this.configuration = { storage, prefix: configuration?.prefix ?? "gql:", ttl };
	}

	/**
	 * Reads a value. Expired or corrupted entries are removed.
	 *
	 * @template T - The stored value type
	 * @param key - The cache key
	 * @returns The value, or `undefined` on a miss
	 */
	get<T>(key: string): T | undefined {
		const raw = this.configuration.storage.getItem(this.configuration.prefix + key);

		if (raw === null) return undefined;

		try {
			const entry = JSON.parse(raw) as StoredEntry;

			if (entry.e === null || Date.now() < entry.e) return entry.v as T;
		} catch {
			// Corrupted entry: fall through and drop it.
		}

		this.delete(key);

		return undefined;
	}

	/**
	 * Stores a value. Silently skipped when the storage rejects the write.
	 *
	 * @template T - The value type
	 * @param key - The cache key
	 * @param value - A JSON-serializable value
	 */
	set<T>(key: string, value: T): void {
		const { ttl, storage, prefix } = this.configuration;
		const entry: StoredEntry = { v: value, e: ttl === Infinity ? null : Date.now() + ttl };

		try {
			storage.setItem(prefix + key, JSON.stringify(entry));
		} catch {
			// Quota exceeded or storage disabled: degrade to a cache miss.
		}
	}

	/**
	 * Removes a single entry.
	 *
	 * @param key - The cache key
	 */
	delete(key: string): void {
		this.configuration.storage.removeItem(this.configuration.prefix + key);
	}

	/**
	 * Removes every entry of this namespace.
	 */
	clear(): void {
		for (const key of this.keys()) this.delete(key);
	}

	/**
	 * Lists the keys of this namespace.
	 *
	 * @returns The keys, without the prefix
	 */
	keys(): string[] {
		const { storage, prefix } = this.configuration;
		const keys: string[] = [];

		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index);

			if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
		}

		return keys;
	}
}
