import { describe, expect, it } from "vitest";
import { applyIncremental, createIncrementalState, deepMerge, getBoundary, readMultipartMixed } from "./incremental";

/**
 * Creates a byte stream emitting the given chunks.
 *
 * @param chunks - Text chunks
 * @returns The stream
 */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

/**
 * Collects every yielded part.
 *
 * @param stream - The stream
 * @param boundary - The boundary
 * @returns The part bodies
 */
async function collect(stream: ReadableStream<Uint8Array>, boundary = "-"): Promise<string[]> {
	const parts: string[] = [];

	for await (const part of readMultipartMixed(stream, boundary)) parts.push(part);

	return parts;
}

describe("applyIncremental", function () {
	it("merges the current format (pending ids, subPath, completed)", function () {
		const state = createIncrementalState();
		const initial = { user: { id: 1, friends: [{ id: 2 }] } };

		applyIncremental(state, {
			data: initial,
			pending: [
				{ id: "0", path: ["user"] },
				{ id: "1", path: ["user", "posts"] },
			],
			hasNext: true,
		});
		const before = state.data;

		applyIncremental(state, {
			incremental: [
				{ id: "0", data: { name: "Rick" } },
				{ id: "0", subPath: ["friends", 0], data: { name: "Morty" } },
			],
			completed: [{ id: "0" }],
			hasNext: true,
		});

		expect(state.data).toEqual({ user: { id: 1, name: "Rick", friends: [{ id: 2, name: "Morty" }] } });
		expect(state.data).not.toBe(before);
		expect(initial.user).not.toHaveProperty("name");
		expect(state.pending.has("0")).toBe(false);

		applyIncremental(state, { incremental: [{ id: "1", items: [{ t: "a" }] }], hasNext: true });
		applyIncremental(state, {
			incremental: [{ id: "1", items: [{ t: "b" }] }],
			completed: [{ id: "1", errors: [{ message: "stream failed" }] }],
			hasNext: false,
		});

		expect((state.data as { user: { posts: unknown[] } }).user.posts).toEqual([{ t: "a" }, { t: "b" }]);
		expect(state.errors).toEqual([{ message: "stream failed" }]);
		expect(state.hasNext).toBe(false);
	});

	it("merges the 2022 format (path, items at index, labels)", function () {
		const state = createIncrementalState();

		applyIncremental(state, { data: { list: ["a"], user: { id: 1 } }, hasNext: true });
		applyIncremental(state, {
			incremental: [
				{ path: ["user"], data: { name: "Rick" } },
				{ path: ["list", 1], items: ["b", "c"] },
				{ path: ["user"], data: null, errors: [{ message: "partial" }] },
			],
			hasNext: false,
		});

		expect(state.data).toEqual({ list: ["a", "b", "c"], user: { id: 1, name: "Rick" } });
		expect(state.errors).toEqual([{ message: "partial" }]);
	});

	it("treats plain responses as complete payloads", function () {
		const state = applyIncremental(createIncrementalState(), { data: { a: 1 }, errors: [{ message: "e" }] });

		expect(state).toMatchObject({ data: { a: 1 }, errors: [{ message: "e" }], hasNext: false });
	});

	it("ignores unknown pending ids and creates missing lists", function () {
		const state = applyIncremental(createIncrementalState(), {
			data: { a: 1 },
			incremental: [
				{ id: "x", data: { b: 2 } },
				{ id: "y", items: [1] },
				{ path: ["c", 0], items: [3] },
			],
		});

		expect(state.data).toEqual({ a: 1, c: [3] });
	});
});

describe("deepMerge", function () {
	it("merges objects and arrays by key and replaces mismatched types", function () {
		expect(deepMerge({ a: { b: 1 }, l: [{ x: 1 }] }, { a: { c: 2 }, l: [{ y: 2 }] })).toEqual({
			a: { b: 1, c: 2 },
			l: [{ x: 1, y: 2 }],
		});
		expect(deepMerge([1], { 0: 2 })).toEqual({ 0: 2 });
		expect(deepMerge(1, { a: 1 })).toEqual({ a: 1 });
	});
});

describe("multipart/mixed", function () {
	it("extracts the boundary", function () {
		expect(getBoundary('multipart/mixed; boundary="graphql"; deferSpec=20220824')).toBe("graphql");
		expect(getBoundary("multipart/mixed;boundary=abc")).toBe("abc");
		expect(getBoundary("multipart/mixed")).toBe("-");
	});

	it("yields part bodies across arbitrary chunking and line endings", async function () {
		const body =
			'\r\n---\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"data":{"a":1},"hasNext":true}\r\n---\r\n' +
			'Content-Type: application/json\r\n\r\n{"incremental":[],"hasNext":false}\r\n-----\r\n';
		const chunks = body.match(/[\s\S]{1,7}/g)!;

		expect(await collect(streamOf(...chunks))).toEqual([
			'{"data":{"a":1},"hasNext":true}',
			'{"incremental":[],"hasNext":false}',
		]);
	});

	it("supports custom boundaries, header-less parts and ignores the preamble", async function () {
		const body = 'preamble\n--graphql\n\n{"a":1}\n--graphql\n{"b":2}\n--graphql--';

		expect(await collect(streamOf(body), "graphql")).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("stops reading on early exit", async function () {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('\r\n---\r\n\r\n{"a":1}\r\n---\r\n'));
			},
			cancel() {
				cancelled = true;
			},
		});

		for await (const part of readMultipartMixed(stream, "-")) {
			expect(part).toBe('{"a":1}');
			break;
		}

		expect(cancelled).toBe(true);
	});
});
