import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAbortScope,
	createCacheKey,
	hashDocument,
	matchesKeyPrefix,
	parseOperation,
	resolveValue,
	sha256,
	sleep,
	stableStringify,
} from "./utils";

describe("parseOperation", function () {
	it.each([
		["query GetUser { user { id } }", { type: "query", name: "GetUser" }],
		["mutation UpdateUser($id: ID!) { updateUser(id: $id) { id } }", { type: "mutation", name: "UpdateUser" }],
		["subscription OnMessage { message }", { type: "subscription", name: "OnMessage" }],
		["query { user { id } }", { type: "query", name: undefined }],
		["{ user { id } }", { type: "query" }],
		["  mutation{ reset }", { type: "mutation", name: undefined }],
	])("detects %s", function (document, expected) {
		expect(parseOperation(document)).toEqual(expected);
	});

	it("skips leading fragments", function () {
		const document = `
			fragment UserFields on User { id profile { name } }
			mutation Save { save { ...UserFields } }
		`;

		expect(parseOperation(document)).toEqual({ type: "mutation", name: "Save" });
	});

	it("ignores keywords inside comments and strings", function () {
		const document = `
			# mutation Fake { x }
			query Search { search(text: "} mutation Evil", block: """} subscription""") { id } }
		`;

		expect(parseOperation(document)).toEqual({ type: "query", name: "Search" });
	});

	it("never reads fields named like keywords as operations", function () {
		expect(parseOperation("{ customer { address { city } subscription { status } } }")).toEqual({ type: "query" });
		expect(parseOperation("{ a { b } mutation }")).toEqual({ type: "query" });
		expect(parseOperation("query A($v: In = { x: { y: 1 } }) { a { b } mutation } mutation B { c }", "B")).toEqual({
			type: "mutation",
			name: "B",
		});
	});

	it("selects the operation matching operationName", function () {
		const document = "query A { a } mutation B { b }";

		expect(parseOperation(document, "B")).toEqual({ type: "mutation", name: "B" });
		expect(parseOperation(document, "Missing")).toEqual({ type: "query", name: "A" });
	});
});

describe("hashDocument", function () {
	it("is deterministic and sensitive to every character", function () {
		const hash = hashDocument("query A { a }");

		expect(hash).toMatch(/^[0-9a-z]+\.[0-9a-z]+$/);
		expect(hashDocument("query A { a }")).toBe(hash);
		expect(hashDocument("query A { b }")).not.toBe(hash);
		expect(hashDocument("query A { a } ")).not.toBe(hash);
	});

	it("has no collisions across many similar documents", function () {
		const hashes = new Set<string>();

		for (let index = 0; index < 20_000; index++) hashes.add(hashDocument(`query Q${index} { field(id: ${index}) }`));

		expect(hashes.size).toBe(20_000);
	});
});

