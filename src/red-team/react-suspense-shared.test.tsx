// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import type { FetchPolicy } from "../types";
import { GraphQLProvider, useSuspenseQuery } from "../react/index";

const URL = "https://test.dev/graphql";
const TODOS = "query Todos { todos }";

async function settle(ms = 0): Promise<void> {
	await act(async function wait() {
		await new Promise(function tick(resolve) {
			setTimeout(resolve, ms);
		});
	});
}

afterEach(function clean() {
	cleanup();
});

const cases: Array<{ name: string; cached: boolean; fetchPolicy?: FetchPolicy }> = [
	{ name: "cacheless client", cached: false },
	{ name: "network-only", cached: true, fetchPolicy: "network-only" },
	{ name: "no-cache", cached: true, fetchPolicy: "no-cache" },
	{ name: "cache-first", cached: true },
];

describe("two useSuspenseQuery consumers of the same query in separate Suspense boundaries", function suite() {
	for (const { name, cached, fetchPolicy } of cases) {
		it(`share one request (${name})`, async function run() {
			const fetchMock = vi.fn<typeof fetch>(async function respond() {
				await new Promise(function wait(resolve) {
					setTimeout(resolve, 20);
				});
				return Response.json({ data: { todos: ["a"] } });
			});
			const client = new Client({ url: URL, fetch: fetchMock, ...(cached ? { cache: new MemoryCache() } : {}) });

			function Todos(props: { id: string }) {
				const { data } = useSuspenseQuery<{ todos: string[] }>({ query: TODOS, fetchPolicy });
				return <span data-testid={props.id}>{data.todos.join(",")}</span>;
			}

			render(
				<GraphQLProvider client={client}>
					<Suspense fallback={<span data-testid="fa">loading</span>}>
						<Todos id="a" />
					</Suspense>
					<Suspense fallback={<span data-testid="fb">loading</span>}>
						<Todos id="b" />
					</Suspense>
				</GraphQLProvider>,
			);
			await settle(60);
			await settle(60);

			expect(screen.getByTestId("a").textContent).toBe("a");
			expect(screen.getByTestId("b").textContent).toBe("a");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	}
});
