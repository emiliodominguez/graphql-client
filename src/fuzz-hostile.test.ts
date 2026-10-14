import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { optimistic } from "./optimistic";
import type { QueryRef } from "./query-ref";
import type { Cache, FetchPolicy, Middleware, OperationContext, QueryState } from "./types";
import { createCacheKey } from "./utils";

/**
 * Seeded, model-based fuzzer for HOSTILE environments (complements src/fuzz.test.ts, which uses a sync MemoryCache).
 *
 * - The cache is ASYNC: every get / set / delete / keys call is parked. The fuzzer decides when each call takes
 *   effect (its linearization point, "apply") and, separately, when its promise settles ("resolve"), so calls resolve
 *   out of order. Apply order is either FIFO (like IndexedDB / a single Redis connection) or arbitrary. Calls can
 *   fail (rejection, or a synchronous throw) at a configurable rate. Reads can return structured clones (IndexedDB).
 * - The network is parked too: the server processes a request (applies a mutation / computes a response) and the
 *   response is delivered later, possibly as a GraphQL error, an HTTP 500 or a network failure (even after the server
 *   applied a mutation). Calls carry timeouts and abort signals; clients may have a default timeout and retries.
 *   Timers (timeouts, retry backoff, deferred deactivation) are faked and advanced explicitly.
 * - Operations: gql with every fetch policy, mutations with optimistic updates and `invalidates`, write, restore,
 *   invalidate (prefix hierarchy), watch subscribe / unsubscribe / refetch / fetchMore, aborts, time advances,
 *   cache steps and network steps. Two clients share the cache through `extend()`.
 *
 * After the sequence the system is drained to quiescence (every parked call settled, timers flushed, every promise
 * settled; no new faults are injected while draining) and the invariants of `checkQuiescent` / `checkConvergence` /
 * `checkLeaks` / `checkSnapshot` are checked. Failing sequences are shrunk and reported.
 *
 * Invariants: I0 only known cache keys; I1/I1b after a fault-free refetch, live queries and cache equal the server;
 * I2/I2b/I2c no rolled-back, placeholder or unknown data in the cache or active live queries; I3/I3b extract() equals
 * the cache, restore(extract()) round-trips; I4/I4b/I4c/I4d no live query stuck loading, every promise settles, the
 * system quiesces, no unhandled rejection; I5 an active (non no-cache, non errored) live query equals its cache entry;
 * I6 the cache never holds data older than the last successful invalidation of its entry; I7/I7b a successful write /
 * restore / fetchMore merge newer than the last invalidation is neither lost nor overwritten by older data; I8/I8b gql
 * results and live-query data are deeply frozen; I9/I9b/I9c no leaked in-flight entry (a new identical request goes to
 * the network), optimistic layer (a write reads back as-is) or watcher (invalidate() with nobody subscribed fetches
 * nothing); I10 a synchronously throwing cache never makes watch()/subscribe() throw.
 *
 * Relaxations (injected faults): when the last set/delete the library issued for an entry failed, or an invalidation
 * covering it rejected, the entry may legitimately hold anything (I2, I3, I5, I7 are skipped for it until a later
 * cache write to it succeeds); an invalidation counts for I6 only once it fully succeeded, and any attempted
 * invalidation (even a failed one) exempts earlier writes from I7; a live query whose last fetch failed is checked
 * leniently (placeholders of successful mutations tolerated, rolled-back data not); I1 runs with faults disabled.
 *
 *   HFUZZ_SEEDS=2000  number of seeds       HFUZZ_START=1   first seed       HFUZZ_OPS=60  operations per sequence
 *   HFUZZ_SEED=123    run one seed with a trace
 *   HFUZZ_OFF=reorder,failures,clone,timeouts,retry,aborts,restore,client2,fetchMore,optimistic,netErrors,frozen
 *                     disable features / invariant families (to look past a dominant bug)
 *   HFUZZ_ON=failGet,sync   also make cache reads fail / use a synchronous cache
 *   HFUZZ_ONLY=I4,I9  only report invariants starting with these prefixes
 *   HFUZZ_DETERMINISM=1   run every seed twice (another run in between) and report any difference
 *   HFUZZ_NOSHRINK=1  report the first failing seed of each invariant without shrinking
 *   HFUZZ_REPORT=/path.json   write shrunk failures      HFUZZ_REPLAY=/path.json:<index>   replay one with a trace
 */

// ---------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------

const env = process.env;
const SEEDS = Number(env.HFUZZ_SEEDS ?? 300);
const START = Number(env.HFUZZ_START ?? 1);
const OPS = Number(env.HFUZZ_OPS ?? 60);
const SINGLE = env.HFUZZ_SEED === undefined ? undefined : Number(env.HFUZZ_SEED);
const OFF = new Set((env.HFUZZ_OFF ?? "").split(",").filter(Boolean));
const ON = new Set((env.HFUZZ_ON ?? "").split(",").filter(Boolean));
/** Only report invariants whose name starts with one of these prefixes (e.g. "I4,I9") */
const ONLY = (env.HFUZZ_ONLY ?? "").split(",").filter(Boolean);
const URL = "https://hostile.test/graphql";

// ---------------------------------------------------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------------------------------------------------

interface Rng {
	(): number;
	int(n: number): number;
	pick<T>(items: readonly T[]): T;
	chance(p: number): boolean;
}

/**
 * Creates a seeded mulberry32 generator with helpers.
 *
 * @param seed - The seed
 * @returns The generator
 */
