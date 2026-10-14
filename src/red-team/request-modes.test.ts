import { expect, it } from "vitest";
import { Client } from "../client";

/**
 * A request built by middleware used to reach fetch as the Request itself, carrying every mode. Now it is converted
 * to fetch(url, init) and only `credentials` / `redirect` survive. Next.js' patched fetch reads `init.cache` (or
 * `input.cache` for a Request); browsers honor `cache` for GET queries (the README pitches them as HTTP-cacheable),
 * and `keepalive` is what lets a request outlive a page unload.
 */
function recorder(): { fetch: typeof fetch; inits: Array<RequestInit | undefined> } {
	const inits: Array<RequestInit | undefined> = [];

	return {
		inits,
		fetch: async function record(_url: unknown, init?: RequestInit) {
			inits.push(init);

			return Response.json({ data: { a: 1 } });
		} as unknown as typeof fetch,
	};
}

it("forwards `cache` of a request built by middleware (GET query, bypassing the HTTP cache)", async function () {
	const { fetch, inits } = recorder();
	const client = new Client({
		url: "https://modes.test/graphql",
		method: "GET",
		fetch,
		middleware: [
			function noStore(request, next) {
				return next(new Request(request, { cache: "no-store" }));
			},
		],
	});

	await client.gql({ query: "{ a }" });

	expect(inits[0]?.cache).toBe("no-store");
});

it("forwards `keepalive` of a request built by middleware", async function () {
	const { fetch, inits } = recorder();
	const client = new Client({
		url: "https://modes.test/graphql",
		fetch,
		middleware: [
			function beacon(request, next) {
				return next(new Request(request, { keepalive: true }));
			},
		],
	});

	await client.gql({ query: "mutation { track }" });

	expect(inits[0]?.keepalive).toBe(true);
});
