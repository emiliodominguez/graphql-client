import type { FetchPolicy, QueryState, WatchOptions } from "./types";

/**
 * Listener notified on every state change.
 *
 * @template TData - The shape of the `data` field
 */
export type QueryListener<TData> = (state: QueryState<TData>) => void;

/**
 * Receives cache-level events for a watched key.
 *
 * @template TData - The shape of the `data` field
 */
export interface QueryWatcher<TData> {
	/** New data was fetched or written for this key elsewhere */
	receive(data: TData): void;
	/** The key was invalidated */
	invalidate(): void;
}

/**
 * Bridge between a {@link QueryRef} and its client.
 *
 * @template TData - The shape of the `data` field
 */
export interface QueryHost<TData> {
	/** Executes the query with the given policy */
	fetch(fetchPolicy: FetchPolicy): Promise<TData>;
	/** Reads the cache synchronously when the cache allows it */
	peek(): TData | undefined;
	/** Whether a cache is configured (so a missing entry means it was invalidated or expired) */
	hasCache(): boolean;
	/** Starts receiving cache events; returns the unregister function */
	register(watcher: QueryWatcher<TData>): () => void;
}

/**
 * An observable query: framework-agnostic state container behind `client.watch()` and the React hooks.
 *
 * - Fetches lazily when the first listener subscribes, and stops background work when the last one leaves.
 * - Keeps showing the previous data while refetching (stale-while-revalidate).
 * - Refetches automatically when its cache key is invalidated, on an interval, on window focus and on reconnect.
 * - Stays in sync with any other fetch or `client.write()` targeting the same key.
 *
 * @template TData - The shape of the `data` field
 */
export class QueryRef<TData> {
	/**
	 * Current state. Replaced (never mutated) on change, so it can back `useSyncExternalStore`.
	 */
	private state: QueryState<TData>;

	/**
	 * Active listeners.
	 */
	private readonly listeners = new Set<QueryListener<TData>>();

	/**
	 * Teardowns for timers and event listeners installed while active.
	 */
	private readonly teardowns: Array<() => void> = [];

	/**
	 * Incremented per fetch so out-of-order responses are ignored.
	 */
	private version = 0;

	/**
	 * Set when invalidated while inactive, so the next activation refetches.
	 */
	private stale = false;

	/**
	 * @param host - The client bridge
	 * @param options - Watch options
	 */
	constructor(
		private readonly host: QueryHost<TData>,
		private readonly options: Pick<
			WatchOptions<TData, unknown>,
			"fetchPolicy" | "pollInterval" | "refetchOnFocus" | "refetchOnReconnect" | "initialData"
		>,
	) {
		const data = host.peek() ?? options.initialData;

		this.state = { data, error: undefined, loading: data === undefined };
		this.getState = this.getState.bind(this);
		this.subscribe = this.subscribe.bind(this);
		this.refetch = this.refetch.bind(this);
	}

	/**
	 * Returns the current state snapshot.
	 *
	 * @returns The state
	 */
	getState(): QueryState<TData> {
		return this.state;
	}

	/**
	 * Subscribes to state changes. The first subscriber activates the query.
	 *
	 * @param listener - Called on every state change
	 * @returns The unsubscribe function
	 */
	subscribe(listener: QueryListener<TData>): () => void {
		this.listeners.add(listener);

		if (this.listeners.size === 1) this.activate();

		return this.createUnsubscribe(listener);
	}

	/**
	 * Fetches from the network, keeping the current data visible meanwhile. Never rejects: failures land in `error`.
	 *
	 * @returns The resulting state
	 */
	async refetch(): Promise<QueryState<TData>> {
		return this.fetch("network-only");
	}

	/**
	 * Builds the unsubscribe function for a listener.
	 *
	 * @param listener - The listener to remove
	 * @returns The unsubscribe function
	 */
	private createUnsubscribe(listener: QueryListener<TData>): () => void {
		const ref = this;

		return function unsubscribe(): void {
			if (!ref.listeners.delete(listener) || ref.listeners.size > 0) return;

			ref.deactivate();
		};
	}

	/**
	 * Registers for cache events, fetches when needed and installs background refetch triggers.
	 */
	private activate(): void {
		const ref = this;
		const { pollInterval, refetchOnFocus, refetchOnReconnect, fetchPolicy } = this.options;

		this.teardowns.push(
			this.host.register({
				receive(data: TData): void {
					ref.setState({ data, error: undefined, loading: ref.state.loading });
				},
				invalidate(): void {
					ref.stale = true;
					if (ref.listeners.size > 0) void ref.refetch();
				},
			}),
		);

		// Catch up with anything that happened while inactive: newer cached data, invalidation or expiry.
		const cached = this.host.peek();

		if (cached !== undefined) this.setState({ data: cached, error: this.state.error, loading: this.state.loading });

		const missing =
			this.host.hasCache() && this.options.initialData === undefined
				? cached === undefined
				: this.state.data === undefined;

		if (missing || this.stale || fetchPolicy === "network-only") {
			void this.fetch(this.stale || fetchPolicy === "network-only" ? "network-only" : (fetchPolicy ?? "cache-first"));
		}

		if (pollInterval) {
			const timer = setInterval(function poll(): void {
				if (!ref.state.loading) void ref.refetch();
			}, pollInterval);

			this.teardowns.push(function stopPolling(): void {
				clearInterval(timer);
			});
		}

		if (refetchOnFocus) this.listen(globalThis.document, "visibilitychange", isVisible);
		if (refetchOnReconnect) this.listen(globalThis, "online", always);
	}

	/**
	 * Removes every background trigger and cache registration.
	 */
	private deactivate(): void {
		for (const teardown of this.teardowns.splice(0)) teardown();
	}

	/**
	 * Refetches when an event fires and its condition holds, while active.
	 *
	 * @param target - Event target (skipped when unavailable, e.g. on the server)
	 * @param type - Event type
	 * @param condition - Extra condition evaluated per event
	 */
	private listen(target: EventTarget | undefined, type: string, condition: () => boolean): void {
		if (!target?.addEventListener) return;

		const ref = this;

		/**
		 * Refetches when the condition holds.
		 */
		function handle(): void {
			if (condition()) void ref.refetch();
		}

		target.addEventListener(type, handle);
		this.teardowns.push(function removeListener(): void {
			target.removeEventListener(type, handle);
		});
	}

	/**
	 * Runs a fetch and folds its outcome into the state.
	 *
	 * @param fetchPolicy - The fetch policy
	 * @returns The resulting state
	 */
	private async fetch(fetchPolicy: FetchPolicy): Promise<QueryState<TData>> {
		const version = ++this.version;

		this.stale = false;
		this.setState({ data: this.state.data, error: this.state.error, loading: true });

		try {
			const data = await this.host.fetch(fetchPolicy);

			if (version === this.version) this.setState({ data, error: undefined, loading: false });
		} catch (error) {
			if (version === this.version) this.setState({ data: this.state.data, error, loading: false });
		}

		return this.state;
	}

	/**
	 * Replaces the state and notifies listeners, unless nothing changed.
	 *
	 * @param next - The next state
	 */
	private setState(next: QueryState<TData>): void {
		const { state } = this;

		if (state.data === next.data && state.error === next.error && state.loading === next.loading) return;

		this.state = next;

		for (const listener of [...this.listeners]) listener(next);
	}
}

/**
 * Checks whether the document is visible.
 *
 * @returns `true` when visible
 */
function isVisible(): boolean {
	return globalThis.document?.visibilityState === "visible";
}

/**
 * Always-true condition.
 *
 * @returns `true`
 */
function always(): boolean {
	return true;
}
