import { vi } from "vitest";
import type { Cache } from "../types";

export const URL = "https://lanes.test/graphql";
export const TODOS = "query Todos { todos }";
export const ADD = "mutation Add($title: String!) { add(title: $title) }";

export type Todos = { todos: string[] };

export interface ParkedCall {
	kind: "get" | "set" | "delete" | "keys" | "clear";
	key: string | undefined;
	release(): void;
}

/**
 * An async cache whose calls apply immediately (in call order) and settle when the test releases them.
 *
 * @returns The cache, its backing map and its parked calls
 */
export function parkedCache(): { cache: Cache; store: Map<string, unknown>; parked: ParkedCall[] } {
	const store = new Map<string, unknown>();
	const parked: ParkedCall[] = [];

	function park<T>(kind: ParkedCall["kind"], key: string | undefined, result: T): Promise<T> {
		return new Promise<T>(function (resolve) {
			parked.push({
				kind,
				key,
				release: function () {
					resolve(result);
				},
			});
		});
	}

	const cache: Cache = {
		get: function <T>(key: string) {
			return park("get", key, store.get(key) as T | undefined);
		},
		set: function <T>(key: string, value: T) {
			store.set(key, value);
			return park("set", key, undefined);
		},
		delete: function (key: string) {
			return park("delete", key, store.delete(key));
		},
		clear: function () {
			store.clear();
			return park("clear", undefined, undefined);
		},
		keys: function () {
			return park("keys", undefined, [...store.keys()]);
		},
	};

	return { cache, store, parked };
}

/**
 * Lets promises and 0ms timers run.
 */
export async function tick(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise(function (resolve) {
			setTimeout(resolve, 0);
		});
	}
}

/**
 * Releases parked calls in call order (and the ones they trigger) until none is left, except those kept.
 *
 * @param parked - The parked calls
 * @param keep - Calls to leave parked
 */
export async function releaseAll(parked: ParkedCall[], keep?: (call: ParkedCall) => boolean): Promise<void> {
	for (let i = 0; i < 500; i++) {
		await tick();

		const index = parked.findIndex(function (call) {
			return keep ? !keep(call) : true;
		});

		if (index === -1) return;
		parked.splice(index, 1)[0]!.release();
	}
}

export interface Held {
	query: string;
	variables: Record<string, unknown> | undefined;
	respond(body: unknown): void;
}

/**
 * Fetch mock holding every request until the test answers it.
 *
 * @returns The mock and the held requests (arrival order)
 */
export function heldServer(): { fetchMock: typeof fetch; held: Held[] } {
	const held: Held[] = [];
	const fetchMock = vi.fn<typeof fetch>(async function (input, init) {
		const request = input instanceof Request ? input.clone() : new Request(input, init);
		const { query, variables } = (await request.json()) as { query: string; variables?: Record<string, unknown> };

		return new Promise<Response>(function (resolve) {
			held.push({
				query,
				variables,
				respond: function (body: unknown) {
					resolve(Response.json(body));
				},
			});
		});
	});

	return { fetchMock, held };
}

/**
 * Removes and returns the first held request whose document contains `text`.
 *
 * @param held - The held requests
 * @param text - Text of the document
 * @returns The request
 */
export function take(held: Held[], text: string): Held {
	const index = held.findIndex(function (request) {
		return request.query.includes(text);
	});

	if (index === -1) throw new Error(`no held request for ${text}`);

	return held.splice(index, 1)[0]!;
}

/**
 * Releases the first parked call of a kind, then lets the consequences run (without releasing anything else).
 *
 * @param parked - The parked calls
 * @param kind - The call kind
 */
export async function releaseFirst(parked: ParkedCall[], kind: ParkedCall["kind"]): Promise<void> {
	const index = parked.findIndex(function (call) {
		return call.kind === kind;
	});

	if (index === -1) throw new Error(`no parked ${kind}`);
	parked.splice(index, 1)[0]!.release();
	await tick();
}
