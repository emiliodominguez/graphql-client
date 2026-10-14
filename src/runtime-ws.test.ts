// Runtime red-team: the WebSocket transport against REAL WebSocket implementations (Node 22's global undici
// WebSocket and the `ws` package recommended by the README) when a handshake fails.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WS, { WebSocketServer } from "ws";
import { Client } from "./client";
import { createWebSocketTransport, type WebSocketConstructor, type WebSocketTransport } from "./ws";

/**
 * A graphql-transport-ws server whose FIRST upgrade is destroyed (server restarting, LB hiccup, 401 at upgrade...).
 */
async function startFlakyServer() {
	let upgrades = 0;
	const server = http.createServer();
	const wss = new WebSocketServer({
		noServer: true,
		handleProtocols: function handleProtocols() {
			return "graphql-transport-ws";
		},
	});

	server.on("upgrade", function upgrade(req, socket, head) {
		if (++upgrades === 1) return void socket.destroy();

		wss.handleUpgrade(req, socket, head, function connected(ws) {
			ws.on("message", function message(raw) {
				const msg = JSON.parse(String(raw));

				if (msg.type === "connection_init") ws.send(JSON.stringify({ type: "connection_ack" }));
				if (msg.type === "subscribe") {
					ws.send(JSON.stringify({ type: "next", id: msg.id, payload: { data: { ok: true } } }));
					ws.send(JSON.stringify({ type: "complete", id: msg.id }));
				}
			});
		});
	});
	await new Promise<void>(function listen(resolve) {
		server.listen(0, "127.0.0.1", resolve);
	});

	return {
		url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
		upgrades: function getUpgrades() {
			return upgrades;
		},
		close: function close() {
			wss.close();
			server.closeAllConnections();
			server.close();
		},
	};
}

let cleanup: Array<() => void> = [];

afterEach(function () {
	for (const fn of cleanup.splice(0)) fn();
});

async function firstResult(transport: WebSocketTransport): Promise<unknown> {
	const client = new Client({ url: "http://unused.invalid", subscriptionTransport: transport });
	const controller = new AbortController();
	const timer = setTimeout(function abort() {
		controller.abort();
	}, 3_000);

	try {
		for await (const data of client.subscribe({ query: "subscription S { ok }", signal: controller.signal }))
			return data;

		return controller.signal.aborted ? "HUNG (no result, no error, no reconnect within 3s)" : "ended";
	} finally {
		clearTimeout(timer);
	}
}

describe("runtime: WebSocket transport handshake failures", function () {
	it("reconnects after a failed handshake with Node's global WebSocket (undici fires `error` but never `close`)", async function () {
		const server = await startFlakyServer();
		const transport = createWebSocketTransport({
			url: server.url,
			retryDelay: function retryDelay() {
				return 20;
			},
		});

		cleanup.push(server.close, transport.dispose);

		expect(await firstResult(transport)).toEqual({ ok: true });
		expect(server.upgrades()).toBe(2);
	}, 10_000);

	it("does not throw an unhandled 'error' event (process crash) with the `ws` package and reconnects", async function () {
		const server = await startFlakyServer();
		const uncaught: unknown[] = [];
		function capture(error: unknown) {
			uncaught.push(error);
		}

		// `ws` is an EventEmitter: an `error` event without a listener is thrown from inside a socket callback.
		process.prependListener("uncaughtException", capture);
		const transport = createWebSocketTransport({
			url: server.url,
			WebSocket: WS as unknown as WebSocketConstructor,
			retryDelay: function retryDelay() {
				return 20;
			},
		});

		cleanup.push(server.close, transport.dispose, function removeCapture() {
			process.removeListener("uncaughtException", capture);
		});

		const result = await firstResult(transport);

		expect(uncaught.map(String)).toEqual([]);
		expect(result).toEqual({ ok: true });
	}, 10_000);

	it("does not crash with the `ws` package when a subscription is aborted while the socket is still connecting", async function () {
		const server = await startFlakyServer();
		const uncaught: unknown[] = [];
		function capture(error: unknown) {
			uncaught.push(error);
		}

		process.prependListener("uncaughtException", capture);
		const transport = createWebSocketTransport({ url: server.url, WebSocket: WS as unknown as WebSocketConstructor });
		const client = new Client({ url: "http://unused.invalid", subscriptionTransport: transport });

		cleanup.push(server.close, transport.dispose, function removeCapture() {
			process.removeListener("uncaughtException", capture);
		});

		const controller = new AbortController();
		const iterator = client.subscribe({ query: "subscription S { ok }", signal: controller.signal });
		const next = iterator.next();

		controller.abort(); // lazy close -> ws.close() on a CONNECTING socket emits 'error'
		await next;
		await new Promise(function wait(resolve) {
			setTimeout(resolve, 200);
		});

		expect(uncaught.map(String)).toEqual([]);
	});
});
