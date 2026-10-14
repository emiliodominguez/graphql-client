# Changelog

## Unreleased

### Added

- A second, hostile model-based fuzzer (`src/fuzz-hostile.test.ts`): an async cache that completes calls out of order and fails at random (including synchronous throws), a flaky network with timeouts, aborts and retries, and two clients sharing the cache. It checks consistency invariants after quiescence (no rolled-back or placeholder data, live queries in sync with the cache, no lost or resurrected writes, frozen results, no leaks). Knobs: `HFUZZ_SEEDS`, `HFUZZ_OPS`, `HFUZZ_ON=sync,failGet`, `HFUZZ_SEED`, `HFUZZ_REPORT` / `HFUZZ_REPLAY`.
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

- Fourth red-team round. Custom fetch implementations: node-fetch / cross-fetch network failures (a `FetchError`, not a `TypeError`) are retried; an error page or invalid JSON is a `ClientError` with its status whatever error `json()` throws (bodies are read, then parsed); `@defer` multipart responses and SSE subscriptions read Node.js `Readable` bodies. A request built by middleware forwards every non-default mode (`cache`, `keepalive`, `integrity`, `mode`, `referrer`, `referrerPolicy`, `credentials`, `redirect`), and a polyfilled `Request` without `body` (React Native) reaches `fetch` as is, so uploads through middleware work there. `pollInterval`, `connectionAckTimeout`, `keepAlive` and `lazyCloseTimeout` treat `Infinity` (and delays a timer cannot hold) as "never" instead of firing back to back. Live queries never re-run `invalidates` or `optimistic` (removed from `WatchOptions`; an `invalidates` of its own key refetched forever). A `cache-and-network` live query showing cached data revalidates like a refetch: its failure reaches `error` and `loading` is `true` meanwhile. `keepPreviousData` never shows data from a previous client (logout / login). `useSuspenseQuery` no longer accepts the `keepPreviousData` it ignored. Large incremental payloads (100k+ errors or streamed items) no longer overflow the stack. An optimistic rollback on an entry whose invalidation failed to list keys no longer leaves the rolled-back data in the cache (a later `fetchMore` merged it in as real data). A succeeded optimistic layer stays only on top of data requested before the operation started (a placeholder stayed on top of newer data). Reads treat keys an invalidation is deleting as misses, and live queries that read a value a slow store then dropped (overtaken by an invalidation) refetch instead of showing data the cache no longer holds.

