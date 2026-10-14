import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../client";
import { isClientError } from "../errors";
import { AsyncQueue } from "../async-queue";
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

	readyState = 0;
	readonly sent: Message[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: (event: { code: number; reason: string }) => void;
	closedWith?: { code: number; reason: string };

	/**
	 * @param url - The endpoint
	 * @param protocol - The subprotocol
	 */
	constructor(
		readonly url: string,
		readonly protocol: string,
	) {
		FakeSocket.instances.push(this);
	}

	/**
	 * Records a client message.
	 *
	 * @param data - Serialized message
	 */
	send(data: string): void {
		this.sent.push(JSON.parse(data));
	}

	/**
	 * Client-initiated close (event dispatched asynchronously, like browsers).
	 *
	 * @param code - Close code
	 * @param reason - Close reason
	 */
	close(code = 1000, reason = ""): void {
		if (this.readyState === 3) return;

		this.readyState = 3;
		this.closedWith = { code, reason };
		const socket = this;

		queueMicrotask(function dispatchClose() {
			socket.onclose?.({ code, reason });
		});
	}

	/**
	 * Server: accepts the connection.
	 */
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	/**
	 * Server: sends a message.
	 *
	 * @param message - The message, or raw text
	 */
	emit(message: Message | string): void {
		this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
	}

	/**
	 * Server: drops the connection.
	 *
	 * @param code - Close code
	 * @param reason - Close reason
	 */
	drop(code = 1006, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}

	/**
	 * Messages of a given type sent by the client.
	 *
	 * @param type - Message type
	 * @returns The messages
	 */
	sentOf(type: string): Message[] {
		return this.sent.filter(function (message) {
			return message.type === type;
		});
	}
}

const SUBSCRIPTION = "subscription OnTick { tick }";

/**
 * Creates a client backed by the WebSocket transport and the fake socket.
 *
 * @param options - Transport overrides
 * @returns The client and transport
 */
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

/**
 * Lets microtasks (and async onopen handlers) settle.
 */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Returns the latest socket.
 *
 * @returns The socket
 */
function latest(): FakeSocket {
	return FakeSocket.instances.at(-1)!;
}

/**
 * Opens and acknowledges the latest socket.
 *
 * @returns The socket
 */
async function accept(): Promise<FakeSocket> {
	const socket = latest();

	socket.open();
	await flush();
	socket.emit({ type: "connection_ack" });

	return socket;
}

/**
 * Starts collecting a subscription in the background.
 *
 * @param iterable - The subscription
 * @returns Collected values and the completion promise
 */
function collect<T>(iterable: AsyncIterable<T>) {
	const values: T[] = [];
	const done = (async function () {
		for await (const value of iterable) values.push(value);
	})();

	return { values, done };
}

beforeEach(function () {
	FakeSocket.instances = [];
});

afterEach(function () {
	vi.useRealTimers();
});

