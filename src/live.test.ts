import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import type { ClientConfiguration, QueryState } from "./types";

const URL = "https://test.dev/graphql";
const TODOS = "query Todos { todos { id } }";
const DEFERRED = "query User { user { id ... @defer { name } } }";

/**
 * Creates a fetch mock answering with sequential `{ data: { n } }` payloads.
 *
 * @returns The fetch mock
 */
function counter() {
	let n = 0;

	return vi.fn<typeof fetch>(async function () {
		return Response.json({ data: { n: ++n } });
	});
}

/**
 * Creates a client with a memory cache.
 *
 * @param fetchMock - The fetch mock
 * @param configuration - Overrides
 * @returns The client
 */
function createClient(fetchMock: typeof fetch, configuration: Partial<ClientConfiguration> = {}): Client {
	return new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache(), ...configuration });
}

/**
 * Builds a multipart/mixed incremental response.
 *
 * @param parts - JSON parts
 * @returns The response
 */
function multipart(...parts: unknown[]): Response {
	const body = parts.map(function (part) {
		return `\r\n---\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(part)}`;
	});

	return new Response(`${body.join("")}\r\n-----\r\n`, {
		headers: { "Content-Type": 'multipart/mixed; boundary="-"; deferSpec=20220824' },
	});
}

/**
 * Waits until pending promises and timers scheduled at 0ms run.
 */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}

