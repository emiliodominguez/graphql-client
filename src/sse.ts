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
	for await (const [block] of readDelimited(stream, "\n\n", signal)) {
		const event = parseEvent(block);

		if (event) yield event;
	}
}

/**
 * Splits a text stream on a delimiter, normalizing line endings to LF. Linear in the body size: each chunk is
 * normalized and searched once (plus a small overlap), and chunks are only joined once a delimiter is found.
 * Text after the last delimiter is dropped when the stream ends. Cancels the stream when the consumer stops early.
 *
 * @param stream - The response body
 * @param delimiter - The delimiter (at least two characters, in normalized form)
 * @param signal - Cancels the stream when aborted, even if the body is not tied to a fetch
 * @param initial - Text considered to precede the body
 * @yields Each delimited segment, with the (possibly partial) text received after its delimiter
 */
export async function* readDelimited(
	stream: ReadableStream<Uint8Array>,
	delimiter: string,
	signal?: AbortSignal,
	initial = "",
): AsyncGenerator<[segment: string, rest: string]> {
	const reader = stream.getReader();
	const release = cancelOnAbort(reader, signal);
	const decoder = new TextDecoder();
	const overlap = delimiter.length - 1;
	let chunks = [initial];
	let tail = initial.slice(-overlap);
	let carry = false;
	let finished = false;

	try {
		while (!finished) {
			const { done, value } = await reader.read();
			// A trailing CR may be the first half of a CRLF pair: it is held back until the next chunk.
			let text: string = (carry ? "\r" : "") + decoder.decode(value, { stream: !done });

			finished = done;
			carry = !done && text.endsWith("\r");
			text = (carry ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");

			if ((tail + text).indexOf(delimiter) === -1) {
				chunks.push(text);
				tail = (tail + text).slice(-overlap);
				continue;
			}

			let buffer = chunks.join("") + text;
			let index = buffer.indexOf(delimiter);

			while (index !== -1) {
				const rest = buffer.slice(index + delimiter.length);

				yield [buffer.slice(0, index), rest];

				buffer = rest;
				index = buffer.indexOf(delimiter);
			}

			chunks = [buffer];
			tail = buffer.slice(-overlap);
		}
	} finally {
		release();

		if (!finished) await reader.cancel().catch(ignore);

		reader.releaseLock();
	}
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