describe("stableStringify", function () {
	it("is independent of object key order, recursively", function () {
		expect(stableStringify({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 2 } })).toBe(
			stableStringify({ a: { c: 2, d: [{ x: 2, y: 1 }] }, b: 1 }),
		);
	});

	it("preserves array order and drops undefined values", function () {
		expect(stableStringify({ list: [2, 1], skip: undefined })).toBe('{"list":[2,1]}');
	});

	it("does not reorder non-plain objects", function () {
		expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
	});

	it("follows JSON.stringify semantics for every value kind", function () {
		class Point {
			y = 2;
			x = 1;
		}

		const value = {
			z: [1, "two", null, undefined, Number.NaN, -0, Infinity, { b: true, a: false }, function () {}],
			date: new Date(0),
			nested: {
				toJSON: function (key: string) {
					return { key, d: 4, c: 3 };
				},
			},
			point: new Point(),
			boxed: [new String("s"), new Number(1), new Boolean(false)],
			escaped: { 'quote"key': "line\nbreak", "\u2028": "\u0000" },
			skipped: undefined,
			symbol: Symbol("x"),
			"10": 10,
			"9": 9,
		};

		expect(stableStringify(value)).toBe(
			'{"9":9,"10":10,"boxed":["s",1,false],"date":"1970-01-01T00:00:00.000Z","escaped":' +
				JSON.stringify({ 'quote"key': "line\nbreak", "\u2028": "\u0000" }) +
				',"nested":{"c":3,"d":4,"key":"nested"},"point":{"y":2,"x":1},' +
				'"z":[1,"two",null,null,null,0,null,{"a":false,"b":true},null]}',
		);
		expect(stableStringify(undefined)).toBeUndefined();
	});

	it("keeps __proto__ as a regular key", function () {
		expect(stableStringify(JSON.parse('{"b":1,"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1},"b":1}');
	});

	it("throws on circular structures and BigInt", function () {
		const circular: Record<string, unknown> = {};

		circular.self = circular;

		expect(function () {
			stableStringify(circular);
		}).toThrow();
		expect(function () {
			stableStringify({ big: BigInt(1) });
		}).toThrow(TypeError);
	});
});

describe("cache keys", function () {
	const key = createCacheKey(["user", 1], "query { a }", { b: 1, a: 2 });

	it("ignores variable key order", function () {
		expect(key).toBe(createCacheKey(["user", 1], "query { a }", { a: 2, b: 1 }));
	});

	it.each([
		[[], true],
		[["user"], true],
		[["user", 1], true],
		[["user", 2], false],
		[["user", "1"], false],
		[["users"], false],
		[["user", 1, "extra"], false],
	])("prefix %j matches: %s", function (prefix, expected) {
		expect(matchesKeyPrefix(key, prefix)).toBe(expected);
	});

	it("never matches foreign keys", function () {
		expect(matchesKeyPrefix("not json", [])).toBe(false);
		expect(matchesKeyPrefix('{"a":1}', [])).toBe(false);
		expect(matchesKeyPrefix('["a","b","c","d"]', [])).toBe(false);
	});
});

describe("resolveValue", function () {
	it("resolves static values and sync/async factories", async function () {
		expect(await resolveValue("a")).toBe("a");
		expect(
			await resolveValue(function () {
				return "b";
			}),
		).toBe("b");
		expect(
			await resolveValue(async function () {
				return "c";
			}),
		).toBe("c");
	});
});

describe("createAbortScope", function () {
	afterEach(function () {
		vi.useRealTimers();
	});

	it("never aborts on its own without a timeout", function () {
		vi.useFakeTimers();

		const scope = createAbortScope(undefined, Infinity);

		vi.advanceTimersByTime(Number.MAX_SAFE_INTEGER);

		expect(scope.signal.aborted).toBe(false);
	});

	it("can be aborted manually", function () {
		const scope = createAbortScope();

		scope.abort("manual");

		expect(scope.signal.reason).toBe("manual");
	});

	it("aborts with a TimeoutError", function () {
		vi.useFakeTimers();

		const scope = createAbortScope(undefined, 100);

		vi.advanceTimersByTime(100);

		expect(scope.signal?.aborted).toBe(true);
		expect(scope.signal?.reason).toMatchObject({ name: "TimeoutError" });
	});

	it("forwards the external abort reason", function () {
		const controller = new AbortController();
		const scope = createAbortScope(controller.signal, 1_000);

		controller.abort("stop");

		expect(scope.signal?.reason).toBe("stop");
		scope.dispose();
	});

	it("starts aborted when the external signal already is", function () {
		const scope = createAbortScope(AbortSignal.abort("early"), 1_000);

		expect(scope.signal?.reason).toBe("early");
		scope.dispose();
	});

	it("stops the timer on dispose", function () {
		vi.useFakeTimers();

		const scope = createAbortScope(undefined, 100);

		scope.dispose();
		vi.advanceTimersByTime(100);

		expect(scope.signal?.aborted).toBe(false);
	});
});

describe("sleep", function () {
	afterEach(function () {
		vi.useRealTimers();
	});

	it("resolves after the delay", async function () {
		vi.useFakeTimers();

		const resolved = vi.fn();

		sleep(100, new AbortController().signal).then(resolved);
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toHaveBeenCalled();
	});

	it("rejects with the abort reason", async function () {
		const controller = new AbortController();
		const pending = sleep(10_000, controller.signal);

		controller.abort("stop");

		await expect(pending).rejects.toBe("stop");
		await expect(sleep(1, AbortSignal.abort("early"))).rejects.toBe("early");
	});
});

describe("sha256", function () {
	it("matches the NIST test vector", async function () {
		expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
