import { Client, MemoryCache, graphql, isClientError } from "../dist/index.js";

const client = new Client({
	url: process.env.GRAPHQL_URL ?? "https://rickandmortyapi.com/graphql",
	cache: new MemoryCache({ ttl: 5 * 60_000, maxSize: 50 }),
	timeout: 10_000,
	retry: 2,
	debug: true,
});

const CHARACTER_FIELDS = graphql`
	fragment CharacterFields on Character {
		id
		name
		species
	}
`;

const CHARACTERS = graphql`
	query Characters($page: Int) {
		characters(page: $page) {
			info {
				count
				pages
			}
			results {
				...CharacterFields
			}
		}
	}
	${CHARACTER_FIELDS}
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
 * Runs the demo: deduplicated burst, cache hit, live query and invalidation-driven refetch.
 */
async function main() {
	try {
		// Two identical concurrent calls share one network request.
		const [first] = await Promise.all([getCharacters(1), getCharacters(1)]);

		console.log(`${first.info.count} characters, first: ${first.results[0]?.name}`);

		// Served from the cache.
		await getCharacters(1);

		// Live query: re-renders whenever its cache entry is invalidated or refreshed.
		const live = client.watch({ key: ["characters", 2], query: CHARACTERS, variables: { page: 2 } });
		const stop = live.subscribe(function render({ data, loading }) {
			if (!loading) console.log(`page 2 → ${data?.characters.results.length} characters`);
		});

		await live.refetch();

		// Hierarchical invalidation: drops every ["characters", ...] entry and refetches the live query.
		console.log(`Invalidated ${await client.invalidate(["characters"])} entries`);
		await new Promise(function wait(resolve) {
			setTimeout(resolve, 1_000);
		});

		stop();
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
