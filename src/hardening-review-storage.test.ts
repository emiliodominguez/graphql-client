import { describe, expect, it, vi } from "vitest";
import { StorageCache, type StorageLike } from "./cache/storage-cache";
import { Client } from "./client";

/**
 * StorageCache vs its documented contract. Every test asserts the CORRECT behavior.
 */

const URL = "https://hardening.test/graphql";

/**
 * Storage that exists but rejects every access (cookies blocked, sandboxed iframe, disabled storage).
 */
function unavailableStorage(): StorageLike {
	function deny(): never {
		throw new DOMException("The operation is insecure.", "SecurityError");
	}

	return { getItem: deny, setItem: deny, removeItem: deny, key: deny, length: 0 };
}

describe("StorageCache with unavailable storage", function () {
	it("falls back to a cache miss instead of failing the request (README: 'rather than throwing')", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { a: 1 } });
		});
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			cache: new StorageCache({ storage: unavailableStorage() }),
		});

		await expect(client.gql({ query: "{ a }" })).resolves.toEqual({ a: 1 });
	});

	it("get() reads as a miss", function () {
		const cache = new StorageCache({ storage: unavailableStorage() });

		expect(cache.get("k")).toBeUndefined();
	});
});
