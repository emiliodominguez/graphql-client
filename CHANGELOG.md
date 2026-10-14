# Changelog

## Unreleased

### Added

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

### Changed

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
