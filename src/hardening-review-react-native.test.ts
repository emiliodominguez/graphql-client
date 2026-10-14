// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { GraphQLProvider, useSuspenseQuery } from "./react/index";

/**
 * `typeof document === "undefined"` is used to detect the server in useSuspenseQuery, but React Native
 * (a client renderer) has no `document` either. Every test asserts the CORRECT behavior.
 */

const URL = "https://hardening.test/graphql";

afterEach(function () {
	cleanup();
	vi.unstubAllGlobals();
});

describe("useSuspenseQuery without a global document (React Native)", function () {
	it("does not refetch a network-only query when the component commits after the suspended load", async function () {
		let resolveFirst!: (response: Response) => void;
		let calls = 0;
		const fetchMock = vi.fn<typeof fetch>(function (): Promise<Response> {
			calls++;

			if (calls === 1) {
				return new Promise<Response>(function (resolve) {
					resolveFirst = resolve;
				});
			}

			return Promise.resolve(Response.json({ data: { n: calls } }));
		});
		const client = new Client({ url: URL, fetch: fetchMock });

		function Reader() {
			const { data } = useSuspenseQuery<{ n: number }>({ query: "query N { n }", fetchPolicy: "network-only" });

			return createElement("span", { "data-testid": "n" }, String(data.n));
		}

		render(
			createElement(
				GraphQLProvider,
				{ client },
				createElement(Suspense, { fallback: createElement("span", null, "loading") }, createElement(Reader)),
			),
		);

		await act(async function () {
			await vi.waitFor(function () {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});
		});

		// The load settles while there is no `document` (as on React Native), and React commits a bit later.
		const realDocument = globalThis.document;

		await act(async function () {
			vi.stubGlobal("document", undefined);
			resolveFirst(Response.json({ data: { n: 1 } }));
			await new Promise(function (resolve) {
				setTimeout(resolve, 5);
			});
			vi.stubGlobal("document", realDocument);
		});
		await act(async function () {
			await new Promise(function (resolve) {
				setTimeout(resolve, 20);
			});
		});

		expect(screen.getByTestId("n").textContent).toBe("1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("control: with a document the same sequence sends one request", async function () {
		let resolveFirst!: (response: Response) => void;
		let calls = 0;
		const fetchMock = vi.fn<typeof fetch>(function (): Promise<Response> {
			calls++;

			if (calls === 1) {
				return new Promise<Response>(function (resolve) {
					resolveFirst = resolve;
				});
			}

			return Promise.resolve(Response.json({ data: { n: calls } }));
		});
		const client = new Client({ url: URL, fetch: fetchMock });

		function Reader() {
			const { data } = useSuspenseQuery<{ n: number }>({ query: "query N { n }", fetchPolicy: "network-only" });

			return createElement("span", { "data-testid": "n" }, String(data.n));
		}

		render(
			createElement(
				GraphQLProvider,
				{ client },
				createElement(Suspense, { fallback: createElement("span", null, "loading") }, createElement(Reader)),
			),
		);

		await act(async function () {
			await vi.waitFor(function () {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});
		});

		// The load settles while there is no `document` (as on React Native), and React commits a bit later.
		await act(async function () {
			resolveFirst(Response.json({ data: { n: 1 } }));
			await new Promise(function (resolve) {
				setTimeout(resolve, 5);
			});
		});
		await act(async function () {
			await new Promise(function (resolve) {
				setTimeout(resolve, 20);
			});
		});

		expect(screen.getByTestId("n").textContent).toBe("1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
