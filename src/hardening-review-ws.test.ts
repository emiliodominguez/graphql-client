import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketTransport, type WebSocketLike } from "./ws/index";

/**
 * WebSocket transport. Every test asserts the CORRECT behavior.
 */

/**
 * A socket whose peer vanished (no FIN, e.g. a laptop waking up on another network): `close()` starts the closing
 * handshake, but the `close` event only arrives once the OS gives up on the TCP connection, minutes later.
 */
class DeadPeerSocket implements WebSocketLike {
	static instances: DeadPeerSocket[] = [];

	readyState = 0;
	readonly sent: Array<{ type: string }> = [];
	onopen: ((event: never) => unknown) | null = null;
	onmessage: ((event: never) => unknown) | null = null;
	onclose: ((event: never) => unknown) | null = null;
	onerror: ((event: never) => unknown) | null = null;

	constructor(readonly url: string) {
		DeadPeerSocket.instances.push(this);

		const socket = this;

		setTimeout(function open() {
			socket.readyState = 1;
			(socket.onopen as (() => void) | null)?.();
		}, 0);
	}

	send(data: string): void {
		const message = JSON.parse(data) as { type: string };

		this.sent.push(message);

		// The server acknowledges, then the network dies: pings are never answered.
		if (message.type === "connection_init") {
			const socket = this;

			setTimeout(function ack() {
				(socket.onmessage as ((event: { data: string }) => void) | null)?.({
					data: JSON.stringify({ type: "connection_ack" }),
				});
			}, 0);
		}
	}

	close(): void {
		// Closing handshake started, never completed.
		this.readyState = 2;
	}
}

afterEach(function () {
	DeadPeerSocket.instances = [];
});

describe("keep-alive on a dead connection", function () {
	it("reconnects once a ping goes unanswered, without waiting for the close event of the dead socket", async function () {
		const transport = createWebSocketTransport({
			url: "wss://hardening.test/graphql",
			WebSocket: DeadPeerSocket,
			keepAlive: 20,
			retryDelay: function () {
				return 0;
			},
		});
		const controller = new AbortController();
		const iterator = transport.subscribe({ query: "subscription { tick }" }, controller.signal)[Symbol.asyncIterator]();

		// Fails once the retries are exhausted: only the reconnects matter here.
		iterator.next().catch(function ignore() {});

		await new Promise(function (resolve) {
			setTimeout(resolve, 200);
		});

		// graphql-ws terminates (treats the socket as closed with 4499) at once for exactly this reason.
		expect(DeadPeerSocket.instances.length).toBeGreaterThan(1);

		controller.abort();
		transport.dispose();
	});
});

describe("connection acknowledgement timeout", function () {
	it("reconnects without waiting for the close event of a socket that never acknowledged", async function () {
		/**
		 * A socket that opens but never acknowledges, and never completes a close.
		 */
		class SilentSocket extends DeadPeerSocket {
			override send(data: string): void {
				this.sent.push(JSON.parse(data) as { type: string });
			}
		}

		const transport = createWebSocketTransport({
			url: "wss://hardening.test/graphql",
			WebSocket: SilentSocket,
			connectionAckTimeout: 20,
			retryDelay: function noDelay() {
				return 0;
			},
		});
		const controller = new AbortController();
		const iterator = transport.subscribe({ query: "subscription { tick }" }, controller.signal)[Symbol.asyncIterator]();

		// Fails once the retries are exhausted: only the reconnects matter here.
		iterator.next().catch(function ignore() {});

		await new Promise(function wait(resolve) {
			setTimeout(resolve, 200);
		});

		expect(DeadPeerSocket.instances.length).toBeGreaterThan(1);

		controller.abort();
		transport.dispose();
	});
});
