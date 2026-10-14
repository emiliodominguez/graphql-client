// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, StrictMode, Suspense, startTransition, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import { GraphQLProvider, useLazyQuery, useQuery, useSuspenseQuery } from "../react/index";

const URL = "https://test.dev/graphql";
const ITEM = "query Item($id: Int!) { item(id: $id) }";

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

async function settle(ms = 0): Promise<void> {
	await act(async function wait() {
		await new Promise(function tick(resolve) {
			setTimeout(resolve, ms);
		});
	});
}

function watcherCount(cache: object): number {
	const registry = (globalThis as Record<symbol, any>)[Symbol.for("lumenql.shared")];
	const state = registry.states.get(cache);
	let n = 0;
	for (const set of state?.watchers.values() ?? []) n += set.size;
	return n;
}

class Boundary extends Component<{ children: ReactNode; onReset?: () => void }, { error?: Error | undefined }> {
	override state: { error?: Error | undefined } = {};
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	override render() {
		const boundary = this;
		return this.state.error ? (
			<button
				data-testid="retry"
				onClick={function reset() {
					boundary.setState({ error: undefined });
				}}
			>
				{this.state.error.message}
			</button>
		) : (
			this.props.children
		);
	}
}

afterEach(function clean() {
	cleanup();
	vi.restoreAllMocks();
});

describe("react misc", function suite() {
	it("useSuspenseQuery recovers through an error boundary reset", async function run() {
		vi.spyOn(console, "error").mockImplementation(function quiet() {});
		let fail = true;
		const fetchMock = vi.fn<typeof fetch>(async function respond(input, init) {
			const { variables } = await toRequest(input, init).json();
			if (fail) return Response.json({ errors: [{ message: "down" }] });
			return Response.json({ data: { item: `item${variables.id}` } });
		});
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });

		function Item() {
			const { data } = useSuspenseQuery<{ item: string }, { id: number }>({ query: ITEM, variables: { id: 1 } });
			return <span data-testid="item">{data.item}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Boundary>
					<Suspense fallback={<span data-testid="fallback">loading</span>}>
						<Item />
					</Suspense>
				</Boundary>
			</GraphQLProvider>,
		);
		await settle(50);
		await settle(200);
		expect(screen.getByTestId("retry").textContent).toBe("down");

		fail = false;
		await act(async function click() {
			screen.getByTestId("retry").click();
		});
		await settle(50);
		await settle(50);
		expect(screen.getByTestId("item").textContent).toBe("item1");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("useSuspenseQuery in a transition keeps the old UI and then shows the new data", async function run() {
		const resolvers: Array<() => void> = [];
		const fetchMock = vi.fn<typeof fetch>(async function respond(input, init) {
			const { variables } = await toRequest(input, init).json();
			if (variables.id === 2) {
				await new Promise<void>(function hold(resolve) {
					resolvers.push(resolve);
				});
			}
			return Response.json({ data: { item: `item${variables.id}` } });
		});
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });
		let setId!: (id: number) => void;

		function Item(props: { id: number }) {
			const { data } = useSuspenseQuery<{ item: string }, { id: number }>({
				query: ITEM,
				variables: { id: props.id },
			});
			return <span data-testid="item">{data.item}</span>;
		}

		function App() {
			const [id, set] = useState(1);
			setId = set;
			return (
				<Suspense fallback={<span data-testid="fallback">loading</span>}>
					<Item id={id} />
				</Suspense>
			);
		}

		render(
			<StrictMode>
				<GraphQLProvider client={client}>
					<App />
				</GraphQLProvider>
			</StrictMode>,
		);
		await settle(20);
		expect(screen.getByTestId("item").textContent).toBe("item1");

		await act(async function go() {
			startTransition(function change() {
				setId(2);
			});
		});
		await settle(20);
		expect(screen.queryByTestId("fallback")).toBeNull();
		expect(screen.getByTestId("item").textContent).toBe("item1");

		await act(async function finish() {
			for (const resolve of resolvers) resolve();
		});
		await settle(20);
		expect(screen.getByTestId("item").textContent).toBe("item2");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		cleanup();
		await settle(20);
		expect(watcherCount(cache)).toBe(0);
	});

	it("useQuery variable churn and unmount leave no watchers behind", async function run() {
		const fetchMock = vi.fn<typeof fetch>(async function respond(input, init) {
			const { variables } = await toRequest(input, init).json();
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 5);
			});
			return Response.json({ data: { item: `item${variables.id}` } });
		});
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });
		let setId!: (id: number) => void;

		function Item() {
			const [id, set] = useState(1);
			setId = set;
			const { data } = useQuery<{ item: string }, { id: number }>({
				query: ITEM,
				variables: { id },
				pollInterval: 1000,
				refetchOnFocus: true,
				refetchOnReconnect: true,
				keepPreviousData: true,
			});
			return <span data-testid="item">{data?.item ?? "-"}</span>;
		}

		render(
			<StrictMode>
				<GraphQLProvider client={client}>
					<Item />
				</GraphQLProvider>
			</StrictMode>,
		);
		for (let i = 2; i < 20; i++) {
			await act(async function change() {
				setId(i);
			});
		}
		await settle(30);
		expect(screen.getByTestId("item").textContent).toBe("item19");
		expect(watcherCount(cache)).toBe(1);
		cleanup();
		await settle(30);
		expect(watcherCount(cache)).toBe(0);
	});

	it("useLazyQuery unmounted mid-flight leaves no watchers behind", async function run() {
		let release!: () => void;
		const fetchMock = vi.fn<typeof fetch>(async function respond() {
			await new Promise<void>(function hold(resolve) {
				release = resolve;
			});
			return Response.json({ data: { item: "x" } });
		});
		const cache = new MemoryCache();
		const client = new Client({ url: URL, fetch: fetchMock, cache });
		let execute!: (v: { id: number }) => Promise<unknown>;

		function Lazy() {
			const [run, { data }] = useLazyQuery<{ item: string }, { id: number }>(ITEM, { pollInterval: 50 });
			execute = run;
			return <span>{data?.item ?? "-"}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Lazy />
			</GraphQLProvider>,
		);
		let promise!: Promise<unknown>;
		await act(async function go() {
			promise = execute({ id: 1 });
		});
		cleanup();
		await settle(5);
		release();
		await promise;
		await settle(200);
		expect(watcherCount(cache)).toBe(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
