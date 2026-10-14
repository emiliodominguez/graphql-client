# Changelog

## Unreleased

### Added

- `maxBufferedResults` for the WebSocket transport (default `1_000`): a subscription whose consumer falls that far behind fails with a `RangeError` instead of buffering without bound.
- A seeded model-based fuzzer (`src/fuzz.test.ts`) for the cache, live queries and optimistic layers. It runs as a deterministic CI gate; use `FUZZ_SEEDS`/`FUZZ_OPS` for longer local runs.
- The `cache-and-network` fetch policy (stale-while-revalidate). It answers from the cache, refreshes in the background, and updates live queries.
- Type-level required variables. Omitting the `variables` a typed document requires is a compile error in `gql`, `watch`, `subscribe`, the hooks and `mutate`. `WithVariables` and `RequiredKeys` are exported.
- `useLazyQuery`: an on-demand query that stays live once executed.
- Strict persisted queries (`persistedQueries.strict`) for trusted documents and operation allow-lists.
- Optimistic updates: the `optimistic` option and the typed `optimistic(target, update)` helper, with automatic rollback.
- An `onError` hook, called once per failed operation after retries.
- `keepPreviousData` and `isPreviousData` for `useQuery`.
- Pagination with `fetchMore` on `QueryRef`, `useQuery` and `useSuspenseQuery`. It merges pages and writes the result to the cache entry.
- `QueryRef` follows the Svelte store contract, and the README has recipes for Svelte, Vue and Solid.
- `yarn verify` runs the full CI sequence locally. It is also used by `prepublishOnly`.
- WebSocket transport (`lumenql/ws`), a zero-dependency implementation of `graphql-transport-ws`. It shares one socket across subscriptions, connects and closes lazily, takes async `connectionParams`, and supports ack timeout, ping/pong keep-alive, and reconnect with resubscribe.
- A pluggable `subscriptionTransport` option and the `SubscriptionTransport` interface.
- A release workflow that publishes to npm with provenance on each GitHub release.
- React bindings (`lumenql/react`): `GraphQLProvider`, `useQuery`, `useSuspenseQuery`, `useMutation`, `useSubscription` and `useClient`.
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

- A WebSocket server that accepts then drops every connection exhausts `retryAttempts` instead of being retried forever: only a connection that stayed up for 10 seconds resets the retry budget.
- Cache and live-query hardening against failing or async cache adapters: a throwing watch listener is reported (via `onError`, else `console.error`) instead of breaking other listeners, the query or an unrelated request; a failing cache write or `invalidates` after a successful request is reported, never retried nor turned into a rejection; `StorageCache` drops an entry it fails to overwrite instead of serving outdated data; `fetchMore` merges pages with async caches; settling optimistic layers removes them all even when one entry fails to render; an optimistic rollback never restores data older than a write made while its base was read; `invalidate()` records itself before reading keys (responses landing meanwhile are dropped), always notifies live queries even when a delete fails, and wins over a slower in-flight `write()`; rejecting async reads never surface as unhandled rejections; promises from another realm are awaited, not shown as data.
- Transport hardening: middleware can call `next()` again (e.g. to retry after refreshing a token); a request whose body a middleware consumed fails once instead of being retried as a network failure; timeouts and aborts also cover stalled middleware, header resolvers and bodies not tied to the signal; a body failing mid-read is a retryable network failure, not "Invalid JSON"; a timeout during the retry backoff reaches `onError`; an aborted `@defer` / `@stream` result rejects instead of resolving with partial data; invalid JSON in a streamed payload is a `ClientError`; response media types match case-insensitively.
- Security hardening against hostile servers and inputs: no exponential backtracking on banner comments (`#####`) in `graphql` / `dedupeFragments`, linear-time lexing of documents full of escaped quotes, linear-time SSE and `multipart/mixed` readers (they were quadratic in the response size), `__proto__` keys and paths in incremental payloads stay plain data, malformed `errors` (an object, a string, `null` entries) surface as a `ClientError` instead of success or a `TypeError`, GET params are placed before a `#fragment` of the endpoint URL, files under variable keys containing `.` are rejected (multipart paths cannot express them), timeouts and retry delays above 2^31-1 ms no longer fire immediately, and a multipart boundary followed by whitespace is parsed.
- React: `useSuspenseQuery` no longer refetches on mount after the suspended load (`network-only` / `no-cache`, StrictMode), and a failed initial load sends one request, not two. `useQuery`, `useSuspenseQuery` and `useLazyQuery` refetch with the latest `headers`, `timeout` and `retry` (e.g. a rotated auth token). `useLazyQuery` drops a query executed with a previous client or document. `useSubscription` resets when `skip` turns true, never shows the previous variables' payload, and ignores payloads of a torn-down stream; `client.subscribe()` stops yielding once aborted.
- WebSocket transport hardening against hostile servers and failing environments: a throwing `WebSocket` constructor fails the waiting subscriptions instead of leaving a ghost subscription (or hanging after a reconnect); late events from a replaced socket (including a late `connectionParams` rejection) no longer affect the current one; malformed frames (`null`, non-objects, missing `type`) close with 4400; a duplicate `connection_ack` no longer resubscribes running operations; `error` messages with an empty or non-array payload surface as a `ClientError`; aborting drops buffered results; `dispose()` leaves no pending timers.
- Anonymous shorthand queries with a field named `subscription` or `mutation` after a nested selection were detected as that operation type (and routed as a subscription or never cached).
- A rolled-back optimistic change no longer stays visible when the refetch meant to replace it fails, including for live queries that were inactive while the layer settled. Live queries get the real data (or none) pushed directly.
- Found by a seeded model-based fuzzer (now part of the test suite):
  - An invalidation issued through another client sharing the cache (`extend()`) no longer lets live queries join a stale in-flight request.
  - Live queries never show a response the cache rejected as superseded, since they read back the cache entry.
  - With a cache configured, an optimistic update never adopts a live query's data as its base on a cache miss.
  - Removing a layer from an invalidated entry makes its live queries refetch, so a rolled-back change can't stay visible.
  - `fetchMore` merges onto the cache entry's current data, and drops the page if the entry was invalidated meanwhile.
  - `no-cache` live queries apply pending layers on top of their own response instead of discarding it.
