# GraphQL Client

[![CI](https://github.com/emiliodominguez/graphql-client/actions/workflows/ci.yml/badge.svg)](https://github.com/emiliodominguez/graphql-client/actions/workflows/ci.yml)
![Size](https://img.shields.io/badge/min%2Bgzip-~3.9%20kB-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

A lightweight, zero-dependency, fully typed GraphQL client. Around 3.9 kB min+gzip, with features you'd normally get from a much bigger client.

- **Zero dependencies.** Ships ESM and CJS and runs anywhere `fetch` exists: browsers, Node 20+, Deno, Bun and edge runtimes.
- **O(1) LRU cache with TTL.** The cache is pluggable and accepts sync or async adapters (memory, `localStorage`, IndexedDB, Redis).
- **Safe for mutations.** Only queries are cached. Mutations always go to the network, and `invalidates` clears related entries after a successful mutation.
- **Request deduplication.** Identical queries that are in flight at the same time share one network request.
- **Hierarchical invalidation.** `invalidate(["user"])` drops `["user", 1]`, `["user", 2, "posts"]` and so on.
- **Retries.** Exponential backoff with jitter that honors `Retry-After`. Only queries are retried by default.
- **Middleware.** Composable wrappers over standard `Request` and `Response` objects, for auth refresh, tracing, logging or mocking.
- **Automatic Persisted Queries and GET.** Send small hashed requests that a CDN can cache.
- **Subscriptions over SSE.** `for await` over GraphQL-over-SSE streams, with no WebSocket library.
- **Typed end to end.** Generics, or zero-config inference from GraphQL Code Generator's `TypedDocumentString`.
- **Typed errors.** `ClientError` carries the status, the GraphQL `errors`, any partial `data` and the raw `Response`.
- **Timeouts and `AbortSignal`.** Set them per client or per call, and they cover retries too.
- **Dynamic auth and headers.** Pass sync or async factories, and derive scoped clients with `extend()`.

## Install

```bash
yarn add @emiliodominguez/graphql-client
# or
npm i @emiliodominguez/graphql-client
```

## Quick start

```ts
import { Client, MemoryCache } from "@emiliodominguez/graphql-client";

const client = new Client({
	url: "https://rickandmortyapi.com/graphql",
	cache: new MemoryCache({ ttl: 5 * 60_000, maxSize: 200 }),
	timeout: 10_000,
});

const { character } = await client.gql<{ character: { name: string } }>({
	key: ["character", 1],
	query: /* GraphQL */ `
		query Character($id: ID!) {
			character(id: $id) {
				name
			}
		}
	`,
	variables: { id: 1 },
});
```

## Typed documents

Pass `TData` and, optionally, `TVariables` explicitly:

```ts
const data = await client.gql<UserQuery, UserQueryVariables>({ query: USER_QUERY, variables: { id: 1 } });
```

You can also use [GraphQL Code Generator](https://the-guild.dev/graphql/codegen)'s `client` preset with `documentMode: "string"`. Both types are then inferred, and `variables` are type-checked against the document:

```ts
import { graphql } from "./gql";

const UserQuery = graphql(`
	query User($id: ID!) {
		user(id: $id) {
			name
		}
	}
`);

const { user } = await client.gql({ query: UserQuery, variables: { id: "1" } }); // fully typed
```

## Caching

Caching is enabled once a `cache` is configured.

| Operation  | Cached by default | Override       |
| ---------- | ----------------- | -------------- |
| `query`    | Yes               | `cache: false` |
| `mutation` | No                | `cache: true`  |

The cache key combines your `key`, the document, the `variables` (independent of key order) and the `operationName`. `key` is optional. Set it when you want to group entries for invalidation.

### Invalidation

```ts
await client.gql({ query: UPDATE_USER, variables: { id: 1, name: "Morty" } });

await client.invalidate(["user", 1]); // that user only
await client.invalidate(["user"]); // every ["user", ...] entry
await client.invalidate(); // everything this client cached
```

Mutations can invalidate cache entries declaratively. This only runs when the mutation succeeds:

```ts
await client.gql({ query: UPDATE_USER, variables: { id: 1 }, invalidates: [["user", 1], ["users"]] });
```

### Custom cache adapters

Implement the `Cache` interface. Every method can be sync or async:

```ts
import type { Cache } from "@emiliodominguez/graphql-client";

const sessionCache: Cache = {
	get(key) {
		const raw = sessionStorage.getItem(key);
		return raw === null ? undefined : JSON.parse(raw);
	},
	set(key, value) {
		sessionStorage.setItem(key, JSON.stringify(value));
	},
	delete(key) {
		sessionStorage.removeItem(key);
	},
	clear() {
		sessionStorage.clear();
	},
	keys() {
		return Object.keys(sessionStorage);
	},
};
```

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
```

Precedence from lowest to highest: defaults, `authToken`, client `headers`, call `headers`.

`extend()` derives a client that shares the same cache, which is handy for per-request auth in SSR:

```ts
const userClient = client.extend({ authToken: session.token });
```

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

- `method: "GET"` sends queries as search params without `Content-Type`, so CORS stays simple and responses are cacheable by HTTP caches and CDNs. Mutations always use `POST`.
- `persistedQueries` implements [Automatic Persisted Queries](https://www.apollographql.com/docs/apollo-server/performance/apq). The client sends a SHA-256 hash first and the full document only when the server asks for it. If the server doesn't support APQ, the client turns it off and falls back. Pass `{ hash }` to use precomputed hashes.

Together they produce short, stable URLs that a CDN can cache.

## Subscriptions (SSE)

```ts
for await (const { messageAdded } of client.subscribe({ query: ON_MESSAGE, variables: { room } })) {
	render(messageAdded);
}
```

This implements [GraphQL over SSE](https://github.com/enisdenjo/graphql-sse/blob/master/PROTOCOL.md) in "distinct connections" mode, which GraphQL Yoga, Hot Chocolate and `graphql-sse` all support. Breaking out of the loop or aborting `signal` closes the connection. Headers, auth and middleware apply as usual.

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

The client throws a `ClientError` when:

- the response contains GraphQL `errors`;
- the status is not 2xx (errors in the body are still parsed);
- the body is not valid JSON;
- `data` is missing.

The library never writes to the console unless `debug: true` is set.

## API

### `new Client(configuration)`

| Option             | Type                                             | Default            | Description                                     |
| ------------------ | ------------------------------------------------ | ------------------ | ----------------------------------------------- |
| `url`              | `string`                                         | (required)         | GraphQL endpoint.                               |
| `authToken`        | `string \| () => MaybePromise<string \| null>`   | none               | Sent as `Authorization: Bearer <token>`.        |
| `headers`          | `HeadersInit \| () => MaybePromise<HeadersInit>` | none               | Extra headers for every request.                |
| `cache`            | `Cache`                                          | none (no caching)  | Query result cache.                             |
| `fetch`            | `typeof fetch`                                   | `globalThis.fetch` | Custom fetch for SSR, tests or instrumentation. |
| `timeout`          | `number` (ms)                                    | none               | Default request timeout.                        |
| `dedupe`           | `boolean`                                        | `true`             | Share in-flight identical queries.              |
| `debug`            | `boolean`                                        | `false`            | Log operations, timings and cache hits.         |
| `retry`            | `number \| RetryOptions`                         | none               | Retry policy. See [Retries](#retries).          |
| `middleware`       | `Middleware[]`                                   | `[]`               | Request/response middleware.                    |
| `method`           | `"POST" \| "GET"`                                | `"POST"`           | HTTP method for queries.                        |
| `persistedQueries` | `boolean \| { hash }`                            | `false`            | Automatic Persisted Queries.                    |

### `client.gql<TData, TVariables>(options): Promise<TData>`

| Option          | Type                                      | Description                                                       |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `query`         | `string \| TypedDocumentString`           | The GraphQL document.                                             |
| `variables`     | `TVariables`                              | Operation variables.                                              |
| `operationName` | `string`                                  | Selects the operation when the document has several.              |
| `key`           | `(string \| number \| boolean \| null)[]` | Hierarchical cache key for grouping and invalidation.             |
| `cache`         | `boolean`                                 | Per-call caching override.                                        |
| `headers`       | `HeadersInit`                             | Per-call headers. Calls with these are not deduplicated.          |
| `signal`        | `AbortSignal`                             | Per-call abort signal. Calls with one are not deduplicated.       |
| `timeout`       | `number` (ms)                             | Per-call timeout, overrides the client default. Not deduplicated. |
| `retry`         | `number \| RetryOptions \| false`         | Per-call retry policy. Calls with one are not deduplicated.       |
| `invalidates`   | `CacheKey[]`                              | Cache prefixes to invalidate after success.                       |

### `client.invalidate(prefix?): Promise<number>`

Removes cached results whose `key` starts with `prefix` and returns how many were removed.

### `client.subscribe<TData, TVariables>(options): AsyncGenerator<TData>`

Takes `query`, `variables`, `operationName`, `headers` and `signal`. See [Subscriptions](#subscriptions-sse).

### `client.extend(overrides): Client`

Returns a new client with the overridden configuration, sharing the cache unless you override it.

### `new MemoryCache({ ttl?, maxSize? })`

An O(1) LRU cache. `ttl` defaults to `60_000` ms and accepts `Infinity`. `maxSize` defaults to `100`. It exposes `get`, `set`, `has`, `delete`, `clear`, `keys` and `size`.

## Development

```bash
yarn install
yarn test          # unit + type tests
yarn coverage      # tests with coverage thresholds
yarn typecheck
yarn build         # ESM + CJS + .d.ts via tsup
yarn size          # min / gzip / brotli bundle size
yarn demo          # builds and runs examples/rick-and-morty.js
```

## License

[MIT](./LICENSE) © Emilio Dominguez