afterEach(function () {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("incremental delivery", function () {
	const PARTS = [
		{ data: { user: { id: 1 } }, pending: [{ id: "0", path: ["user"] }], hasNext: true },
		{ incremental: [{ id: "0", data: { name: "Rick" } }], completed: [{ id: "0" }], hasNext: false },
	];

	it("advertises multipart/mixed only for @defer/@stream documents", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return multipart(...PARTS);
		});
		const client = createClient(fetchMock);

		await client.gql({ query: DEFERRED });
		await client.gql({ query: TODOS }).catch(function () {
			return undefined;
		});

		const [deferred, plain] = fetchMock.mock.calls.map(function (call) {
			return (call[0] as Request).headers.get("Accept");
		});

		expect(deferred).toMatch(/^multipart\/mixed;deferSpec=20220824, application\/graphql-response\+json/);
		expect(plain).not.toContain("multipart");
	});

	it("resolves gql with the fully merged result and caches it", async function () {
		const client = createClient(
			vi.fn<typeof fetch>(async function () {
				return multipart(...PARTS);
			}),
		);

		expect(await client.gql({ query: DEFERRED })).toEqual({ user: { id: 1, name: "Rick" } });
		expect(await client.read({ query: DEFERRED })).toEqual({ user: { id: 1, name: "Rick" } });
	});

	it("throws with partial data when a deferred fragment fails", async function () {
		const client = createClient(
			vi.fn<typeof fetch>(async function () {
				return multipart(PARTS[0], {
					completed: [{ id: "0", errors: [{ message: "name failed" }] }],
					hasNext: false,
				});
			}),
		);

		await expect(client.gql({ query: DEFERRED })).rejects.toMatchObject({
			message: "name failed",
			data: { user: { id: 1 } },
		});
	});

	it("yields each merged snapshot through subscribe", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return multipart(...PARTS);
		});
		const snapshots: unknown[] = [];

		for await (const data of createClient(fetchMock).subscribe({ query: DEFERRED })) snapshots.push(data);

		expect(snapshots).toEqual([{ user: { id: 1 } }, { user: { id: 1, name: "Rick" } }]);
		expect((fetchMock.mock.calls[0]![0] as Request).headers.get("Accept")).toBe(
			"text/event-stream, multipart/mixed;deferSpec=20220824",
		);
	});

	it("merges incremental payloads delivered over SSE", async function () {
		const events = PARTS.map(function (part) {
			return `event: next\ndata: ${JSON.stringify(part)}\n\n`;
		});
		const client = createClient(
			vi.fn<typeof fetch>(async function () {
				return new Response(`${events.join("")}event: complete\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}),
		);
		const snapshots: unknown[] = [];

		for await (const data of client.subscribe({ query: DEFERRED })) snapshots.push(data);

		expect(snapshots.at(-1)).toEqual({ user: { id: 1, name: "Rick" } });
	});
});

describe("fetch policies", function () {
	it("cache-only throws on a miss and serves hits", async function () {
		const client = createClient(counter());

		await expect(client.gql({ query: TODOS, fetchPolicy: "cache-only" })).rejects.toThrow(
			"No cached data for query Todos (cache-only).",
		);

		await client.write({ query: TODOS }, { n: 0 });
		expect(await client.gql({ query: TODOS, fetchPolicy: "cache-only" })).toEqual({ n: 0 });
	});

	it("network-only skips the cache read but refreshes the entry", async function () {
		const client = createClient(counter());

		await client.gql({ query: TODOS });
		expect(await client.gql({ query: TODOS, fetchPolicy: "network-only" })).toEqual({ n: 2 });
		expect(await client.gql({ query: TODOS })).toEqual({ n: 2 });
	});

	it("no-cache never touches the cache", async function () {
		const cache = new MemoryCache();
		const client = createClient(counter(), { cache });

		await client.gql({ query: TODOS, fetchPolicy: "no-cache" });
		expect(cache.size).toBe(0);
	});
});

describe("read / write / extract / restore", function () {
	it("reads and writes entries by the same fields as requests", async function () {
		const client = createClient(counter());

		expect(await client.read({ query: TODOS })).toBeUndefined();

		await client.write({ key: ["todos"], query: TODOS }, { n: 42 });

		expect(await client.read({ key: ["todos"], query: TODOS })).toEqual({ n: 42 });
		expect(await client.gql({ key: ["todos"], query: TODOS })).toEqual({ n: 42 });
	});

	it("is a no-op without a cache", async function () {
		const client = new Client({ url: URL, fetch: counter() });

		await client.write({ query: TODOS }, { n: 1 });

		expect(await client.read({ query: TODOS })).toBeUndefined();
		expect(await client.extract()).toEqual({});
	});

	it("round-trips a snapshot between clients (SSR hydration)", async function () {
		const server = createClient(counter());
		const cache = new MemoryCache();

		cache.set("foreign", 1);
		await server.gql({ key: ["todos"], query: TODOS });
		await server.gql({ query: "{ me }" });

		const snapshot = JSON.parse(
			JSON.stringify(await createClient(counter(), { cache: server["configuration"].cache }).extract()),
		);
		const browserFetch = counter();
		const browser = createClient(browserFetch);

		await browser.restore(snapshot);

		expect(Object.keys(snapshot)).toHaveLength(2);
		expect(await browser.gql({ key: ["todos"], query: TODOS })).toEqual({ n: 1 });
		expect(browserFetch).not.toHaveBeenCalled();
	});
});

describe("watch", function () {
	it("fetches lazily on first subscribe and exposes stable snapshots", async function () {
		const fetchMock = counter();
		const ref = createClient(fetchMock).watch({ query: TODOS });
		const states: QueryState<unknown>[] = [];

		expect(ref.getState()).toEqual({ data: undefined, error: undefined, loading: true });
		expect(fetchMock).not.toHaveBeenCalled();

		const unsubscribe = ref.subscribe(function (state) {
			states.push(state);
		});

		await flush();

		expect(states.at(-1)).toEqual({ data: { n: 1 }, error: undefined, loading: false });
		expect(ref.getState()).toBe(ref.getState());
		unsubscribe();
	});

	it("starts from synchronous cache data without fetching", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);

		await client.write({ query: TODOS }, { n: 0 });

		const ref = client.watch({ query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		expect(ref.getState()).toEqual({ data: { n: 0 }, error: undefined, loading: false });
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("network-only watches fetch even with cached data", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);

		await client.write({ query: TODOS }, { n: 0 });

		const ref = client.watch({ query: TODOS, fetchPolicy: "network-only" });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		expect(ref.getState().data).toEqual({ n: 1 });
		unsubscribe();
	});

	it("keeps stale data while refetching and after errors", async function () {
		let fail = false;
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return fail ? Response.json({ errors: [{ message: "down" }] }) : Response.json({ data: { ok: true } });
		});
		const ref = createClient(fetchMock).watch({ query: TODOS });
		const states: QueryState<unknown>[] = [];
		const unsubscribe = ref.subscribe(function (state) {
			states.push(state);
		});

		await flush();
		fail = true;

		const result = await ref.refetch();

		expect(states.slice(-2)).toEqual([
			{ data: { ok: true }, error: undefined, loading: true },
			{ data: { ok: true }, error: expect.objectContaining({ message: "down" }), loading: false },
		]);
		expect(result).toBe(ref.getState());
		unsubscribe();
	});

	it("refetches active watchers on invalidation (e.g. after a mutation)", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);
		const ref = client.watch({ key: ["todos"], query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		await client.gql({ query: "mutation Add { add }", invalidates: [["todos"]] });
		await flush();

		expect(ref.getState().data).toEqual({ n: 3 });
		unsubscribe();
	});

	it("refetches on reactivation when invalidated while inactive", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);
		const ref = client.watch({ key: ["todos"], query: TODOS });

		ref.subscribe(function () {})();
		await flush();

		const unsubscribe = ref.subscribe(function () {});

		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		unsubscribe();

		await client.invalidate(["todos"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const again = ref.subscribe(function () {});

		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		again();
	});

	it("stays in sync with other fetches and writes of the same key", async function () {
		const client = createClient(counter());
		const ref = client.watch({ query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		await client.gql({ query: TODOS, fetchPolicy: "network-only" });
		expect(ref.getState().data).toEqual({ n: 2 });

		await client.write({ query: TODOS }, { n: 99 });
		expect(ref.getState()).toEqual({ data: { n: 99 }, error: undefined, loading: false });
		unsubscribe();
	});

	it("ignores out-of-order responses", async function () {
		const resolvers: Array<(response: Response) => void> = [];
		const fetchMock = vi.fn<typeof fetch>(function () {
			return new Promise<Response>(function (resolve) {
				resolvers.push(resolve);
			});
		});
		const ref = new Client({ url: URL, fetch: fetchMock, dedupe: false }).watch({ query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		void ref.refetch();
		await flush();

		resolvers[1]!(Response.json({ data: { v: "new" } }));
		await flush();
		resolvers[0]!(Response.json({ data: { v: "old" } }));
		await flush();

		expect(ref.getState().data).toEqual({ v: "new" });
		unsubscribe();
	});

	it("never lets a superseded response overwrite the cache", async function () {
		const resolvers: Array<(response: Response) => void> = [];
		const cache = new MemoryCache();
		const client = new Client({
			url: URL,
			cache,
			dedupe: false,
			fetch: vi.fn<typeof fetch>(function () {
				return new Promise<Response>(function (resolve) {
					resolvers.push(resolve);
				});
			}),
		});
		const older = client.gql({ query: TODOS, fetchPolicy: "network-only" });
		const newer = client.gql({ query: TODOS, fetchPolicy: "network-only" });

		await flush();
		resolvers[1]!(Response.json({ data: { v: "new" } }));
		await newer;
		resolvers[0]!(Response.json({ data: { v: "old" } }));

		expect(await older).toEqual({ v: "old" });
		expect(await client.read({ query: TODOS })).toEqual({ v: "new" });
		expect(client["shared"].active.size).toBe(0);
		expect(client["shared"].applied.size).toBe(0);
	});

	it("shares notifications with derived clients using the same cache", async function () {
		const base = createClient(counter());
		const scoped = base.extend({ authToken: "user" });
		const isolated = base.extend({ cache: new MemoryCache() });
		const ref = base.watch({ query: TODOS });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		await scoped.write({ query: TODOS }, { n: 42 });
		expect(ref.getState().data).toEqual({ n: 42 });

		await isolated.write({ query: TODOS }, { n: 0 });
		expect(ref.getState().data).toEqual({ n: 42 });
		unsubscribe();
	});

	it("polls while observed and stops when the last listener leaves", async function () {
		vi.useFakeTimers();

		const fetchMock = counter();
		const ref = createClient(fetchMock).watch({ query: TODOS, pollInterval: 1_000 });
		const first = ref.subscribe(function () {});
		const second = ref.subscribe(function () {});

		await vi.advanceTimersByTimeAsync(3_000);
		expect(fetchMock).toHaveBeenCalledTimes(4);

		first();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchMock).toHaveBeenCalledTimes(5);

		second();
		second();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("refetches on focus and reconnect", async function () {
		const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
		const windowTarget = new EventTarget();

		vi.stubGlobal("document", document);
		vi.stubGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget));
		vi.stubGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget));

		const fetchMock = counter();
		const ref = createClient(fetchMock).watch({ query: TODOS, refetchOnFocus: true, refetchOnReconnect: true });
		const unsubscribe = ref.subscribe(function () {});

		await flush();
		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		document.visibilityState = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		unsubscribe();
		windowTarget.dispatchEvent(new Event("online"));
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("skips focus/reconnect listeners when the environment has none", async function () {
		const ref = createClient(counter()).watch({ query: TODOS, refetchOnFocus: true, refetchOnReconnect: true });

		expect(function () {
			ref.subscribe(function () {})();
		}).not.toThrow();
	});
});

describe("store contract", function () {
	it("emits the current state synchronously on subscribe (Svelte store contract)", function () {
		const ref = createClient(counter()).watch({ query: TODOS });
		const received: QueryState<unknown>[] = [];
		const unsubscribe = ref.subscribe(function (state) {
			received.push(state);
		});

		expect(received[0]).toBe(ref.getState());
		unsubscribe();
	});
});

describe("fetchMore", function () {
	const FEED = "query Feed($after: Int) { feed(after: $after) }";

	/**
	 * Paginated server: each page has two items starting after the cursor.
	 *
	 * @returns The fetch mock
	 */
	function pages() {
		return vi.fn<typeof fetch>(async function (input) {
			const { variables } = await (input as Request).clone().json();
			const start = variables?.after ?? 0;

			if (start >= 4) return Response.json({ errors: [{ message: "no more pages" }] });

			return Response.json({ data: { feed: [start + 1, start + 2] } });
		});
	}

	/**
	 * Concatenates pages.
	 *
	 * @param previous - Current data
	 * @param next - New page
	 * @returns Merged data
	 */
	function concat(previous: { feed: number[] }, next: { feed: number[] }): { feed: number[] } {
		return { feed: [...previous.feed, ...next.feed] };
	}

	it("merges pages into the data and the cache entry, syncing every watcher", async function () {
		const fetchMock = pages();
		const client = createClient(fetchMock);
		const options = { key: ["feed"], query: FEED, variables: { after: 0 } };
		const ref = client.watch<{ feed: number[] }, { after: number }>(options);
		const twin = client.watch<{ feed: number[] }, { after: number }>(options);
		const stop = [ref.subscribe(function () {}), twin.subscribe(function () {})];

		await flush();

		const state = await ref.fetchMore({ variables: { after: 2 }, merge: concat });

		expect(state).toEqual({ data: { feed: [1, 2, 3, 4] }, error: undefined, loading: false });
		expect(twin.getState().data).toEqual({ feed: [1, 2, 3, 4] });
		expect(await client.read(options)).toEqual({ feed: [1, 2, 3, 4] });
		expect(await (fetchMock.mock.calls[1]![0] as Request).json()).toMatchObject({ variables: { after: 2 } });

		for (const unsubscribe of stop) unsubscribe();
	});

	it("keeps the data and exposes the error when a page fails", async function () {
		const ref = createClient(pages()).watch<{ feed: number[] }, { after: number }>({
			query: FEED,
			variables: { after: 2 },
		});
		const unsubscribe = ref.subscribe(function () {});

		await flush();

		const state = await ref.fetchMore({ variables: { after: 4 }, merge: concat });

		expect(state.data).toEqual({ feed: [3, 4] });
		expect(state.error).toMatchObject({ message: "no more pages" });
		expect(state.loading).toBe(false);
		unsubscribe();
	});

	it("uses the fetched page as-is when there is no data yet", async function () {
		const ref = new Client({ url: URL, fetch: pages() }).watch<{ feed: number[] }, { after?: number }>({ query: FEED });
		const merge = vi.fn(concat);

		expect((await ref.fetchMore({ variables: { after: 2 }, merge })).data).toEqual({ feed: [3, 4] });
		expect(merge).not.toHaveBeenCalled();
	});
});

describe("cache-and-network", function () {
	it("answers from the cache and refreshes it in the background", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);

		await client.write({ query: TODOS }, { n: 0 });

		expect(await client.gql({ query: TODOS, fetchPolicy: "cache-and-network" })).toEqual({ n: 0 });

		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await client.read({ query: TODOS })).toEqual({ n: 1 });
	});

	it("fetches like network-only on a miss", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);

		expect(await client.gql({ query: TODOS, fetchPolicy: "cache-and-network" })).toEqual({ n: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("shows cached data in live queries, then the refreshed data", async function () {
		const fetchMock = counter();
		const client = createClient(fetchMock);

		await client.write({ query: TODOS }, { n: 0 });

		const ref = client.watch({ query: TODOS, fetchPolicy: "cache-and-network" });
		const seen: unknown[] = [];
		const unsubscribe = ref.subscribe(function (state) {
			seen.push(state.data);
		});

		expect(seen[0]).toEqual({ n: 0 });

		await flush();
		expect(ref.getState().data).toEqual({ n: 1 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("reports background refresh failures through onError without rejecting", async function () {
		const onError = vi.fn();
		const client = createClient(
			vi.fn<typeof fetch>(async function () {
				return Response.json({ errors: [{ message: "down" }] });
			}),
			{ onError },
		);

		await client.write({ query: TODOS }, { n: 0 });

		expect(await client.gql({ query: TODOS, fetchPolicy: "cache-and-network" })).toEqual({ n: 0 });

		await flush();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(await client.read({ query: TODOS })).toEqual({ n: 0 });
	});
});
