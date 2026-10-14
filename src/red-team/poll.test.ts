import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";

const URL = "https://test.dev/graphql";

function setup() {
	const fetchMock = vi.fn<typeof fetch>(async function respond() {
		return Response.json({ data: { n: 1 } });
	});
	const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

	return { client, fetchMock };
}

afterEach(function restore() {
	vi.useRealTimers();
});

describe("pollInterval values that cannot be honored", function suite() {
	for (const pollInterval of [Infinity, 2 ** 31, -1000]) {
		it(`pollInterval ${pollInterval} does not hammer the server`, async function run() {
			const { client, fetchMock } = setup();
			const ref = client.watch({ query: "query N { n }", pollInterval });
			const stop = ref.subscribe(function listen() {});

			await new Promise(function wait(resolve) {
				setTimeout(resolve, 300);
			});
			stop();

			// One initial fetch; a 2^31 ms (24.8 days) / infinite interval never fires within 300 ms.
			expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
		});
	}
});
