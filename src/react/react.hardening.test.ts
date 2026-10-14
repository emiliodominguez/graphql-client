// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { GraphQLProvider, useSuspenseQuery } from "./index";

/**
 * Regressions in the React fixes. Every test asserts the CORRECT behavior.
 */

const URL = "https://attack2.test/graphql";

/**
 * Normalizes the arguments `fetch` was called with into a Request (the client calls `fetch(url, init)`).
 *
 * @param input - The URL or request
 * @param init - The request init
 * @returns The request
 */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

async function settle(ms = 0): Promise<void> {
	await act(async function () {
		await new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	});
}

afterEach(function () {
	cleanup();
});

describe("useSuspenseQuery: request options from the latest render", function () {
	it("uses the latest headers on refetch after the initial suspension (e.g. a rotated auth token)", async function () {
		const seen: Array<string | null> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
			seen.push(toRequest(input, init).headers.get("authorization"));
			return Response.json({ data: { n: seen.length } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		let setToken!: (token: string) => void;
		let refetch!: () => Promise<unknown>;

		function Reader() {
			const [token, set] = useState("token-a");
			const result = useSuspenseQuery<{ n: number }>({ query: "query N { n }", headers: { authorization: token } });

			setToken = set;
			refetch = result.refetch;

			return createElement("span", { "data-testid": "n" }, String(result.data.n));
		}

		render(
			createElement(
				GraphQLProvider,
				{ client },
				createElement(Suspense, { fallback: createElement("span", null, "loading") }, createElement(Reader)),
			),
		);
		await settle(10);
		expect(screen.getByTestId("n").textContent).toBe("1");

		await act(async function () {
			setToken("token-b");
		});
		await act(async function () {
			await refetch();
		});

		// The ref created in the suspended (discarded) render must still see the committed component's options.
		expect(seen).toEqual(["token-a", "token-b"]);
	});
});
