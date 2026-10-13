import { Client, MemoryCache, isClientError } from "../dist/index.js";

const client = new Client({
	url: "https://rickandmortyapi.com/graphql",
	cache: new MemoryCache({ ttl: 5 * 60_000, maxSize: 50 }),
	timeout: 10_000,
	debug: true,
});

const CHARACTERS = /* GraphQL */ `
	query Characters($page: Int) {
		characters(page: $page) {
			info {
				count
				pages
			}
			results {
				id
				name
				species
			}
		}
	}
`;

/**
 * Fetches one page of characters.
 *
 * @param {number} page - Page number
 * @returns {Promise<{ info: { count: number, pages: number }, results: Array<{ id: string, name: string, species: string }> }>}
 */
async function getCharacters(page) {
	const { characters } = await client.gql({ key: ["characters", page], query: CHARACTERS, variables: { page } });

	return characters;
}

/**
 * Runs the demo: a network request, a deduplicated burst, a cache hit, then an invalidation.
 */
async function main() {
	try {
		// Two identical concurrent calls → one network request.
		const [first] = await Promise.all([getCharacters(1), getCharacters(1)]);

		console.log(`${first.info.count} characters, first: ${first.results[0]?.name}`);

		// Served from the cache.
		await getCharacters(1);

		// Hierarchical invalidation: drops every ["characters", ...] entry.
		console.log(`Invalidated ${await client.invalidate(["characters"])} entries`);
	} catch (error) {
		if (isClientError(error)) {
			console.error(`GraphQL request failed (${error.status}):`, error.errors);
		} else {
			console.error("Network failure:", error);
		}

		process.exitCode = 1;
	}
}

main();
