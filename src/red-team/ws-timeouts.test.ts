import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketTransport, type WebSocketTransport } from "../ws/index";

/**
 * A well-behaved graphql-transport-ws server: acks after `ackDelay` ms, answers pings with pongs after `pongDelay`.
 */
function serverWith(ackDelay: number, pongDelay: number, sockets: FakeSocket[]): new (url: string) => FakeSocket {
	return class Socket extends FakeSocket {
		constructor(url: string) {
			super(url, ackDelay, pongDelay);
			sockets.push(this);
		}
	};
}

class FakeSocket {
	readyState = 0;
	onopen: ((event: unknown) => unknown) | null = null;
	onmessage: ((event: { data: string }) => unknown) | null = null;
	onclose: ((event: { code: number; reason: string }) => unknown) | null = null;
	onerror: ((event: unknown) => unknown) | null = null;
	closes: number[] = [];
	readonly #ackDelay: number;
	readonly #pongDelay: number;

	constructor(_url: string, ackDelay: number, pongDelay: number) {
		this.#ackDelay = ackDelay;
		this.#pongDelay = pongDelay;
		const socket = this;

		setTimeout(function open() {
			socket.readyState = 1;
			socket.onopen?.({});
		}, 1);
	}

	send(data: string): void {
		const message = JSON.parse(data) as { type: string; id?: string };
		const socket = this;

		function reply(payload: object, delay: number): void {
			setTimeout(function deliver() {
				if (socket.readyState === 1) socket.onmessage?.({ data: JSON.stringify(payload) });
			}, delay);
		}

		if (message.type === "connection_init") reply({ type: "connection_ack" }, this.#ackDelay);
		if (message.type === "ping") reply({ type: "pong" }, this.#pongDelay);
		if (message.type === "subscribe") reply({ id: message.id, type: "next", payload: { data: { n: 1 } } }, 1);
	}

	close(code = 1000, reason = ""): void {
		this.closes.push(code);

		if (this.readyState === 3) return;

		this.readyState = 3;
		const socket = this;

		setTimeout(function closed() {
			socket.onclose?.({ code, reason });
		}, 1);
	}
}

let transport: WebSocketTransport | undefined;

afterEach(function cleanup() {
	transport?.dispose();
	transport = undefined;
});

function sleep(ms: number): Promise<void> {
	return new Promise(function wait(resolve) {
		setTimeout(resolve, ms);
	});
}

async function firstResult(t: WebSocketTransport): Promise<unknown> {
	const controller = new AbortController();

	for await (const result of t.subscribe({ query: "subscription { n }" }, controller.signal)) {
		controller.abort();

		return result;
	}

	return undefined;
}

describe("WebSocket timeouts set to Infinity (the value `lazyCloseTimeout` documents as 'keep open')", function () {
	it("`connectionAckTimeout: Infinity` waits for a slow ack instead of terminating every connection", async function () {
		const sockets: FakeSocket[] = [];

		transport = createWebSocketTransport({
			url: "ws://ws.test",
			WebSocket: serverWith(30, 1, sockets) as never,
			connectionAckTimeout: Infinity,
			retryAttempts: 1,
			retryDelay: function now() {
				return 0;
			},
		});

		await expect(firstResult(transport)).resolves.toEqual({ data: { n: 1 } });
		expect(sockets[0]!.closes).not.toContain(4499);
	});

	it("`keepAlive: Infinity` never times out a healthy connection", async function () {
		const sockets: FakeSocket[] = [];

		transport = createWebSocketTransport({
			url: "ws://ws.test",
			WebSocket: serverWith(1, 20, sockets) as never,
			keepAlive: Infinity,
			lazyCloseTimeout: Infinity,
		});

		const controller = new AbortController();
		const iterator = transport.subscribe({ query: "subscription { n }" }, controller.signal)[Symbol.asyncIterator]();

		await iterator.next();
		await sleep(100);

		expect(sockets).toHaveLength(1);
		expect(sockets[0]!.closes).not.toContain(4499);
		controller.abort();
	});
});