describe("WebSocket transport", function () {
	it("connects lazily, sends connection params and streams results", async function () {
		const { client } = setup({
			connectionParams: async function () {
				return { token: "t" };
			},
		});

		expect(FakeSocket.instances).toHaveLength(0);

		const { values, done } = collect(client.subscribe({ query: SUBSCRIPTION, variables: { every: 1 } }));

		await flush();

		const socket = latest();

		expect(socket.protocol).toBe("graphql-transport-ws");
		expect(socket.url).toBe("wss://test.dev/graphql");

		socket.open();
		await flush();
		expect(socket.sent[0]).toEqual({ type: "connection_init", payload: { token: "t" } });

		socket.emit({ type: "connection_ack" });

		const [subscribe] = socket.sentOf("subscribe");

		expect(subscribe).toEqual({
			id: "1",
			type: "subscribe",
			payload: { query: SUBSCRIPTION, variables: { every: 1 }, operationName: undefined },
		});

		socket.emit({ id: "1", type: "next", payload: { data: { tick: 1 } } });
		socket.emit({ id: "1", type: "next", payload: { data: { tick: 2 } } });
		socket.emit({ id: "1", type: "complete" });
		await done;

		expect(values).toEqual([{ tick: 1 }, { tick: 2 }]);
		expect(socket.sentOf("complete")).toHaveLength(0);
	});

	it("multiplexes subscriptions over one socket and ignores unknown ids", async function () {
		const { client } = setup();
		const first = collect(client.subscribe({ query: SUBSCRIPTION }));
		const second = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		expect(FakeSocket.instances).toHaveLength(1);
		expect(socket.sentOf("subscribe").map(getId)).toEqual(["1", "2"]);

		socket.emit({ id: "2", type: "next", payload: { data: { tick: "b" } } });
		socket.emit({ id: "1", type: "next", payload: { data: { tick: "a" } } });
		socket.emit({ id: "999", type: "next", payload: { data: { tick: "x" } } });
		socket.emit({ id: "999", type: "complete" });
		socket.emit({ id: "1", type: "complete" });
		socket.emit({ id: "2", type: "complete" });
		await Promise.all([first.done, second.done]);

		expect(first.values).toEqual([{ tick: "a" }]);
		expect(second.values).toEqual([{ tick: "b" }]);
	});

	it("sends subscribe immediately on an acknowledged socket", async function () {
		const { client } = setup({ lazyCloseTimeout: Infinity });
		const first = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();
		const second = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();
		expect(socket.sentOf("subscribe").map(getId)).toEqual(["1", "2"]);

		socket.emit({ id: "1", type: "complete" });
		socket.emit({ id: "2", type: "complete" });
		await Promise.all([first.done, second.done]);
	});

	it("turns server errors into ClientErrors without echoing complete", async function () {
		const { client } = setup();
		const iterator = client.subscribe({ query: SUBSCRIPTION });
		const pending = iterator.next();

		await flush();

		const socket = await accept();

		socket.emit({ id: "1", type: "error", payload: [{ message: "Unauthorized field" }] });

		const error = await pending.catch(function (reason: unknown) {
			return reason;
		});

		expect(isClientError(error)).toBe(true);
		expect(error).toMatchObject({ message: "Unauthorized field", status: 0, response: undefined });
		expect(socket.sentOf("complete")).toHaveLength(0);
	});

	it("sends complete when the consumer stops, then closes the idle socket", async function () {
		const { client } = setup();
		const controller = new AbortController();
		const { done } = collect(client.subscribe({ query: SUBSCRIPTION, signal: controller.signal }));

		await flush();

		const socket = await accept();

		controller.abort();
		await done;
		await new Promise(function (resolve) {
			setTimeout(resolve, 5);
		});

		expect(socket.sentOf("complete")).toEqual([{ id: "1", type: "complete" }]);
		expect(socket.closedWith).toEqual({ code: 1000, reason: "Normal Closure" });
	});

	it("keeps the socket open across quick resubscribes (lazyCloseTimeout)", async function () {
		vi.useFakeTimers();

		const { client } = setup({ lazyCloseTimeout: 1_000 });
		const controller = new AbortController();
		const first = collect(client.subscribe({ query: SUBSCRIPTION, signal: controller.signal }));

		await flush();

		const socket = await accept();

		controller.abort();
		await first.done;
		await vi.advanceTimersByTimeAsync(500);

		const second = collect(client.subscribe({ query: SUBSCRIPTION }));

		await vi.advanceTimersByTimeAsync(2_000);

		expect(socket.closedWith).toBeUndefined();
		expect(FakeSocket.instances).toHaveLength(1);

		socket.emit({ id: "2", type: "complete" });
		await second.done;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.closedWith?.code).toBe(1000);
	});

	it("reconnects with backoff and resubscribes active operations", async function () {
		const { client } = setup();
		const { values, done } = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const first = await accept();

		first.emit({ id: "1", type: "next", payload: { data: { tick: 1 } } });
		first.drop(1006);

		await new Promise(function (resolve) {
			setTimeout(resolve, 20);
		});

		const second = await accept();

		expect(FakeSocket.instances).toHaveLength(2);
		expect(second.sentOf("subscribe").map(getId)).toEqual(["1"]);

		second.emit({ id: "1", type: "next", payload: { data: { tick: 2 } } });
		second.emit({ id: "1", type: "complete" });
		await done;

		expect(values).toEqual([{ tick: 1 }, { tick: 2 }]);
	});

	it("fails subscriptions on fatal close codes", async function () {
		const { client } = setup();
		const iterator = client.subscribe({ query: SUBSCRIPTION });
		const pending = iterator.next();

		await flush();
		(await accept()).drop(4403, "Forbidden");

		await expect(pending).rejects.toThrow("WebSocket closed with code 4403: Forbidden");
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("gives up after the configured reconnect attempts", async function () {
		const { client } = setup({ retryAttempts: 2 });
		const pending = client.subscribe({ query: SUBSCRIPTION }).next();

		for (let attempt = 0; attempt < 3; attempt++) {
			await new Promise(function (resolve) {
				setTimeout(resolve, 15);
			});
			latest().drop(1006);
		}

		await expect(pending).rejects.toThrow("WebSocket closed with code 1006");
		expect(FakeSocket.instances).toHaveLength(3);
	});

	it("closes and retries when the server never acknowledges", async function () {
		vi.useFakeTimers();

		const { client } = setup({ connectionAckTimeout: 100 });
		void client.subscribe({ query: SUBSCRIPTION }).next();

		await vi.advanceTimersByTimeAsync(0);
		latest().open();
		await vi.advanceTimersByTimeAsync(100);

		expect(FakeSocket.instances[0]!.closedWith).toEqual({ code: 4499, reason: "Connection acknowledgement timeout" });

		await vi.advanceTimersByTimeAsync(10);
		expect(FakeSocket.instances).toHaveLength(2);
	});

	it("answers pings and enforces keep-alive pongs", async function () {
		vi.useFakeTimers();

		const { client } = setup({ keepAlive: 1_000 });
		void client.subscribe({ query: SUBSCRIPTION }).next();

		await vi.advanceTimersByTimeAsync(0);

		const socket = latest();

		socket.open();
		await vi.advanceTimersByTimeAsync(0);
		socket.emit({ type: "connection_ack" });
		socket.emit({ type: "ping" });

		expect(socket.sentOf("pong")).toHaveLength(1);
		expect(socket.sentOf("ping")).toHaveLength(1);

		socket.emit({ type: "pong" });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.sentOf("ping")).toHaveLength(2);
		expect(socket.closedWith).toBeUndefined();

		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.closedWith).toEqual({ code: 4499, reason: "Keep-alive timeout" });
	});

	it("closes with 4400 on malformed messages", async function () {
		const { client } = setup();
		void client
			.subscribe({ query: SUBSCRIPTION })
			.next()
			.catch(function () {});

		await flush();

		const socket = await accept();

		socket.emit("{not json");
		expect(socket.closedWith).toEqual({ code: 4400, reason: "Invalid message received" });
	});

	it("fails subscriptions when connection params throw", async function () {
		const { client } = setup({
			connectionParams: function () {
				throw new Error("no token");
			},
		});
		const pending = client.subscribe({ query: SUBSCRIPTION }).next();

		await flush();
		latest().open();

		await expect(pending).rejects.toThrow("no token");
		expect(latest().closedWith?.code).toBe(1000);
	});

	it("dispose completes subscriptions and rejects new ones", async function () {
		const { client, transport } = setup();
		const { done } = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();

		const socket = await accept();

		transport.dispose();
		await done;

		expect(socket.closedWith?.code).toBe(1000);
		await expect(client.subscribe({ query: SUBSCRIPTION }).next()).rejects.toThrow("disposed");
	});

	it("is only used for subscription operations", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { ok: true } });
		});
		const client = new Client({
			url: "https://test.dev/graphql",
			fetch: fetchMock,
			subscriptionTransport: createWebSocketTransport({ url: "wss://x", WebSocket: FakeSocket as never }),
		});

		for await (const data of client.subscribe({ query: "query Q { ok }" })) expect(data).toEqual({ ok: true });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(FakeSocket.instances).toHaveLength(0);
	});

	it("uses exponential backoff by default", async function () {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(1);

		const transport = createWebSocketTransport({ url: "wss://x", WebSocket: FakeSocket as never });
		const iterator = transport.subscribe({ query: SUBSCRIPTION }, new AbortController().signal)[Symbol.asyncIterator]();
		void iterator.next();

		await vi.advanceTimersByTimeAsync(0);
		latest().drop(1006);
		await vi.advanceTimersByTimeAsync(999);
		expect(FakeSocket.instances).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(FakeSocket.instances).toHaveLength(2);

		latest().drop(1006);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeSocket.instances).toHaveLength(3);
		transport.dispose();
		vi.restoreAllMocks();
	});
});

