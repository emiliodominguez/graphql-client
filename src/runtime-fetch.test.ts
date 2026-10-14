// Runtime red-team: the `fetch` option with fetch implementations that are not the global one.
// Real repro with the actual packages: scratchpad/runtimes/consumer/custom-fetch.mjs (node-fetch@2, cross-fetch,
// undici@7 npm fetch all fail every request: "Only absolute URLs are supported" / "Failed to parse URL from [object Request]").
import { describe, expect, it } from "vitest";
import { Client } from "./client";

/**
 * Behaves like node-fetch@2 / cross-fetch / an npm `undici` copy: it only recognizes its OWN Request class, so a
 * global `Request` is stringified ("[object Request]") and rejected as a URL.
 */
function foreignFetch(input: unknown, init?: RequestInit): Promise<Response> {
	if (typeof input !== "string" && !(input instanceof URL)) {
		return Promise.reject(new TypeError(`Failed to parse URL from ${String(input)}`));
	}

	return Promise.resolve(Response.json({ data: { ok: true, method: init?.method ?? "GET" } }));
}

describe("runtime: custom fetch implementations", function () {
	it("works with a fetch that takes (url, init), like node-fetch / cross-fetch / undici from npm", async function () {
		const client = new Client({ url: "https://api.example.com/graphql", fetch: foreignFetch as typeof fetch });

		await expect(client.gql({ query: "query Q { ok }" })).resolves.toEqual({ ok: true, method: "POST" });
	});
});
