export interface CacheNode<Data> {
	key: string;
	data: Data;
	timestamp: number;
}

export interface BaseCache {
	cache: Map<string, CacheNode<unknown>>;
	set<Data>(key: string, data: Partial<CacheNode<Data>>): void;
	get<Data>(key: string): CacheNode<Data> | undefined;
	delete(key: string): void;
	clear(): void;
	isValid<Data>(payload: CacheNode<Data>): boolean;
}

export interface MemoryCacheConfiguration {
	ttl?: number;
	maxSize?: number;
}
