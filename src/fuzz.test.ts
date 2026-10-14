import { describe, expect, it, vi } from "vitest";
import { MemoryCache } from "./cache/memory-cache";
import { Client } from "./client";
import { optimistic } from "./optimistic";
import type { QueryRef } from "./query-ref";
import type { FetchPolicy, QueryState } from "./types";
import { createCacheKey } from "./utils";

/**
 * Seeded, model-based (property) tests for the cache / live-query / optimistic-layer machinery.
 *
 * A fake server holds the authoritative state (a todo list and a counter). Every request is parked in a queue; the fuzzer
 * decides when the server *processes* it (applies a mutation / computes a response) and, separately, when the response
 * is *delivered* to the client, so processing order and delivery order can differ like on a real network.
 *
 * A seeded PRNG (mulberry32) generates an operation sequence: `gql` with every fetch policy, mutations with optimistic
 * updates and/or `invalidates` (succeeding or failing), `write`, `invalidate`, subscribing to / unsubscribing from live
 * queries, `refetch`, `fetchMore`, processing / delivering a pending request, and timer ticks (deferred deactivation).
 * Two clients share a cache (`extend`), as documented.
 *
 * After the sequence the system is drained to quiescence and invariants are checked (see `checkQuiescent`,
 * `checkConvergence` and `checkSnapshot`). Failing sequences are shrunk by deleting operations while the same invariant
 * still fails, and the test fails with the minimal sequence and its seed.
 *
 * By default a fixed seed range runs with every feature on, so the test is a deterministic CI gate. Environment
 * overrides for local exploration:
 *
 *   FUZZ_SEEDS=3000       number of seeds              FUZZ_START=1     first seed
 *   FUZZ_OPS=100          operations per sequence      FUZZ_SEED=123    run a single seed and print its trace
 *   FUZZ_OFF=client2,queryErrors,fetchMore,noCache,inactive,writes      disable features (to look past a dominant bug)
 *   FUZZ_REPORT=/path.json  also write the shrunk failures as JSON
 *   FUZZ_REPLAY=/path.json:<index>  replay a shrunk case from such a report with a trace
 *
 * e.g. `FUZZ_SEEDS=3000 npx vitest run src/fuzz.test.ts`.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------

const env = process.env;
const SEEDS = Number(env.FUZZ_SEEDS ?? 1000);
const START = Number(env.FUZZ_START ?? 1);
const OPS = Number(env.FUZZ_OPS ?? 40);
const SINGLE = env.FUZZ_SEED === undefined ? undefined : Number(env.FUZZ_SEED);
const OFF = new Set((env.FUZZ_OFF ?? "").split(",").filter(Boolean));
const URL = "https://fuzz.test/graphql";

// ---------------------------------------------------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Normalizes the arguments `fetch` was called with into a Request (the client calls `fetch(url, init)`).
 *
 * @param input - The URL or request
 * @param init - The request init
 * @returns The request
 */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

