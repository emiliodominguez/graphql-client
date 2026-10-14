import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { Client } from "../client";
import { createWebSocketTransport, type WebSocketTransport } from "./index";

/**
 * Minimal graphql-transport-ws server: acks authorized connections and ticks every 10ms per subscription.
 *
 * @returns The server, its URL and per-connection bookkeeping
 */
async function startServer() {
	const server = new WebSocketServer({ port: 0, handleProtocols: pickProtocol });
	const sockets: ServerSocket[] = [];
	const completed: string[] = [];

	server.on("connection", function handleConnection(socket) {
		const timers = new Map<string, ReturnType<typeof setInterval>>();

		sockets.push(socket);

		socket.on("message", function handleMessage(raw) {
			const message = JSON.parse(String(raw));

			if (message.type === "connection_init") {
				if (message.payload?.token !== "secret") return socket.close(4403, "Forbidden");

				return socket.send(JSON.stringify({ type: "connection_ack" }));
			}

			if (message.type === "subscribe") {
				let tick = 0;

				timers.set(
					message.id,
					setInterval(function sendTick() {
						socket.send(JSON.stringify({ id: message.id, type: "next", payload: { data: { tick: ++tick } } }));
					}, 10),
				);
			}

			if (message.type === "complete") {
				completed.push(message.id);
				clearInterval(timers.get(message.id));
			}
		});

		socket.on("close", function cleanup() {
			for (const timer of timers.values()) clearInterval(timer);
		});
	});

	await new Promise(function (resolve) {
		server.once("listening", resolve);
	});

	return { server, sockets, completed, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/**
 * Accepts the graphql-transport-ws subprotocol.
 *
 * @param protocols - Offered subprotocols
 * @returns The selected one
 */
function pickProtocol(protocols: Set<string>): string | false {
	return protocols.has("graphql-transport-ws") ? "graphql-transport-ws" : false;
}

let cleanup: Array<() => void> = [];

afterEach(function () {
	for (const run of cleanup) run();
	cleanup = [];
});

describe("WebSocket transport (real sockets)", function () {
	/**
	 * Builds a client against a fresh server.
	 *
	 * @param token - The token sent in connection params
	 * @returns The server and client
	 */
	async function setup(token = "secret") {
		const backend = await startServer();
		const transport: WebSocketTransport = createWebSocketTransport({
			url: backend.url,
			connectionParams: async function () {
				return { token };
			},
			retryDelay: function () {
				return 20;
			},
		});
		const client = new Client({ url: "http://unused", subscriptionTransport: transport });

		cleanup.push(function () {
			transport.dispose();
			backend.server.close();
		});

		return { ...backend, client };
	}

	it("streams results and completes server-side on break", async function () {
		const { client, completed } = await setup();
		const ticks: number[] = [];

		for await (const data of client.subscribe<{ tick: number }>({ query: "subscription { tick }" })) {
			ticks.push(data.tick);
			if (ticks.length === 3) break;
		}

		await new Promise(function (resolve) {
			setTimeout(resolve, 30);
		});

		expect(ticks).toEqual([1, 2, 3]);
		expect(completed).toEqual(["1"]);
	});

	it("reconnects and resubscribes when the server drops the connection", async function () {
		const { client, sockets } = await setup();
		const ticks: number[] = [];

		for await (const data of client.subscribe<{ tick: number }>({ query: "subscription { tick }" })) {
			ticks.push(data.tick);

			if (ticks.length === 2) sockets[0]!.terminate();
			if (ticks.length === 4) break;
		}

		expect(sockets).toHaveLength(2);
		expect(ticks.slice(2)).toEqual([1, 2]);
	});

	it("fails on authorization errors", async function () {
		const { client } = await setup("wrong");

		await expect(client.subscribe({ query: "subscription { tick }" }).next()).rejects.toThrow(
			"WebSocket closed with code 4403: Forbidden",
		);
	});
});