describe("WebSocket transport regressions", function () {
	it("ends immediately for an already-aborted signal without opening a socket", async function () {
		const { client } = setup();
		const result = await client.subscribe({ query: SUBSCRIPTION, signal: AbortSignal.abort() }).next();

		expect(result.done).toBe(true);
		expect(FakeSocket.instances).toHaveLength(0);
	});

	it("does not reconnect when every subscription ended before the retry timer", async function () {
		const { client } = setup({ lazyCloseTimeout: 0 });
		const controller = new AbortController();
		const { done } = collect(client.subscribe({ query: SUBSCRIPTION, signal: controller.signal }));

		await flush();
		(await accept()).drop(1006);
		controller.abort();
		await done;
		await new Promise(function (resolve) {
			setTimeout(resolve, 30);
		});

		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("closes an idle socket once acknowledged", async function () {
		const { client } = setup({ lazyCloseTimeout: 0 });
		const controller = new AbortController();
		const { done } = collect(client.subscribe({ query: SUBSCRIPTION, signal: controller.signal }));

		await flush();

		const socket = latest();

		socket.open();
		await flush();
		controller.abort();
		await done;
		socket.emit({ type: "connection_ack" });
		await new Promise(function (resolve) {
			setTimeout(resolve, 5);
		});

		expect(socket.closedWith?.code).toBe(1000);
	});

	it("gives new subscriptions a full retry budget after giving up", async function () {
		const { client } = setup({ retryAttempts: 1 });
		const first = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();
		latest().drop(1006);
		await new Promise(function (resolve) {
			setTimeout(resolve, 30);
		});
		latest().drop(1006);
		await first.done.catch(function () {});

		const before = FakeSocket.instances.length;
		const second = collect(client.subscribe({ query: SUBSCRIPTION }));

		await flush();
		latest().drop(1006);
		await new Promise(function (resolve) {
			setTimeout(resolve, 30);
		});

		expect(FakeSocket.instances.length - before).toBe(2);

		const socket = await accept();

		socket.emit({ id: "2", type: "complete" });
		await second.done;
	});
});

describe("AsyncQueue", function () {
	it("buffers values, then ends or fails after draining", async function () {
		const queue = new AsyncQueue<number>();

		queue.push(1);
		queue.push(2);
		queue.fail(new Error("boom"));
		queue.push(3);
		queue.end();

		const values: number[] = [];

		await expect(
			(async function () {
				for await (const value of queue) values.push(value);
			})(),
		).rejects.toThrow("boom");
		expect(values).toEqual([1, 2]);
	});
});

/**
 * Reads a message id.
 *
 * @param message - The message
 * @returns Its id
 */
function getId(message: Message): string | undefined {
	return message.id;
}
