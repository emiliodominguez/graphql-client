import type {
	GraphQLFormattedError,
	GraphQLResponse,
	MaybePromise,
	SubscriptionRequest,
	SubscriptionTransport,
} from "../types";
import { AsyncQueue } from "../async-queue";
import { resolveValue } from "../utils";

/**
 * Subprotocol of the `graphql-ws` library ("GraphQL over WebSocket").
 *
 * @see https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md
 */
const PROTOCOL = "graphql-transport-ws";

/**
 * Close codes that must not trigger a reconnect: protocol violations, auth failures, duplicate subscribers.
 * Other codes (network loss, server restarts, ack/pong timeouts) reconnect.
 */
const FATAL_CLOSE_CODES = new Set([1002, 1003, 4400, 4401, 4403, 4406, 4409, 4429]);

/**
 * Close code used when the client gives up on an unresponsive server (retryable).
 */
const TERMINATED = 4499;

/**
 * Configuration for {@link createWebSocketTransport}.
 */
export interface WebSocketTransportOptions {
	/** WebSocket endpoint (`ws://` or `wss://`) */
	url: string;
	/** Sent with `connection_init` (typically auth). Evaluated on every (re)connect. */
	connectionParams?: (Record<string, unknown> | (() => MaybePromise<Record<string, unknown> | undefined>)) | undefined;
	/** WebSocket implementation. Defaults to `globalThis.WebSocket`. */
	WebSocket?: WebSocketConstructor | undefined;
	/** Close the socket this many milliseconds after the last subscription ends. `Infinity` keeps it open. Defaults to `0`. */
	lazyCloseTimeout?: number | undefined;
	/** Maximum consecutive reconnect attempts before failing active subscriptions. Defaults to `5`. */
	retryAttempts?: number | undefined;
	/** Delay before a reconnect attempt (1-based). Defaults to exponential backoff with jitter, capped at 30s. */
	retryDelay?: ((attempt: number) => number) | undefined;
	/** Fail the connection when `connection_ack` takes longer than this. Defaults to `10_000`. */
	connectionAckTimeout?: number | undefined;
	/** Send a ping at this interval and reconnect if the previous one got no pong. Disabled by default. */
	keepAlive?: number | undefined;
}

/**
 * Minimal WebSocket constructor contract (browser, Node 22+, `ws`, React Native...).
 */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocket;

/**
 * A WebSocket transport, usable as `subscriptionTransport`.
 */
export interface WebSocketTransport extends SubscriptionTransport {
	/** Closes the socket and completes every active subscription. The transport cannot be reused. */
	dispose(): void;
}

/**
 * Message sent or received on the socket.
 */
interface Message {
	type: string;
	id?: string | undefined;
	payload?: unknown | undefined;
}

/**
 * Receives the messages of one subscription.
 */
interface Sink {
	/** The operation, re-sent after reconnects */
	request: SubscriptionRequest;
	/** Delivers a result */
	next(result: GraphQLResponse<unknown>): void;
	/** Fails the subscription */
	error(error: unknown): void;
	/** Ends the subscription */
	complete(): void;
}

/**
 * Creates a WebSocket transport speaking the `graphql-transport-ws` protocol (the `graphql-ws` library, supported by
 * Apollo Server, GraphQL Yoga, Hasura, Mercurius, Hot Chocolate...). One socket is shared by every subscription.
 *
 * @example
 * const client = new Client({
 *   url: "https://api.example.com/graphql",
 *   subscriptionTransport: createWebSocketTransport({
 *     url: "wss://api.example.com/graphql",
 *     connectionParams: async function () { return { authorization: await getToken() }; },
 *   }),
 * });
 *
 * @param options - Transport options
 * @returns The transport
 */
