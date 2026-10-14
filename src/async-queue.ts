/**
 * Push-based async iterable: values pushed before being consumed are buffered.
 *
 * @template T - The value type
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
	/**
	 * Buffered values.
	 */
	readonly #values: T[] = [];

	/**
	 * Resolves the pending `next()` call, if any.
	 */
	#wake?: (() => void) | undefined;

	/**
	 * Failure to throw once the buffer drains.
	 */
	#failure?: { error: unknown };

	/**
	 * Whether the queue ended.
	 */
	#ended = false;

	/**
	 * Maximum number of buffered values.
	 */
	readonly #limit: number;

	/**
	 * @param limit - Maximum number of buffered values: a producer outpacing its consumer fails the queue instead of
	 * growing memory without bound
	 */
	constructor(limit = Infinity) {
		this.#limit = limit;
	}

	/**
	 * Adds a value.
	 *
	 * @param value - The value
	 */
	push(value: T): void {
		if (this.#ended) return;

		if (this.#values.length >= this.#limit) {
			this.fail(new RangeError(`More than ${this.#limit} results are waiting: the consumer is too slow.`));
			return;
		}

		this.#values.push(value);
		this.#notify();
	}

	/**
	 * Ends the queue with an error, thrown after buffered values.
	 *
	 * @param error - The failure
	 */
	fail(error: unknown): void {
		if (this.#ended) return;

		this.#failure = { error };
		this.end();
	}

	/**
	 * Ends the queue after buffered values.
	 */
	end(): void {
		this.#ended = true;
		this.#notify();
	}

	/**
	 * Ends the queue immediately, dropping buffered values (the consumer is no longer interested).
	 */
	discard(): void {
		this.#values.length = 0;
		this.end();
	}

	/**
	 * Iterates buffered and future values.
	 *
	 * @yields Each value, in push order
	 */
	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		while (true) {
			if (this.#values.length > 0) {
				yield this.#values.shift()!;
				continue;
			}

			if (this.#failure) throw this.#failure.error;
			if (this.#ended) return;

			const queue = this;

			await new Promise<void>(function wait(resolve): void {
				queue.#wake = resolve;
			});
		}
	}

	/**
	 * Wakes the pending consumer.
	 */
	#notify(): void {
		const wake = this.#wake;

		this.#wake = undefined;
		wake?.();
	}
}
