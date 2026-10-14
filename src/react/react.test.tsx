// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, StrictMode, Suspense, useState, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../client";
import type { ClientConfiguration, SubscriptionTransport } from "../types";
import { GraphQLProvider, useClient, useMutation, useQuery, useSubscription, useSuspenseQuery } from "./index";

const URL = "https://test.dev/graphql";
const TODOS = "query Todos { todos }";
const ADD = "mutation Add($title: String!) { add(title: $title) }";

/**
 * Creates a client whose server keeps a todo list.
 *
 * @param configuration - Overrides
 * @returns The client and its fetch mock
 */
function setup(configuration: Partial<ClientConfiguration> = {}) {
	const todos: string[] = ["a"];
	const fetchMock = vi.fn<typeof fetch>(async function (input) {
		const { query, variables } = await (input as Request).json();

		if (query.startsWith("mutation")) {
			if (variables.title === "boom") return Response.json({ errors: [{ message: "rejected" }] });

			todos.push(variables.title);

			return Response.json({ data: { add: true } });
		}

		return Response.json({ data: { todos: [...todos] } });
	});
	const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache(), ...configuration });

	/**
	 * Wraps children with the provider.
	 *
	 * @param props - Children
	 * @returns The element
	 */
	function wrapper(props: { children: ReactNode }) {
		return <GraphQLProvider client={client}>{props.children}</GraphQLProvider>;
	}

	return { client, fetchMock, wrapper };
}

/**
 * Renders the todo list.
 *
 * @returns The element
 */
function Todos() {
	const { data, loading, error, refetch } = useQuery<{ todos: string[] }>({ key: ["todos"], query: TODOS });

	return (
		<div>
			<span data-testid="status">{loading ? "loading" : error ? "error" : "idle"}</span>
			<span data-testid="todos">{data?.todos.join(",") ?? "-"}</span>
			<button onClick={refetch}>refetch</button>
		</div>
	);
}

/**
 * Adds todos through a mutation that invalidates the list.
 *
 * @returns The element
 */
function AddTodo() {
	const [add, { loading, error, data, reset }] = useMutation<{ add: boolean }, { title: string }>(ADD, {
		invalidates: [["todos"]],
	});

	/**
	 * Adds a todo, swallowing rejections (the state exposes them).
	 *
	 * @param title - The todo title
	 */
	function handleAdd(title: string): void {
		add({ title }).catch(function ignore() {});
	}

	return (
		<div>
			<span data-testid="mutation">{loading ? "saving" : error ? "failed" : data ? "saved" : "idle"}</span>
			<button
				onClick={function () {
					handleAdd("b");
				}}
			>
				add
			</button>
			<button
				onClick={function () {
					handleAdd("boom");
				}}
			>
				fail
			</button>
			<button onClick={reset}>reset</button>
		</div>
	);
}

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
 * Reads an element's text.
 *
 * @param node - The element
 * @returns Its text content
 */
function getText(node: HTMLElement): string | null {
	return node.textContent;
}

afterEach(function () {
	cleanup();
	vi.restoreAllMocks();
});

describe("GraphQLProvider / useClient", function () {
	it("throws outside a provider", function () {
		vi.spyOn(console, "error").mockImplementation(function () {});

		/**
		 * Reads the client.
		 *
		 * @returns Nothing
		 */
		function Orphan() {
			useClient();
			return null;
		}

		expect(function () {
			render(<Orphan />);
		}).toThrow(/GraphQLProvider/);
	});
});