- Optimistic layers on invalidated or expired entries no longer write their old base back. This covers a mutation's own `invalidates` on success, an invalidation while a layer is pending, and TTL expiry.
- A throwing optimistic update no longer leaves an orphan layer entry behind.
- `fetchMore` merges pages onto the real data, so pending optimistic layers stay layers.
- Live queries never apply optimistic layers twice when reading data that is already layered from the cache.
- `extract()` snapshots real data only, never pending optimistic data.
- Live queries no longer stay `loading` forever when the cache filled before their first subscriber.
- A cache failure while settling a successful optimistic mutation is reported through `onError` instead of rejecting the mutation.
- `RequiredKeys` keeps known required keys in variables that also have an index signature.
- Optimistic updates are layered. Each update sits on top of the entry's real data. Responses, writes and refetches rebase the pending layers, a failure removes only its own layer, and a success folds it into the real data. Concurrent optimistic mutations, refetches and invalidations no longer clobber each other.
- An optimistic `update` that throws rolls back the layers already applied and is reported to `onError`.
- `useLazyQuery` drives its own live query: one request and one `onError` per execution, whatever the dedupe settings or the fetch policy.
- Strict persisted queries also cover `subscribe()`, including HTTP streaming and custom transports.
- `keepPreviousData` never shows stale data while the query is skipped.
- Required-variables types: union variables are checked, and `variables: undefined` no longer bypasses the requirement. Hooks with `skip` accept possibly-undefined variables.
- Live queries defer deactivation by a tick, so hand-offs (StrictMode remounts, a promise handing over to a component) keep the query running instead of refetching.
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
- Variables with an own `__proto__` key are no longer dropped from cache keys (they collided with the same variables without it) or from multipart upload payloads.

### Changed

- The package is published as `lumenql` (subpaths `lumenql/react` and `lumenql/ws`). Debug logs use the `[lumenql]` prefix.
- Faster hot paths, about 1.5-1.8x on cache hits (`yarn bench`): documents are parsed once and memoized, file detection no longer deep-clones the variables, and cache keys embed a 64-bit hash of the document instead of its full text. Persisted cache entries written with the previous key format are simply misses.
- The build targets ES2022. Internals use native `#private` fields: truly private at runtime, and minified for a smaller bundle. This requires Node 20+ and browsers from 2021 or later.
- `SubscriptionRequest.query` is optional and `extensions` was added. Strict persisted queries send only `extensions.persistedQuery`.
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
