import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientError } from "./errors";
import { isRetryable, parseRetryAfter, resolveRetryPolicy } from "./retry";
import type { OperationContext } from "./types";

const QUERY: OperationContext = { type: "query", query: "{ a }", attempt: 0 };
const MUTATION: OperationContext = { type: "mutation", query: "mutation { a }", attempt: 0 };

/**
 * Builds a ClientError with the given status and headers.
 *
 * @param status - HTTP status
 * @param headers - Response headers
 * @returns The error
 */
function httpError(status: number, headers?: HeadersInit): ClientError {
	return new ClientError(`HTTP ${status}`, { status, response: new Response(null, { status, headers }) });
}

describe("resolveRetryPolicy", function () {
	it("is disabled when unset, 0 or false", function () {
		expect(resolveRetryPolicy(undefined, undefined)).toBeUndefined();
		expect(resolveRetryPolicy(0, undefined)).toBeUndefined();
		expect(resolveRetryPolicy(3, 0)).toBeUndefined();
		expect(resolveRetryPolicy(3, false)).toBeUndefined();
	});

	it("lets the call option override the client option", function () {
		expect(resolveRetryPolicy(5, 1)?.attempts).toBe(1);
		expect(resolveRetryPolicy(5, false)).toBeUndefined();
		expect(resolveRetryPolicy(undefined, { attempts: 4 })?.attempts).toBe(4);
	});

	it("defaults to 2 attempts with the built-in predicate", function () {
		const policy = resolveRetryPolicy({}, undefined);

		expect(policy?.attempts).toBe(2);
		expect(policy?.retryIf).toBe(isRetryable);
	});

	it("supports constant and custom delays", function () {
		const custom = vi.fn(function () {
			return 7;
		});

		expect(resolveRetryPolicy({ delay: 250 }, undefined)?.delay(3, null)).toBe(250);
		expect(resolveRetryPolicy({ delay: custom }, undefined)?.delay(1, "e")).toBe(7);
		expect(custom).toHaveBeenCalledWith(1, "e");
	});

	describe("default delay", function () {
		afterEach(function () {
			vi.restoreAllMocks();
		});

		it("backs off exponentially with jitter, capped at 30s", function () {
			const { delay } = resolveRetryPolicy(1, undefined)!;

			vi.spyOn(Math, "random").mockReturnValue(1);
			expect(
				[0, 1, 2, 10].map(function (retry) {
					return delay(retry, null);
				}),
			).toEqual([1_000, 2_000, 4_000, 30_000]);

			vi.spyOn(Math, "random").mockReturnValue(0);
			expect(delay(0, null)).toBe(500);
		});

		it("honors Retry-After", function () {
			const { delay } = resolveRetryPolicy(1, undefined)!;

			expect(delay(0, httpError(429, { "Retry-After": "3" }))).toBe(3_000);
			expect(delay(0, httpError(503, { "Retry-After": "3600" }))).toBe(30_000);
		});
	});
});

describe("isRetryable", function () {
	it.each([
		[new TypeError("fetch failed"), true],
		[httpError(408), true],
		[httpError(429), true],
		[httpError(500), true],
		[httpError(503), true],
		[httpError(400), false],
		[httpError(401), false],
		[new Error("boom"), false],
		[new DOMException("Aborted", "AbortError"), false],
	])("%s → %s for queries", function (error, expected) {
		expect(isRetryable(error, QUERY)).toBe(expected);
	});

	it("never retries mutations", function () {
		expect(isRetryable(new TypeError("fetch failed"), MUTATION)).toBe(false);
		expect(isRetryable(httpError(503), MUTATION)).toBe(false);
	});
});

describe("parseRetryAfter", function () {
	afterEach(function () {
		vi.useRealTimers();
	});

	it("parses delta-seconds and HTTP dates", function () {
		vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00Z") });

		expect(parseRetryAfter("2")).toBe(2_000);
		expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT")).toBe(5_000);
		expect(parseRetryAfter("Wed, 31 Dec 2025 23:00:00 GMT")).toBe(0);
		expect(parseRetryAfter("-1")).toBe(0);
	});

	it("ignores missing or invalid values", function () {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter("")).toBeUndefined();
		expect(parseRetryAfter("soon")).toBeUndefined();
	});
});
