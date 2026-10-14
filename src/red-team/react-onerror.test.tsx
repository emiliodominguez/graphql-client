// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { Component, StrictMode, Suspense, useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import type { FetchPolicy } from "../types";
import { GraphQLProvider, useLazyQuery, useMutation, useQuery, useSubscription, useSuspenseQuery } from "../react/index";

const URL = "https://test.dev/graphql";

class Boundary extends Component<{ children: ReactNode }, { error?: Error | undefined }> {
	override state: { error?: Error | undefined } = {};
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	override render() {
		return this.state.error ? <span>boundary</span> : this.props.children;
	}
}

async function settle(ms = 0): Promise<void> {
	await act(async function wait() {
		await new Promise(function tick(resolve) {
			setTimeout(resolve, ms);
		});
	});
}

function setup() {
	const onError = vi.fn();
	const fetchMock = vi.fn<typeof fetch>(async function respond() {
		return Response.json({ errors: [{ message: "nope" }] }, { status: 500 });
	});
	const client = new Client({
		url: URL,
		fetch: fetchMock,
		cache: new MemoryCache(),
		onError,
		retry: { attempts: 1, delay: 1 },
	});
	return { client, fetchMock, onError };
}

afterEach(function clean() {
	cleanup();
	vi.restoreAllMocks();
});

const policies: FetchPolicy[] = ["cache-first", "network-only", "no-cache", "cache-and-network"];

describe("onError exactly once per failed operation under StrictMode", function suite() {
	for (const fetchPolicy of policies) {
		it(`useQuery (${fetchPolicy})`, async function run() {
			const { client, fetchMock, onError } = setup();
			function Q() {
				useQuery({ query: "query A { a }", fetchPolicy });
				return null;
			}
			render(
				<StrictMode>
					<GraphQLProvider client={client}>
						<Q />
					</GraphQLProvider>
				</StrictMode>,
			);
			await settle(50);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(onError).toHaveBeenCalledTimes(1);
		});

		it(`useSuspenseQuery (${fetchPolicy})`, async function run() {
			vi.spyOn(console, "error").mockImplementation(function quiet() {});
			const { client, fetchMock, onError } = setup();
			function Q() {
				useSuspenseQuery({ query: "query A { a }", fetchPolicy });
				return null;
			}
			render(
				<StrictMode>
					<GraphQLProvider client={client}>
						<Boundary>
							<Suspense fallback={null}>
								<Q />
							</Suspense>
						</Boundary>
					</GraphQLProvider>
				</StrictMode>,
			);
			await settle(50);
			await settle(200);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(onError).toHaveBeenCalledTimes(1);
		});

		it(`useLazyQuery (${fetchPolicy})`, async function run() {
			const { client, fetchMock, onError } = setup();
			function Q() {
				const [run] = useLazyQuery("query A { a }", { fetchPolicy });
				useEffect(
					function go() {
						run().catch(function ignore() {});
					},
					[run],
				);
				return null;
			}
			render(
				<StrictMode>
					<GraphQLProvider client={client}>
						<Q />
					</GraphQLProvider>
				</StrictMode>,
			);
			await settle(50);
			// StrictMode runs the effect twice: two executions are legitimate, one onError per request.
			expect(onError).toHaveBeenCalledTimes(fetchMock.mock.calls.length / 2);
		});
	}

	it("useMutation", async function run() {
		const { client, fetchMock, onError } = setup();
		let mutate!: () => Promise<unknown>;
		function M() {
			const [m] = useMutation("mutation M { m }");
			mutate = m;
			return null;
		}
		render(
			<StrictMode>
				<GraphQLProvider client={client}>
					<M />
				</GraphQLProvider>
			</StrictMode>,
		);
		await act(async function go() {
			await mutate().catch(function ignore() {});
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("useSubscription", async function run() {
		const { client, fetchMock, onError } = setup();
		function S() {
			useSubscription({ query: "subscription S { s }" });
			return null;
		}
		render(
			<StrictMode>
				<GraphQLProvider client={client}>
					<S />
				</GraphQLProvider>
			</StrictMode>,
		);
		await settle(50);
		expect(onError).toHaveBeenCalledTimes(fetchMock.mock.calls.length);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
