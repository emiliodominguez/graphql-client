import { MemoryCache } from "../src/cache/memory-cache";
import { Client } from "../src/client";

/**
 * Micro-benchmarks for the client's hot paths. Run with `yarn bench`.
 */

const QUERY = /* GraphQL */ `
	query Dashboard($team: ID!, $first: Int = 20, $after: String, $filter: TaskFilter) {
		team(id: $team) {
			id
			name
			members(first: 50) {
				edges {
					node {
						id
						name
						avatar(size: 64)
						role
					}
				}
			}
			tasks(first: $first, after: $after, filter: $filter) {
				pageInfo {
					endCursor
					hasNextPage
				}
				edges {
					node {
						id
						title
						status
						priority
						assignee {
							id
							name
						}
						labels {
							id
							name
							color
						}
						updatedAt
					}
				}
			}
		}
	}
`;
const VARIABLES = { team: "t1", first: 20, filter: { status: ["OPEN", "IN_PROGRESS"], labels: ["bug", "p1"] } };

/**
 * Runs `task` repeatedly for about `ms` milliseconds after a warm-up and prints operations per second.
 *
 * @param name - Benchmark name
 * @param task - The operation to measure
 * @param ms - Measurement duration
 */
async function measure(name: string, task: () => unknown, ms = 1_500): Promise<void> {
	for (let index = 0; index < 2_000; index++) await task();

	let operations = 0;
	const start = performance.now();

	while (performance.now() - start < ms) {
		for (let index = 0; index < 200; index++) await task();
		operations += 200;
	}

	const perSecond = (operations / (performance.now() - start)) * 1_000;

	console.log(`${name.padEnd(44)} ${Math.round(perSecond).toLocaleString("en-US").padStart(12)} ops/s`);
}

/**
 * Entry point.
 */
async function main(): Promise<void> {
	const client = new Client({
		url: "https://bench.dev/graphql",
		cache: new MemoryCache({ maxSize: 1_000 }),
		fetch: async function () {
			return Response.json({ data: { team: { id: "t1" } } });
		},
	});

	await client.gql({ key: ["dashboard"], query: QUERY, variables: VARIABLES });

	await measure("gql cache hit", function () {
		return client.gql({ key: ["dashboard"], query: QUERY, variables: VARIABLES });
	});

	await measure("watch + subscribe + unsubscribe (cache hit)", function () {
		client.watch({ key: ["dashboard"], query: QUERY, variables: VARIABLES }).subscribe(function () {})();
	});

	await measure("read (cache hit)", function () {
		return client.read({ key: ["dashboard"], query: QUERY, variables: VARIABLES });
	});
}

void main();