/**
 * The mulberry32 PRNG: small, fast and good enough to explore interleavings reproducibly.
 *
 * @param seed - The seed
 * @returns A function returning the next number in [0, 1)
 */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;

	return function next(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Rng {
	(): number;
	/** An integer in [0, n) */
	int(n: number): number;
	/** A random element of `items` */
	pick<T>(items: readonly T[]): T;
	/** True with probability `p` */
	chance(p: number): boolean;
}

/**
 * Creates a seeded random generator with a few helpers.
 *
 * @param seed - The seed
 * @returns The generator
 */
function createRng(seed: number): Rng {
	const next = mulberry32(seed) as Rng;

	next.int = function int(n: number): number {
		return Math.floor(next() * n);
	};
	next.pick = function pick<T>(items: readonly T[]): T {
		return items[next.int(items.length)]!;
	};
	next.chance = function chance(p: number): boolean {
		return next() < p;
	};

	return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema / targets
// ---------------------------------------------------------------------------------------------------------------------

const TODOS = "query Todos($page: Int) { todos(page: $page) served }";
const SIZE = "query Size { size served }";
const COUNT = "query Count { count served }";
const ADD = "mutation Add($title: String!) { add(title: $title) }";
const INC = "mutation Inc($fail: Boolean) { inc(fail: $fail) }";

/** Every query result carries `served`: the id of the server response (`s…`) or write (`w…`) it comes from. */
type Todos = { todos: string[]; served: string };
type Size = { size: number; served: string };
type Count = { count: number; served: string };

interface Target {
	key: readonly string[];
	query: string;
	variables?: Record<string, unknown>;
}

const TARGETS: readonly Target[] = [
	{ key: ["todos"], query: TODOS, variables: {} },
	{ key: ["todos", "size"], query: SIZE },
	{ key: ["count"], query: COUNT },
];
const TARGET_NAMES = ["T0:todos", "T1:size", "T2:count"];
const TARGET_KEYS = TARGETS.map(function (target) {
	return createCacheKey([...target.key], target.query, target.variables);
});
/** Prefixes used by `invalidate` and mutations' `invalidates` */
const PREFIXES: ReadonlyArray<readonly string[]> = [[], ["todos"], ["todos", "size"], ["count"]];

type Policy = Exclude<FetchPolicy, "cache-only">;

/**
 * Builds the options of a query on a target (with a fresh, mutable key).
 *
 * @param target - The target index
 * @returns The query options
 */
function targetOptions(target: number) {
	const { key, query, variables } = TARGETS[target]!;

	return { key: [...key], query, ...(variables ? { variables } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------------------

/** A live query (`watch`) the operations can subscribe to, refetch or paginate */
interface Slot {
	target: number;
	policy: Policy;
	client: number;
}

type Op =
	| { t: "query"; id: number; c: number; target: number; policy: Policy }
	| { t: "add"; id: number; c: number; fail: boolean; opt: "none" | "exact" | "temp"; inv: number[] }
	| { t: "inc"; id: number; c: number; fail: boolean; opt: boolean; inv: number[] }
	| { t: "write"; id: number; c: number; target: number }
	| { t: "invalidate"; id: number; c: number; prefix: number }
	| { t: "sub"; id: number; w: number }
	| { t: "unsub"; id: number; w: number }
	| { t: "refetch"; id: number; w: number }
	| { t: "fetchMore"; id: number; w: number }
	| { t: "process"; id: number; r: number; err: boolean }
	| { t: "deliver"; id: number; r: number; err: boolean }
	| { t: "tick"; id: number };

interface Case {
	seed: number;
	slots: Slot[];
	ops: Op[];
	/** Order in which the final drain delivers pending requests */
	drain?: "random" | "fifo" | "lifo";
}

/**
 * Generates the live-query slots and the operation sequence of a seed.
 *
 * @param seed - The seed
 * @param count - The number of operations
 * @returns The test case
 */
function generate(seed: number, count = OPS): Case {
	const rng = createRng(seed);
	const clients = OFF.has("client2") ? 1 : 2;
	const policies: Policy[] = ["cache-first", "cache-first", "network-only", "cache-and-network"];

	if (!OFF.has("noCache")) policies.push("no-cache");

	const slots: Slot[] = [];

	for (let i = 0; i < 4; i++) {
		slots.push({ target: rng.chance(0.6) ? 0 : rng.int(3), policy: rng.pick(policies), client: rng.int(clients) });
	}

	const weights: Array<[Op["t"], number]> = [
		["sub", 12],
		["unsub", 8],
		["refetch", 6],
		["fetchMore", OFF.has("fetchMore") ? 0 : 4],
		["query", 10],
		["add", 10],
		["inc", 5],
		["write", OFF.has("writes") ? 0 : 4],
		["invalidate", 7],
		["process", 7],
		["deliver", 22],
		["tick", 6],
	];
	let total = 0;

	for (const [, weight] of weights) total += weight;

	const ops: Op[] = [];
	const errors = !OFF.has("queryErrors");

	/**
	 * Picks the prefixes a mutation invalidates.
	 *
	 * @returns Indexes into `PREFIXES`
	 */
	function invalidates(): number[] {
		const out: number[] = [];

		if (rng.chance(0.3)) out.push(1);
		if (rng.chance(0.15)) out.push(rng.int(PREFIXES.length));

		return out;
	}

	for (let id = 0; id < count; id++) {
		let roll = rng() * total;
		let type: Op["t"] = "tick";

		for (const [candidate, weight] of weights) {
			roll -= weight;
			if (roll < 0) {
				type = candidate;
				break;
			}
		}

		const c = rng.int(clients);

		switch (type) {
			case "query":
				ops.push({ t: type, id, c, target: rng.int(3), policy: rng.pick(policies) });
				break;
			case "add": {
				const opt = rng.pick(["none", "exact", "exact", "temp"] as const);
				const inv = invalidates();

				// A placeholder only goes away through an invalidation (the documented pattern).
				if (
					opt === "temp" &&
					!inv.some(function (prefix) {
						return prefix <= 1;
					})
				) {
					inv.push(1);
				}
				ops.push({ t: type, id, c, fail: rng.chance(0.35), opt, inv });
				break;
			}
			case "inc": {
				const opt = rng.chance(0.6);
				const inv = invalidates();

				if (
					opt &&
					!inv.some(function (prefix) {
						return prefix === 0 || prefix === 3;
					})
				) {
					inv.push(3);
				}
				ops.push({ t: type, id, c, fail: rng.chance(0.35), opt, inv });
				break;
			}
			case "write":
				ops.push({ t: type, id, c, target: rng.int(3) });
				break;
			case "invalidate":
				ops.push({ t: type, id, c, prefix: rng.int(PREFIXES.length) });
				break;
			case "sub":
			case "unsub":
			case "refetch":
			case "fetchMore":
				ops.push({ t: type, id, w: rng.int(slots.length) });
				break;
			case "process":
			case "deliver":
				ops.push({ t: type, id, r: rng.int(1000), err: errors && rng.chance(0.08) });
				break;
			default:
				ops.push({ t: "tick", id });
		}
	}

	return { seed, slots, ops };
}

/**
 * Names a client for traces.
 *
 * @param c - The client index
 * @returns The client name
 */
function clientName(c: number): string {
	return c ? "client2" : "client1";
}

/**
 * Formats prefix indexes for traces.
 *
 * @param inv - Indexes into `PREFIXES`
 * @returns The prefixes as JSON
 */
function prefixList(inv: number[]): string {
	return JSON.stringify(
		inv.map(function (index) {
			return PREFIXES[index];
		}),
	);
}

/**
 * Describes an operation in plain words, for traces and failure reports.
 *
 * @param op - The operation
 * @param slots - The case's live-query slots
 * @returns The description
 */
function describeOp(op: Op, slots: Slot[]): string {
	switch (op.t) {
		case "query":
			return `${clientName(op.c)}.gql(${TARGET_NAMES[op.target]}, ${op.policy})`;
		case "add":
			return `${clientName(op.c)}.gql(Add "${title(op)}"${op.fail ? " [server rejects]" : ""}, optimistic=${op.opt}, invalidates=${prefixList(op.inv)})`;
		case "inc":
			return `${clientName(op.c)}.gql(Inc${op.fail ? " [server rejects]" : ""}, optimistic=${op.opt ? "count+1" : "none"}, invalidates=${prefixList(op.inv)})`;
		case "write":
			return `${clientName(op.c)}.write(${TARGET_NAMES[op.target]}, <current server truth>)`;
		case "invalidate":
			return `${clientName(op.c)}.invalidate(${JSON.stringify(PREFIXES[op.prefix])})`;
		case "sub":
		case "unsub":
		case "refetch":
		case "fetchMore": {
			const slot = slots[op.w]!;
			const call = op.t === "sub" ? "subscribe()" : op.t === "unsub" ? "unsubscribe()" : `${op.t}()`;

			return `W${op.w}.${call}   [W${op.w} = ${clientName(slot.client)}.watch(${TARGET_NAMES[slot.target]}, ${slot.policy})]`;
		}
		case "process":
			return `server processes pending[${op.r} % n]${op.err ? " (query fails)" : ""}`;
		case "deliver":
			return `deliver pending[${op.r} % n]${op.err ? " (query fails if unprocessed)" : ""}`;
		case "tick":
			return "tick (run 0ms timers: deferred deactivations)";
	}
}

/**
 * The title an `add` operation sends: the server rejects titles starting with "boom".
 *
 * @param op - The operation
 * @returns The title
 */
function title(op: { id: number; fail: boolean }): string {
	return op.fail ? `boom${op.id}` : `t${op.id}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------------------------------------------------

interface PendingRequest {
	seq: number;
	/** Event number at which the request reached the server */
	evt: number;
	query: string;
	variables: Record<string, unknown> | undefined;
	resolve(response: Response): void;
	processed?: { status: number; body: unknown };
}

/**
 * Builds a successful response body.
 *
 * @param data - The data
 * @returns The processed response
 */
function ok(data: unknown): { status: number; body: unknown } {
	return { status: 200, body: { data } };
}

/**
 * Builds a GraphQL error response body.
 *
 * @param message - The error message
 * @returns The processed response
 */
function failure(message: string): { status: number; body: unknown } {
	return { status: 200, body: { errors: [{ message }] } };
}

/**
 * The authoritative state, with requests parked until the fuzzer processes / delivers them.
 */
class FakeServer {
	todos: string[] = ["a"];
	count = 0;
	served = 0;
	pending: PendingRequest[] = [];
	requests = 0;
	/** Served id -> event number at which the request reached the server */
	servedAt = new Map<string, number>();
	/** The `fetch` implementation handed to the clients */
	readonly fetch: typeof fetch;
	readonly #events: () => number;

	/**
	 * Creates the server with its initial state: todos ["a"] and count 0.
	 *
	 * @param events - Returns the next event number (a logical clock shared with the runner)
	 */
	constructor(events: () => number) {
		this.#events = events;
		this.fetch = this.#receive.bind(this) as typeof fetch;
	}

	/**
	 * Parks an incoming request.
	 *
	 * @param input - The URL or request
	 * @param init - The request init
	 * @returns The response, once delivered
	 */
	async #receive(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const evt = this.#events();
		const body = (await toRequest(input, init).clone().json()) as { query: string; variables?: Record<string, unknown> };
		const pending = this.pending;
		const seq = this.requests++;

		return new Promise<Response>(function (resolve) {
			pending.push({ seq, evt, query: body.query, variables: body.variables, resolve });
		});
	}

	/**
	 * The current data of a target.
	 *
	 * @param target - The target index
	 * @returns The data, without `served`
	 */
	truth(target: number): Record<string, unknown> {
		if (target === 0) return { todos: [...this.todos] };
		if (target === 1) return { size: this.todos.length };

		return { count: this.count };
	}

	/**
	 * Processes a request: applies a mutation or computes a query response (once).
	 *
	 * @param request - The pending request
	 * @param fail - Whether a query fails
	 */
	process(request: PendingRequest, fail: boolean): void {
		if (request.processed) return;

		const { query, variables } = request;

		if (query.startsWith("mutation Add")) {
			const name = String(variables?.title);

			if (name.startsWith("boom")) {
				request.processed = failure("rejected");
			} else {
				if (!this.todos.includes(name)) this.todos.push(name);
				request.processed = ok({ add: true });
			}

			return;
		}

		if (query.startsWith("mutation Inc")) {
			request.processed = variables?.fail ? failure("rejected") : ok({ inc: ++this.count });
			return;
		}

		if (fail) {
			request.processed = failure("query failed");
			return;
		}

		const served = `s${++this.served}`;

		this.servedAt.set(served, request.evt);

		if (query.startsWith("query Todos")) request.processed = ok({ todos: [...this.todos], served });
		else if (query.startsWith("query Size")) request.processed = ok({ size: this.todos.length, served });
		else request.processed = ok({ count: this.count, served });
	}

	/**
	 * Delivers a pending request's response, processing it first if needed.
	 *
	 * @param index - The index in `pending`
	 * @param fail - Whether a query fails (when not processed yet)
	 */
	deliver(index: number, fail: boolean): void {
		const [request] = this.pending.splice(index, 1);

		if (!request) return;

		this.process(request, fail);
		request.resolve(Response.json(request.processed!.body, { status: request.processed!.status }));
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------------------------------

interface Violation {
	invariant: string;
	detail: string;
}

/** Stops a run when it cannot reach quiescence. */
class Abort extends Error {}

/**
 * Lets pending promises settle (timers are faked, `setImmediate` is not).
 */
async function microFlush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await new Promise<void>(function (resolve) {
			setImmediate(resolve);
		});
	}
}

/**
 * Drops the `served` marker to compare data with the server truth.
 *
 * @param value - Query data
 * @returns The data without `served`
 */
function strip(value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { served: _served, ...rest } = value as Record<string, unknown>;

		return rest;
	}

	return value;
}

/**
 * Structural equality (key order is deterministic here).
 *
 * @param a - A value
 * @param b - Another value
 * @returns Whether both serialize the same
 */
function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Finds the target of a cache key.
 *
 * @param cacheKey - The cache key
 * @returns The target index, or -1
 */
function keyTarget(cacheKey: string): number {
	return TARGET_KEYS.indexOf(cacheKey);
}

/**
 * Whether invalidating `prefix` drops a target.
 *
 * @param target - The target index
 * @param prefix - The invalidated prefix
 * @returns Whether the target's key starts with the prefix
 */
function matchesPrefix(target: number, prefix: readonly string[]): boolean {
	const key = TARGETS[target]!.key;

	return (
		prefix.length <= key.length &&
		prefix.every(function (segment, i) {
			return key[i] === segment;
		})
	);
}

/**
 * Merges a page into the todo list (other targets just take the page).
 *
 * @param target - The target index
 * @returns The `fetchMore` merge function
 */
function merge(target: number) {
	return function mergePages(previous: unknown, next: unknown): unknown {
		if (target !== 0) return next;

		const known = (previous as Todos).todos;
		const page = next as Todos;

		return {
			...page,
			todos: [
				...known,
				...page.todos.filter(function (item) {
					return !known.includes(item);
				}),
			],
		};
	};
}

/**
 * Runs a test case, drains it to quiescence and checks the invariants.
 *
 * @param testCase - The case
 * @param trace - Log every step with the resulting state
 * @returns The invariant violations
 */
async function run(testCase: Case, trace = false): Promise<Violation[]> {
	const violations: Violation[] = [];
	const rng = createRng(testCase.seed ^ 0x9e3779b9);
	let evt = 0;
	const server = new FakeServer(function nextEvent() {
		return ++evt;
	});
	const cache = new MemoryCache({ ttl: Infinity, maxSize: 1000 });
	const client1 = new Client({ url: URL, fetch: server.fetch, cache });
	const client2 = OFF.has("client2") ? client1 : client1.extend({});
	const clients = [client1, client2];
	/** Last invalidation event per target */
	const invalidatedAt = [0, 0, 0];
	/** Write id -> event */
	const writtenAt = new Map<string, number>();
	let writes = 0;
	const unhandled: unknown[] = [];
	const refs: Array<QueryRef<unknown> | undefined> = [];
	const listeners: Array<Array<() => void>> = testCase.slots.map(function () {
		return [];
	});
	let outstanding = 0;

	/**
	 * Records unhandled rejections (a violation).
	 *
	 * @param reason - The rejection reason
	 */
	function onUnhandled(reason: unknown): void {
		unhandled.push(reason);
	}

	process.on("unhandledRejection", onUnhandled);

	// Record when each target is invalidated, whichever client (or mutation) does it.
	for (const client of new Set(clients)) {
		const original = client.invalidate.bind(client);

		client.invalidate = function invalidate(prefix = []) {
			const at = ++evt;

			for (let target = 0; target < TARGETS.length; target++) {
				if (matchesPrefix(target, prefix as string[])) invalidatedAt[target] = at;
			}

			return original(prefix);
		};
	}

	/**
	 * Counts a promise as outstanding until it settles (rejections are expected).
	 *
	 * @param promise - A gql / refetch / fetchMore / write / invalidate promise
	 */
	function track(promise: Promise<unknown>): void {
		outstanding++;
		promise.then(
			function () {
				outstanding--;
			},
			function () {
				outstanding--;
			},
		);
	}

	/**
	 * Gets (creating it on first use) the live query of a slot.
	 *
	 * @param w - The slot index
	 * @returns The query ref
	 */
	function ref(w: number): QueryRef<unknown> {
		let existing = refs[w];

		if (!existing) {
			const slot = testCase.slots[w]!;

			existing = clients[slot.client]!.watch<unknown, Record<string, unknown>>({
				...targetOptions(slot.target),
				fetchPolicy: slot.policy,
			});
			refs[w] = existing;
		}

		return existing;
	}

	/**
	 * The live queries that currently have at least one listener.
	 *
	 * @returns The active refs with their slot
	 */
	function activeRefs(): Array<{ w: number; r: QueryRef<unknown>; slot: Slot }> {
		const out = [];

		for (let w = 0; w < refs.length; w++) {
			const r = refs[w];

			if (r && listeners[w]!.length > 0) out.push({ w, r, slot: testCase.slots[w]! });
		}

		return out;
	}

	/**
	 * Logs the active live queries and the cache.
	 *
	 * @param prefix - Line prefix
	 */
	function logState(prefix: string): void {
		for (const { w, r } of activeRefs()) console.log(`${prefix}W${w} -> ${JSON.stringify(r.getState())}`);
		console.log(
			`${prefix}cache: ${JSON.stringify(
				TARGET_KEYS.map(function (key) {
					return cache.get(key);
				}),
			)} pending=${server.pending.length} server=${JSON.stringify(server.todos)} count=${server.count}`,
		);
	}

	/**
	 * Executes one operation.
	 *
	 * @param op - The operation
	 */
	async function execute(op: Op): Promise<void> {
		switch (op.t) {
			case "query":
				track(clients[op.c]!.gql({ ...targetOptions(op.target), fetchPolicy: op.policy }));
				break;
			case "add": {
				const name = title(op);
				const item = op.opt === "temp" ? `temp${op.id}` : name;
				const updates =
					op.opt === "none"
						? undefined
						: [
								optimistic<Todos, unknown>(targetOptions(0), function (current) {
									const todos = current?.todos ?? [];

									return {
										todos: todos.includes(item) ? todos : [...todos, item],
										served: current?.served ?? "fold",
									};
								}),
							];

				track(
					clients[op.c]!.gql({
						query: ADD,
						variables: { title: name },
						...(updates ? { optimistic: updates } : {}),
						...(op.inv.length ? { invalidates: invalidatedPrefixes(op.inv) } : {}),
					}),
				);
				break;
			}
			case "inc": {
				const updates = op.opt
					? [
							optimistic<Count, unknown>(targetOptions(2), function (current) {
								return { count: (current?.count ?? 0) + 1, served: "opt" };
							}),
						]
					: undefined;

				track(
					clients[op.c]!.gql({
						query: INC,
						variables: { fail: op.fail },
						...(updates ? { optimistic: updates } : {}),
						...(op.inv.length ? { invalidates: invalidatedPrefixes(op.inv) } : {}),
					}),
				);
				break;
			}
			case "write": {
				const id = `w${++writes}`;

				writtenAt.set(id, ++evt);
				track(clients[op.c]!.write(targetOptions(op.target), { ...server.truth(op.target), served: id }));
				break;
			}
			case "invalidate":
				track(clients[op.c]!.invalidate([...PREFIXES[op.prefix]!]));
				break;
			case "sub":
				// A distinct listener per subscription.
				listeners[op.w]!.push(ref(op.w).subscribe(function listener(_state: QueryState<unknown>) {}));
				break;
			case "unsub":
				listeners[op.w]!.pop()?.();
				break;
			case "refetch":
				if (OFF.has("inactive") && !listeners[op.w]!.length) break;
				track(ref(op.w).refetch());
				break;
			case "fetchMore": {
				if (OFF.has("inactive") && !listeners[op.w]!.length) break;
				const slot = testCase.slots[op.w]!;

				track(ref(op.w).fetchMore({ variables: { page: 2 }, merge: merge(slot.target) }));
				break;
			}
			case "process":
				if (server.pending.length) server.process(server.pending[op.r % server.pending.length]!, op.err);
				break;
			case "deliver":
				if (server.pending.length) server.deliver(op.r % server.pending.length, op.err);
				break;
			case "tick":
				vi.runOnlyPendingTimers();
				break;
		}

		await microFlush();
	}

	/**
	 * Delivers every pending request (and the ones they trigger) and runs timers until nothing is left.
	 *
	 * @param phase - Name of the phase, for reports
	 */
	async function quiesce(phase: string): Promise<void> {
		for (let i = 0; i < 400; i++) {
			await microFlush();

			if (server.pending.length) {
				const n = server.pending.length;
				const index = testCase.drain === "fifo" ? 0 : testCase.drain === "lifo" ? n - 1 : rng.int(n);

				if (trace) console.log(`  [${phase}] deliver req ${server.pending[index]!.seq}`);
				server.deliver(index, false);
				if (trace) {
					await microFlush();
					logState("      ");
				}
				continue;
			}

			if (vi.getTimerCount() > 0) {
				vi.runOnlyPendingTimers();
				continue;
			}

			await microFlush();
			if (server.pending.length || vi.getTimerCount() > 0) continue;

			if (outstanding > 0) {
				violations.push({
					invariant: "I4b promises settle",
					detail: `${phase}: ${outstanding} gql/refetch/fetchMore/write promise(s) never settled with no request in flight`,
				});
				throw new Abort();
			}

			return;
		}

		violations.push({ invariant: "I4c quiescence", detail: `${phase}: system never quiesced (endless refetch loop?)` });
		throw new Abort();
	}

	/**
	 * Checks that a value holds only real data.
	 *
	 * `lenient`: the holder is a live query whose last fetch failed. Its data stays visible after errors (documented), so
	 * a placeholder of a *successful* mutation ("temp…" / count "opt") is tolerated there; rejected data is not.
	 *
	 * @param where - Where the value was read, for reports
	 * @param target - The target index
	 * @param value - The value
	 * @param lenient - Tolerate placeholders
	 */
	function scan(where: string, target: number, value: unknown, lenient = false): void {
		/**
		 * Records a violation.
		 *
		 * @param invariant - The invariant
		 * @param detail - What was observed
		 */
		function fail(invariant: string, detail: string): void {
			violations.push({ invariant, detail: `${where} (${TARGET_NAMES[target]}): ${detail}` });
		}

		if (value === undefined) return;

		if (target === 0) {
			const data = value as Todos;

			for (const item of data.todos) {
				if (item.startsWith("boom")) {
					fail(
						"I2 rolled-back optimistic data visible",
						`contains "${item}" from a rejected mutation: ${JSON.stringify(data)}`,
					);
				} else if (item.startsWith("temp")) {
					if (!lenient) {
						fail(
							"I2b placeholder optimistic data visible",
							`contains "${item}" (layer of a settled mutation): ${JSON.stringify(data)}`,
						);
					}
				} else if (!server.todos.includes(item)) {
					fail("I2c unknown data", `contains "${item}" which the server never had`);
				}
			}

			if (new Set(data.todos).size !== data.todos.length) fail("I2d duplicates", JSON.stringify(data));
		} else if (target === 1) {
			const data = value as Size;

			if (data.size > server.todos.length)
				fail("I2c unknown data", `size ${data.size} > server ${server.todos.length}`);
		} else {
			const data = value as Count;

			if (data.served === "opt" && !lenient) {
				fail("I2 rolled-back optimistic data visible", `optimistic count still visible: ${JSON.stringify(data)}`);
			}
			if (data.count > server.count) fail("I2c unknown data", `count ${data.count} > server ${server.count}`);
		}
	}

	/**
	 * Invariants that must hold after quiescence, before any corrective refetch.
	 *
	 * @param phase - Name of the phase, for reports
	 */
	async function checkQuiescent(phase: string): Promise<void> {
		const keys = [...cache.keys()];
		const snapshot = await client1.extract();

		for (const key of keys) {
			const target = keyTarget(key);

			if (target === -1) {
				violations.push({ invariant: "I0 unexpected cache entry", detail: `${phase}: ${key}` });
				continue;
			}

			const value = cache.get(key);

			scan(`${phase} cache`, target, value);

			// I3: with no pending optimistic mutation, extract() must equal the cache.
			if (!same(snapshot[key], value)) {
				violations.push({
					invariant: "I3 extract() differs from cache with no pending mutation",
					detail: `${phase} ${TARGET_NAMES[target]}: extract=${JSON.stringify(snapshot[key])} cache=${JSON.stringify(value)}`,
				});
			}

			// I6: freshness. Data in the cache must come from a request that reached the server (or a write made) after
			// the last invalidation of that entry.
			const served = (value as { served?: string } | undefined)?.served;
			const at = served?.startsWith("s")
				? server.servedAt.get(served)
				: served?.startsWith("w")
					? writtenAt.get(served)
					: undefined;

			if (at !== undefined && at < invalidatedAt[target]!) {
				violations.push({
					invariant: "I6 invalidated data resurrected in cache",
					detail: `${phase} ${TARGET_NAMES[target]}: cache holds ${JSON.stringify(value)} (from event ${at}) although the entry was invalidated at event ${invalidatedAt[target]}`,
				});
			}
		}

		for (const key of Object.keys(snapshot)) {
			if (!keys.includes(key)) {
				violations.push({
					invariant: "I3 extract() differs from cache with no pending mutation",
					detail: `${phase}: extract has ${key} which the cache lacks`,
				});
			}

			const target = keyTarget(key);

			if (target !== -1) scan(`${phase} extract()`, target, snapshot[key]);
		}

		for (const { w, r, slot } of activeRefs()) {
			const state = r.getState();

			scan(`${phase} W${w}.data`, slot.target, state.data, state.error !== undefined);

			if (state.loading) {
				violations.push({
					invariant: "I4 live query stuck loading",
					detail: `${phase} W${w}: ${JSON.stringify(state)}`,
				});
			}

			if (slot.policy === "no-cache" || state.error !== undefined) continue;

			const cached = cache.get(TARGET_KEYS[slot.target]!);

			if (!same(cached, state.data)) {
				violations.push({
					invariant: "I5 active live query out of sync with its cache entry",
					detail: `${phase} W${w} (${slot.policy}, ${TARGET_NAMES[slot.target]}): watcher=${JSON.stringify(state.data)} cache=${JSON.stringify(cached)}`,
				});
			}
		}

		if (unhandled.length) {
			violations.push({ invariant: "I4d unhandled rejection", detail: `${phase}: ${String(unhandled[0])}` });
		}
	}

	/**
	 * After refetching every active live query (and every target with network-only), everything equals the server.
	 */
	async function checkConvergence(): Promise<void> {
		for (const { r } of activeRefs()) track(r.refetch());
		await quiesce("final refetch");

		for (const { w, r, slot } of activeRefs()) {
			const state = r.getState();
			const expected = server.truth(slot.target);

			if (state.error !== undefined || !same(strip(state.data), expected)) {
				violations.push({
					invariant: "I1 live query != server truth after a final refetch",
					detail: `W${w} (${slot.policy}, ${TARGET_NAMES[slot.target]}): watcher=${JSON.stringify(state)} server=${JSON.stringify(expected)}`,
				});
			}
		}

		for (let target = 0; target < TARGETS.length; target++) {
			track(client1.gql({ ...targetOptions(target), fetchPolicy: "network-only" }));
		}
		await quiesce("final network-only");

		for (let target = 0; target < TARGETS.length; target++) {
			const cached = cache.get(TARGET_KEYS[target]!);

			if (!same(strip(cached), server.truth(target))) {
				violations.push({
					invariant: "I1b cache != server truth after a network-only read",
					detail: `${TARGET_NAMES[target]}: cache=${JSON.stringify(cached)} server=${JSON.stringify(server.truth(target))}`,
				});
			}
		}

		await checkQuiescent("after convergence");
	}

	/**
	 * `restore(extract())` into a fresh client yields the same (real) data.
	 */
	async function checkSnapshot(): Promise<void> {
		const snapshot = await client1.extract();
		const fresh = new Client({ url: URL, fetch: server.fetch, cache: new MemoryCache({ ttl: Infinity }) });

		await fresh.restore(snapshot);

		for (let target = 0; target < TARGETS.length; target++) {
			const restored = await fresh.read(targetOptions(target));
			const original = cache.get(TARGET_KEYS[target]!);

			if (!same(restored, original)) {
				violations.push({
					invariant: "I3b restore(extract()) differs",
					detail: `${TARGET_NAMES[target]}: restored=${JSON.stringify(restored)} original=${JSON.stringify(original)}`,
				});
			}
		}
	}

	try {
		for (const op of testCase.ops) {
			if (trace) {
				console.log(`  #${op.id} ${describeOp(op, testCase.slots)}`);
				if ((op.t === "deliver" || op.t === "process") && server.pending.length) {
					const request = server.pending[op.r % server.pending.length]!;

					console.log(
						`      (= req ${request.seq}: ${request.query.split(" {")[0]} ${JSON.stringify(request.variables ?? {})})`,
					);
				}
			}

			await execute(op);
			if (trace) logState("      ");
		}

		await quiesce("drain");
		if (trace) logState("  [quiesced] ");
		await checkQuiescent("after drain");
		// Convergence and snapshot checks are independent: run them even when a quiescent invariant failed.
		await checkConvergence();
		await checkSnapshot();
	} catch (error) {
		if (!(error instanceof Abort)) {
			violations.push({ invariant: "harness exception", detail: String((error as Error)?.stack ?? error) });
		}
	} finally {
		for (const list of listeners) for (const stop of list.splice(0)) stop();
		vi.runOnlyPendingTimers();
		for (const request of server.pending.splice(0))
			request.resolve(Response.json({ errors: [{ message: "teardown" }] }));
		await microFlush();
		process.off("unhandledRejection", onUnhandled);
	}

	return violations;
}

/**
 * Turns prefix indexes into `invalidates` prefixes.
 *
 * @param inv - Indexes into `PREFIXES`
 * @returns The prefixes
 */
function invalidatedPrefixes(inv: number[]): string[][] {
	return inv.map(function (index) {
		return [...PREFIXES[index]!];
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Shrinking
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether a case still violates an invariant.
 *
 * @param testCase - The case
 * @param invariant - The invariant
 * @returns Whether it fails
 */
async function fails(testCase: Case, invariant: string): Promise<boolean> {
	const violations = await run(testCase);

	return violations.some(function (violation) {
		return violation.invariant === invariant;
	});
}

/**
 * Shrinks a failing case: deletes chunks of operations, tries a deterministic drain order and simplifies operations
 * while the same invariant still fails.
 *
 * @param testCase - The failing case
 * @param invariant - The violated invariant
 * @returns The minimal case found
 */
async function shrink(testCase: Case, invariant: string): Promise<Case> {
	let current = testCase;
	let chunk = Math.max(1, Math.floor(current.ops.length / 2));

	while (chunk >= 1) {
		let improved = false;

		for (let start = 0; start < current.ops.length;) {
			const candidate = { ...current, ops: [...current.ops.slice(0, start), ...current.ops.slice(start + chunk)] };

			if (candidate.ops.length < current.ops.length && (await fails(candidate, invariant))) {
				current = candidate;
				improved = true;
			} else {
				start += chunk;
			}
		}

		if (!improved) chunk = Math.floor(chunk / 2);
	}

	for (const drain of ["fifo", "lifo"] as const) {
		if ((current.drain ?? "random") === "random" && (await fails({ ...current, drain }, invariant))) {
			return shrink({ ...current, drain }, invariant);
		}
	}

	// Simplify individual operations (drop invalidates / errors / optimistic updates) when still failing.
	for (let i = 0; i < current.ops.length; i++) {
		const op = current.ops[i]!;
		const variants: Op[] = [];

		// Optimistic placeholders rely on their invalidates to reconcile (documented pattern): keep those.
		if (op.t === "add" && op.inv.length && op.opt !== "temp") variants.push({ ...op, inv: [] });
		if (op.t === "inc" && op.inv.length && !op.opt) variants.push({ ...op, inv: [] });
		if (op.t === "add" && op.opt === "exact") variants.push({ ...op, opt: "none" });
		if ((op.t === "deliver" || op.t === "process") && op.err) variants.push({ ...op, err: false });

		for (const variant of variants) {
			const ops = current.ops.slice();

			ops[i] = variant;

			if (await fails({ ...current, ops }, invariant)) {
				current = { ...current, ops };
				break;
			}
		}
	}

	return current;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------------------------------

interface Failure {
	invariant: string;
	/** First failing seed */
	seed: number;
	/** Number of failing seeds */
	seedsFailing: number;
	originalDetail: string;
	/** The shrunk sequence, described */
	minimal: string[];
	/** The violations of the shrunk sequence */
	observed: string[];
	/** The shrunk case, replayable with FUZZ_REPLAY */
	case: Case;
}

/**
 * Runs a seed range, then shrinks the first failing seed of each violated invariant.
 *
 * @param start - First seed
 * @param seeds - Number of seeds
 * @returns The shrunk failures and the number of failing seeds
 */
async function explore(start: number, seeds: number): Promise<{ failures: Failure[]; failingSeeds: number }> {
	const first = new Map<string, { seed: number; detail: string; count: number }>();
	let failingSeeds = 0;

	for (let seed = start; seed < start + seeds; seed++) {
		const violations = await run(generate(seed));

		if (violations.length) failingSeeds++;

		const seen = new Set<string>();

		for (const violation of violations) {
			// Count each seed once per invariant, remembering the first one.
			if (seen.has(violation.invariant)) continue;
			seen.add(violation.invariant);

			const known = first.get(violation.invariant);

			if (known) known.count++;
			else first.set(violation.invariant, { seed, detail: violation.detail, count: 1 });
		}
	}

	const failures: Failure[] = [];

	for (const [invariant, { seed, detail, count }] of first) {
		const minimal = await shrink(generate(seed), invariant);
		const observed = (await run(minimal))
			.filter(function (violation) {
				return violation.invariant === invariant;
			})
			.map(function (violation) {
				return violation.detail;
			});
		const steps = minimal.ops.map(function (op) {
			return describeOp(op, minimal.slots);
		});

		steps.push(`final drain order: ${minimal.drain ?? "random"}`);
		failures.push({
			invariant,
			seed,
			seedsFailing: count,
			originalDetail: detail,
			minimal: steps,
			observed,
			case: minimal,
		});
	}

	return { failures, failingSeeds };
}

/**
 * Formats shrunk failures for the assertion message.
 *
 * @param failures - The failures
 * @returns A readable report
 */
function formatFailures(failures: Failure[]): string {
	return failures
		.map(function (failure) {
			return [
				`=== ${failure.invariant}  (first seed ${failure.seed}, ${failure.seedsFailing} failing seed(s); rerun with FUZZ_SEED=${failure.seed})`,
				...failure.minimal.map(function (step) {
					return `   ${step}`;
				}),
				...failure.observed.map(function (detail) {
					return `   -> ${detail}`;
				}),
			].join("\n");
		})
		.join("\n\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------------------------------------------------

describe("model-based fuzzing", function () {
	it(
		"keeps cache, live queries, optimistic layers and snapshots consistent",
		async function () {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

			try {
				if (env.FUZZ_REPLAY) {
					const [file, index] = env.FUZZ_REPLAY.split(":");
					const { readFileSync } = await import("node:fs");
					const entry = JSON.parse(readFileSync(file!, "utf8")).report[Number(index ?? 0)] as Failure;

					console.log(`replaying ${entry.invariant} (seed ${entry.seed})`);
					const violations = await run(entry.case, true);

					expect(violations).toEqual([]);
					return;
				}

				if (SINGLE !== undefined) {
					const violations = await run(generate(SINGLE), true);

					expect(violations).toEqual([]);
					return;
				}

				const { failures, failingSeeds } = await explore(START, SEEDS);
				const report = formatFailures(failures);

				console.log(
					`${SEEDS} seeds (from ${START}) x ${OPS} ops${OFF.size ? `, off: ${[...OFF].join(",")}` : ""}: ${failingSeeds} failing seed(s)`,
				);

				if (env.FUZZ_REPORT) {
					const { writeFileSync } = await import("node:fs");

					writeFileSync(
						env.FUZZ_REPORT,
						JSON.stringify(
							{ seeds: SEEDS, start: START, ops: OPS, off: [...OFF], failingSeeds, report: failures },
							null,
							2,
						),
					);
				}

				expect(failures.length, `invariant violations:\n\n${report}\n`).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
		60 * 60_000,
	);
});
