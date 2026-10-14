import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";

/**
 * Regressions in result freezing. Every test asserts the CORRECT behavior.
 */

describe("deepFreeze on network results", function () {
	it("returns a deeply nested (but valid) response instead of failing with a stack overflow", async function () {
		const depth = 50_000;
		const body = '{"data":' + '{"a":'.repeat(depth) + "1" + "}".repeat(depth) + "}";
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return new Response(body, { headers: { "Content-Type": "application/json" } });
		});
		const client = new Client({ url: "https://attack2.test/graphql", fetch: fetchMock });

		// JSON.parse accepts this body; freezing it must not turn a successful response into a RangeError.
		await expect(client.gql({ query: "query Deep { a }" })).resolves.toBeDefined();
	});
});
