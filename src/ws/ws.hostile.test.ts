import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client";
import { isClientError } from "../errors";
import { createWebSocketTransport, type WebSocketTransportOptions } from "./index";

/**
 * Protocol message.
 */
interface Message {
	type: string;
	id?: string;
	payload?: unknown;
}

/**
 * Scriptable WebSocket double: the test plays the server.
 */
class FakeSocket {
	static instances: FakeSocket[] = [];
	/** When > 0, the next constructions throw (decremented each time). */
	static throwNext = 0;

	readyState = 0;
	readonly sent: Message[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: (event: { code: number; reason: string }) => void;
	closedWith?: { code: number; reason: string };

	constructor(
		readonly url: string,
		readonly protocol: string,
	) {
		if (FakeSocket.throwNext > 0) {
			FakeSocket.throwNext--;
			throw new Error("SecurityError: blocked");
		}

		FakeSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;

		this.readyState = 3;
		this.closedWith = { code, reason };
		const socket = this;

		queueMicrotask(function dispatchClose() {
			socket.onclose?.({ code, reason });
		});
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	emit(message: Message | string): void {
		this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
	}

	drop(code = 1006, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}

	sentOf(type: string): Message[] {
		return this.sent.filter(function (message) {
			return message.type === type;
		});
	}
}

const SUBSCRIPTION = "subscription OnTick { tick }";

function setup(options: Partial<WebSocketTransportOptions> = {}) {
	const transport = createWebSocketTransport({
		url: "wss://test.dev/graphql",
		WebSocket: FakeSocket as unknown as WebSocketTransportOptions["WebSocket"],
		retryDelay: function () {
			return 10;
		},
		...options,
	});
	const client = new Client({ url: "https://test.dev/graphql", subscriptionTransport: transport, fetch: vi.fn() });

	return { client, transport };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function latest(): FakeSocket {
	return FakeSocket.instances.at(-1)!;
}

async function accept(socket: FakeSocket = latest()): Promise<FakeSocket> {
	socket.open();
	await flush();
	socket.emit({ type: "connection_ack" });

	return socket;
}

function collect<T>(iterable: AsyncIterable<T>) {
	const values: T[] = [];
	const state: { error?: unknown; settled: boolean } = { settled: false };
	const done = (async function () {
		try {
			for await (const value of iterable) values.push(value);
		} catch (error) {
			state.error = error;
		} finally {
			state.settled = true;
		}
	})();

	return { values, done, state };
}

beforeEach(function () {
	FakeSocket.instances = [];
	FakeSocket.throwNext = 0;
});

afterEach(function () {
	vi.useRealTimers();
});

describe("WebSocket transport attack: malformed frames", function () {
	it("closes with 4400 on a JSON `null` frame instead of throwing a TypeError from onmessage", async function () {
		const { client } = setup();
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		expect(function () {
			socket.emit("null");
		}).not.toThrow();
		expect(socket.closedWith?.code).toBe(4400);

		await sub.done;
	});

	it("closes with 4400 on a message that is not an object with a string `type`", async function () {
		const { client } = setup();
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		socket.emit("42");
		expect(socket.closedWith?.code).toBe(4400);

		await sub.done;
	});
});

describe("WebSocket transport attack: protocol violations by the server", function () {
	it("does not re-send `subscribe` for already-running operations on a duplicate connection_ack", async function () {
		const { client } = setup();
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		expect(socket.sentOf("subscribe")).toHaveLength(1);

		socket.emit({ type: "connection_ack" });

		// A second `subscribe` with id "1" makes a compliant server close with 4409, which is fatal.
		expect(socket.sentOf("subscribe")).toHaveLength(1);

		socket.emit({ id: "1", type: "complete" });
		await sub.done;
	});

	it("surfaces an `error` message with an empty payload as an error, not as a clean completion", async function () {
		const { client } = setup();
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		socket.emit({ id: "1", type: "error", payload: [] });
		await sub.done;

		expect(sub.state.error).toBeDefined();
	});

	it("surfaces an `error` message whose payload is a single error object as a ClientError, not a TypeError", async function () {
		const { client } = setup();
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		socket.emit({ id: "1", type: "error", payload: { message: "Forbidden" } });
		await sub.done;

		expect(isClientError(sub.state.error)).toBe(true);
	});
});

describe("WebSocket transport attack: stale socket handlers", function () {
	it("a connectionParams rejection from an already-dropped socket does not fail subscriptions on the replacement", async function () {
		vi.useFakeTimers();

		let calls = 0;
		let rejectFirst: (error: unknown) => void = function () {};
		const { client } = setup({
			connectionParams: function () {
				calls++;

				if (calls === 1) {
					return new Promise(function (_resolve, reject) {
						rejectFirst = reject;
					});
				}

				return { token: "fresh" };
			},
		});
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const first = latest();

		first.open(); // connectionParams (token refresh) pending...
		first.drop(1006); // ...while the network drops the socket
		await vi.advanceTimersByTimeAsync(10);

		const second = latest();

		expect(second).not.toBe(first);
		await accept(second);
		expect(second.sentOf("subscribe")).toHaveLength(1);

		// The stale token refresh for the dead socket finally fails.
		rejectFirst(new Error("stale token refresh failed"));
		await flush();

		second.emit({ id: "1", type: "next", payload: { data: { tick: 1 } } });
		await flush();

		expect(sub.state.error).toBeUndefined();
		expect(sub.values).toEqual([{ tick: 1 }]);

		second.emit({ id: "1", type: "complete" });
		await sub.done;
	});
});

describe("WebSocket transport attack: throwing WebSocket constructor", function () {
	it("does not leave a ghost subscription behind when the WebSocket constructor throws", async function () {
		const { client } = setup();

		FakeSocket.throwNext = 1;

		const failed = collect(client.subscribe({ query: SUBSCRIPTION }));

		await failed.done;
		expect(failed.state.error).toBeDefined();

		const sub = collect(client.subscribe({ query: "subscription OnOther { other }" }));

		await flush();

		const socket = await accept();

		// Only the live subscription must be sent; the failed one (id "1") must be forgotten.
		expect(
			socket.sentOf("subscribe").map(function (message) {
				return message.id;
			}),
		).toEqual(["2"]);

		socket.emit({ id: "2", type: "complete" });
		await sub.done;
		await new Promise(function (resolve) {
			setTimeout(resolve, 5);
		});

		// With no live subscription left, the idle socket must close.
		expect(socket.closedWith?.code).toBe(1000);
	});

	it("fails active subscriptions (instead of hanging forever) when the constructor throws during a reconnect", async function () {
		vi.useFakeTimers();

		const { client } = setup({ retryAttempts: 3 });
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		FakeSocket.throwNext = 1;
		socket.drop(1006);

		let thrownFromTimer: unknown;

		try {
			await vi.advanceTimersByTimeAsync(1_000);
		} catch (error) {
			thrownFromTimer = error;
		}

		await vi.advanceTimersByTimeAsync(60_000);
		await flush();

		// The exception must not escape into a timer callback (uncaught in production)...
		expect(thrownFromTimer).toBeUndefined();
		// ...and the subscription must either have reconnected or settled, never hang with no socket and no timer.
		expect(FakeSocket.instances.length > 1 || sub.state.settled).toBe(true);
	});
});

describe("WebSocket transport attack: abort and dispose", function () {
	it("stops yielding buffered results once the signal is aborted", async function () {
		const { client } = setup();
		const controller = new AbortController();
		const received: unknown[] = [];
		let release: () => void = function () {};
		const gate = new Promise<void>(function (resolve) {
			release = resolve;
		});
		const done = (async function () {
			for await (const value of client.subscribe({ query: SUBSCRIPTION, signal: controller.signal })) {
				received.push(value);
				// Slow consumer: busy with the first result while more arrive.
				if (received.length === 1) await gate;
			}
		})();

		await flush();

		const socket = await accept();

		socket.emit({ id: "1", type: "next", payload: { data: { tick: 1 } } });
		await flush();
		socket.emit({ id: "1", type: "next", payload: { data: { tick: 2 } } });
		socket.emit({ id: "1", type: "next", payload: { data: { tick: 3 } } });

		controller.abort();
		release();
		await done;

		expect(received).toEqual([{ tick: 1 }]);
	});

	it("leaves no pending timer after dispose() when connectionParams resolves late", async function () {
		vi.useFakeTimers();

		let resolveParams: (value: Record<string, unknown>) => void = function () {};
		const { client, transport } = setup({
			connectionParams: function () {
				return new Promise(function (resolve) {
					resolveParams = resolve;
				});
			},
		});
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();
		latest().open();
		await flush();

		transport.dispose();
		await sub.done;

		resolveParams({ token: "late" });
		await flush();

		// A disposed transport must not keep a 10s ack-timeout timer alive (keeps Node processes from exiting).
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("WebSocket transport attack: resource exhaustion", function () {
	it("gives up on a server that accepts then drops every connection, instead of reconnecting forever", async function () {
		const { client } = setup({ retryAttempts: 2 });
		const sub = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		for (let round = 0; round < 6 && !sub.state.settled; round++) {
			const socket = await accept();

			socket.drop(1011, "restarting");
			await new Promise(function wait(resolve) {
				setTimeout(resolve, 20);
			});
		}

		await sub.done;

		expect(FakeSocket.instances).toHaveLength(3);
		expect(String(sub.state.error)).toContain("1011");
	});

	it("fails a subscription whose consumer falls too far behind, instead of buffering without bound", async function () {
		const { client } = setup({ maxBufferedResults: 3 });
		const iterator = client.subscribe({ query: SUBSCRIPTION })[Symbol.asyncIterator]();
		const first = iterator.next();

		await flush();

		const socket = await accept();

		for (let tick = 1; tick <= 10; tick++) socket.emit({ id: "1", type: "next", payload: { data: { tick } } });

		expect(await first).toEqual({ done: false, value: { tick: 1 } });

		const delivered: unknown[] = [];
		let failure: unknown;

		try {
			for (;;) {
				const result = await iterator.next();

				if (result.done) break;

				delivered.push(result.value);
			}
		} catch (error) {
			failure = error;
		}

		expect(delivered).toEqual([{ tick: 2 }, { tick: 3 }]);
		expect(failure).toBeInstanceOf(RangeError);
		expect(socket.sentOf("complete")).toEqual([{ id: "1", type: "complete" }]);
	});
});
