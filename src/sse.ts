/**
 * A parsed Server-Sent Event.
 */
export interface ServerSentEvent {
	/** Event type. Defaults to `message`. */
	event: string;
	/** Event payload (multi-line `data` fields joined by `\n`) */
	data: string;
}

/**
 * Reads a `text/event-stream` body as a sequence of events, per the WHATWG SSE parsing rules
 * (any line ending, multi-line data, comments). Cancels the stream when the consumer stops early.
 *
 * @param stream - The response body
 * @yields Every dispatched event
 */
export async function* readServerSentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let finished = false;

	try {
		while (!finished) {
			const { done, value } = await reader.read();

			finished = done;
			buffer = normalizeLineEndings(buffer + decoder.decode(value, { stream: !done }), done);

			let boundary = buffer.indexOf("\n\n");

			while (boundary !== -1) {
				const event = parseEvent(buffer.slice(0, boundary));

				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");

				if (event) yield event;
			}
		}
	} finally {
		if (!finished) await reader.cancel().catch(ignore);

		reader.releaseLock();
	}
}

/**
 * Converts CRLF and CR line endings to LF. A trailing CR is held back until the next chunk,
 * since it may be the first half of a CRLF pair.
 *
 * @param text - Buffered text
 * @param done - Whether the stream ended
 * @returns The normalized text
 */
function normalizeLineEndings(text: string, done: boolean): string {
	const hold = !done && text.endsWith("\r");
	const normalized = (hold ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");

	return hold ? `${normalized}\r` : normalized;
}

/**
 * Parses one event block.
 *
 * @param block - Lines between two blank lines
 * @returns The event, or `undefined` for comment-only or empty blocks
 */
function parseEvent(block: string): ServerSentEvent | undefined {
	let event: string | undefined;
	const data: string[] = [];

	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) continue;

		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}

	if (event === undefined && data.length === 0) return undefined;

	return { event: event || "message", data: data.join("\n") };
}

/**
 * Swallows a rejection.
 */
function ignore(): void {}
