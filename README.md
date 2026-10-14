# GraphQL Client

[![CI](https://github.com/emiliodominguez/graphql-client/actions/workflows/ci.yml/badge.svg)](https://github.com/emiliodominguez/graphql-client/actions/workflows/ci.yml)
![Size](https://img.shields.io/badge/min%2Bgzip-~6.8%20kB-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

A lightweight, zero-dependency, fully typed GraphQL client. It gives you the features of a heavier client in about 6.8 kB min+gzip, plus about 1.3 kB for the React hooks and about 1.5 kB for WebSockets.

**Transport**

- **Fetch-native.** Runs anywhere `fetch` exists: browsers, Node 20+, Deno, Bun and edge runtimes. Ships ESM and CJS, and works with GraphQL over HTTP and any spec-compliant server.
- **Middleware.** Composable wrappers over standard `Request` and `Response` objects, for auth refresh, tracing, logging or mocking.
- **Retries.** Exponential backoff with jitter that honors `Retry-After`. Only queries are retried by default.
- **Timeouts and `AbortSignal`.** Set them per client or per call, and they cover retries too.
- **Automatic Persisted Queries and GET.** Send small hashed requests that a CDN can cache. `minify()` shortens documents further.
- **File uploads.** Follows the GraphQL multipart request spec, and switches on automatically when variables contain a `File` or `Blob`.
- **`@defer` / `@stream`.** Incremental delivery over `multipart/mixed` or SSE, in both the current and the 2022 payload formats.
- **Subscriptions over SSE or WebSocket.** GraphQL over SSE built in, or a zero-dependency `graphql-transport-ws` transport (`/ws`, ~1.5 kB) with reconnects and keep-alive. Any other transport plugs in the same way.

**Data**

- **Document cache.** O(1) LRU with TTL (`MemoryCache`), persistent `StorageCache`, or any sync or async adapter you write.
- **Fetch policies.** `cache-first`, `network-only`, `cache-only` and `no-cache`. Mutations are never cached by default.
- **Deduplication and race safety.** Identical in-flight queries share one request, and the last request for a cache key always wins.
- **Hierarchical invalidation.** `invalidate(["user"])` drops `["user", 1]`, `["user", 2, "posts"]` and so on. Mutations can do this declaratively with `invalidates`.
- **Live queries.** `client.watch()` refetches on invalidation, polling, focus and reconnect, and keeps showing stale data while it revalidates.
- **Optimistic updates.** `client.write()` pushes data to every component watching that entry.
- **SSR.** `extract()` and `restore()` move the cache from server to browser, and hooks render cached data on the server.

**DX**

- **React.** `useQuery`, `useSuspenseQuery`, `useMutation` and `useSubscription`, safe under `StrictMode` and SSR.
- **Typed end to end.** Use the `graphql<TData, TVariables>` tag, generics, or zero-config GraphQL Code Generator documents.
- **`graphql` tag.** Compose fragments, with duplicated fragment definitions removed automatically.
- **Typed errors.** `ClientError` carries the status, the GraphQL `errors`, any partial `data` and the raw `Response`.

## Contents

[Install](#install) · [Quick start](#quick-start) · [Typed documents](#typed-documents) · [Caching](#caching) · [Live queries](#live-queries) · [React](#react) · [SSR](#ssr) · [Auth and headers](#auth-and-headers) · [Retries](#retries) · [Middleware](#middleware) · [GET and persisted queries](#get-requests-and-persisted-queries) · [File uploads](#file-uploads) · [@defer / @stream](#incremental-delivery-defer--stream) · [Subscriptions](#subscriptions-sse) · [WebSocket](#websocket-subscriptions) · [Abort and timeouts](#abort-and-timeouts) · [Errors](#error-handling) · [API](#api) · [Size](#size)

## Install

```bash
yarn add @emiliodominguez/graphql-client
# or
npm i @emiliodominguez/graphql-client
```

## Quick start

```ts
import { Client, MemoryCache, graphql } from "@emiliodominguez/graphql-client";

const client = new Client({
	url: "https://rickandmortyapi.com/graphql",
	cache: new MemoryCache({ ttl: 5 * 60_000, maxSize: 200 }),
	timeout: 10_000,
});

const CHARACTER = graphql<{ character: { name: string } }, { id: string }>`
	query Character($id: ID!) {
		character(id: $id) {
			name
		}
	}
`;

const { character } = await client.gql({ key: ["character", 1], query: CHARACTER, variables: { id: "1" } });
```

## Typed documents

There are three ways to type a document, and you can mix them:

```ts
// 1. The graphql tag with type arguments (no codegen).
const USER = graphql<UserQuery, UserQueryVariables>`
	query User($id: ID!) {
		user(id: $id) {
			name
		}
	}
`;
await client.gql({ query: USER, variables: { id: "1" } }); // data and variables inferred and checked

// 2. Generics on a plain string.
await client.gql<UserQuery, UserQueryVariables>({ query: USER_STRING, variables: { id: "1" } });

// 3. GraphQL Code Generator: `client` preset with `documentMode: "string"`.
import { graphql as codegen } from "./gql";
await client.gql({ query: codegen(`query User($id: ID!) { user(id: $id) { name } }`), variables: { id: "1" } });
```

The `graphql` tag composes fragments and removes duplicated fragment definitions, so shared dependencies only appear once:

```ts
const USER_FIELDS = graphql`
	fragment UserFields on User {
		id
		name
	}
`;
const FRIENDS = graphql`
	fragment Friends on User {
		friends {
			...UserFields
		}
	}
	${USER_FIELDS}
`;
const USER = graphql`
	query User {
		me {
			...UserFields
			...Friends
		}
	}
	${USER_FIELDS}
	${FRIENDS}
`;
```

## Caching

Caching is enabled once a `cache` is configured. Choose a strategy per call with `fetchPolicy`:

| Policy         | Reads cache | Network        | Writes cache | Default for |
| -------------- | ----------- | -------------- | ------------ | ----------- |
| `cache-first`  | Yes         | On a miss      | Yes          | queries     |
| `network-only` | No          | Always         | Yes          |             |
| `cache-only`   | Yes         | Never (throws) | No           |             |
| `no-cache`     | No          | Always         | No           | mutations   |

The cache key combines your `key`, the document, the `variables` (independent of key order) and the `operationName`. `key` is optional. Set it when you want to group entries for invalidation.

### Invalidation

```ts
await client.invalidate(["user", 1]); // that user only
await client.invalidate(["user"]); // every ["user", ...] entry
await client.invalidate(); // everything this client cached

// Declarative: runs only if the mutation succeeds.
await client.gql({ query: UPDATE_USER, variables: { id: 1 }, invalidates: [["user", 1], ["users"]] });
```

Any watched query (live query or React hook) under an invalidated prefix refetches automatically.

### Optimistic updates

`read` and `write` work on the same fields as a request. `write` updates every watcher of that entry immediately:

```ts
const target = { key: ["todos"], query: TODOS };
const previous = await client.read(target);

await client.write(target, { todos: [...previous.todos, draft] }); // instant UI

try {
	await client.gql({ query: ADD_TODO, variables: { draft }, invalidates: [["todos"]] }); // reconcile with the server
} catch (error) {
	await client.write(target, previous); // roll back
}
```

### Persistent cache

`StorageCache` persists results in `localStorage`, `sessionStorage` or any Storage-like object. That gives instant cache-first renders after a reload and offline reads:

```ts
import { StorageCache } from "@emiliodominguez/graphql-client";

const client = new Client({ url, cache: new StorageCache({ prefix: "app:", ttl: 24 * 60 * 60_000 }) });
```

It is namespaced, honors the TTL and drops corrupted entries. If storage is full or unavailable it falls back to a cache miss rather than throwing.

### Custom cache adapters

Implement `Cache`. Every method can be sync or async, so you can back it with IndexedDB, Redis or a KV store:

```ts
import type { Cache } from "@emiliodominguez/graphql-client";

const redisCache: Cache = {
	async get(key) {
		const raw = await redis.get(key);
		return raw === null ? undefined : JSON.parse(raw);
	},
	async set(key, value) {
		await redis.set(key, JSON.stringify(value), "EX", 60);
	},
	async delete(key) {
		await redis.del(key);
	},
	async clear() {
		await redis.flushdb();
	},
	async keys() {
		return redis.keys("*");
	},
};
```

## Live queries

`client.watch()` returns an observable query that works with any framework:

```ts
const todos = client.watch({
	key: ["todos"],
	query: TODOS,
	pollInterval: 30_000,
	refetchOnFocus: true,
	refetchOnReconnect: true,
});

const unsubscribe = todos.subscribe(function render({ data, error, loading }) {
	// ...
});

await todos.refetch(); // never rejects; failures land in `error`
```

- **Lazy.** It fetches when the first listener subscribes and stops polling and listening when the last one leaves.
- **Stale-while-revalidate.** `data` stays visible during refetches and after errors.
- **Stays fresh.** It refetches on invalidation, polling, focus and reconnect. If it was invalidated while inactive, it catches up on the next subscribe.
- **In sync.** Other fetches of the same entry, `write()` and `restore()` update it.
- **Synchronous cache read.** With a sync cache, cached data is available immediately, with no loading flash.
- **Store contract.** `subscribe` emits the current state immediately, so a `QueryRef` _is_ a Svelte store.

### Pagination

`fetchMore` fetches the same document with extra variables and merges the page into the data. It writes the merged result to the query's cache entry, so every component reading that entry updates:

```ts
const feed = client.watch({ key: ["feed"], query: FEED, variables: { first: 20 } });

await feed.fetchMore({
	variables: { after: feed.getState().data?.feed.pageInfo.endCursor },
	merge(previous, next) {
		return { feed: { ...next.feed, edges: [...previous.feed.edges, ...next.feed.edges] } };
	},
});
```

`useQuery` and `useSuspenseQuery` return the same `fetchMore`.

### Other frameworks

```svelte
<script>
	const todos = client.watch({ key: ["todos"], query: TODOS }); // a Svelte store as-is
</script>

{#if $todos.loading}Loading…{:else}{$todos.data.todos.length} todos{/if}
```

```ts
// Vue: a composable in four lines
export function useQuery(options) {
	const state = shallowRef();
	onScopeDispose(
		client.watch(options).subscribe(function update(next) {
			state.value = next;
		}),
	);
	return state;
}

// Solid
const todos = from(client.watch({ key: ["todos"], query: TODOS }));
```

## React

```tsx
import { GraphQLProvider, useMutation, useQuery } from "@emiliodominguez/graphql-client/react";

function App() {
	return (
		<GraphQLProvider client={client}>
			<Todos />
		</GraphQLProvider>
	);
}

function Todos() {
	const { data, loading, error, refetch } = useQuery({ key: ["todos"], query: TODOS, refetchOnFocus: true });
	const [addTodo, { loading: saving }] = useMutation(ADD_TODO, { invalidates: [["todos"]] });

	// `addTodo({ title })` → on success the list refetches and re-renders automatically
}
```

| Hook                              | Purpose                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useQuery(options)`               | Live query built on `client.watch()`. Returns `refetch` and `fetchMore`, supports `skip`. `useSyncExternalStore`-based, so it's tearing-free and SSR-safe. |
| `useSuspenseQuery(options)`       | Suspends until data is available and throws errors to the nearest error boundary. `data` is always defined.                                                |
| `useMutation(document, options?)` | Returns `[mutate, { data, error, loading, reset }]`. `mutate` rejects on failure.                                                                          |
| `useSubscription(options)`        | Streams SSE subscriptions or `@defer` queries while mounted. Supports `onData` and `skip`.                                                                 |
| `useClient()`                     | The client from context.                                                                                                                                   |

Components using the same entry share one request, and invalidations and `write()` re-render every consumer. React is an optional peer dependency (≥ 18).

## SSR

```ts
// Server
const client = new Client({ url, cache: new MemoryCache() });
await client.gql({ key: ["todos"], query: TODOS }); // or render with your framework's data loading
const snapshot = await client.extract();
// embed JSON.stringify(snapshot) in the HTML (escape "<" when inlining in a <script>)

// Browser
const client = new Client({ url, cache: new MemoryCache() });
await client.restore(window.__GRAPHQL_STATE__);
```

`useQuery` reads the restored cache synchronously, so the first render matches the server HTML without a loading state. To give each server request its own headers while sharing the cache, use `client.extend({ authToken })`.

## Auth and headers

```ts
const client = new Client({
	url: "/graphql",
	authToken: async function getToken() {
		return (await auth.getSession())?.accessToken; // evaluated per request; nullish skips the header
	},
	headers: { "X-Client": "web" }, // any HeadersInit, or a (sync/async) function returning one
});

await client.gql({ query, headers: { "X-Request-Id": crypto.randomUUID() } }); // per-call headers

const userClient = client.extend({ authToken: session.token }); // derived client, shared cache
```

Precedence from lowest to highest: defaults, `authToken`, client `headers`, call `headers`.

## Retries

```ts
const client = new Client({ url, retry: 3 }); // or { attempts, delay, retryIf }

await client.gql({ query, retry: false }); // per-call override
```

By default, network failures and HTTP 408, 429 and 5xx are retried for **queries only**, since mutations aren't idempotent. Retries back off exponentially with jitter (about 1 s, 2 s, 4 s and so on, capped at 30 s) and honor `Retry-After`. The `isRetryable` predicate is exported so you can extend it:

```ts
import { isClientError, isRetryable } from "@emiliodominguez/graphql-client";

const client = new Client({
	url,
	retry: {
		attempts: 5,
		retryIf(error, context) {
			return isRetryable(error, context) || (isClientError(error) && error.status === 401);
		},
	},
});
```

## Middleware

Middleware wraps every request, retries included, using standard `Request` and `Response` objects:

```ts
import type { Middleware } from "@emiliodominguez/graphql-client";

const tracing: Middleware = async function tracing(request, next, context) {
	const headers = new Headers(request.headers);

	headers.set("traceparent", createTraceparent());

	const startedAt = performance.now();
	const response = await next(new Request(request, { headers }));

	metrics.timing(`graphql.${context.name}`, performance.now() - startedAt, { attempt: context.attempt });

	return response;
};

const client = new Client({ url, middleware: [tracing] });
```

Calling `next()` with no argument forwards the current request. Returning a `Response` without calling `next` short-circuits the network, which works well for mocks and offline fallbacks.

## GET requests and persisted queries

```ts
const client = new Client({ url, method: "GET", persistedQueries: true });
```

- `method: "GET"` sends queries as search params without `Content-Type`, so CORS stays simple and responses are cacheable by HTTP caches and CDNs. Mutations and uploads always use `POST`.
- `persistedQueries` implements [Automatic Persisted Queries](https://www.apollographql.com/docs/apollo-server/performance/apq). The client sends a SHA-256 hash first and the full document only when the server asks for it. If the server doesn't support APQ, the client turns it off and falls back. Pass `{ hash }` to use precomputed hashes.
- `minify(document)` strips comments, insignificant whitespace and commas, and leaves strings untouched, so URLs are shorter and hashes stable.

## File uploads

When the variables contain a `File` or `Blob`, at any depth or in lists, the request switches to the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec):

```ts
await client.gql({ query: UPLOAD_AVATAR, variables: { userId, avatar: input.files[0] } });
```

Apollo Server's CSRF prevention requires a non-simple header for multipart requests. Add one with `headers: { "Apollo-Require-Preflight": "true" }`.

## Incremental delivery (`@defer` / `@stream`)

Documents containing `@defer` or `@stream` automatically advertise `multipart/mixed`:

```ts
// Resolves once every deferred fragment has arrived, fully merged.
const data = await client.gql({ query: PRODUCT_WITH_DEFERRED_REVIEWS });

// Or render progressively: each value is the merged result so far (new references on every patch).
for await (const partial of client.subscribe({ query: PRODUCT_WITH_DEFERRED_REVIEWS })) render(partial);
```

The client supports the current incremental format (`pending`/`id`/`subPath`/`completed`) and the 2022 format (`path`/`items`), delivered over `multipart/mixed` or SSE. If a deferred fragment fails, the client throws a `ClientError` that carries the partial data.

## Subscriptions (SSE)

```ts
for await (const { messageAdded } of client.subscribe({ query: ON_MESSAGE, variables: { room } })) {
	render(messageAdded);
}
```

This implements [GraphQL over SSE](https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md) in "distinct connections" mode, which GraphQL Yoga, Hot Chocolate and `graphql-sse` all support. Breaking out of the loop or aborting `signal` closes the connection. Headers, auth and middleware apply as usual.

## WebSocket subscriptions

`/ws` is a zero-dependency implementation of the [`graphql-transport-ws`](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md) protocol, as used by the `graphql-ws` library and supported by Apollo Server, GraphQL Yoga, Hasura, Mercurius and Hot Chocolate. Plug it in as the `subscriptionTransport`, and `client.subscribe()` and `useSubscription()` use it for `subscription` operations:

```ts
import { Client } from "@emiliodominguez/graphql-client";
import { createWebSocketTransport } from "@emiliodominguez/graphql-client/ws";

const client = new Client({
	url: "https://api.example.com/graphql",
	subscriptionTransport: createWebSocketTransport({
		url: "wss://api.example.com/graphql",
		connectionParams: async function getParams() {
			return { authorization: `Bearer ${await getToken()}` }; // evaluated on every (re)connect
		},
		keepAlive: 15_000, // ping every 15s and reconnect if no pong arrives
	}),
});
```

- **One socket** carries every subscription. It opens lazily and closes when the last subscription ends (`lazyCloseTimeout`).
- **Reconnects** with exponential backoff (`retryAttempts`, `retryDelay`) and **resubscribes** active operations. Fatal close codes, such as 4401 or 4403 for auth, fail the subscriptions instead of retrying.
- **Server errors** surface as `ClientError`s with `status: 0` and no `response`.
- **Custom runtimes:** pass `WebSocket` (for example the `ws` package) when there is no global `WebSocket`. Call `transport.dispose()` to shut it down.

Need another protocol (Phoenix, Ably, Pusher)? Implement `SubscriptionTransport`: a `subscribe(request, signal)` method that returns an `AsyncIterable` of GraphQL results.

## Abort and timeouts

```ts
const controller = new AbortController();

await client.gql({ query, signal: controller.signal, timeout: 5_000 });
```

An abort rejects with the signal's reason, usually an `AbortError`. A timeout rejects with a `TimeoutError` `DOMException`. The timeout covers the whole operation, retries and backoff included.

## Error handling

```ts
import { isClientError } from "@emiliodominguez/graphql-client";

try {
	await client.gql({ query });
} catch (error) {
	if (isClientError(error)) {
		error.status; // HTTP status
		error.errors; // GraphQL errors ([] when the failure is HTTP-level)
		error.data; // partial data, if the server sent any
		error.response; // raw Response
	} else {
		// transport failure (offline, DNS, CORS) or abort/timeout
	}
}
```

The client throws a `ClientError` when the response contains GraphQL `errors`, when the status is not 2xx (errors in the body are still parsed), when the body is not valid JSON, or when `data` is missing. The library never writes to the console unless `debug: true` is set.

## API

### `new Client(configuration)`

| Option                  | Type                                             | Default            | Description                                     |
| ----------------------- | ------------------------------------------------ | ------------------ | ----------------------------------------------- |
| `url`                   | `string`                                         | (required)         | GraphQL endpoint.                               |
| `authToken`             | `string \| () => MaybePromise<string \| null>`   | none               | Sent as `Authorization: Bearer <token>`.        |
| `headers`               | `HeadersInit \| () => MaybePromise<HeadersInit>` | none               | Extra headers for every request.                |
| `cache`                 | `Cache`                                          | none (no caching)  | Result cache.                                   |
| `fetch`                 | `typeof fetch`                                   | `globalThis.fetch` | Custom fetch for SSR, tests or instrumentation. |
| `timeout`               | `number` (ms)                                    | none               | Default request timeout.                        |
| `dedupe`                | `boolean`                                        | `true`             | Share in-flight identical queries.              |
| `retry`                 | `number \| RetryOptions`                         | none               | Retry policy. See [Retries](#retries).          |
| `middleware`            | `Middleware[]`                                   | `[]`               | Request/response middleware.                    |
| `method`                | `"POST" \| "GET"`                                | `"POST"`           | HTTP method for queries.                        |
| `persistedQueries`      | `boolean \| { hash }`                            | `false`            | Automatic Persisted Queries.                    |
| `subscriptionTransport` | `SubscriptionTransport`                          | SSE over `fetch`   | Transport for `subscription` operations.        |
| `debug`                 | `boolean`                                        | `false`            | Log operations, timings and cache hits.         |

### Methods

| Method                                 | Description                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gql(options): Promise<TData>`         | Runs a query or mutation. Options below.                                                                                                                     |
| `watch(options): QueryRef`             | Live query: `getState()`, `subscribe(listener)`, `refetch()`, `fetchMore()`. Takes `pollInterval`, `refetchOnFocus`, `refetchOnReconnect` and `initialData`. |
| `subscribe(options)`                   | `AsyncGenerator` over SSE subscriptions or `@defer`/`@stream` results.                                                                                       |
| `invalidate(prefix?)`                  | Removes cached results under a key prefix and refetches watchers. Returns the number removed.                                                                |
| `read(target)` / `write(target, data)` | Reads or writes a cache entry; `write` notifies watchers.                                                                                                    |
| `extract()` / `restore(snapshot)`      | Serializes the cache or hydrates it (SSR).                                                                                                                   |
| `extend(overrides): Client`            | Returns a derived client that shares the cache unless you override it.                                                                                       |

### `gql` / `watch` options

| Option          | Type                                      | Description                                                       |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `query`         | `string \| TypedDocumentString`           | The GraphQL document.                                             |
| `variables`     | `TVariables`                              | Operation variables (may contain files).                          |
| `operationName` | `string`                                  | Selects the operation when the document has several.              |
| `key`           | `(string \| number \| boolean \| null)[]` | Hierarchical cache key for grouping and invalidation.             |
| `fetchPolicy`   | `FetchPolicy`                             | See [Caching](#caching).                                          |
| `invalidates`   | `CacheKey[]`                              | Cache prefixes to invalidate after success.                       |
| `headers`       | `HeadersInit`                             | Per-call headers. Calls with these are not deduplicated.          |
| `signal`        | `AbortSignal`                             | Per-call abort signal. Calls with one are not deduplicated.       |
| `timeout`       | `number` (ms)                             | Per-call timeout, overrides the client default. Not deduplicated. |
| `retry`         | `number \| RetryOptions \| false`         | Per-call retry policy. Calls with one are not deduplicated.       |

### Caches and helpers

- `new MemoryCache({ ttl?, maxSize? })`: O(1) LRU. `ttl` defaults to 60 s and accepts `Infinity`. `maxSize` defaults to 100.
- `new StorageCache({ storage?, prefix?, ttl? })`: Web Storage–backed. Defaults to `localStorage`, `"gql:"` and 24 h.
- `graphql` tag, `minify(document)`, `dedupeFragments(document)`, `isClientError(error)`, `isRetryable(error, context)`.

## Size

Sizes are minified + gzip, measured by `yarn size` and enforced in CI:

| Import                                  | Size    |
| --------------------------------------- | ------- |
| `Client` + `MemoryCache` (tree-shaken)  | ~6.8 kB |
| `@emiliodominguez/graphql-client/react` | ~1.3 kB |
| `@emiliodominguez/graphql-client/ws`    | ~1.5 kB |

## Development

```bash
yarn install
yarn verify        # everything CI runs: format, typecheck, coverage, build, size, exports
yarn test          # unit, integration, React and type tests
yarn coverage      # tests with coverage thresholds
yarn typecheck
yarn build         # ESM + CJS + .d.ts via tsup
yarn size          # bundle sizes + budget
yarn check:exports # validates package exports/types for every resolution mode
yarn demo          # builds and runs examples/rick-and-morty.js
```

### Releasing

1. Add an `NPM_TOKEN` repository secret (an npm automation token).
2. Bump `version` in `package.json`, update the CHANGELOG and push.
3. Publish a GitHub release tagged `v<version>`.

The release workflow checks that the tag matches the package version, runs the full check suite, and publishes to npm with provenance.

## License

[MIT](./LICENSE) © Emilio Dominguez
