/**
 * Push-based async iterable: values pushed before being consumed are buffered.
 *
 * @template T - The value type
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
	/**
	 * Buffered values.
	 */
	private readonly values: T[] = [];

	/**
	 * Resolves the pending `next()` call, if any.
	 */
	private wake?: (() => void) | undefined;

	/**
	 * Failure to throw once the buffer drains.
	 */
	private failure?: { error: unknown };

	/**
	 * Whether the queue ended.
	 */
	private ended = false;

	/**
	 * Adds a value.
	 *
	 * @param value - The value
	 */
	push(value: T): void {
		if (this.ended) return;

		this.values.push(value);
		this.notify();
	}

	/**
	 * Ends the queue with an error, thrown after buffered values.
	 *
	 * @param error - The failure
	 */
	fail(error: unknown): void {
		if (this.ended) return;

		this.failure = { error };
		this.end();
	}

	/**
	 * Ends the queue after buffered values.
	 */
	end(): void {
		this.ended = true;
		this.notify();
	}

	/**
	 * Iterates buffered and future values.
	 *
	 * @yields Each value, in push order
	 */
	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		while (true) {
			if (this.values.length > 0) {
				yield this.values.shift()!;
				continue;
			}

			if (this.failure) throw this.failure.error;
			if (this.ended) return;

			const queue = this;

			await new Promise<void>(function wait(resolve): void {
				queue.wake = resolve;
			});
		}
	}

	/**
	 * Wakes the pending consumer.
	 */
	private notify(): void {
		const wake = this.wake;

		this.wake = undefined;
		wake?.();
	}
}
