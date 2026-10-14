import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client";

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

describe("WebSocket transport: retry budget", function () {
	it("gives a fresh retry budget after a long stable connection that was closed lazily (idle)", async function () {
		vi.useFakeTimers();

		const { client } = setup({ retryAttempts: 1, lazyCloseTimeout: 0 });
		const controllerA = new AbortController();
		const subA = collect(client.subscribe({ query: SUBSCRIPTION, signal: controllerA.signal }));

		await flush();

		// One early flap uses the single retry...
		(await accept()).drop(1006);
		await vi.advanceTimersByTimeAsync(10);
		await accept();

		// ...then the connection stays up for a minute before the last subscription ends (idle lazy close).
		await vi.advanceTimersByTimeAsync(60_000);
		controllerA.abort();
		await subA.done;
		await vi.advanceTimersByTimeAsync(10);
		await flush();

		// Much later, a new subscription opens a new connection, which drops once.
		const subB = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();
		(await accept()).drop(1006);
		await vi.advanceTimersByTimeAsync(10);
		await flush();

		// The earlier flap was a minute-long stable connection ago: subscription B must be retried, not failed.
		expect(subB.state.error).toBeUndefined();
		expect(FakeSocket.instances).toHaveLength(4);
	});
});