- Third red-team round: a response body already read by middleware, and malformed or non-object incremental payloads (`@defer` / `@stream` over multipart or SSE), fail fast with a `ClientError` instead of being retried as network failures or surfacing as raw `TypeError`s; only a body failing mid-read is a (retryable) network failure. An incremental path pointing far past the end of a list no longer creates a 4-billion-element sparse array. `subscribe()` races header and persisted-query hash resolution against its signal (a stalled token refresh no longer outlives the abort). The WebSocket transport reconnects at once after a keep-alive or acknowledgement timeout instead of waiting for the dead socket's `close` event (minutes on a vanished peer). `useSuspenseQuery` no longer mistakes React Native (no `document`) for a server. `StorageCache` reads, deletes and lists as empty when the storage denies access. Operation detection is linear in the document size (deeply nested documents were quadratic). The document hash folds high bits back down: documents differing only in high bits of their characters collided on far fewer than 64 bits (persisted cache entries written with the previous hash are simply misses). `write()` and `read()` see writes queued earlier for the same entry (read-your-writes), and an invalidation in progress no longer hides newer data for keys it already deleted or skipped.
- Cache consistency under concurrency and cache failures (found by the hostile fuzzer): rollbacks never restore data older than a write, a refetch or a store in flight; a `fetchMore` merge applies to the newest data and never persists a rolled-back layer or a placeholder; invalidations never delete data written after them, never let older data survive, and win over a slower write; a request superseded by a write is never joined by deduplication; a `fetchMore` started while an invalidation's refetch runs lets the refetch win; keys whose cleanup failed (e.g. a failed delete while rolling back) read as misses until a write succeeds; a failing cache write drops the entry instead of keeping outdated data; rollback failures reach `onError`; cache hits, overlays and rollbacks are frozen; `restore()` supersedes in-flight responses; a synchronously throwing cache read never makes `watch()` / `subscribe()` throw.
- Real-runtime hardening: a failed WebSocket handshake no longer wedges the transport (Node 22's WebSocket never fires `close`) or crashes the process (the `ws` package throws unhandled `error` events); streaming SSR with `useSuspenseQuery` no longer keeps Node alive for 10 seconds nor keeps polling from the server; two copies of the library (ESM + CJS, or two bundles) sharing a cache share notifications, ordering and retry classification; runtimes without `AbortSignal.prototype.throwIfAborted`, `DOMException` or `Request.prototype.clone` no longer fail every `@defer` query, hang on timeouts or fail every request.
- Second adversarial round: a slow store's post-invalidation cleanup never deletes data a newer write stored; optimistic base reads are no longer starved by stores on other keys (per-key tracking); a store in flight when an optimistic layer is applied becomes the layer's base instead of overwriting it; one failing `invalidates` prefix or cache delete (even a synchronous throw) no longer skips the others; an aborted subscription releases a response that arrives late; an intentional idle WebSocket close restores the full retry budget; deeply nested results no longer overflow the stack when frozen, and shallowly frozen inputs are still frozen deeply; `useSuspenseQuery` refetches with the latest `headers` after suspending.
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

- The size budget for `Client` + `MemoryCache` is 10.75 kB min+gzip (was 10 kB): the fixes of four red-team rounds (per-key cache lanes, hostile payload validation, foreign fetch support) cost about 0.7 kB.
- Cache operations on an entry are serialized: stores, optimistic renders and rollbacks, invalidation deletes, `fetchMore` merges and consistent reads run one at a time per key, so the cache and every live query go through the same states in the same order, whatever order an async cache adapter completes calls in. Data a live query receives while it fetches wins over the fetch's own (older) result.
- `invalidates` runs after the operation's optimistic layers settled. A succeeded operation's layer stays on top of real data requested before the operation started (which cannot contain its effect) and is dropped as soon as newer real data arrives; once no request is in flight it becomes part of the real data, unless that data is unknown (a placeholder never becomes real data: the refetch brings the truth).
- **Breaking:** a custom `fetch` is called as `fetch(url, init)` (the contract of node-fetch, cross-fetch, an npm `undici` with a proxy agent, and other GraphQL clients) instead of `fetch(request)`. Middleware still receives a `Request`; a request a middleware builds itself is converted to `fetch(url, init)` too (its body is read from a clone, and non-default `credentials` / `redirect` are forwarded).
- Aborting a subscription ends it quietly over every transport (SSE threw `AbortError`, WebSocket ended quietly); an incremental result left partial still rejects.
- Stricter types, found by a type-level red team: `read`, `write` and `optimistic` targets require the document's variables; passing only a data type argument (`gql<User>(...)`) no longer drops required variables (`__apiType` is a property, checked strictly); `useQuery` / `useSubscription` accept `variables: undefined` only together with `skip`; `optimistic()` takes `TData` from the document, never from the returned value; `fetchMore` merge and optimistic update callbacks receive `DeepReadonly` data (it is frozen at runtime) and must return new objects; `isClientError` no longer narrows other libraries' errors named `ClientError`; `fetchMore` `variables` is optional; the WebSocket transport accepts any `WebSocketLike` (the `ws` package type-checks); header types no longer need the DOM lib (`HeadersLike`).
- **Breaking:** results are deeply frozen (network results, `write()` / `restore()` data and optimistic renders). They are shared by the cache, deduplicated callers and live queries, so an in-place mutation used to corrupt all of them silently; it now throws. Optimistic updates and `fetchMore` merges must return new objects.
- The package is published as `lumenql` (subpaths `lumenql/react` and `lumenql/ws`). Debug logs use the `[lumenql]` prefix.
- Faster hot paths, about 1.5-1.8x on cache hits (`yarn bench`): documents are parsed once and memoized, file detection no longer deep-clones the variables, and cache keys embed a 64-bit hash of the document instead of its full text. Persisted cache entries written with the previous key format are simply misses.
- The build targets ES2022. Internals use native `#private` fields: truly private at runtime, and minified for a smaller bundle. This requires Node 20+ and browsers from 2021 or later.
- `SubscriptionRequest.query` is optional and `extensions` was added. Strict persisted queries send only `extensions.persistedQuery`.
- Clients that share a cache (for example via `extend()`) now also share live-query notifications and last-request-wins ordering.
- `ClientError.response` is now optional, and `status` is `0` for non-HTTP transports.
- **Breaking:** the per-call `cache?: boolean` option is replaced by `fetchPolicy`. Use `"no-cache"` for `cache: false` and `"cache-first"` for `cache: true`.
- The last request for a cache key wins: a superseded response no longer overwrites the cache or notifies watchers.
- Stream readers cancel on abort even when the body isn't tied to a `fetch`, for example a response returned by middleware.
- The timeout covers the whole operation, retries included.
- Minimum Node version is now 20.

## 1.0.0

- Rewritten as a zero-dependency, fully typed client with an O(1) LRU cache, request deduplication, hierarchical invalidation, typed errors, timeouts, dynamic auth and headers, and ESM + CJS builds.