function createRng(seed: number): Rng {
	let a = seed >>> 0;
	const next = function next(): number {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	} as Rng;

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
const PREFIXES: ReadonlyArray<readonly string[]> = [[], ["todos"], ["todos", "size"], ["count"]];

/**
 * Builds the options of a query on a target.
 *
 * @param target - The target index
 * @returns Fresh options
 */
function targetOptions(target: number) {
	const { key, query, variables } = TARGETS[target]!;

	return { key: [...key], query, ...(variables ? { variables } : {}) };
}

/**
 * Whether invalidating `prefix` drops a target.
 *
 * @param target - The target index
 * @param prefix - The prefix
 * @returns Whether it matches
 */
function matchesPrefix(target: number, prefix: readonly unknown[]): boolean {
	const key = TARGETS[target]!.key;

	return (
		prefix.length <= key.length &&
		prefix.every(function (segment, i) {
			return key[i] === segment;
		})
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------------------------------

type NetMode = "process" | "ok" | "gqlerr" | "http500" | "neterr";

interface Slot {
	target: number;
	policy: FetchPolicy;
	client: number;
}

type Op =
	| { t: "query"; id: number; c: number; target: number; policy: FetchPolicy; timeout?: number; abortable: boolean }
	| {
			t: "add";
			id: number;
			c: number;
			fail: boolean;
			opt: "none" | "exact" | "temp";
			inv: number[];
			abortable: boolean;
	  }
	| { t: "inc"; id: number; c: number; fail: boolean; opt: boolean; inv: number[]; abortable: boolean }
	| { t: "write"; id: number; c: number; target: number }
	| { t: "restore"; id: number; c: number; target: number }
	| { t: "invalidate"; id: number; c: number; prefix: number }
	| { t: "sub"; id: number; w: number }
	| { t: "unsub"; id: number; w: number }
	| { t: "refetch"; id: number; w: number }
	| { t: "fetchMore"; id: number; w: number }
	| { t: "cache"; id: number; r: number; resolve: boolean }
	| { t: "net"; id: number; r: number; mode: NetMode }
	| { t: "abort"; id: number; r: number }
	| { t: "advance"; id: number; ms: number };

interface Flags {
	/** Cache calls take effect in call order (only their resolution is reordered) */
	fifo: boolean;
	/** Cache calls also resolve in call order (the most benign async cache) */
	ordered?: boolean;
	/** Probability that a set / delete / keys call fails */
	failRate: number;
	/** Fraction of failures thrown synchronously instead of rejected */
	syncThrow: number;
	/** Reads return structured clones (IndexedDB-like) */
	clone: boolean;
	/** Default timeout of client2 */
	clientTimeout: number | undefined;
	/** Client-level retries */
	retry: boolean;
	/** Cache reads fail too */
	failGet: boolean;
	/** The cache is synchronous (MemoryCache-like): isolates bugs that need no async adapter */
	sync?: boolean;
}

interface Case {
	seed: number;
	flags: Flags;
	slots: Slot[];
	ops: Op[];
	drain?: "random" | "fifo" | "lifo";
}

/**
 * Generates a case from a seed.
 *
 * @param seed - The seed
 * @param count - Number of operations
 * @returns The case
 */
function generate(seed: number, count = OPS): Case {
	const rng = createRng(seed);
	const clients = OFF.has("client2") ? 1 : 2;
	const policies: FetchPolicy[] = [
		"cache-first",
		"cache-first",
		"network-only",
		"cache-and-network",
		"no-cache",
		"cache-only",
	];
	const flags: Flags = {
		fifo: OFF.has("reorder") ? true : rng.chance(0.5),
		ordered: OFF.has("reorder"),
		failRate: OFF.has("failures") ? 0 : rng.pick([0, 0.05, 0.15, 0.3]),
		syncThrow: rng.pick([0, 0.3]),
		clone: OFF.has("clone") ? false : rng.chance(0.35),
		clientTimeout: OFF.has("timeouts") ? undefined : rng.pick([undefined, undefined, 30]),
		retry: OFF.has("retry") ? false : rng.chance(0.4),
		failGet: ON.has("failGet"),
		sync: ON.has("sync"),
	};
	const slots: Slot[] = [];

	for (let i = 0; i < 4; i++) {
		slots.push({
			target: rng.chance(0.6) ? 0 : rng.int(3),
			policy: rng.pick(policies.slice(0, 5)),
			client: rng.int(clients),
		});
	}

	const weights: Array<[Op["t"], number]> = [
		["sub", 10],
		["unsub", 6],
		["refetch", 5],
		["fetchMore", OFF.has("fetchMore") ? 0 : 3],
		["query", 10],
		["add", OFF.has("optimistic") ? 4 : 8],
		["inc", 4],
		["write", 4],
		["restore", OFF.has("restore") ? 0 : 2],
		["invalidate", 7],
		["cache", 30],
		["net", 18],
		["abort", OFF.has("aborts") ? 0 : 2],
		["advance", 5],
	];
	let total = 0;

	for (const [, weight] of weights) total += weight;

	/**
	 * Picks the prefixes a mutation invalidates.
	 *
	 * @returns Prefix indexes
	 */
	function invalidates(): number[] {
		const out: number[] = [];

		if (rng.chance(0.3)) out.push(1);
		if (rng.chance(0.15)) out.push(rng.int(PREFIXES.length));

		return out;
	}

	const ops: Op[] = [];
	const netModes: NetMode[] = OFF.has("netErrors")
		? ["process", "ok", "ok", "ok"]
		: ["process", "ok", "ok", "ok", "ok", "gqlerr", "http500", "neterr"];

	for (let id = 0; id < count; id++) {
		let roll = rng() * total;
		let type: Op["t"] = "advance";

		for (const [candidate, weight] of weights) {
			roll -= weight;
			if (roll < 0) {
				type = candidate;
				break;
			}
		}

		const c = rng.int(clients);
		const abortable = !OFF.has("aborts") && rng.chance(0.15);

		switch (type) {
			case "query": {
				const timeout = OFF.has("timeouts") ? undefined : rng.chance(0.15) ? rng.pick([10, 40]) : undefined;

				ops.push({
					t: type,
					id,
					c,
					target: rng.int(3),
					policy: rng.pick(policies),
					...(timeout === undefined ? {} : { timeout }),
					abortable,
				});
				break;
			}
			case "add": {
				const opt = OFF.has("optimistic") ? "none" : rng.pick(["none", "exact", "exact", "temp"] as const);
				const inv = invalidates();

				if (
					opt === "temp" &&
					!inv.some(function (prefix) {
						return prefix <= 1;
					})
				) {
					inv.push(1);
				}
				ops.push({ t: type, id, c, fail: rng.chance(0.3), opt, inv, abortable });
				break;
			}
			case "inc": {
				const opt = !OFF.has("optimistic") && rng.chance(0.6);
				const inv = invalidates();

				if (
					opt &&
					!inv.some(function (prefix) {
						return prefix === 0 || prefix === 3;
					})
				) {
					inv.push(3);
				}
				ops.push({ t: type, id, c, fail: rng.chance(0.3), opt, inv, abortable });
				break;
			}
			case "write":
			case "restore":
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
			case "cache":
				ops.push({ t: type, id, r: rng.int(1000), resolve: rng.chance(0.6) });
				break;
			case "net":
				ops.push({ t: type, id, r: rng.int(1000), mode: rng.pick(netModes) });
				break;
			case "abort":
				ops.push({ t: type, id, r: rng.int(1000) });
				break;
			default:
				ops.push({ t: "advance", id, ms: rng.pick([0, 0, 5, 15, 45]) });
		}
	}

	return { seed, flags, slots, ops };
}

/**
 * Names a client.
 *
 * @param c - Client index
 * @returns The name
 */
function clientName(c: number): string {
	return c ? "client2" : "client1";
}

/**
 * Formats prefixes.
 *
 * @param inv - Prefix indexes
 * @returns JSON
 */
function prefixList(inv: number[]): string {
	return JSON.stringify(
		inv.map(function (index) {
			return PREFIXES[index];
		}),
	);
}

/**
 * The title an `add` sends ("boom…" is rejected by the server).
 *
 * @param op - The op
 * @returns The title
 */
function title(op: { id: number; fail: boolean }): string {
	return op.fail ? `boom${op.id}` : `t${op.id}`;
}

/**
 * Describes an operation.
 *
 * @param op - The op
 * @param slots - The slots
 * @returns Description
 */
function describeOp(op: Op, slots: Slot[]): string {
	switch (op.t) {
		case "query":
			return `${clientName(op.c)}.gql(${TARGET_NAMES[op.target]}, ${op.policy}${op.timeout ? `, timeout ${op.timeout}` : ""}${op.abortable ? ", signal" : ""})`;
		case "add":
			return `${clientName(op.c)}.gql(Add "${title(op)}"${op.fail ? " [server rejects]" : ""}, optimistic=${op.opt}, invalidates=${prefixList(op.inv)}${op.abortable ? ", signal" : ""})`;
		case "inc":
			return `${clientName(op.c)}.gql(Inc${op.fail ? " [server rejects]" : ""}, optimistic=${op.opt ? "count+1" : "none"}, invalidates=${prefixList(op.inv)}${op.abortable ? ", signal" : ""})`;
		case "write":
			return `${clientName(op.c)}.write(${TARGET_NAMES[op.target]}, <server truth>)`;
		case "restore":
			return `${clientName(op.c)}.restore({ ${TARGET_NAMES[op.target]}: <server truth> })`;
		case "invalidate":
			return `${clientName(op.c)}.invalidate(${JSON.stringify(PREFIXES[op.prefix])})`;
		case "sub":
		case "unsub":
		case "refetch":
		case "fetchMore": {
			const slot = slots[op.w]!;

			return `W${op.w}.${op.t}()   [W${op.w} = ${clientName(slot.client)}.watch(${TARGET_NAMES[slot.target]}, ${slot.policy})]`;
		}
		case "cache":
			return `cache: ${op.resolve ? "apply+resolve" : "apply (or resolve if applied)"} pending[${op.r} % n]`;
		case "net":
			return `net: ${op.mode} pending[${op.r} % n]`;
		case "abort":
			return `abort controller[${op.r} % n]`;
		case "advance":
			return `advance ${op.ms}ms`;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Hostile async cache
// ---------------------------------------------------------------------------------------------------------------------

/** Promises handed to the library -> the cache call they come from (to name unhandled rejections) */
const callOf = new WeakMap<Promise<unknown>, string>();

type CacheKind = "get" | "set" | "delete" | "keys" | "clear";

interface CacheCall {
	seq: number;
	kind: CacheKind;
	key: string | undefined;
	value: unknown;
	fail: boolean;
	applied: boolean;
	/** A delete dropping an entry whose write just failed (part of that failed write, not a new intent) */
	compensating: boolean;
	result: unknown;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/**
 * Async cache with parked calls, out-of-order resolution and injected failures.
 */
class HostileCache implements Cache {
	readonly store = new Map<string, unknown>();
	readonly pending: CacheCall[] = [];
	/** Per key: whether the last set/delete that reached its linearization point failed (the library's intent lost) */
	readonly lastWriteFailed = new Map<string, boolean>();
	/** Per key: harness event of the last failed set/delete (a failed write may lose any earlier write for good) */
	readonly failedAt = new Map<string, number>();
	/** Harness clock, set by the harness */
	clock: () => number = function noClock() {
		return 0;
	};
	/** Whether faults are injected for new calls */
	faults = true;
	/** Calls apply and resolve immediately (used by the checks) */
	immediate = false;
	failures = 0;
	#seq = 0;
	readonly #rng: Rng;
	readonly #flags: Flags;
	readonly #log: ((line: string) => void) | undefined;

	/**
	 * @param rng - Runtime randomness (fault decisions)
	 * @param flags - The case flags
	 * @param log - Trace logger
	 */
	constructor(rng: Rng, flags: Flags, log?: (line: string) => void) {
		this.#rng = rng;
		this.#flags = flags;
		this.#log = log;
	}

	/**
	 * Parks a call.
	 *
	 * @param kind - The call
	 * @param key - The key
	 * @param value - The value (set)
	 * @returns The promise
	 */
	#call(kind: CacheKind, key?: string, value?: unknown): Promise<unknown> {
		const fallible = kind !== "get" || this.#flags.failGet;
		const fail = this.faults && fallible && this.#flags.failRate > 0 && this.#rng.chance(this.#flags.failRate);

		if (fail && this.#rng.chance(this.#flags.syncThrow)) {
			// A synchronous throw: the call never takes effect.
			this.failures++;
			if (key !== undefined && (kind === "set" || kind === "delete")) {
				this.lastWriteFailed.set(key, true);
				this.failedAt.set(key, this.clock());
			}
			this.#log?.(`      cache ${kind}(${shortKey(key)}) THROWS synchronously`);
			throw new Error(`cache ${kind} threw`);
		}

		const cache = this;
		const compensating = kind === "delete" && /#put/.test(new Error().stack ?? "");
		const call = {
			seq: ++this.#seq,
			kind,
			key,
			value,
			fail,
			applied: false,
			compensating,
			result: undefined,
		} as CacheCall;
		const promise = new Promise<unknown>(function (resolve, reject) {
			call.resolve = resolve;
			call.reject = reject;
		});

		if (this.#log) {
			this.#log(
				`      cache #${call.seq} ${kind}(${shortKey(key)}${kind === "set" ? ` = ${JSON.stringify(value)}` : ""}) issued${fail ? " [will fail]" : ""}  <- ${caller()}`,
			);
		}

		if (this.#flags.sync) {
			this.#apply(call);
			if (fail) throw new Error(`cache ${kind} failed`);
			return (
				this.#flags.clone && kind === "get" && call.result !== undefined ? structuredClone(call.result) : call.result
			) as Promise<unknown>;
		}

		if (this.immediate) {
			this.#apply(call);
			this.#settle(call);
		} else {
			this.pending.push(call);
		}

		const delivered = promise.then(function (result) {
			return cache.#flags.clone && kind === "get" && result !== undefined ? structuredClone(result) : result;
		});

		callOf.set(delivered, `cache #${call.seq} ${kind}(${shortKey(key)})`);

		return delivered;
	}

	/**
	 * Applies a call (its linearization point).
	 *
	 * @param call - The call
	 */
	#apply(call: CacheCall): void {
		call.applied = true;

		if (call.fail) {
			this.failures++;
			if (call.key !== undefined && (call.kind === "set" || call.kind === "delete")) {
				this.lastWriteFailed.set(call.key, true);
				this.failedAt.set(call.key, this.clock());
			}
			return;
		}

		switch (call.kind) {
			case "get":
				call.result = this.store.get(call.key!);
				break;
			case "set":
				this.store.set(call.key!, call.value);
				this.lastWriteFailed.set(call.key!, false);
				break;
			case "delete":
				call.result = this.store.delete(call.key!);
				if (!call.compensating) this.lastWriteFailed.set(call.key!, false);
				break;
			case "keys":
				call.result = [...this.store.keys()];
				break;
			case "clear":
				this.store.clear();
				break;
		}
	}

	/**
	 * Settles a call's promise.
	 *
	 * @param call - The call
	 */
	#settle(call: CacheCall): void {
		if (call.fail) call.reject(new Error(`cache ${call.kind} failed`));
		else call.resolve(call.result);
	}

	/**
	 * Advances a parked call: applies it (FIFO mode: applies every older unapplied call first), and resolves it when
	 * asked or when it was already applied.
	 *
	 * @param r - Selects the call
	 * @param resolve - Also resolve it
	 */
	step(r: number, resolve: boolean): void {
		if (!this.pending.length) return;

		const index = r % this.pending.length;
		const call = this.pending[index]!;
		const wasApplied = call.applied;

		if (!call.applied) {
			if (this.#flags.fifo) {
				for (const older of this.pending) {
					if (older.seq >= call.seq) break;
					if (!older.applied) {
						this.#apply(older);
						this.#log?.(`      cache #${older.seq} ${older.kind}(${shortKey(older.key)}) applied (fifo)`);
					}
				}
			}
			this.#apply(call);
			this.#log?.(`      cache #${call.seq} ${call.kind}(${shortKey(call.key)}) applied`);
		}

		if (resolve || wasApplied) {
			if (this.#flags.ordered) {
				// Resolve every older call first (applying it if needed: FIFO).
				for (const older of this.pending.slice()) {
					if (older.seq >= call.seq) break;
					if (!older.applied) this.#apply(older);
					this.pending.splice(this.pending.indexOf(older), 1);
					this.#log?.(`      cache #${older.seq} ${older.kind}(${shortKey(older.key)}) resolved (ordered)`);
					this.#settle(older);
				}
			}
			this.pending.splice(this.pending.indexOf(call), 1);
			this.#log?.(`      cache #${call.seq} ${call.kind}(${shortKey(call.key)}) resolved`);
			this.#settle(call);
		}
	}

	get<T>(key: string): Promise<T | undefined> {
		return this.#call("get", key) as Promise<T | undefined>;
	}

	set<T>(key: string, value: T): Promise<void> {
		return this.#call("set", key, value) as Promise<void>;
	}

	delete(key: string): Promise<unknown> {
		return this.#call("delete", key);
	}

	clear(): Promise<void> {
		return this.#call("clear") as Promise<void>;
	}

	keys(): Promise<Iterable<string>> {
		return this.#call("keys") as Promise<Iterable<string>>;
	}
}

/**
 * The library frames that issued a cache call (trace mode only).
 *
 * @returns e.g. "client.ts:870 #store"
 */
function caller(): string {
	const frames = (new Error().stack ?? "").split("\n").filter(function (line) {
		return /src\/(client|query-ref)\.ts/.test(line);
	});

	return frames
		.slice(0, 2)
		.map(function (line) {
			const match = /at (?:async )?(\S+) .*\/(\w[\w-]*\.ts):(\d+)/.exec(line);

			return match ? `${match[2]}:${match[3]} ${match[1]}` : line.trim();
		})
		.join(" < ");
}

/**
 * Short name of a cache key for traces.
 *
 * @param key - The key
 * @returns Its target name
 */
function shortKey(key: string | undefined): string {
	if (key === undefined) return "";
	const index = TARGET_KEYS.indexOf(key);

	return index === -1 ? key.slice(0, 30) : TARGET_NAMES[index]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------------------------------------------------

interface PendingRequest {
	seq: number;
	evt: number;
	query: string;
	variables: Record<string, unknown> | undefined;
	attempt: number;
	/** Kept alive: undici links a Request's signal to its source through a WeakRef, so a collected request would stop
	 * receiving aborts (GC-dependent, nondeterministic behavior). */
	request: Request;
	resolve(response: Response): void;
	reject(error: unknown): void;
	processed?: { status: number; body: unknown };
}

/**
 * Authoritative server: requests are parked until the fuzzer processes / delivers them.
 */
class FakeServer {
	todos: string[] = ["a"];
	count = 0;
	served = 0;
	requests = 0;
	pending: PendingRequest[] = [];
	servedAt = new Map<string, number>();
	/** Context of the request being sent (stashed by the middleware, read synchronously by fetch) */
	context: OperationContext | undefined;
	readonly fetch: typeof fetch;
	readonly middleware: Middleware;
	readonly #events: () => number;

	/**
	 * @param events - The logical clock
	 */
	constructor(events: () => number) {
		const server = this;

		this.#events = events;
		this.fetch = function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			// Accept both calling conventions: fetch(request) and fetch(url, init).
			const request = input instanceof Request ? input : new Request(input, init);

			return server.#receive(request, init?.signal ?? request.signal);
		} as typeof fetch;
		this.middleware = function stash(request, next, context) {
			server.context = context;
			return next(request);
		};
	}

	/**
	 * Parks a request.
	 *
	 * @param request - The request
	 * @returns The response once delivered
	 */
	#receive(request: Request, signal: AbortSignal): Promise<Response> {
		const context = this.context!;

		this.context = undefined;

		if (signal.aborted) return Promise.reject(signal.reason);

		const evt = this.#events();
		const pending = this.pending;
		const seq = this.requests++;

		return new Promise<Response>(function (resolve, reject) {
			const entry: PendingRequest = {
				seq,
				evt,
				query: context.query,
				variables: context.variables as Record<string, unknown> | undefined,
				attempt: context.attempt,
				request,
				resolve,
				reject,
			};

			pending.push(entry);
			signal.addEventListener(
				"abort",
				function () {
					const index = pending.indexOf(entry);

					if (index !== -1) pending.splice(index, 1);
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	}

	/**
	 * Current data of a target (without `served`).
	 *
	 * @param target - Target index
	 * @returns Data
	 */
	truth(target: number): Record<string, unknown> {
		if (target === 0) return { todos: [...this.todos] };
		if (target === 1) return { size: this.todos.length };

		return { count: this.count };
	}

	/**
	 * Processes a request once.
	 *
	 * @param request - The request
	 * @param fail - Whether a query fails / an unprocessed mutation is rejected without being applied
	 */
	process(request: PendingRequest, fail: boolean): void {
		if (request.processed) return;

		const { query, variables } = request;

		if (fail) {
			request.processed = { status: 200, body: { errors: [{ message: "failed" }] } };
			return;
		}

		if (query.startsWith("mutation Add")) {
			const name = String(variables?.title);

			if (name.startsWith("boom")) {
				request.processed = { status: 200, body: { errors: [{ message: "rejected" }] } };
			} else {
				if (!this.todos.includes(name)) this.todos.push(name);
				request.processed = { status: 200, body: { data: { add: true } } };
			}
			return;
		}

		if (query.startsWith("mutation Inc")) {
			request.processed = variables?.fail
				? { status: 200, body: { errors: [{ message: "rejected" }] } }
				: { status: 200, body: { data: { inc: ++this.count } } };
			return;
		}

		const served = `s${++this.served}`;

		this.servedAt.set(served, request.evt);

		if (query.startsWith("query Todos")) {
			request.processed = { status: 200, body: { data: { todos: [...this.todos], served } } };
		} else if (query.startsWith("query Size")) {
			request.processed = { status: 200, body: { data: { size: this.todos.length, served } } };
		} else {
			request.processed = { status: 200, body: { data: { count: this.count, served } } };
		}
	}

	/**
	 * Steps a request.
	 *
	 * @param index - Index in `pending`
	 * @param mode - What happens
	 */
	step(index: number, mode: NetMode): void {
		const request = this.pending[index];

		if (!request) return;

		if (mode === "process") {
			this.process(request, false);
			return;
		}

		this.pending.splice(index, 1);

		if (mode === "neterr") {
			// The connection drops; a processed mutation stays applied on the server.
			request.reject(new TypeError("fetch failed"));
			return;
		}

		if (mode === "http500" && !request.processed) {
			request.resolve(new Response("Internal Server Error", { status: 500 }));
			return;
		}

		this.process(request, mode === "gqlerr");
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

class Abort extends Error {}

/**
 * Lets pending promises settle (setImmediate is not faked).
 */
async function microFlush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise<void>(function (resolve) {
			setImmediate(resolve);
		});
	}
}

/**
 * Drops `served`.
 *
 * @param value - Data
 * @returns Data without `served`
 */
function strip(value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { served: _served, ...rest } = value as Record<string, unknown>;

		return rest;
	}

	return value;
}

/**
 * JSON equality.
 *
 * @param a - A value
 * @param b - Another
 * @returns Equal
 */
function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a value is deeply frozen.
 *
 * @param value - The value
 * @returns Frozen
 */
function deepFrozen(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	if (!Object.isFrozen(value)) return false;

	return Object.values(value).every(deepFrozen);
}

/**
 * Runs a case.
 *
 * @param testCase - The case
 * @param trace - Log the steps
 * @returns Violations
 */
async function run(testCase: Case, trace = false): Promise<Violation[]> {
	const violations: Violation[] = [];
	const { flags } = testCase;
	const runtime = createRng(testCase.seed ^ 0x5bd1e995);
	const drainRng = createRng(testCase.seed ^ 0x9e3779b9);
	let evt = 0;
	const log = trace
		? function (line: string): void {
				console.log(line);
			}
		: undefined;
	const server = new FakeServer(function () {
		return ++evt;
	});
	const cache = new HostileCache(runtime, flags, log);

	cache.clock = function now() {
		return evt;
	};
	const errors: unknown[] = [];
	const client1 = new Client({
		url: URL,
		fetch: server.fetch,
		cache,
		middleware: [server.middleware],
		onError: function (error) {
			errors.push(error);
		},
		...(flags.retry ? { retry: { attempts: 1, delay: 10 } } : {}),
	});
	const client2 = OFF.has("client2") ? client1 : client1.extend({ timeout: flags.clientTimeout });
	const clients = [client1, client2];
	/** Last effective invalidation per target (event) */
	const invalidatedAt = [0, 0, 0];
	/** Last invalidation per target, successful or not (a failing one may still have dropped entries) */
	const attemptedInvalidationAt = [0, 0, 0];
	/** Per target: event of the last invalidation that failed (the client could not refresh the entry) */
	const failedInvalidationAt = [0, 0, 0];
	/** Newest successful write / restore / merge per target (event) */
	const writtenAt = [0, 0, 0];
	/** Data id -> event (writes `w`, restores `r`, merges `m`) */
	const madeAt = new Map<string, number>();
	let made = 0;
	const unhandled: unknown[] = [];
	const refs: Array<QueryRef<unknown> | undefined> = [];
	const listeners: Array<Array<() => void>> = testCase.slots.map(function () {
		return [];
	});
	const controllers: AbortController[] = [];
	let outstanding = 0;

	/**
	 * @param reason - Unhandled rejection
	 */
	function onUnhandled(reason: unknown, promise: Promise<unknown>): void {
		unhandled.push(`${String(reason)} (from ${callOf.get(promise) ?? "a library promise"})`);
		log?.(`      !! unhandled rejection: ${String(reason)} (from ${callOf.get(promise) ?? "a library promise"})`);
	}

	process.on("unhandledRejection", onUnhandled);

	for (const client of new Set(clients)) {
		const original = client.invalidate.bind(client);

		client.invalidate = function invalidate(prefix = []) {
			const at = ++evt;
			const promise = original(prefix);

			for (let target = 0; target < TARGETS.length; target++) {
				if (matchesPrefix(target, prefix as string[])) attemptedInvalidationAt[target] = at;
			}

			// Only an invalidation that fully succeeded is guaranteed to have dropped its entries.
			promise.then(
				function () {
					for (let target = 0; target < TARGETS.length; target++) {
						if (matchesPrefix(target, prefix as string[]) && invalidatedAt[target]! < at) {
							invalidatedAt[target] = at;
						}
					}
				},
				function () {
					// The invalidation failed (keys() or a delete rejected): its deletes may be lost. Like a failed set, this
					// relaxes the checks on those entries until a later cache write to them succeeds.
					for (let target = 0; target < TARGETS.length; target++) {
						if (matchesPrefix(target, prefix as string[])) {
							cache.lastWriteFailed.set(TARGET_KEYS[target]!, true);
							if (failedInvalidationAt[target]! < at) failedInvalidationAt[target] = at;
						}
					}
				},
			);

			return promise;
		};
	}

	/**
	 * Counts a promise until it settles; checks results are frozen.
	 *
	 * @param promise - The promise
	 * @param what - Description
	 * @returns The promise
	 */
	function track<T>(promise: Promise<T>, what: string): Promise<T> {
		outstanding++;
		promise.then(
			function (value) {
				outstanding--;
				if (!OFF.has("frozen") && what.startsWith("gql") && !deepFrozen(value)) {
					violations.push({
						invariant: "I8 gql result not frozen",
						detail: `${what} resolved with a mutable result ${JSON.stringify(value)}`,
					});
				}
			},
			function () {
				outstanding--;
			},
		);

		return promise;
	}

	/**
	 * A signal for an abortable call.
	 *
	 * @param abortable - Whether the call is abortable
	 * @returns Options
	 */
	function signal(abortable: boolean): { signal?: AbortSignal } {
		if (!abortable) return {};
		const controller = new AbortController();

		controllers.push(controller);

		return { signal: controller.signal };
	}

	/**
	 * Gets / creates a slot's live query.
	 *
	 * @param w - Slot
	 * @returns The ref
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
	 * Active live queries.
	 *
	 * @returns The active refs
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
	 * Logs state.
	 *
	 * @param prefix - Line prefix
	 */
	function logState(prefix: string): void {
		for (const { w, r } of activeRefs()) console.log(`${prefix}W${w} -> ${JSON.stringify(r.getState())}`);
		console.log(
			`${prefix}store: ${JSON.stringify(
				TARGET_KEYS.map(function (key) {
					return cache.store.get(key);
				}),
			)} cachePending=${cache.pending.length} netPending=${server.pending.length} server=${JSON.stringify(server.todos)} count=${server.count} t=${Date.now()}`,
		);
	}

	/**
	 * Merges a fetched page, stamping the merged data as a new write.
	 *
	 * @param target - Target
	 * @returns The merge function
	 */
	function merge(target: number) {
		return function mergePages(previous: unknown, next: unknown): unknown {
			const id = `m${++made}`;
			const pageAt = orderOf((next as { served?: string }).served);
			const baseAt = orderOf((previous as { served?: string } | undefined)?.served);

			// Merged pages are as fresh as the newest of their parts: a request started after both arrived (e.g. a
			// refetch) legitimately supersedes them, whenever the merge itself runs.
			madeAt.set(id, pageAt === undefined && baseAt === undefined ? ++evt : Math.max(pageAt ?? 0, baseAt ?? 0));

			if (target !== 0) return { ...(next as object), served: id };

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
				served: id,
			};
		};
	}

	/**
	 * Advances fake time millisecond by millisecond, letting promises settle in between.
	 *
	 * @param ms - Milliseconds
	 */
	async function advance(ms: number): Promise<void> {
		vi.advanceTimersByTime(0);
		await microFlush();

		for (let i = 0; i < ms; i++) {
			if (vi.getTimerCount() === 0) break;
			vi.advanceTimersByTime(1);
			await microFlush();
		}
	}

	/**
	 * Executes an op.
	 *
	 * @param op - The op
	 */
	async function execute(op: Op): Promise<void> {
		switch (op.t) {
			case "query":
				track(
					clients[op.c]!.gql({
						...targetOptions(op.target),
						fetchPolicy: op.policy,
						...(op.timeout === undefined ? {} : { timeout: op.timeout }),
						...signal(op.abortable),
					}),
					`gql #${op.id}`,
				);
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
						...signal(op.abortable),
					}),
					`gql #${op.id}`,
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
						...signal(op.abortable),
					}),
					`gql #${op.id}`,
				);
				break;
			}
			case "write": {
				const id = `w${++made}`;
				const at = ++evt;
				const target = op.target;

				madeAt.set(id, at);
				let promise: Promise<void>;

				try {
					promise = clients[op.c]!.write(targetOptions(target), { ...server.truth(target), served: id });
				} catch (error) {
					promise = Promise.reject(error);
				}
				track(promise, `write #${op.id}`).then(
					function () {
						if (writtenAt[target]! < at) writtenAt[target] = at;
					},
					function () {},
				);
				break;
			}
			case "restore": {
				const id = `r${++made}`;
				const at = ++evt;
				const target = op.target;

				madeAt.set(id, at);
				track(
					clients[op.c]!.restore({ [TARGET_KEYS[target]!]: { ...server.truth(target), served: id } }),
					`restore #${op.id}`,
				).then(
					function () {
						if (writtenAt[target]! < at) writtenAt[target] = at;
					},
					function () {},
				);
				break;
			}
			case "invalidate":
				track(clients[op.c]!.invalidate([...PREFIXES[op.prefix]!]), `invalidate #${op.id}`);
				break;
			case "sub": {
				const w = op.w;
				let live: QueryRef<unknown>;

				try {
					live = ref(w);
				} catch (error) {
					violations.push({
						invariant: "I10 synchronous cache failure escapes watch()/subscribe()",
						detail: `W${w}: client.watch() threw ${String(error)}`,
					});
					break;
				}

				let stop: () => void;

				try {
					stop = live.subscribe(function listener(state: QueryState<unknown>) {
						log?.(`      W${w} emits ${JSON.stringify(state)}`);
						if (!OFF.has("frozen") && !deepFrozen(state.data)) {
							violations.push({
								invariant: "I8b live query data not frozen",
								detail: `W${w} emitted mutable data ${JSON.stringify(state.data)}`,
							});
						}
					});
				} catch (error) {
					violations.push({
						invariant: "I10 synchronous cache failure escapes watch()/subscribe()",
						detail: `W${w}: subscribe() threw ${String(error)}`,
					});
					break;
				}
				listeners[w]!.push(stop);
				break;
			}
			case "unsub":
				listeners[op.w]!.pop()?.();
				break;
			case "refetch":
				if (refs[op.w] || !cache.faults || !flags.failGet) track(ref(op.w).refetch(), `refetch #${op.id}`);
				break;
			case "fetchMore": {
				const slot = testCase.slots[op.w]!;
				const target = slot.target;

				if (!refs[op.w] && flags.failGet) break;
				const r = ref(op.w);
				const before = made;

				track(r.fetchMore({ variables: { page: 2 }, merge: merge(target) }), `fetchMore #${op.id}`).then(
					function (state) {
						const served = (state.data as { served?: string } | undefined)?.served;

						// The merged page reached the cache (fetchMore never rejects: check its own merge is shown).
						if (
							slot.policy !== "no-cache" &&
							state.error === undefined &&
							served?.startsWith("m") &&
							Number(served.slice(1)) > before
						) {
							const at = madeAt.get(served)!;

							if (writtenAt[target]! < at) writtenAt[target] = at;
						}
					},
				);
				break;
			}
			case "cache":
				cache.step(op.r, op.resolve);
				break;
			case "net":
				if (server.pending.length) {
					const request = server.pending[op.r % server.pending.length]!;

					log?.(
						`      (= req ${request.seq}: ${request.query.split(" {")[0]} ${JSON.stringify(request.variables ?? {})} attempt ${request.attempt})`,
					);
					server.step(op.r % server.pending.length, op.mode);
				}
				break;
			case "abort":
				if (controllers.length) controllers[op.r % controllers.length]!.abort();
				break;
			case "advance":
				await advance(op.ms);
				break;
		}

		await microFlush();
	}

	/**
	 * Drains everything: parked cache calls, requests, timers.
	 *
	 * @param phase - Phase name
	 */
	async function quiesce(phase: string): Promise<void> {
		cache.faults = false;

		for (let i = 0; i < 3000; i++) {
			await microFlush();

			const choices: string[] = [];

			if (cache.pending.length) choices.push("cache");
			if (server.pending.length) choices.push("net");

			if (choices.length) {
				const choice = drainRng.pick(choices);

				if (choice === "cache") {
					const n = cache.pending.length;
					const index = testCase.drain === "fifo" ? 0 : testCase.drain === "lifo" ? n - 1 : drainRng.int(n);

					cache.step(index, true);
				} else {
					const n = server.pending.length;
					const index = testCase.drain === "fifo" ? 0 : testCase.drain === "lifo" ? n - 1 : drainRng.int(n);

					log?.(`  [${phase}] deliver req ${server.pending[index]!.seq}`);
					server.step(index, "ok");
				}
				continue;
			}

			if (vi.getTimerCount() > 0) {
				vi.advanceTimersToNextTimer();
				continue;
			}

			await microFlush();
			if (cache.pending.length || server.pending.length || vi.getTimerCount() > 0) continue;

			if (outstanding > 0) {
				violations.push({
					invariant: "I4b promises settle",
					detail: `${phase}: ${outstanding} promise(s) never settled with nothing in flight`,
				});
				throw new Abort();
			}

			return;
		}

		violations.push({ invariant: "I4c quiescence", detail: `${phase}: never quiesced` });
		throw new Abort();
	}

	/**
	 * Order of a data id, or undefined when unknown.
	 *
	 * @param served - The id
	 * @returns The event
	 */
	function orderOf(served: string | undefined): number | undefined {
		if (!served) return undefined;
		if (served.startsWith("s")) return server.servedAt.get(served);

		return madeAt.get(served);
	}

	/**
	 * Checks a value holds only real data.
	 *
	 * @param where - Where
	 * @param target - Target
	 * @param value - Value
	 * @param lenient - Tolerate placeholders of successful mutations
	 */
	function scan(where: string, target: number, value: unknown, lenient = false): void {
		/**
		 * @param invariant - Invariant
		 * @param detail - Detail
		 */
		function fail(invariant: string, detail: string): void {
			violations.push({ invariant, detail: `${where} (${TARGET_NAMES[target]}): ${detail}` });
		}

		if (value === undefined) return;

		if (target === 0) {
			const data = value as Todos;

			for (const item of data.todos) {
				if (item.startsWith("boom")) {
					fail("I2 rolled-back optimistic data visible", `contains "${item}": ${JSON.stringify(data)}`);
				} else if (item.startsWith("temp")) {
					// A committed placeholder stays until a refetch replaces it: the invalidation meant to trigger it failed.
					if (!lenient && failedInvalidationAt[target]! <= invalidatedAt[target]!)
						fail("I2b placeholder optimistic data visible", `contains "${item}": ${JSON.stringify(data)}`);
				} else if (!server.todos.includes(item)) {
					fail("I2c unknown data", `contains "${item}" which the server never had`);
				}
			}
			if (new Set(data.todos).size !== data.todos.length) fail("I2d duplicates", JSON.stringify(data));
		} else if (target === 1) {
			const data = value as Size;

			if (data.size > server.todos.length) fail("I2c unknown data", `size ${data.size} > ${server.todos.length}`);
		} else {
			const data = value as Count;

			// A committed (exact) optimistic count stays until a refetch replaces it: when the invalidation meant to trigger
			// it failed (and none succeeded since), it legitimately remains, as long as it matches the server.
			const unrefreshed = failedInvalidationAt[target]! > invalidatedAt[target]! && data.count <= server.count;

			if (data.served === "opt" && !lenient && !unrefreshed) {
				fail("I2 rolled-back optimistic data visible", `optimistic count visible: ${JSON.stringify(data)}`);
			}
			if (data.count > server.count) fail("I2c unknown data", `count ${data.count} > ${server.count}`);
		}
	}

	/**
	 * Invariants after quiescence.
	 *
	 * @param phase - Phase name
	 */
	async function checkQuiescent(phase: string): Promise<void> {
		cache.immediate = true;

		try {
			const snapshot = await client1.extract();

			for (const [key, value] of cache.store) {
				const target = TARGET_KEYS.indexOf(key);

				if (target === -1) {
					violations.push({ invariant: "I0 unexpected cache entry", detail: `${phase}: ${key}` });
					continue;
				}

				const failed = cache.lastWriteFailed.get(key) === true;

				// The library's last write to this entry was lost (its cache call failed): the entry may hold anything it
				// held before, including optimistic data the failed write was removing.
				if (!failed) scan(`${phase} cache`, target, value);

				if (!same(snapshot[key], value) && !failed) {
					violations.push({
						invariant: "I3 extract() differs from cache with no pending mutation",
						detail: `${phase} ${TARGET_NAMES[target]}: extract=${JSON.stringify(snapshot[key])} cache=${JSON.stringify(value)}`,
					});
				}

				const served = (value as { served?: string }).served;
				const at = orderOf(served);

				// A failed cleanup delete leaves the key untrusted: the client reads it as a miss.
				if (at !== undefined && at < invalidatedAt[target]! && !failed) {
					violations.push({
						invariant: "I6 invalidated data resurrected in cache",
						detail: `${phase} ${TARGET_NAMES[target]}: cache holds ${JSON.stringify(value)} (event ${at}) but the entry was invalidated at event ${invalidatedAt[target]}`,
					});
				}
			}

			// I7: a successful write / restore / merge newer than the last invalidation is not lost or overwritten by
			// older data.
			for (let target = 0; target < TARGETS.length; target++) {
				const key = TARGET_KEYS[target]!;
				const newest = writtenAt[target]!;

				if (
					!newest ||
					newest <= attemptedInvalidationAt[target]! ||
					cache.lastWriteFailed.get(key) === true ||
					(cache.failedAt.get(key) ?? -1) >= newest
				) {
					continue;
				}

				const value = cache.store.get(key) as { served?: string } | undefined;
				const at = value === undefined ? undefined : orderOf(value.served);

				if (value === undefined) {
					violations.push({
						invariant: "I7 written data lost",
						detail: `${phase} ${TARGET_NAMES[target]}: written at event ${newest} (after the last invalidation at ${invalidatedAt[target]}) but the cache is empty`,
					});
				} else if (at !== undefined && at < newest) {
					violations.push({
						invariant: "I7b written data overwritten by older data",
						detail: `${phase} ${TARGET_NAMES[target]}: written at event ${newest}, cache holds ${JSON.stringify(value)} from event ${at}`,
					});
				}
			}

			for (const { w, r, slot } of activeRefs()) {
				const state = r.getState();
				const key = TARGET_KEYS[slot.target]!;
				const failed = cache.lastWriteFailed.get(key) === true;

				if (!failed) scan(`${phase} W${w}.data`, slot.target, state.data, state.error !== undefined);

				if (state.loading) {
					violations.push({
						invariant: "I4 live query stuck loading",
						detail: `${phase} W${w}: ${JSON.stringify(state)}`,
					});
				}

				if (!OFF.has("frozen") && !deepFrozen(state.data)) {
					violations.push({
						invariant: "I8b live query data not frozen",
						detail: `${phase} W${w}: ${JSON.stringify(state.data)}`,
					});
				}

				if (slot.policy === "no-cache" || state.error !== undefined || failed) continue;

				const cached = cache.store.get(key);

				if (!same(cached, state.data)) {
					violations.push({
						invariant: "I5 active live query out of sync with its cache entry",
						detail: `${phase} W${w} (${slot.policy}, ${TARGET_NAMES[slot.target]}): watcher=${JSON.stringify(state.data)} cache=${JSON.stringify(cached)}`,
					});
				}
			}

			if (unhandled.length) {
				violations.push({ invariant: "I4d unhandled rejection", detail: `${phase}: ${String(unhandled[0])}` });
				unhandled.length = 0;
			}
		} finally {
			cache.immediate = false;
		}
	}

	/**
	 * After a fault-free refetch, everything equals the server.
	 */
	async function checkConvergence(): Promise<void> {
		cache.faults = false;
		for (const { r } of activeRefs()) track(r.refetch(), "final refetch");
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
			track(client1.gql({ ...targetOptions(target), fetchPolicy: "network-only" }), "gql final");
		}
		await quiesce("final network-only");

		for (let target = 0; target < TARGETS.length; target++) {
			const cached = cache.store.get(TARGET_KEYS[target]!);

			if (!same(strip(cached), server.truth(target))) {
				violations.push({
					invariant: "I1b cache != server truth after a network-only read",
					detail: `${TARGET_NAMES[target]}: cache=${JSON.stringify(cached)} server=${JSON.stringify(server.truth(target))}`,
				});
			}
		}

		// Every failure is now in the past: the last writes succeeded.
		cache.lastWriteFailed.clear();
		await checkQuiescent("after convergence");
	}

	/**
	 * Internal bookkeeping returns to empty: in-flight maps, optimistic layers, watcher registrations.
	 */
	async function checkLeaks(): Promise<void> {
		// In-flight: a new identical request is sent when nothing is in flight (never joins a leaked entry).
		for (const policy of ["network-only", "no-cache"] as const) {
			for (let c = 0; c < new Set(clients).size; c++) {
				for (let target = 0; target < TARGETS.length; target++) {
					const before = server.requests;
					const promise = track(clients[c]!.gql({ ...targetOptions(target), fetchPolicy: policy }), "gql leak");

					await microFlush();
					await microFlush();
					for (let i = 0; i < 20 && cache.pending.length; i++) {
						cache.step(0, true);
						await microFlush();
					}
					if (server.requests !== before + 1) {
						violations.push({
							invariant: "I9 in-flight entry leaked",
							detail: `${clientName(c)}.gql(${TARGET_NAMES[target]}, ${policy}) with nothing in flight sent ${server.requests - before} request(s)`,
						});
					}
					await quiesce("leak check");
					await promise.catch(function () {});
				}
			}
		}

		// Optimistic layers: a write lands as-is.
		cache.immediate = true;
		try {
			for (let target = 0; target < TARGETS.length; target++) {
				const value = { ...server.truth(target), served: `w${++made}` };

				madeAt.set(value.served, ++evt);
				await client1.write(targetOptions(target), value);
				const read = await client2.read(targetOptions(target));

				if (!same(read, value)) {
					violations.push({
						invariant: "I9b optimistic layer leaked",
						detail: `${TARGET_NAMES[target]}: wrote ${JSON.stringify(value)}, read ${JSON.stringify(read)}`,
					});
				}
			}
		} finally {
			cache.immediate = false;
		}

		// Watchers: once every live query is unsubscribed and deactivated, an invalidation fetches nothing.
		for (const list of listeners) for (const stop of list.splice(0)) stop();
		await quiesce("unsubscribe all");
		const before = server.requests;

		track(client1.invalidate([]), "invalidate leak");
		await quiesce("leak invalidate");
		if (server.requests !== before) {
			violations.push({
				invariant: "I9c watcher leaked",
				detail: `invalidate([]) with no subscribed live query sent ${server.requests - before} request(s)`,
			});
		}
	}

	/**
	 * restore(extract()) into a fresh client yields the same data.
	 */
	async function checkSnapshot(): Promise<void> {
		cache.immediate = true;
		try {
			const snapshot = await client1.extract();
			const freshCache = new HostileCache(createRng(1), { ...flags, failRate: 0 });

			freshCache.immediate = true;
			const restored = new Client({
				url: URL,
				fetch: server.fetch,
				middleware: [server.middleware],
				cache: freshCache,
			});

			await restored.restore(snapshot);
			for (let target = 0; target < TARGETS.length; target++) {
				const value = await restored.read(targetOptions(target));
				const original = cache.store.get(TARGET_KEYS[target]!);

				if (!same(value, original)) {
					violations.push({
						invariant: "I3b restore(extract()) differs",
						detail: `${TARGET_NAMES[target]}: restored=${JSON.stringify(value)} original=${JSON.stringify(original)}`,
					});
				}
			}
		} finally {
			cache.immediate = false;
		}
	}

	try {
		for (const op of testCase.ops) {
			if (trace) console.log(`  #${op.id} ${describeOp(op, testCase.slots)}`);
			await execute(op);
			if (trace) logState("      ");
		}

		await quiesce("drain");
		if (trace) logState("  [quiesced] ");
		await checkQuiescent("after drain");
		await checkConvergence();
		await checkSnapshot();
		await checkLeaks();
		if (unhandled.length) {
			violations.push({ invariant: "I4d unhandled rejection", detail: `end: ${String(unhandled[0])}` });
		}
	} catch (error) {
		if (!(error instanceof Abort)) {
			violations.push({ invariant: "harness exception", detail: String((error as Error)?.stack ?? error) });
		}
	} finally {
		for (const list of listeners) for (const stop of list.splice(0)) stop();
		cache.immediate = true;
		for (const call of cache.pending.splice(0)) call.resolve(undefined);
		for (const request of server.pending.splice(0))
			request.resolve(Response.json({ errors: [{ message: "teardown" }] }));
		vi.runOnlyPendingTimers();
		await microFlush();
		vi.clearAllTimers();
		await microFlush();
		process.off("unhandledRejection", onUnhandled);
	}

	if (ONLY.length) {
		const kept = violations.filter(function (violation) {
			return ONLY.some(function (prefix) {
				return violation.invariant.startsWith(prefix);
			});
		});

		violations.length = 0;
		violations.push(...kept);
	}

	if (trace) {
		console.log(`  onError reports: ${errors.length}, cache failures: ${cache.failures}`);
		for (const violation of violations) console.log(`  !! ${violation.invariant}: ${violation.detail}`);
	}

	return violations;
}

