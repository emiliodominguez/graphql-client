import type { FetchMoreOptions, FetchPolicy, QueryState, WatchOptions } from "./types";

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
	/** The data currently held by the watcher */
	current(): TData | undefined;
}

/**
 * Bridge between a {@link QueryRef} and its client.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface QueryHost<TData, TVariables> {
	/** Executes the query with the given policy */
	fetch(fetchPolicy: FetchPolicy): Promise<TData>;
	/** Reads the cache synchronously when the cache allows it */
	peek(): TData | undefined;
	/** Whether a cache is configured (so a missing entry means it was invalidated or expired) */
	hasCache(): boolean;
	/** Current invalidation epoch */
	epoch(): number;
	/** Whether this query's entry was invalidated after `epoch` */
	invalidatedSince(epoch: number): boolean;
	/** Starts receiving cache events; returns the unregister function */
	register(watcher: QueryWatcher<TData>): () => void;
	/** Fetches the same document with extra variables, bypassing the cache */
	fetchMore(variables: Partial<TVariables>): Promise<TData>;
	/** Stores data for this query's entry and notifies every watcher of it */
	write(data: TData): Promise<void>;
}

/**
 * An observable query: framework-agnostic state container behind `client.watch()` and the React hooks.
 *
 * - Fetches lazily when the first listener subscribes, and stops background work when the last one leaves.
 * - Keeps showing the previous data while refetching (stale-while-revalidate).
 * - Refetches automatically when its cache key is invalidated, on an interval, on window focus and on reconnect.
 * - Stays in sync with any other fetch or `client.write()` targeting the same key.
 * - Implements the Svelte store contract: `subscribe` emits the current state immediately, so `$query` just works.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export class QueryRef<TData, TVariables = Record<string, unknown>> {
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
	 * Set when invalidated while active but before a refetch could start.
	 */
	private stale = false;

	/**
	 * Invalidation epoch the current data is fresh as of. Compared on activation to detect missed invalidations.
	 */
	private freshAsOf: number;

	/**
	 * Whether a fetch ever succeeded (after which `initialData` no longer counts as fresh).
	 */
	private fetched = false;

	/**
	 * @param host - The client bridge
	 * @param options - Watch options
	 */
	constructor(
		private readonly host: QueryHost<TData, TVariables>,
		private readonly options: Pick<
			WatchOptions<TData, unknown>,
			"fetchPolicy" | "pollInterval" | "refetchOnFocus" | "refetchOnReconnect" | "initialData"
		>,
	) {
		const data = host.peek() ?? options.initialData;

		this.state = { data, error: undefined, loading: data === undefined };
		this.freshAsOf = host.epoch();
		this.getState = this.getState.bind(this);
		this.subscribe = this.subscribe.bind(this);
		this.refetch = this.refetch.bind(this);
		this.fetchMore = this.fetchMore.bind(this);
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
	 * Subscribes to state changes. The listener is called immediately with the current state, then on every
	 * change (Svelte store contract). The first subscriber activates the query.
	 *
	 * @param listener - Called with the current state and on every state change
	 * @returns The unsubscribe function
	 */
	subscribe(listener: QueryListener<TData>): () => void {
		if (this.listeners.has(listener)) {
			listener(this.state);
			return this.createUnsubscribe(listener);
		}

		this.listeners.add(listener);
		listener(this.state);

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
	 * Fetches another page (or any variable variation) and merges it into the current data. The merged result is
	 * written to this query's cache entry, so every consumer of it updates. Never rejects: failures land in `error`.
	 *
	 * @example
	 * await feed.fetchMore({
	 *   variables: { after: feed.getState().data?.posts.pageInfo.endCursor },
	 *   merge(previous, next) {
	 *     return { posts: { ...next.posts, edges: [...previous.posts.edges, ...next.posts.edges] } };
	 *   },
	 * });
	 *
	 * @param options - Variables to override and how to merge the result
	 * @returns The resulting state
	 */
	async fetchMore(options: FetchMoreOptions<TData, TVariables>): Promise<QueryState<TData>> {
		// Supersedes any in-flight refetch, whose older page must not overwrite the merged result.
		const version = ++this.version;

		this.setState({ data: this.state.data, error: undefined, loading: true });

		try {
			const next = await this.host.fetchMore(options.variables);

			if (version !== this.version) return this.state;

			const merged = this.state.data === undefined ? next : options.merge(this.state.data, next);

			await this.host.write(merged);
			this.setState({ data: merged, error: undefined, loading: false });
		} catch (error) {
			if (version === this.version) this.setState({ data: this.state.data, error, loading: false });
		}

		return this.state;
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
					ref.fetched = true;
					ref.setState({ data, error: undefined, loading: ref.state.loading });
				},
				current(): TData | undefined {
					return ref.state.data;
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

		if (this.host.invalidatedSince(this.freshAsOf)) this.stale = true;

		// `initialData` stands in for the cache only until the first fetch.
		const trustsCache = this.host.hasCache() && (this.options.initialData === undefined || this.fetched);
		const missing = trustsCache ? cached === undefined : this.state.data === undefined;

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

		// Invalidations were delivered directly while active; later ones are detected on reactivation.
		this.freshAsOf = this.host.epoch();
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
		this.freshAsOf = this.host.epoch();
		this.setState({ data: this.state.data, error: this.state.error, loading: true });

		try {
			const data = await this.host.fetch(fetchPolicy);

			if (version === this.version) {
				this.fetched = true;
				this.setState({ data, error: undefined, loading: false });
			}
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
