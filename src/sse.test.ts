import { describe, expect, it, vi } from "vitest";
import { readServerSentEvents, type ServerSentEvent } from "./sse";

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
 * Collects every event of a stream.
 *
 * @param stream - The stream
 * @returns The events
 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<ServerSentEvent[]> {
	const events: ServerSentEvent[] = [];

	for await (const event of readServerSentEvents(stream)) events.push(event);

	return events;
}

describe("readServerSentEvents", function () {
	it("parses events, multi-line data and defaults the event type", async function () {
		const events = await collect(streamOf('event: next\ndata: {"a":1}\n\n', "data: line 1\ndata: line 2\n\n"));

		expect(events).toEqual([
			{ event: "next", data: '{"a":1}' },
			{ event: "message", data: "line 1\nline 2" },
		]);
	});

	it("handles events split across chunks and every line ending", async function () {
		const events = await collect(streamOf("event: ne", "xt\r", "\ndata: 1\r\n\r", "\nevent: next\rdata: 2\r\r"));

		expect(events).toEqual([
			{ event: "next", data: "1" },
			{ event: "next", data: "2" },
		]);
	});

	it("skips comments, unknown fields and empty blocks; keeps value-less fields", async function () {
		const events = await collect(streamOf(": keep-alive\n\nid: 1\nretry: 10\n\nevent: complete\ndata\n\n"));

		expect(events).toEqual([{ event: "complete", data: "" }]);
	});

	it("dispatches events without data", async function () {
		expect(await collect(streamOf("event: complete\n\n"))).toEqual([{ event: "complete", data: "" }]);
	});

	it("does not dispatch a trailing unterminated block", async function () {
		expect(await collect(streamOf("data: 1\n\ndata: 2"))).toEqual([{ event: "message", data: "1" }]);
	});

	it("cancels the stream when the consumer stops early", async function () {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: 1\n\ndata: 2\n\n"));
			},
			cancel,
		});

		for await (const event of readServerSentEvents(stream)) {
			expect(event.data).toBe("1");
			break;
		}

		expect(cancel).toHaveBeenCalled();
	});
});
