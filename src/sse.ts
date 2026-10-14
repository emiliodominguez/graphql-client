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
 * @param signal - Cancels the stream when aborted, even if the body is not tied to a fetch
 * @yields Every dispatched event
 */
export async function* readServerSentEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = stream.getReader();
	const release = cancelOnAbort(reader, signal);
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
		release();

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
export function normalizeLineEndings(text: string, done: boolean): string {
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
 * Cancels a stream reader when a signal aborts, so pending reads settle.
 *
 * @param reader - The stream reader
 * @param signal - The abort signal
 * @returns Removes the abort listener
 */
export function cancelOnAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): () => void {
	/**
	 * Cancels the reader with the abort reason.
	 */
	function cancel(): void {
		reader.cancel(signal?.reason).catch(ignore);
	}

	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });

	return function release(): void {
		signal?.removeEventListener("abort", cancel);
	};
}

/**
 * Swallows a rejection.
 */
function ignore(): void {}
