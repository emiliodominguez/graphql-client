import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { dedupeFragments, graphql, minify } from "./document";

/**
 * Regression tests for issues found in review. Each test reproduces the original failure scenario.
 */

const URL = "https://test.dev/graphql";
const TODOS = "query Todos { todos }";
const FEED = "query Feed($after: Int) { feed(after: $after) }";

/**
 * Lets pending promises and 0ms timers run.
 */
async function tick(): Promise<void> {
	await new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}

/**
 * Fetch mock whose responses are released manually, answering with the server version at request time.
 *
 * @param getVersion - Reads the current server version
 * @returns The fetch mock and its release functions (in call order)
 */
function gatedServer(getVersion: () => number) {
	const releases: Array<() => void> = [];
	const fetchMock = vi.fn<typeof fetch>(async function () {
		const version = getVersion();

		await new Promise<void>(function (resolve) {
			releases.push(resolve);
		});

		return Response.json({ data: { todos: version } });
	});

	return { fetchMock, releases };
}

describe("ordering", function () {
	it("an invalidation refetch never joins the stale in-flight request", async function () {
		let version = 1;
		const { fetchMock, releases } = gatedServer(function () {
			return version;
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const ref = client.watch<{ todos: number }>({ key: ["todos"], query: TODOS });

		ref.subscribe(function () {});
		await tick();

		version = 2;
		await client.invalidate(["todos"]);
		await tick();

		expect(fetchMock).toHaveBeenCalledTimes(2);

		releases[1]!();
		await tick();
		releases[0]!();
		await tick();

		expect(ref.getState().data).toEqual({ todos: 2 });
		expect(await client.read({ key: ["todos"], query: TODOS })).toEqual({ todos: 2 });
	});

	it("a request in flight during an invalidation does not repopulate the cache", async function () {
		let version = 1;
		const { fetchMock, releases } = gatedServer(function () {
			return version;
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const pending = client.gql({ key: ["todos"], query: TODOS });

		await tick();
		version = 2;
		await client.invalidate(["todos"]);
		releases[0]!();

		expect(await pending).toEqual({ todos: 1 });
		expect(await client.read({ key: ["todos"], query: TODOS })).toBeUndefined();
	});

	it("a cache-first call never joins a no-cache request", async function () {
		const { fetchMock, releases } = gatedServer(function () {
			return 1;
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const uncached = client.gql({ query: TODOS, fetchPolicy: "no-cache" });
		const cached = client.gql({ query: TODOS });

		await tick();
		for (const release of releases) release();
		await Promise.all([uncached, cached]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await client.read({ query: TODOS })).toEqual({ todos: 1 });
	});

	it("a no-cache request does not suppress a concurrent cache write", async function () {
		let version = 0;
		const { fetchMock, releases } = gatedServer(function () {
			return ++version;
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });

		await client.write({ query: TODOS }, { todos: 0 });

		const writer = client.gql({ query: TODOS, fetchPolicy: "network-only" });
		const reader = client.gql({ query: TODOS, fetchPolicy: "no-cache", headers: { "X-Reader": "1" } });

		await tick();
		releases[1]!();
		await reader;
		releases[0]!();
		await writer;

		expect(await client.read({ query: TODOS })).toEqual({ todos: 1 });
	});

	it("an aborted newer request does not discard an older successful response", async function () {
		let release!: () => void;
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			const request = input as Request;

			if (request.headers.get("X-Newer")) {
				return new Promise<Response>(function (_resolve, reject) {
					request.signal.addEventListener("abort", function () {
						reject(request.signal.reason);
					});
				});
			}

			await new Promise<void>(function (resolve) {
				release = resolve;
			});

			return Response.json({ data: { todos: 1 } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const older = client.gql({ query: TODOS });

		await tick();

		const controller = new AbortController();
		const newer = client.gql({ query: TODOS, signal: controller.signal, headers: { "X-Newer": "1" } }).catch(function (
			error: unknown,
		) {
			return error;
		});

		await tick();
		controller.abort();
		await newer;
		release();
		await older;

		expect(await client.read({ query: TODOS })).toEqual({ todos: 1 });
	});

	it("fetchMore is not overwritten by an older in-flight refetch", async function () {
		const slow: Array<() => void> = [];
		const fetchMock = vi.fn<typeof fetch>(async function (input) {
			const { variables } = await (input as Request).clone().json();
			const after = variables?.after ?? 0;

			if (after === 0 && fetchMock.mock.calls.length > 1) {
				await new Promise<void>(function (resolve) {
					slow.push(resolve);
				});
			}

			return Response.json({ data: { feed: [after + 1, after + 2] } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const options = { key: ["feed"], query: FEED, variables: {} };
		const ref = client.watch<{ feed: number[] }, { after?: number }>(options);

		ref.subscribe(function () {});
		await tick();

		const refetch = ref.refetch();

		await tick();
		await ref.fetchMore({
			variables: { after: 2 },
			merge(previous, next) {
				return { feed: [...previous.feed, ...next.feed] };
			},
		});

		slow[0]!();
		await refetch;

		expect(ref.getState().data).toEqual({ feed: [1, 2, 3, 4] });
		expect(await client.read(options)).toEqual({ feed: [1, 2, 3, 4] });
	});
});

describe("missed invalidations", function () {
	/**
	 * Creates a counting server.
	 *
	 * @returns The fetch mock
	 */
	function counter() {
		let n = 0;

		return vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { todos: ++n } });
		});
	}

	it("detects invalidations missed while inactive, with or without a cache or initialData", async function () {
		for (const configuration of [{}, { cache: new MemoryCache() }]) {
			const fetchMock = counter();
			const client = new Client({ url: URL, fetch: fetchMock, ...configuration });
			const ref = client.watch<{ todos: number }>({ key: ["t"], query: TODOS, initialData: { todos: 0 } });
			const stop = ref.subscribe(function () {});

			await ref.refetch();
			stop();

			await client.invalidate(["t"]);

			const again = ref.subscribe(function () {});

			await tick();

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(ref.getState().data).toEqual({ todos: 2 });
			again();
		}
	});

	it("keeps detecting them after the invalidation log overflows", async function () {
		const fetchMock = counter();
		const client = new Client({ url: URL, fetch: fetchMock });
		const ref = client.watch({ key: ["t"], query: TODOS });

		ref.subscribe(function () {})();
		await tick();

		for (let index = 0; index < 100; index++) await client.invalidate(["other", index]);

		ref.subscribe(function () {});
		await tick();

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not refetch when unrelated keys are invalidated", async function () {
		const fetchMock = counter();
		const client = new Client({ url: URL, fetch: fetchMock });
		const ref = client.watch({ key: ["t"], query: TODOS });

		ref.subscribe(function () {})();
		await tick();
		await client.invalidate(["other"]);
		ref.subscribe(function () {});
		await tick();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("misc", function () {
	it("subscribing the same listener twice activates once", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { todos: 1 } });
		});
		const ref = new Client({ url: URL, fetch: fetchMock, dedupe: false }).watch({ query: TODOS });
		const listener = vi.fn();

		ref.subscribe(listener);
		const unsubscribe = ref.subscribe(listener);

		await tick();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("never caches nor dedupes requests carrying files", async function () {
		let n = 0;
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { result: ++n } });
		});
		const client = new Client({ url: URL, fetch: fetchMock, cache: new MemoryCache() });
		const query = "query Analyze($f: Upload!) { analyze(file: $f) }";
		const [first, second] = await Promise.all([
			client.gql({ query, variables: { f: new Blob(["a"]) } }),
			client.gql({ query, variables: { f: new Blob(["b"]) } }),
		]);
		const third = await client.gql({ query, variables: { f: new Blob(["a"]) } });

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(new Set([first, second, third]).size).toBe(3);
	});

	it("retries a failed persisted-query hash instead of memoizing the failure", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { a: 1 } });
		});
		let calls = 0;
		const client = new Client({
			url: URL,
			fetch: fetchMock,
			persistedQueries: {
				async hash() {
					if (++calls === 1) throw new Error("hash failed");
					return "h";
				},
			},
		});

		await expect(client.gql({ query: "{ a }" })).rejects.toThrow("hash failed");
		expect(await client.gql({ query: "{ a }" })).toEqual({ a: 1 });
		expect(calls).toBe(2);
	});
});

