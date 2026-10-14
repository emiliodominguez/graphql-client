# Changelog

## Unreleased

### Added

- Optimistic updates: the `optimistic` option and the typed `optimistic(target, update)` helper, with automatic rollback.
- An `onError` hook, called once per failed operation after retries.
- `keepPreviousData` and `isPreviousData` for `useQuery`.
- Pagination with `fetchMore` on `QueryRef`, `useQuery` and `useSuspenseQuery`. It merges pages and writes the result to the cache entry.
- `QueryRef` follows the Svelte store contract, and the README has recipes for Svelte, Vue and Solid.
- `yarn verify` runs the full CI sequence locally. It is also used by `prepublishOnly`.
- WebSocket transport (`@emiliodominguez/graphql-client/ws`), a zero-dependency implementation of `graphql-transport-ws`. It shares one socket across subscriptions, connects and closes lazily, takes async `connectionParams`, and supports ack timeout, ping/pong keep-alive, and reconnect with resubscribe.
- A pluggable `subscriptionTransport` option and the `SubscriptionTransport` interface.
- A release workflow that publishes to npm with provenance on each GitHub release.
- React bindings (`@emiliodominguez/graphql-client/react`): `GraphQLProvider`, `useQuery`, `useSuspenseQuery`, `useMutation`, `useSubscription` and `useClient`.
- Live queries (`client.watch()`). They activate lazily, keep stale data visible while revalidating, and refetch on invalidation, polling, focus and reconnect.
- Fetch policies (`cache-first`, `network-only`, `cache-only`, `no-cache`).
- `client.read()` and `client.write()` for optimistic updates. `write()` notifies watchers.
- `client.extract()` and `client.restore()` for SSR hydration.
- `@defer` / `@stream` incremental delivery over `multipart/mixed` and SSE, in both the current and the 2022 payload formats.
- File uploads following the GraphQL multipart request spec, detected automatically.
- The `graphql` template tag, with typed documents and fragment dedupe, plus `minify()` and `dedupeFragments()`.
- `StorageCache`, a persistent cache backed by Web Storage.
- `initialData` for watched queries.

- Retries with exponential backoff, jitter and `Retry-After` support (`retry`). The `isRetryable` predicate is exported.
- Fetch-level middleware over standard `Request` and `Response` objects (`middleware`).
- `GET` requests for queries (`method: "GET"`).
- Automatic Persisted Queries (`persistedQueries`).
- Subscriptions over Server-Sent Events (`client.subscribe`).
- Declarative cache invalidation after a successful operation (`invalidates`).
- `client.extend()` for derived clients that share the cache.
- A bundle size budget enforced in CI.

### Fixed

- **Security (docs):** the SSR guide shared one cache across users while varying the auth token, which could serve one user's data to another. It now uses one cache per request, and `extend()` warns about it.
- A truncated or timed-out `multipart/mixed` response (`hasNext` still true) now rejects instead of resolving partial data and caching it.
- `no-cache` live queries no longer write the cache on refetch, poll or `fetchMore`. `cache-only` live queries no longer hit the network after an invalidation.
- `extract()` no longer loops forever with caches whose `keys()` returns a live iterator.
- `retry.attempts: NaN` no longer retries indefinitely. A `timeout` of `0` or a non-finite value disables the timeout instead of aborting at once. `StorageCache` rejects a `NaN` TTL.
- `subscribe()` no longer yields the same merged result twice for a trailing `completed` payload.
- Only network failures raised by `fetch` are retried by default. Invalid URLs and bodies consumed by middleware fail fast.
- A failing persisted-query hash, for example with no `crypto.subtle` on insecure origins, falls back to sending the full document.
- Public option types accept explicit `undefined` (`exactOptionalPropertyTypes`), and the library itself compiles with that flag.
- An invalidation now supersedes requests already in flight: they no longer repopulate the cache, and refetches never join them.
- `fetchMore` results are no longer overwritten by an older refetch that resolves later.
- The ordering model is now last-applied-wins per cache key. `no-cache` requests no longer interfere with cache writes, an aborted newer request no longer discards an older success, and cache-writing and `no-cache` requests are never deduplicated together.
- Live queries detect invalidations that happened while they were inactive, including on cacheless clients and with `initialData`.
- `useSuspenseQuery` adopts the live query that loaded while suspended instead of seeding a new one, so a later invalidation is never missed. Unused entries expire.
- `useSubscription` no longer reports `active: false` after a resubscribe or under StrictMode.
- WebSocket: an already-aborted signal ends immediately, there are no reconnects once no subscriptions are left, an idle socket closes after the ack, and the retry budget resets after giving up.
- `minify` no longer merges adjacent strings into a block string, and escaped `\"""` inside block strings is handled.
- `dedupeFragments` handles fragments preceded by comments and object values in arguments.
- Requests carrying files are never cached or deduplicated, since different files previously shared a key.
- A failed persisted-query hash is retried instead of being memoized.
- Subscribing the same listener twice no longer activates a query twice.

### Changed

- Clients that share a cache (for example via `extend()`) now also share live-query notifications and last-request-wins ordering.
- `ClientError.response` is now optional, and `status` is `0` for non-HTTP transports.
- **Breaking:** the per-call `cache?: boolean` option is replaced by `fetchPolicy`. Use `"no-cache"` for `cache: false` and `"cache-first"` for `cache: true`.
- The last request for a cache key wins: a superseded response no longer overwrites the cache or notifies watchers.
- Stream readers cancel on abort even when the body isn't tied to a `fetch`, for example a response returned by middleware.
- `TypedDocumentString.__apiType` is now declared as a method, which makes it bivariant. It remains structurally compatible with codegen.

- The transport now passes a `Request` object to `fetch`.
- The timeout covers the whole operation, retries included.
- Minimum Node version is now 20.

## 1.0.0

- Rewritten as a zero-dependency, fully typed client with an O(1) LRU cache, request deduplication, hierarchical invalidation, typed errors, timeouts, dynamic auth and headers, and ESM + CJS builds.
