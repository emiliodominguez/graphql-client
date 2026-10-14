import { describe, expect, it } from "vitest";
import { createCacheKey, hashDocument, parseOperation } from "./utils";

/**
 * document memo / hashing. Every test asserts the CORRECT behavior.
 */

describe("hashDocument", function () {
	it("gives different cache keys to two different documents (structured collision in the 64-bit hash)", function () {
		// Found by a 2^22 brute force: the two multiply-xor lanes never mix high bits down, so documents whose
		// characters differ only in bit 15 and above collide on far fewer than 64 bits.
		const first = '{ search(term: "칡칡칡칡칡乡乡乡乡乡乡乡乡乡乡乡칡乡칡칡乡칡칡칡") { id } }';
		const second = '{ search(term: "칡칡칡칡칡칡칡칡乡칡칡乡칡칡칡칡칡乡乡칡칡乡칡칡") { id } }';

		expect(first).not.toBe(second);
		expect(hashDocument(first)).not.toBe(hashDocument(second));
		// Same cache key: the client would serve the first query's cached data for the second one.
		expect(createCacheKey([], first)).not.toBe(createCacheKey([], second));
	});
});

describe("parseOperation", function () {
	it("detects the operation type in time linear in the document size (deep nesting)", function () {
		const depth = 16_000;
		const document = `subscription S ${"{a ".repeat(depth)}${"}".repeat(depth)}`;
		const startedAt = performance.now();

		expect(parseOperation(document).type).toBe("subscription");
		// A linear scan of 64 KB takes about a millisecond; INNERMOST_BLOCK rescans the document once per level.
		expect(performance.now() - startedAt).toBeLessThan(250);
	});
});