/**
 * Prefix indexes to prefixes.
 *
 * @param inv - Indexes
 * @returns Prefixes
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
 * @param testCase - Case
 * @param invariant - Invariant
 * @returns Fails
 */
async function fails(testCase: Case, invariant: string): Promise<boolean> {
	const violations = await run(testCase);

	return violations.some(function (violation) {
		return violation.invariant === invariant;
	});
}

/**
 * Shrinks a failing case.
 *
 * @param testCase - Case
 * @param invariant - Invariant
 * @returns Smaller case
 */
async function shrink(testCase: Case, invariant: string): Promise<Case> {
	let current = testCase;

	// Simplify the environment first: fewer moving parts make the op deletion more effective.
	const simpler: Array<Partial<Flags>> = [
		{ failRate: 0 },
		{ clone: false },
		{ retry: false },
		{ clientTimeout: undefined },
		{ fifo: true },
		{ fifo: true, ordered: true },
		{ syncThrow: 0 },
	];

	for (const change of simpler) {
		const candidate = { ...current, flags: { ...current.flags, ...change } };

		if (!same(candidate.flags, current.flags) && (await fails(candidate, invariant))) current = candidate;
	}

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

	for (let i = 0; i < current.ops.length; i++) {
		const op = current.ops[i]!;
		const variants: Op[] = [];

		if (op.t === "add" && op.inv.length && op.opt !== "temp") variants.push({ ...op, inv: [] });
		if (op.t === "inc" && op.inv.length && !op.opt) variants.push({ ...op, inv: [] });
		if (op.t === "add" && op.opt === "exact") variants.push({ ...op, opt: "none" });
		if ((op.t === "add" || op.t === "inc" || op.t === "query") && op.abortable)
			variants.push({ ...op, abortable: false });
		if (op.t === "query" && op.timeout !== undefined) {
			const { timeout: _timeout, ...rest } = op;

			variants.push(rest);
		}
		if (op.t === "net" && op.mode !== "ok") variants.push({ ...op, mode: "ok" });
		if (op.t === "cache" && !op.resolve) variants.push({ ...op, resolve: true });

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
	seed: number;
	seedsFailing: number;
	originalDetail: string;
	minimal: string[];
	observed: string[];
	case: Case;
}

/**
 * Runs a seed range and shrinks the first failure of each invariant.
 *
 * @param start - First seed
 * @param seeds - Count
 * @returns Failures
 */
async function explore(start: number, seeds: number): Promise<{ failures: Failure[]; failingSeeds: number }> {
	const first = new Map<string, { seed: number; detail: string; count: number }>();
	let failingSeeds = 0;

	for (let seed = start; seed < start + seeds; seed++) {
		const violations = await run(generate(seed));

		if (env.HFUZZ_DETERMINISM) {
			// An unrelated run in between: results must not depend on what ran before.
			await run(generate(seed * 7919 + 13));
			const again = await run(generate(seed));

			if (!same(again, violations)) {
				violations.push({
					invariant: "harness nondeterminism",
					detail: `seed ${seed}: ${JSON.stringify(violations).slice(0, 400)} vs ${JSON.stringify(again).slice(0, 400)}`,
				});
			}
		}

		if (violations.length) failingSeeds++;

		const seen = new Set<string>();

		for (const violation of violations) {
			if (seen.has(violation.invariant)) continue;
			seen.add(violation.invariant);

			const known = first.get(violation.invariant);

			if (known) known.count++;
			else first.set(violation.invariant, { seed, detail: violation.detail, count: 1 });
		}
	}

	const failures: Failure[] = [];

	for (const [invariant, { seed, detail, count }] of first) {
		const minimal = env.HFUZZ_NOSHRINK ? generate(seed) : await shrink(generate(seed), invariant);
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

		steps.unshift(`flags: ${JSON.stringify(minimal.flags)}`);
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
 * Formats failures.
 *
 * @param failures - Failures
 * @returns Report
 */
function formatFailures(failures: Failure[]): string {
	return failures
		.map(function (failure) {
			return [
				`=== ${failure.invariant}  (first seed ${failure.seed}, ${failure.seedsFailing} failing seed(s); rerun with HFUZZ_SEED=${failure.seed})`,
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

describe("hostile model-based fuzzing (async failing cache, flaky network, timers)", function () {
	it(
		"keeps cache, live queries, optimistic layers and bookkeeping consistent",
		async function () {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: 0 });

			try {
				if (env.HFUZZ_REPLAY) {
					const [file, index] = env.HFUZZ_REPLAY.split(":");
					const { readFileSync } = await import("node:fs");
					const entry = JSON.parse(readFileSync(file!, "utf8")).report[Number(index ?? 0)] as Failure;

					console.log(
						`replaying ${entry.invariant} (seed ${entry.seed}) flags ${JSON.stringify(entry.case.flags)}`,
					);
					expect(await run(entry.case, true)).toEqual([]);
					return;
				}

				if (SINGLE !== undefined) {
					const testCase = generate(SINGLE);

					console.log(
						`seed ${SINGLE} flags ${JSON.stringify(testCase.flags)} slots ${JSON.stringify(testCase.slots)}`,
					);
					expect(await run(testCase, true)).toEqual([]);
					return;
				}

				const { failures, failingSeeds } = await explore(START, SEEDS);
				const report = formatFailures(failures);

				console.log(
					`${SEEDS} seeds (from ${START}) x ${OPS} ops${OFF.size ? `, off: ${[...OFF].join(",")}` : ""}: ${failingSeeds} failing seed(s)`,
				);

				if (env.HFUZZ_REPORT) {
					const { writeFileSync } = await import("node:fs");

					writeFileSync(
						env.HFUZZ_REPORT,
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
		6 * 60 * 60_000,
	);
});
