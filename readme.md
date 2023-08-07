## GraphQL Client

This library provides a simple GraphQL client with an optional memory cache for caching GraphQL query responses. The library is written in TypeScript and can be used in both TypeScript and JavaScript projects.

### Basic scrips

```bash
yarn start	# Runs the script
yarn dev	# Runs the script in watch mode
yarn test	# Runs tests
```

Make sure to install the required devDependencies before running the scripts:

```bash
yarn install
```

### Classes

#### `Client`

The `Client` class is a GraphQL client that allows you to perform GraphQL query and mutation operations against a GraphQL server. It supports features like network request handling, response caching, and error handling.

##### Constructor

```typescript
constructor(configuration: ClientConfiguration)
```

-   `configuration` (Required): An object that provides the configuration options for the client. It includes the cache, GraphQL server URL, authentication token, headers, and debugging options.

##### Methods

###### `gql`

```typescript
async gql<Variables extends Record<string, string | number>, Payload>(options: {
    key: (string | number)[];
    query: string;
    variables?: Variables;
}): Promise<Payload>;
```

-   `options` (Required): An object containing the following properties:
    -   `key`: An array of string or number values used as the cache key for the request. Used when caching is enabled.
    -   `query`: The GraphQL query or mutation string.
    -   `variables` (Optional): An object containing the variables for the GraphQL query or mutation.

This method performs a single GraphQL query or mutation operation. It first checks the cache using the provided `key` and returns the cached data if available. If the data is not in the cache, it makes a network request to the GraphQL server and returns the response data. If caching is enabled, the response data is stored in the cache for future use.

Throws an error if the network response is not successful, the GraphQL server returns errors, or there is no data in the response.

###### `fetch` (Private)

```typescript
private async fetch<Variables extends Record<string, string | number>>(
    query: string,
    variables?: Variables,
): Promise<Response>;
```

-   `query` (Required): The GraphQL query or mutation string.
-   `variables` (Optional): An object containing the variables for the GraphQL query or mutation.

This private method performs the actual network request to the GraphQL server using the `fetch` API. It includes headers such as the `Content-Type`, `Authorization`, and custom headers specified in the client configuration.

###### `log` (Private)

```typescript
private log(query: string): void;
```

-   `query` (Required): The GraphQL query or mutation string.

This private method logs the query in the development mode for debugging purposes. It extracts the query name from the query string using a regular expression and logs it to the console when the debugging option is enabled in the client configuration.

#### `MemoryCache`

The `MemoryCache` class is a simple in-memory cache implementation used by the GraphQL client to store the responses from GraphQL server queries.

##### Constructor

```typescript
constructor(configuration?: Partial<MemoryCacheConfiguration>)
```

-   `configuration` (Optional): An object that provides optional configuration options for the cache. It includes time-to-live (TTL) and maximum cache size.

##### Methods

###### `get`

```typescript
get<Data>(key: string): CacheNode<Data> | undefined;
```

-   `key` (Required): The key associated with the cached data to be retrieved.

This method retrieves the cached data associated with the given key if it exists and is still valid (based on the TTL). If the data is expired, it returns `undefined`.

###### `set`

```typescript
set<Data>(key: string, data: Data): void;
```

-   `key` (Required): The key to associate with the cached data.
-   `data` (Required): The data to be cached.

This method sets a value in the cache with the given key. It also checks the cache size and evicts the least recently used item if necessary.

###### `delete`

```typescript
delete(key: string): void;
```

-   `key` (Required): The key associated with the item to be removed from the cache.

This method removes a specific item from the cache based on its key.

###### `clear`

```typescript
clear(): void;
```

This method clears the entire cache, removing all cached data.

###### `isValid` (Private)

```typescript
private isValid<Data>(payload: CacheNode<Data>): boolean;
```

-   `payload` (Required): The cache payload containing the data and its timestamp.

This private method checks if the cached data is still valid based on the time-to-live (TTL) configuration.

###### `evictLeastRecentlyUsed` (Private)

```typescript
private evictLeastRecentlyUsed(): void;
```

This private method is called after every successful `get` or `set` operation. It checks the cache size and evicts the least recently used item when necessary.

###### `moveToFront` (Private)

```typescript
private moveToFront<Data>(payload: CacheNode<Data>): void;
```

-   `payload` (Required): The cache payload to be moved to the front.

This private method moves the accessed payload to the front of the cache, ensuring that the most recently accessed item is closer to the front of the list.

### Configuration Options

#### `ClientConfiguration`

The `ClientConfiguration` interface defines the configuration options for the `Client` class.

```typescript
interface ClientConfiguration {
    graphUrl: string;
    authToken?: string;
    headers?: Record<string, string>;
    debug?: boolean;
    cache?: MemoryCache;
}
```

-   `cache` (Optional): An instance of the `MemoryCache` class used for caching the GraphQL responses. If not provided, caching is disabled.
-   `graphUrl` (Required): The URL of the GraphQL server.
-   `authToken` (Optional): An optional authentication token used in the `Authorization` header for GraphQL requests.
-   `headers` (Optional): An object containing custom headers to be included in GraphQL requests.
-   `debug` (Optional): A boolean flag to enable or disable logging of the queries in the development mode for debugging purposes.

#### `MemoryCacheConfiguration`

The `MemoryCacheConfiguration` interface defines the configuration options for the `MemoryCache` class.

```typescript
interface MemoryCacheConfiguration {
    ttl?: number;
    maxSize?: number;
}
```

-   `ttl` (Optional): The time-to-live (TTL) in milliseconds for cached data. Data older than the TTL will be considered expired and evicted from the cache. Default value: 60000 ms (1 minute).
-   `maxSize` (Optional): The maximum size of the cache. When the cache size exceeds this limit, the least recently used item is evicted. Default value: 100.

### Example Usage

```javascript
const client = new Client({
    graphUrl: "https://example.com/graphql",
    authToken: "YOUR_AUTH_TOKEN",
    headers: {}, // Custom headers if needed
    debug: true, // Debug mode
    cache: new MemoryCache({ ttl: 300000, maxSize: 50 })
});

const query = /* GraphQL */`
    query GetUser($id: Int!) {
        user(id: $id) {
            id
            name
        }
    }
`;

const variables = { id: 123 };

client
    .gql({ key: ["user", variables.id], query, variables })
    .then((data) => console.log("GraphQL Response:", data))
    .catch((error) => console.error("GraphQL Error:", error));
```

### Notes

-   The library uses the `fetch` API for making network requests, so it may not work in older browsers that do not support `fetch`.

---