describe("documents", function () {
	it("minify keeps adjacent strings apart", function () {
		expect(minify('{ f(a: ["", "x"]) }')).toBe('{f(a:["" "x"])}');
		expect(minify('query ($v: [String] = ["", "z"]) { f }')).toBe('query($v:[String]=["" "z"]){f}');
	});

	it("minify and operation parsing handle escaped triple quotes in block strings", function () {
		const document = 'query { f(a: """x \\""" y""") }';

		expect(minify(document)).toBe('query{f(a:"""x \\""" y""")}');
	});

	it("dedupeFragments recognizes fragments preceded by comments", function () {
		const shared = graphql`
			# Shared user fields
			fragment F on User {
				id
			}
		`;
		const a = graphql`
			fragment A on User {
				...F
			}
			${shared}
		`;
		const b = graphql`
			fragment B on User {
				...F
			}
			${shared}
		`;
		const document = graphql`
			query {
				me {
					...A
					...B
				}
			}
			${a}
			${b}
		`;

		expect(document.match(/fragment F on/g)).toHaveLength(1);
	});

	it("dedupeFragments ignores object values in arguments", function () {
		const fragment = "fragment F on T @x(a: {b: 1}) { id }";

		expect(dedupeFragments(`${fragment}\n${fragment}\nquery { ...F }`)).toBe(`${fragment}\n\nquery { ...F }`);
	});
});
