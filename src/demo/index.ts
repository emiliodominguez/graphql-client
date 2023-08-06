import Client from "../client";
import { MemoryCache } from "../cache/memory-cache";

const client = new Client({
	graphUrl: "https://rickandmortyapi.com/graphql",
	cache: new MemoryCache(),
});

async function getCharacters(): Promise<any /** For demo purposes. Should add the proper type */> {
	const query = /* GraphQL */ `
		query CharactersQuery($page: Int) {
			characters(page: $page) {
				info {
					count
					pages
					next
					prev
				}
				results {
					id
					name
					status
					species
					type
					gender
					image
				}
			}
		}
	`;

	const { characters } = await client.gql<any, any>({
		key: ["characters"],
		query,
		variables: { page: 2 },
	});

	return characters;
}

getCharacters().then(console.log);
