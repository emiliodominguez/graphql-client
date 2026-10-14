// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { GraphQLProvider, useLazyQuery, useQuery } from "../react/index";

const URL = "https://test.dev/graphql";
const ME = "query Me { me }";

function createUserClient(user: string) {
	let release: (() => void) | undefined;
	const fetchMock = vi.fn<typeof fetch>(async function respond() {
		if (user === "bob") {
			// Bob's request is slow: the window in which Alice's data could leak.
			await new Promise<void>(function hold(resolve) {
				release = resolve;
			});
		}
		return Response.json({ data: { me: user } });
	});

	return {
		client: new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() }),
		release() {
			release?.();
		},
	};
}

afterEach(function clean() {
	cleanup();
});

describe("keepPreviousData across a client swap (e.g. logout / login as another user)", function suite() {
	it("useQuery never shows the previous client's data", async function run() {
		const alice = createUserClient("alice");
		const bob = createUserClient("bob");

		function Me() {
			const { data, isPreviousData } = useQuery<{ me: string }>({ query: ME, keepPreviousData: true });
			return <span data-testid="me">{`${data?.me ?? "-"}${isPreviousData ? " (previous)" : ""}`}</span>;
		}

		const { rerender } = render(
			<GraphQLProvider client={alice.client}>
				<Me />
			</GraphQLProvider>,
		);

		await act(async function settle() {
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 10);
			});
		});
		expect(screen.getByTestId("me").textContent).toBe("alice");

		rerender(
			<GraphQLProvider client={bob.client}>
				<Me />
			</GraphQLProvider>,
		);
		await act(async function settle() {
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 10);
			});
		});

		// Bob is logged in: Alice's data must not be on screen while Bob's loads.
		expect(screen.getByTestId("me").textContent).not.toContain("alice");
		bob.release();
	});

	it("useLazyQuery never shows the previous client's data after executing on the new client", async function run() {
		const alice = createUserClient("alice");
		const bob = createUserClient("bob");
		let execute!: () => Promise<unknown>;

		function Me() {
			const [run, { data }] = useLazyQuery<{ me: string }>(ME, { keepPreviousData: true });
			execute = run;
			return <span data-testid="me">{data?.me ?? "-"}</span>;
		}

		const { rerender } = render(
			<GraphQLProvider client={alice.client}>
				<Me />
			</GraphQLProvider>,
		);

		await act(async function go() {
			await execute();
		});
		expect(screen.getByTestId("me").textContent).toBe("alice");

		rerender(
			<GraphQLProvider client={bob.client}>
				<Me />
			</GraphQLProvider>,
		);
		await act(async function go() {
			void execute().catch(function ignore() {});
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 10);
			});
		});

		expect(screen.getByTestId("me").textContent).not.toBe("alice");
		bob.release();
	});
});
