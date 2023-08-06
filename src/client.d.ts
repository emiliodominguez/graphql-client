import { type MemoryCache } from "./cache/memory-cache";

export interface ClientConfiguration {
	graphUrl: string;
	authToken?: string;
	headers?: HeadersInit;
	cache?: MemoryCache;
	debug?: boolean;
}
