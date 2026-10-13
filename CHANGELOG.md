# Changelog

## Unreleased

### Added

- Retries with exponential backoff, jitter and `Retry-After` support (`retry`). The `isRetryable` predicate is exported.
- Fetch-level middleware over standard `Request` and `Response` objects (`middleware`).
- `GET` requests for queries (`method: "GET"`).
- Automatic Persisted Queries (`persistedQueries`).
- Subscriptions over Server-Sent Events (`client.subscribe`).
- Declarative cache invalidation after a successful operation (`invalidates`).
- `client.extend()` for derived clients that share the cache.
- A bundle size budget enforced in CI.

### Changed

- The transport now passes a `Request` object to `fetch`.
- The timeout covers the whole operation, retries included.
- Minimum Node version is now 20.

## 1.0.0

- Rewritten as a zero-dependency, fully typed client with an O(1) LRU cache, request deduplication, hierarchical invalidation, typed errors, timeouts, dynamic auth and headers, and ESM + CJS builds.
