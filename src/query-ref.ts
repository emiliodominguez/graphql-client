import type { DeepReadonly, FetchMoreOptions, FetchPolicy, QueryState, WatchOptions } from "./types";

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
	/** Replaces the shown data, even with `undefined` (e.g. when an optimistic layer it showed was removed) */
	replace(data: TData | undefined): void;
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
	/** Reads the entry, whatever the fetch policy */
	cached(): Promise<TData | undefined>;
	/** Whether a cache is configured (so a missing entry means it was invalidated or expired) */
	hasCache(): boolean;
	/** Whether the entry currently has pending optimistic layers */
	optimistic(): boolean;
	/** Current invalidation epoch */
	epoch(): number;
	/** Whether this query's entry was invalidated after `epoch` */
	invalidatedSince(epoch: number): boolean;
	/** Starts receiving cache events; returns the unregister function */
	register(watcher: QueryWatcher<TData>): () => void;
	/** Fetches the same document with extra variables, bypassing the cache */
	fetchMore(variables: Partial<TVariables> | undefined): Promise<TData>;
	/** Stores data for this query's entry and notifies every watcher of it */
	write(data: TData): Promise<void>;
	/** The real data under pending optimistic layers (or `visible` when there are none) */
	real(visible: TData | undefined): TData | undefined;
	/** Applies pending optimistic layers on top of real data */
	overlay(data: TData): TData;
	/** Reports an error thrown by a listener */
	report(error: unknown): void;
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
	#state: QueryState<TData>;

	/**
	 * Active listeners.
	 */
	readonly #listeners = new Set<QueryListener<TData>>();

	/**
	 * Teardowns for timers and event listeners installed while active.
	 */
	readonly #teardowns: Array<() => void> = [];

	/**
	 * Incremented per fetch so out-of-order responses are ignored.
	 */
	#version = 0;

	/**
	 * Pending deactivation after the last listener left, cancelled if a listener subscribes meanwhile.
	 */
	#deactivation: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Whether background work (cache registration, timers, event listeners) is installed.
	 */
	#active = false;

	/**
	 * Set when invalidated while active but before a refetch could start.
	 */
	#stale = false;

	/**
	 * Invalidation epoch the current data is fresh as of. Compared on activation to detect missed invalidations.
	 */
	#freshAsOf: number;

	/**
	 * Whether the shown data includes pending optimistic layers. Checked on activation: layers settled while this ref
	 * was inactive (and so not notified) must not stay visible.
	 */
	#optimistic: boolean;

	/**
	 * Whether a fetch ever succeeded (after which `initialData` no longer counts as fresh).
	 */
	#fetched = false;

	/**
	 * The client bridge.
	 */
	readonly #host: QueryHost<TData, TVariables>;

	/**
	 * Watch options.
	 */
	readonly #options: Pick<
		WatchOptions<TData, unknown>,
		"fetchPolicy" | "pollInterval" | "refetchOnFocus" | "refetchOnReconnect" | "initialData"
	>;

	/**
	 * @param host - The client bridge
	 * @param options - Watch options
	 */
	constructor(
		host: QueryHost<TData, TVariables>,
		options: Pick<
			WatchOptions<TData, unknown>,
			"fetchPolicy" | "pollInterval" | "refetchOnFocus" | "refetchOnReconnect" | "initialData"
		>,
	) {
		this.#host = host;
		this.#options = options;
		const data = host.peek() ?? options.initialData;

		this.#state = { data, error: undefined, loading: data === undefined };
		this.#freshAsOf = host.epoch();
		this.#optimistic = data !== undefined && host.optimistic();
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
		return this.#state;
	}

	/**
	 * Subscribes to state changes. The listener is called immediately with the current state, then on every
	 * change (Svelte store contract). The first subscriber activates the query.
	 *
	 * @param listener - Called with the current state and on every state change
	 * @returns The unsubscribe function
	 */
	subscribe(listener: QueryListener<TData>): () => void {
		if (this.#listeners.has(listener)) {
			this.#call(listener, this.#state);
			return this.#createUnsubscribe(listener);
		}

		this.#listeners.add(listener);
		this.#call(listener, this.#state);

		clearTimeout(this.#deactivation);
		this.#deactivation = undefined;

		if (!this.#active) this.#activate();
		// Resubscribed during the deactivation grace period after an invalidation: catch up now.
		else if (this.#listeners.size === 1 && this.#stale) void this.refetch();

		return this.#createUnsubscribe(listener);
	}

	/**
	 * Fetches from the network, keeping the current data visible meanwhile. Never rejects: failures land in `error`.
	 *
	 * @returns The resulting state
	 */
	async refetch(): Promise<QueryState<TData>> {
		return this.#fetch(this.#refreshPolicy());
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
		const version = ++this.#version;
		const startedAt = this.#host.epoch();

		this.#setState({ data: this.#state.data, error: undefined, loading: true });

		try {
			const next = await this.#host.fetchMore(options.variables);

			if (version !== this.#version) return this.#state;

			// Merge onto the real data: pending optimistic layers must stay layers, not become part of the pages.
			// Merge onto the entry's current data, not onto this ref's possibly outdated snapshot.
			const writes = this.#options.fetchPolicy !== "no-cache" && this.#host.hasCache();
			const entry = writes ? await this.#host.cached() : this.#state.data;

			if (
				writes &&
				(this.#host.invalidatedSince(startedAt) || (entry === undefined && this.#state.data !== undefined))
			) {
				// The entry was invalidated (or expired) meanwhile: its pages are no longer trusted, let a refetch win.
				this.#stale = true;
				this.#setState({ data: this.#state.data, error: undefined, loading: false });
				if (this.#listeners.size > 0) void this.refetch();
				return this.#state;
			}

			const current = this.#host.real(entry);
			// Results are frozen: the readonly views handed to `merge` are the same objects.
			const merged =
				current === undefined
					? next
					: (options.merge(current as DeepReadonly<TData>, next as DeepReadonly<TData>) as TData);

			// `no-cache` queries never touch the cache: keep the merged pages local to this ref.
			if (this.#options.fetchPolicy !== "no-cache") await this.#host.write(merged);

			this.#optimistic = this.#host.optimistic();
			this.#setState({ data: this.#host.overlay(merged), error: undefined, loading: false });
		} catch (error) {
			if (version === this.#version) this.#setState({ data: this.#state.data, error, loading: false });
		}

		return this.#state;
	}

	/**
	 * Builds the unsubscribe function for a listener.
	 *
	 * @param listener - The listener to remove
	 * @returns The unsubscribe function
	 */
	#createUnsubscribe(listener: QueryListener<TData>): () => void {
		const ref = this;

		return function unsubscribe(): void {
			if (!ref.#listeners.delete(listener) || ref.#listeners.size > 0) return;

			// Deactivate on the next tick: a listener handing over to another (StrictMode remounts, a promise
			// handing over to a component) keeps the query running instead of tearing it down and refetching.
			clearTimeout(ref.#deactivation);
			ref.#deactivation = setTimeout(function deactivateIdle(): void {
				ref.#deactivation = undefined;
				if (ref.#listeners.size === 0) ref.#deactivate();
			}, 0);
		};
	}

	/**
	 * Registers for cache events, fetches when needed and installs background refetch triggers.
	 */
	#activate(): void {
		const ref = this;

		this.#active = true;
		const { pollInterval, refetchOnFocus, refetchOnReconnect, fetchPolicy } = this.#options;

		this.#teardowns.push(
			this.#host.register({
				receive(data: TData): void {
					ref.#fetched = true;
					ref.#optimistic = ref.#host.optimistic();
					ref.#setState({ data, error: undefined, loading: ref.#state.loading });
				},
				current(): TData | undefined {
					return ref.#state.data;
				},
				replace(data: TData | undefined): void {
					ref.#optimistic = ref.#host.optimistic();
					ref.#setState({ data, error: ref.#state.error, loading: ref.#state.loading });
				},
				invalidate(): void {
					ref.#stale = true;
					if (ref.#listeners.size > 0) void ref.refetch();
				},
			}),
		);

		// Catch up with anything that happened while inactive: newer cached data, invalidation or expiry.
		const cached = this.#host.peek();

		// Optimistic data shown before going inactive was never confirmed: once its layers settled, drop it.
		if (this.#optimistic && !this.#host.optimistic()) {
			this.#optimistic = false;
			this.#setState({ data: cached, error: this.#state.error, loading: this.#state.loading });
		}

		if (cached !== undefined) this.#setState({ data: cached, error: this.#state.error, loading: this.#state.loading });

		if (this.#host.invalidatedSince(this.#freshAsOf)) this.#stale = true;

		// `initialData` stands in for the cache only until the first fetch.
		const trustsCache = this.#host.hasCache() && (this.#options.initialData === undefined || this.#fetched);
		const missing = trustsCache ? cached === undefined : this.#state.data === undefined;

		const fetches = missing || this.#stale || fetchPolicy === "network-only" || fetchPolicy === "cache-and-network";

		if (fetches) {
			void this.#fetch(
				this.#stale || fetchPolicy === "network-only" ? this.#refreshPolicy() : (fetchPolicy ?? "cache-first"),
			);
		} else if (this.#state.loading && this.#state.data !== undefined) {
			// Data arrived (e.g. in the cache) between construction and activation: nothing left to load.
			this.#setState({ data: this.#state.data, error: this.#state.error, loading: false });
		}

		if (pollInterval) {
			const timer = setInterval(function poll(): void {
				if (!ref.#state.loading && ref.#listeners.size > 0) void ref.refetch();
			}, pollInterval);

			this.#teardowns.push(function stopPolling(): void {
				clearInterval(timer);
			});
		}

		if (refetchOnFocus) this.#listen(globalThis.document, "visibilitychange", isVisible);
		if (refetchOnReconnect) this.#listen(globalThis, "online", always);
	}

	/**
	 * Removes every background trigger and cache registration.
	 */
	#deactivate(): void {
		this.#active = false;

		for (const teardown of this.#teardowns.splice(0)) teardown();

		// Invalidations were delivered directly while active; later ones are detected on reactivation.
		this.#freshAsOf = this.#host.epoch();
	}

	/**
	 * Refetches when an event fires and its condition holds, while active.
	 *
	 * @param target - Event target (skipped when unavailable, e.g. on the server)
	 * @param type - Event type
	 * @param condition - Extra condition evaluated per event
	 */
	#listen(target: EventTarget | undefined, type: string, condition: () => boolean): void {
		if (!target?.addEventListener) return;

		const ref = this;

		/**
		 * Refetches when the condition holds.
		 */
		function handle(): void {
			if (condition() && ref.#listeners.size > 0) void ref.refetch();
		}

		target.addEventListener(type, handle);
		this.#teardowns.push(function removeListener(): void {
			target.removeEventListener(type, handle);
		});
	}

	/**
	 * Policy for refetches (manual, polling, focus, reconnect, invalidation): bypass the cache read, unless the
	 * query must not touch the network (`cache-only`) or the cache (`no-cache`).
	 *
	 * @returns The fetch policy
	 */
	#refreshPolicy(): FetchPolicy {
		const { fetchPolicy } = this.#options;

		return fetchPolicy === "cache-only" || fetchPolicy === "no-cache" ? fetchPolicy : "network-only";
	}

	/**
	 * Runs a fetch and folds its outcome into the state.
	 *
	 * @param fetchPolicy - The fetch policy
	 * @returns The resulting state
	 */
	async #fetch(fetchPolicy: FetchPolicy): Promise<QueryState<TData>> {
		const version = ++this.#version;

		this.#stale = false;
		this.#freshAsOf = this.#host.epoch();
		this.#setState({ data: this.#state.data, error: this.#state.error, loading: true });

		try {
			const data = await this.#host.fetch(fetchPolicy);

			if (version === this.#version) {
				this.#fetched = true;
				this.#optimistic = this.#host.optimistic();
				this.#setState({ data, error: undefined, loading: false });
			}
		} catch (error) {
			if (version === this.#version) this.#setState({ data: this.#state.data, error, loading: false });
		}

		return this.#state;
	}

	/**
	 * Replaces the state and notifies listeners, unless nothing changed.
	 *
	 * @param next - The next state
	 */
	#setState(next: QueryState<TData>): void {
		const state = this.#state;

		if (state.data === next.data && state.error === next.error && state.loading === next.loading) return;

		this.#state = next;

		for (const listener of [...this.#listeners]) this.#call(listener, next);
	}

	/**
	 * Calls a listener. A throwing listener is reported, never allowed to break the query, the other listeners or
	 * the operation that produced the state (e.g. an unrelated request writing the shared entry).
	 *
	 * @param listener - The listener
	 * @param state - The state to deliver
	 */
	#call(listener: QueryListener<TData>, state: QueryState<TData>): void {
		try {
			listener(state);
		} catch (error) {
			this.#host.report(error);
		}
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