describe("useQuery", function () {
	it("loads, renders data and refetches", async function () {
		const { wrapper, fetchMock } = setup();

		render(<Todos />, { wrapper });
		expect(screen.getByTestId("status").textContent).toBe("loading");

		await waitFor(function () {
			expect(screen.getByTestId("todos").textContent).toBe("a");
		});

		fireEvent.click(screen.getByText("refetch"));
		await waitFor(function () {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
		expect(screen.getByTestId("status").textContent).toBe("idle");
	});

	it("shares one request across components and survives StrictMode", async function () {
		const { wrapper, fetchMock } = setup();

		render(
			<StrictMode>
				<Todos />
				<Todos />
			</StrictMode>,
			{ wrapper },
		);

		await waitFor(function () {
			expect(screen.getAllByTestId("todos").map(getText)).toEqual(["a", "a"]);
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("re-renders after a mutation invalidates the query", async function () {
		const { wrapper } = setup();

		render(
			<>
				<Todos />
				<AddTodo />
			</>,
			{ wrapper },
		);

		await waitFor(function () {
			expect(screen.getByTestId("todos").textContent).toBe("a");
		});

		fireEvent.click(screen.getByText("add"));

		await waitFor(function () {
			expect(screen.getByTestId("todos").textContent).toBe("a,b");
		});
		expect(screen.getByTestId("mutation").textContent).toBe("saved");
	});

	it("re-renders on client.write (optimistic updates)", async function () {
		const { wrapper, client } = setup();

		render(<Todos />, { wrapper });
		await waitFor(function () {
			expect(screen.getByTestId("todos").textContent).toBe("a");
		});

		await act(async function () {
			await client.write({ key: ["todos"], query: TODOS }, { todos: ["optimistic"] });
		});

		expect(screen.getByTestId("todos").textContent).toBe("optimistic");
	});

	it("exposes fetchMore for pagination", async function () {
		const { wrapper } = setup();

		/**
		 * Paginated list with a load-more button.
		 *
		 * @returns The element
		 */
		function Paged() {
			const { data, fetchMore } = useQuery<{ todos: string[] }>({ key: ["paged"], query: TODOS });

			/**
			 * Appends the next page.
			 */
			function loadMore(): void {
				void fetchMore({
					variables: {},
					merge(previous, next) {
						return { todos: [...previous.todos, ...next.todos] };
					},
				});
			}

			return (
				<div>
					<span data-testid="paged">{data?.todos.join(",") ?? "-"}</span>
					<button onClick={loadMore}>more</button>
				</div>
			);
		}

		render(<Paged />, { wrapper });
		await waitFor(function () {
			expect(screen.getByTestId("paged").textContent).toBe("a");
		});

		fireEvent.click(screen.getByText("more"));

		await waitFor(function () {
			expect(screen.getByTestId("paged").textContent).toBe("a,a");
		});
	});

	it("skips without fetching", function () {
		const { wrapper, fetchMock } = setup();

		/**
		 * A skipped query.
		 *
		 * @returns The element
		 */
		function Skipped() {
			const { loading, data } = useQuery({ query: TODOS, skip: true });

			return (
				<span data-testid="skipped">
					{String(loading)}:{String(data)}
				</span>
			);
		}

		render(<Skipped />, { wrapper });

		expect(screen.getByTestId("skipped").textContent).toBe("false:undefined");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders cached data on the server and hydrates without a loading state", async function () {
		const { client, wrapper } = setup();

		await client.write({ key: ["todos"], query: TODOS }, { todos: ["ssr"] });

		const html = renderToString(wrapper({ children: <Todos /> }));

		expect(html).toContain("ssr");
		expect(html).toContain("idle");
	});
});

describe("useSuspenseQuery", function () {
	/**
	 * Suspense consumer.
	 *
	 * @returns The element
	 */
	function SuspenseTodos() {
		const { data } = useSuspenseQuery<{ todos: string[] }>({ query: TODOS });

		return <span data-testid="suspense">{data.todos.join(",")}</span>;
	}

	it.each([
		["with a cache", {}],
		["without a cache", { cache: undefined }],
	])("suspends until data is available (%s)", async function (_label, configuration) {
		const { wrapper, fetchMock } = setup(configuration);

		render(
			<Suspense fallback={<span data-testid="fallback">…</span>}>
				<SuspenseTodos />
			</Suspense>,
			{ wrapper },
		);

		expect(screen.getByTestId("fallback")).toBeTruthy();
		expect(await screen.findByTestId("suspense")).toHaveProperty("textContent", "a");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("throws errors to the nearest error boundary", async function () {
		vi.spyOn(console, "error").mockImplementation(function () {});

		const { wrapper } = setup({
			fetch: vi.fn<typeof fetch>(async function () {
				return Response.json({ errors: [{ message: "denied" }] });
			}),
		});

		render(
			<Boundary>
				<Suspense fallback="…">
					<SuspenseTodos />
				</Suspense>
			</Boundary>,
			{ wrapper },
		);

		expect((await screen.findByTestId("boundary")).textContent).toBe("denied");
	});
});

describe("useMutation", function () {
	it("exposes failures and resets", async function () {
		const { wrapper } = setup();

		render(<AddTodo />, { wrapper });

		fireEvent.click(screen.getByText("fail"));
		expect(screen.getByTestId("mutation").textContent).toBe("saving");

		await waitFor(function () {
			expect(screen.getByTestId("mutation").textContent).toBe("failed");
		});

		fireEvent.click(screen.getByText("reset"));
		expect(screen.getByTestId("mutation").textContent).toBe("idle");
	});

	it("resolves with data and rejects with the error", async function () {
		const { client } = setup();
		let mutate!: ReturnType<typeof useMutation<{ add: boolean }, { title: string }>>[0];

		/**
		 * Captures the mutate function.
		 *
		 * @returns Nothing
		 */
		function Capture() {
			[mutate] = useMutation<{ add: boolean }, { title: string }>(ADD);
			return null;
		}

		render(
			<GraphQLProvider client={client}>
				<Capture />
			</GraphQLProvider>,
		);

		await act(async function () {
			expect(await mutate({ title: "c" })).toEqual({ add: true });
			await expect(mutate({ title: "boom" })).rejects.toThrow("rejected");
		});
	});
});

describe("useSubscription", function () {
	/**
	 * Builds an SSE response that emits `count` ticks, then optionally stays open.
	 *
	 * @param count - Number of ticks
	 * @param keepOpen - Leave the stream open
	 * @param onCancel - Called when the client disconnects
	 * @returns The response
	 */
	function ticks(count: number, keepOpen = false, onCancel?: () => void): Response {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let tick = 1; tick <= count; tick++) {
					controller.enqueue(encoder.encode(`event: next\ndata: {"data":{"tick":${tick}}}\n\n`));
				}

				if (!keepOpen) controller.close();
			},
			...(onCancel ? { cancel: onCancel } : {}),
		});

		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	}

	/**
	 * Renders the latest tick.
	 *
	 * @param props - Subscription callbacks
	 * @returns The element
	 */
	function Ticker(props: { onData?: (data: { tick: number }) => void; skip?: boolean }) {
		const { data, active, error } = useSubscription<{ tick: number }>({
			query: "subscription Ticks { tick }",
			onData: props.onData,
			skip: props.skip,
		});

		return (
			<span data-testid="ticker">
				{data?.tick ?? "-"}:{active ? "open" : "closed"}:{error ? "error" : "ok"}
			</span>
		);
	}

	it("streams payloads, calls onData and reports completion", async function () {
		const onData = vi.fn();
		const { wrapper } = setup({
			fetch: vi.fn<typeof fetch>(async function () {
				return ticks(3);
			}),
		});

		render(<Ticker onData={onData} />, { wrapper });

		await waitFor(function () {
			expect(screen.getByTestId("ticker").textContent).toBe("3:closed:ok");
		});
		expect(onData).toHaveBeenCalledTimes(3);
	});

	it("disconnects on unmount", async function () {
		const onCancel = vi.fn();
		const { wrapper } = setup({
			fetch: vi.fn<typeof fetch>(async function () {
				return ticks(1, true, onCancel);
			}),
		});

		const { unmount } = render(<Ticker />, { wrapper });

		await waitFor(function () {
			expect(screen.getByTestId("ticker").textContent).toBe("1:open:ok");
		});

		unmount();
		await waitFor(function () {
			expect(onCancel).toHaveBeenCalled();
		});
	});

	it("reports errors and supports skip", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ errors: [{ message: "nope" }] }, { status: 400 });
		});
		const { wrapper } = setup({ fetch: fetchMock });

		const { rerender } = render(<Ticker skip />, { wrapper });

		expect(screen.getByTestId("ticker").textContent).toBe("-:closed:ok");
		expect(fetchMock).not.toHaveBeenCalled();

		rerender(<Ticker />);

		await waitFor(function () {
			expect(screen.getByTestId("ticker").textContent).toBe("-:closed:error");
		});
	});
});

