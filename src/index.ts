export { Client } from "./client";
export { MemoryCache, type MemoryCacheConfiguration } from "./cache/memory-cache";
export { StorageCache, type StorageCacheConfiguration, type StorageLike } from "./cache/storage-cache";
export { dedupeFragments, graphql, minify, type DocumentString } from "./document";
export { ClientError, isClientError, type ClientErrorDetails } from "./errors";
export { optimistic } from "./optimistic";
export { QueryRef, type QueryListener } from "./query-ref";
export { isRetryable } from "./retry";
export type {
	AuthTokenResolver,
	Cache,
	CacheKey,
	CacheTarget,
	ClientConfiguration,
	FetchMoreOptions,
	FetchPolicy,
	GraphQLFormattedError,
	GraphQLResponse,
	HeadersResolver,
	MaybePromise,
	Middleware,
	MiddlewareNext,
	OperationContext,
	OperationType,
	OptimisticUpdate,
	PersistedQueriesOptions,
	QueryState,
	RequestOptions,
	RetryOptions,
	SubscribeOptions,
	SubscriptionRequest,
	SubscriptionTransport,
	TypedDocumentString,
	WatchOptions,
} from "./types";