export function createWebSocketTransport(options: WebSocketTransportOptions): WebSocketTransport {
	const {
		url,
		connectionParams,
		lazyCloseTimeout = 0,
		retryAttempts = 5,
		retryDelay = defaultRetryDelay,
		connectionAckTimeout = 10_000,
		keepAlive = 0,
	} = options;
	const sinks = new Map<string, Sink>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let socket: WebSocket | undefined;
	let acknowledged = false;
	let awaitingPong = false;
	let attempt = 0;
	let nextId = 0;
	let disposed = false;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Serializes and sends a message when the socket is open.
	 *
	 * @param target - The socket
	 * @param message - The message
	 */
	function send(target: WebSocket, message: Message): void {
		if (target.readyState === 1) target.send(JSON.stringify(message));
	}

	/**
	 * Schedules a tracked timer, cleared on close and dispose.
	 *
	 * @param callback - The callback
	 * @param ms - Delay in milliseconds
	 * @returns The timer
	 */
	function schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
		const timer = setTimeout(function run(): void {
			timers.delete(timer);
			callback();
		}, ms);

		timers.add(timer);

		return timer;
	}

	/**
	 * Clears every tracked timer.
	 */
	function clearTimers(): void {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	}

	/**
	 * Opens the socket if needed. Subscriptions are (re)sent once the server acknowledges the connection.
	 */
	function connect(): void {
		// A reconnect timer may fire after every subscription ended: nothing left to connect for.
		if (socket || disposed || sinks.size === 0) return;

		const Implementation = options.WebSocket ?? globalThis.WebSocket;
		const current = new Implementation(url, PROTOCOL);

		socket = current;
		acknowledged = false;

		current.onopen = async function handleOpen(): Promise<void> {
			try {
				const payload = connectionParams === undefined ? undefined : await resolveValue(connectionParams);

				send(current, { type: "connection_init", payload });
				schedule(function ackTimeout(): void {
					if (!acknowledged) current.close(TERMINATED, "Connection acknowledgement timeout");
				}, connectionAckTimeout);
			} catch (error) {
				failAll(error);
				current.close(1000, "Invalid connection params");
			}
		};

		current.onmessage = function handleMessage(event: MessageEvent): void {
			let message: Message;

			try {
				message = JSON.parse(String(event.data)) as Message;
			} catch {
				current.close(4400, "Invalid message received");
				return;
			}

			receive(current, message);
		};

		current.onclose = function handleClose(event: CloseEvent): void {
			closed(current, event);
		};
	}

	/**
	 * Handles a server message.
	 *
	 * @param target - The socket it came from
	 * @param message - The message
	 */
	function receive(target: WebSocket, message: Message): void {
		const sink = message.id === undefined ? undefined : sinks.get(message.id);

		switch (message.type) {
			case "connection_ack":
				acknowledged = true;
				attempt = 0;
				clearTimers();

				for (const [id, active] of sinks) send(target, { id, type: "subscribe", payload: active.request });

				if (keepAlive > 0) ping(target, false);

				scheduleLazyClose();
				break;
			case "ping":
				send(target, { type: "pong" });
				break;
			case "pong":
				awaitingPong = false;
				break;
			case "next":
				sink?.next(message.payload as GraphQLResponse<unknown>);
				break;
			case "error":
			case "complete":
				if (!sink) break;

				// The server ended the operation: forget it first so no `complete` is echoed back.
				sinks.delete(message.id!);

				if (message.type === "error") sink.next({ errors: message.payload as GraphQLFormattedError[] });

				sink.complete();
				scheduleLazyClose();
				break;
		}
	}

	/**
	 * Keep-alive loop: closes (and so reconnects) when the previous ping went unanswered.
	 *
	 * @param target - The socket
	 * @param check - Whether to verify the previous pong
	 */
	function ping(target: WebSocket, check: boolean): void {
		if (check && awaitingPong) {
			target.close(TERMINATED, "Keep-alive timeout");
			return;
		}

		awaitingPong = true;
		send(target, { type: "ping" });
		schedule(function nextPing(): void {
			ping(target, true);
		}, keepAlive);
	}

	/**
	 * Handles a closed socket: reconnects or fails the active subscriptions.
	 *
	 * @param target - The closed socket
	 * @param event - The close event
	 */
	function closed(target: WebSocket, event: CloseEvent): void {
		if (socket !== target) return;

		socket = undefined;
		awaitingPong = false;
		clearTimers();

		if (disposed || sinks.size === 0) return;

		if (FATAL_CLOSE_CODES.has(event.code) || attempt >= retryAttempts) {
			failAll(new Error(`WebSocket closed with code ${event.code}${event.reason ? `: ${event.reason}` : ""}`));
			return;
		}

		schedule(connect, retryDelay(++attempt));
	}

	/**
	 * Fails and removes every active subscription.
	 *
	 * @param error - The failure
	 */
	function failAll(error: unknown): void {
		const active = [...sinks.values()];

		// Give the next subscription a full retry budget.
		attempt = 0;
		sinks.clear();

		for (const sink of active) sink.error(error);
	}

	/**
	 * Closes the socket once no subscription is left, after `lazyCloseTimeout`.
	 */
	function scheduleLazyClose(): void {
		if (sinks.size > 0 || !socket || lazyCloseTimeout === Infinity) return;

		clearTimeout(closeTimer);
		closeTimer = setTimeout(function closeIdle(): void {
			if (sinks.size === 0 && socket) {
				const idle = socket;

				socket = undefined;
				clearTimers();
				idle.close(1000, "Normal Closure");
			}
		}, lazyCloseTimeout);
	}

	return {
		async *subscribe(request: SubscriptionRequest, signal: AbortSignal): AsyncGenerator<GraphQLResponse<unknown>> {
			if (disposed) throw new Error("WebSocket transport has been disposed.");
			if (signal.aborted) return;

			const id = String(++nextId);
			const queue = new AsyncQueue<GraphQLResponse<unknown>>();

			/**
			 * Ends the stream when the consumer aborts.
			 */
			function abort(): void {
				queue.end();
			}

			sinks.set(id, {
				request,
				next: queue.push.bind(queue),
				error: queue.fail.bind(queue),
				complete: queue.end.bind(queue),
			});
			signal.addEventListener("abort", abort, { once: true });
			clearTimeout(closeTimer);

			if (socket && acknowledged) send(socket, { id, type: "subscribe", payload: request });
			else connect();

			try {
				yield* queue;
			} finally {
				signal.removeEventListener("abort", abort);

				if (sinks.delete(id) && socket && acknowledged) send(socket, { id, type: "complete" });

				scheduleLazyClose();
			}
		},
		dispose(): void {
			disposed = true;
			clearTimers();
			clearTimeout(closeTimer);

			const active = [...sinks.values()];

			sinks.clear();

			for (const sink of active) sink.complete();

			socket?.close(1000, "Normal Closure");
			socket = undefined;
		},
	};
}

/**
 * Default reconnect delay: exponential backoff with equal jitter, capped at 30s.
 *
 * @param attempt - 1-based attempt number
 * @returns Delay in milliseconds
 */
function defaultRetryDelay(attempt: number): number {
	const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);

	return base / 2 + Math.random() * (base / 2);
}