describe("regressions", function () {
	/**
	 * Transport that ends quietly when aborted, like the WebSocket transport.
	 */
	const idleTransport: SubscriptionTransport = {
		async *subscribe(_request, signal) {
			await new Promise<void>(function (resolve) {
				if (signal.aborted) resolve();
				signal.addEventListener("abort", function () {
					resolve();
				});
			});
		},
	};

	/**
	 * Shows whether the subscription is open.
	 *
	 * @param props - The variable
	 * @returns The element
	 */
	function Status(props: { value: number }) {
		const { active } = useSubscription({
			query: "subscription S($value: Int) { s(value: $value) }",
			variables: { value: props.value },
		});

		return <span data-testid="active">{String(active)}</span>;
	}

	/**
	 * Lets effects and pending promises settle.
	 */
	async function settle(): Promise<void> {
		await act(async function () {
			await new Promise(function (resolve) {
				setTimeout(resolve, 0);
			});
		});
	}

	it("useSubscription stays active across resubscribes and StrictMode", async function () {
		const client = new Client({ url: URL, fetch: vi.fn(), subscriptionTransport: idleTransport });
		let setValue!: (value: number) => void;

		/**
		 * Owns the variable.
		 *
		 * @returns The element
		 */
		function App() {
			const [value, set] = useState(1);

			setValue = set;

			return <Status value={value} />;
		}

		render(
			<StrictMode>
				<GraphQLProvider client={client}>
					<App />
				</GraphQLProvider>
			</StrictMode>,
		);
		await settle();
		expect(screen.getByTestId("active").textContent).toBe("true");

		await act(async function () {
			setValue(2);
		});
		await settle();
		expect(screen.getByTestId("active").textContent).toBe("true");
	});

	it("useSuspenseQuery refetches after an invalidation that happened while its tree was unmounted", async function () {
		let n = 0;
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { n: ++n } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		/**
		 * Suspense reader.
		 *
		 * @returns The element
		 */
		function Reader() {
			const { data } = useSuspenseQuery<{ n: number }>({ key: ["n"], query: "query N { n }" });

			return <span data-testid="n">{data.n}</span>;
		}

		/**
		 * Renders the reader under suspense.
		 *
		 * @returns The element
		 */
		function Tree() {
			return (
				<GraphQLProvider client={client}>
					<Suspense fallback="…">
						<Reader />
					</Suspense>
				</GraphQLProvider>
			);
		}

		render(<Tree />).unmount();
		await settle();
		await client.invalidate(["n"]);

		render(<Tree />);

		await waitFor(function () {
			expect(screen.getByTestId("n").textContent).toBe("2");
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("keepPreviousData", function () {
	it("keeps showing the previous data while new variables load", async function () {
		const releases: Array<() => void> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			const { variables } = await (input as Request).json();

			if (variables.page > 1) {
				await new Promise<void>(function (resolve) {
					releases.push(resolve);
				});
			}

			return Response.json({ data: { page: variables.page } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		let setPage!: (page: number) => void;

		/**
		 * Paginated view.
		 *
		 * @returns The element
		 */
		function Pages() {
			const [page, set] = useState(1);
			const { data, isPreviousData } = useQuery<{ page: number }>({
				query: "query P($page: Int) { page(n: $page) }",
				variables: { page },
				keepPreviousData: true,
			});

			setPage = set;

			return <span data-testid="page">{`${data?.page ?? "-"}:${isPreviousData}`}</span>;
		}

		render(
			<GraphQLProvider client={client}>
				<Pages />
			</GraphQLProvider>,
		);

		await waitFor(function () {
			expect(screen.getByTestId("page").textContent).toBe("1:false");
		});

		await act(async function () {
			setPage(2);
		});

		expect(screen.getByTestId("page").textContent).toBe("1:true");

		await act(async function () {
			releases[0]!();
		});

		await waitFor(function () {
			expect(screen.getByTestId("page").textContent).toBe("2:false");
		});
	});
});
