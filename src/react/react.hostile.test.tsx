// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, StrictMode, Suspense, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import type { FetchPolicy, SubscriptionTransport } from "../types";
import { GraphQLProvider, useLazyQuery, useQuery, useSubscription, useSuspenseQuery } from "./index";

const URL = "https://test.dev/graphql";

/**
 * Minimal error boundary.
 */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
	override state: { error?: Error } = {};

	/**
	 * Captures render errors.
	 *
	 * @param error - The error
	 * @returns The next state
	 */
	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	/**
	 * Renders the error or the children.
	 *
	 * @returns The element
	 */
	override render() {
		return this.state.error ? <span data-testid="boundary">{this.state.error.message}</span> : this.props.children;
	}
}

/**
 * Lets timers, effects and pending promises settle.
 *
 * @param ms - How long to wait
 */
async function settle(ms = 0): Promise<void> {
	await act(async function () {
		await new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	});
}

/**
 * Subscription transport whose payloads are pushed by the test, one per `push(variable, payload)`.
 * Like a WebSocket transport, it keeps reading messages until its signal is aborted.
 *
 * @returns The transport and the push function
 */
function createPushTransport() {
	const waiting = new Map<number, (payload: unknown) => void>();
	const transport: SubscriptionTransport = {
		async *subscribe(request, signal) {
			const key = (request.variables as { v: number }).v;

			while (!signal.aborted) {
				const payload = await new Promise(function (resolve) {
					waiting.set(key, resolve);
					signal.addEventListener("abort", function () {
						resolve(undefined);
					});
				});

				if (payload === undefined) return;

				yield payload as never;
			}
		},
	};

	/**
	 * Delivers a payload to the open subscription for `key`.
	 *
	 * @param key - The `v` variable of the target subscription
	 * @param payload - The payload
	 */
	function push(key: number, payload: unknown): void {
		waiting.get(key)?.(payload);
	}

	return { transport, push };
}

afterEach(function () {
	cleanup();
	vi.restoreAllMocks();
});

describe("attack: useSuspenseQuery", function () {
	it("makes exactly one request when the initial load fails (no second request after the error is thrown)", async function () {
		vi.spyOn(console, "error").mockImplementation(function () {});

		let attempt = 0;
		const fetchMock = vi.fn<typeof fetch>(async function () {
			attempt++;
			return Response.json({ errors: [{ message: `denied #${attempt}` }] });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		/**
		 * Suspense reader.
		 *
		 * @returns The element
		 */
		function Reader() {
			const { data } = useSuspenseQuery<{ n: number }>({ query: "query N { n }" });

			return <span>{data.n}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Boundary>
					<Suspense fallback="…">
						<Reader />
					</Suspense>
				</Boundary>
			</GraphQLProvider>,
		);

		await screen.findByTestId("boundary");
		await settle(50);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("boundary").textContent).toBe("denied #1");
	});

	it.each<[FetchPolicy, boolean]>([
		["network-only", false],
		["network-only", true],
		["no-cache", false],
	])(
		"does not refetch on mount after the suspended load (fetchPolicy %s, StrictMode %s)",
		async function (fetchPolicy, strict) {
			const fetchMock = vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { n: 1 } });
			});
			const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

			/**
			 * Suspense reader.
			 *
			 * @returns The element
			 */
			function Reader() {
				const { data } = useSuspenseQuery<{ n: number }>({ query: "query N { n }", fetchPolicy });

				return <span data-testid="n">{data.n}</span>;
			}

			const tree = (
				<GraphQLProvider client={client}>
					<Suspense fallback="…">
						<Reader />
					</Suspense>
				</GraphQLProvider>
			);

			render(strict ? <StrictMode>{tree}</StrictMode> : tree);

			await screen.findByTestId("n");
			await settle(50);

			// The suspended load already went to the network; mounting must adopt it, not fetch again.
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);
});

