import { ClientConfiguration } from "./client.d";

export default class Client {
	/**
	 * @constructor
	 * @param configuration - Configuration for the client
	 */
	constructor(private readonly configuration: ClientConfiguration) {}

	/**
	 * Perform a single GraphQL query/mutation operation
	 *
	 * @param key - The key used for cache
	 * @param query - The GraphQL query or mutation string
	 * @param variables - Optional variables object for the query or mutation
	 * @returns A Promise that resolves to the response data from the GraphQL server
	 * @throws Error if the network response is not ok, GraphQL server returns errors, or there is no data in the response
	 */
	async gql<Variables extends Record<string, string | number>, Payload>({
		key,
		query,
		variables,
	}: {
		key: (string | number)[];
		query: string;
		variables?: Variables;
	}): Promise<Payload> {
		const cache = this.configuration.cache;
		const cacheKey = cache ? JSON.stringify({ key, query, variables }) : "";

		if (cache) {
			const cachedData = cache.get<Payload>(cacheKey);

			if (cachedData) {
				return cachedData.data;
			}
		}

		try {
			const response = await this.fetch(query, variables);

			if (!response.ok) {
				throw new Error(`Network response was not ok. Status: ${response.status}, ${response.statusText}`);
			}

			const { data, errors } = await response.json();

			if (errors) {
				throw new Error(`GraphQL Errors: ${JSON.stringify(errors)}`);
			}

			if (!data) {
				throw new Error("No data found in the GraphQL response.");
			}

			if (cache) {
				cache.set(cacheKey, data);
			}

			return data;
		} catch (error) {
			console.error("GraphQL Request Error:", error);
			throw error;
		}
	}

	/**
	 * Perform the actual network request to the GraphQL server
	 *
	 * @param query - The GraphQL query or mutation string
	 * @param variables - Optional variables object for the query or mutation
	 * @returns A Promise that resolves to the fetch Response object
	 */
	private async fetch<Variables extends Record<string, string | number>>(
		query: string,
		variables?: Variables,
	): Promise<Response> {
		this.log(query);

		return fetch(this.configuration.graphUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: this.configuration.authToken ? `Bearer ${this.configuration.authToken}` : "",
				...this.configuration.headers,
			},
			body: JSON.stringify({ query, variables }),
		});
	}

	/**
	 * Log the query in development mode for debugging purposes
	 *
	 * @param query - The GraphQL query or mutation string
	 */
	private log(query: string): void {
		if (!this.configuration.debug) return;

		const regex = /query\s(\w+)/;
		const matches = query.match(regex);

		if (matches && matches.length > 1) {
			console.log(`Query: ${matches[1]}`);
		}
	}
}
