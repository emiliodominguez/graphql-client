// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "../client";
import { GraphQLProvider, useLazyQuery } from "../react/index";

afterEach(function () {
	cleanup();
});

describe("useLazyQuery execute()", function () {
	it("rejects with the error of the first fetch, which the state also exposes", async function () {
		const client = new Client({
			url: "https://lazy.test/graphql",
			fetch: async function failing() {
				return Response.json({ errors: [{ message: "search failed" }] });
			} as typeof fetch,
			onError: function ignore() {},
		});
		let outcome: unknown;

		function Search() {
			const [search, { error }] = useLazyQuery<{ hits: string[] }>("query Search { hits }");

			useEffect(
				function run() {
					search().catch(function capture(caught: unknown) {
						outcome = caught;
					});
				},
				[search],
			);

			return createElement("span", { "data-testid": "status" }, error ? "error" : "idle");
		}

		render(createElement(GraphQLProvider, { client }, createElement(Search)));

		await act(async function settle() {
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 20);
			});
		});

		expect((outcome as Error | undefined)?.message).toContain("search failed");
		expect(screen.getByTestId("status").textContent).toBe("error");
	});
});