describe("attack: useSubscription", function () {
	it("reports inactive (and drops the payload) once skip turns true on an open subscription", async function () {
		const { transport, push } = createPushTransport();
		const client = new Client({ url: URL, fetch: vi.fn(), subscriptionTransport: transport });
		let setSkip!: (skip: boolean) => void;

		/**
		 * Skippable subscriber.
		 *
		 * @returns The element
		 */
		function Subscriber() {
			const [skip, set] = useState(false);
			const { active, data } = useSubscription<{ v: number }, { v: number }>({
				query: "subscription S($v: Int) { v(v: $v) }",
				variables: { v: 1 },
				skip,
			});

			setSkip = set;

			return <span data-testid="sub">{`${String(active)}:${data?.v ?? "-"}`}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Subscriber />
			</GraphQLProvider>,
		);
		await settle();
		await act(async function () {
			push(1, { data: { v: 1 } });
		});
		await settle();
		expect(screen.getByTestId("sub").textContent).toBe("true:1");

		await act(async function () {
			setSkip(true);
		});
		await settle();

		// The stream was aborted: nothing is connected anymore.
		expect(screen.getByTestId("sub").textContent).toBe("false:-");
	});

	it("ignores payloads the torn-down subscription yields after it was aborted", async function () {
		const { transport, push } = createPushTransport();
		const client = new Client({ url: URL, fetch: vi.fn(), subscriptionTransport: transport });
		const onData = vi.fn();
		let setValue!: (value: number) => void;

		/**
		 * Subscriber whose variable changes.
		 *
		 * @returns The element
		 */
		function Subscriber() {
			const [v, set] = useState(1);
			const { data } = useSubscription<{ v: number }, { v: number }>({
				query: "subscription S($v: Int) { v(v: $v) }",
				variables: { v },
				onData,
			});

			setValue = set;

			return <span data-testid="sub">{`${v}:${data?.v ?? "-"}`}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Subscriber />
			</GraphQLProvider>,
		);
		await settle();

		// A message for v=1 arrives in the same task as the switch to v=2 (its continuation runs after the abort).
		act(function () {
			push(1, { data: { v: 1 } });
			setValue(2);
		});
		await settle();

		expect(onData).not.toHaveBeenCalled();
		expect(screen.getByTestId("sub").textContent).toBe("2:-");
	});

	it("does not show the previous variables' payload after resubscribing with new variables", async function () {
		const { transport, push } = createPushTransport();
		const client = new Client({ url: URL, fetch: vi.fn(), subscriptionTransport: transport });
		let setValue!: (value: number) => void;

		/**
		 * Subscriber whose variable changes (e.g. a chat room id).
		 *
		 * @returns The element
		 */
		function Subscriber() {
			const [v, set] = useState(1);
			const { data } = useSubscription<{ v: number }, { v: number }>({
				query: "subscription S($v: Int) { v(v: $v) }",
				variables: { v },
			});

			setValue = set;

			return <span data-testid="sub">{`${v}:${data?.v ?? "-"}`}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Subscriber />
			</GraphQLProvider>,
		);
		await settle();
		await act(async function () {
			push(1, { data: { v: 1 } });
		});
		await settle();
		expect(screen.getByTestId("sub").textContent).toBe("1:1");

		await act(async function () {
			setValue(2);
		});
		await settle();

		// No payload received for v=2 yet: v=1's payload must not be presented as v=2's.
		expect(screen.getByTestId("sub").textContent).toBe("2:-");
	});
});

describe("attack: useQuery", function () {
	it("uses the latest headers on refetch (e.g. a rotated auth token)", async function () {
		const seen: Array<string | null> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			seen.push((input as Request).headers.get("authorization"));
			return Response.json({ data: { n: 1 } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		let setToken!: (token: string) => void;
		let refetch!: () => Promise<unknown>;

		/**
		 * Query authenticated with a per-request header.
		 *
		 * @returns The element
		 */
		function Reader() {
			const [token, set] = useState("token-a");
			const result = useQuery<{ n: number }>({ query: "query N { n }", headers: { authorization: token } });

			setToken = set;
			refetch = result.refetch;

			return <span>{result.data?.n ?? "-"}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Reader />
			</GraphQLProvider>,
		);
		await settle();

		await act(async function () {
			setToken("token-b");
		});
		await act(async function () {
			await refetch();
		});

		expect(seen).toEqual(["token-a", "token-b"]);
	});
});

describe("attack: useLazyQuery", function () {
	it("drops the previous client's query when the provider's client is swapped", async function () {
		/**
		 * Creates a client whose server answers with its label.
		 *
		 * @param label - The label
		 * @returns The client and its fetch mock
		 */
		function createLabelledClient(label: string) {
			const fetchMock = vi.fn<typeof fetch>(async function () {
				return Response.json({ data: { who: label } });
			});

			return { client: new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() }), fetchMock };
		}

		const first = createLabelledClient("first");
		const second = createLabelledClient("second");
		let execute!: () => Promise<unknown>;
		let refetch!: () => Promise<unknown>;

		/**
		 * Lazy reader.
		 *
		 * @returns The element
		 */
		function Lazy() {
			const [run, result] = useLazyQuery<{ who: string }>("query W { who }");

			execute = run;
			refetch = result.refetch;

			return <span data-testid="lazy">{result.data?.who ?? "-"}</span>;
		}

		const { rerender } = render(
			<GraphQLProvider client={first.client}>
				<Lazy />
			</GraphQLProvider>,
		);

		await act(async function () {
			await execute();
		});
		expect(screen.getByTestId("lazy").textContent).toBe("first");

		// E.g. logout: the app swaps in a fresh client for the next user.
		rerender(
			<GraphQLProvider client={second.client}>
				<Lazy />
			</GraphQLProvider>,
		);
		await act(async function () {
			await refetch();
		});

		expect(first.fetchMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("lazy").textContent).not.toBe("first");
	});
});
