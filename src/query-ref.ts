import type { DeepReadonly, FetchMoreOptions, FetchPolicy, QueryState, WatchOptions } from "./types";
import { isTimerDelay } from "./utils";

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
	/**
	 * Merges a page into the entry's newest real data and stores the result, atomically for the entry.
	 * Resolves `undefined` when the entry was invalidated since `since` or expired although data was `expected`.
	 */
	merge(
		next: TData,
		merge: (current: TData, next: TData) => TData,
		since: number,
		expected: boolean,
	): Promise<TData | undefined>;
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
	 * Teardowns for the cache registration, timers and event listeners installed while active (empty while inactive).
	 */
	readonly #teardowns: Array<() => void> = [];

	/**
	 * Incremented per fetch so out-of-order responses are ignored.
	 */
	#version = 0;

	/**
	 * Pending deactivation after the last listener left, cancelled if a listener subscribes meanwhile. Only ever
	 * passed to `clearTimeout`, which ignores a timer that already fired or was cleared.
	 */
	#deactivation: ReturnType<typeof setTimeout> | undefined;

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
	 * Number of times the cache pushed data to this query: a fetch completing after a push keeps the pushed data.
	 */
	#pushes = 0;

	/**
	 * Version of the refetch an invalidation started, while it runs: a page fetched meanwhile was requested against
	 * outdated data and must not supersede it.
	 */
	#refreshing = 0;

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

		if (this.#teardowns.length === 0) this.#activate();
		// Resubscribed during the deactivation grace period after an invalidation: catch up now.
		else if (this.#listeners.size === 1 && this.#stale) this.#refresh();

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
		const refreshing = this.#refreshing !== 0;

		this.#setState({ error: undefined, loading: true });

		/**
		 * Applies the caller's merge. Results are frozen: the readonly views handed to it are the same objects.
		 *
		 * @param current - The current (real) data
		 * @param page - The fetched page
		 * @returns The merged data
		 */
		function mergePage(current: TData, page: TData): TData {
			return options.merge(current as DeepReadonly<TData>, page as DeepReadonly<TData>) as TData;
		}

		try {
			const next = await this.#host.fetchMore(options.variables);

			if (version !== this.#version) return this.#state;

			// Started while an invalidation's refetch was running: the page belongs to outdated data, let a refetch win.
			if (refreshing) {
				this.#setState({ error: undefined, loading: false });
				if (this.#listeners.size > 0) this.#refresh();
				return this.#state;
			}

			const writes = this.#options.fetchPolicy !== "no-cache" && this.#host.hasCache();

			if (!writes) {
				// `no-cache` queries never touch the cache: the merged pages stay local to this ref, under any layers.
				const current = this.#host.real(this.#state.data);
				const merged = current === undefined ? next : mergePage(current, next);

				this.#optimistic = this.#host.optimistic();
				this.#setState({ data: this.#host.overlay(merged), error: undefined, loading: false });
				return this.#state;
			}

			const pushes = this.#pushes;
			const merged = await this.#host.merge(next, mergePage, startedAt, this.#state.data !== undefined);

			if (merged === undefined) {
				// The entry was invalidated (or expired) meanwhile: its pages are no longer trusted, let a refetch win.
				this.#stale = true;
				this.#setState({ error: undefined, loading: false });
				if (this.#listeners.size > 0) void this.refetch();
				return this.#state;
			}

			this.#optimistic = this.#host.optimistic();
			// The write pushed the merge (and anything newer) to this ref: keep it, never overwrite newer data.
			this.#setState({
				data: this.#pushes !== pushes ? this.#state.data : this.#host.overlay(merged),
				error: undefined,
				loading: false,
			});
		} catch (error) {
			if (version === this.#version) this.#setState({ error, loading: false });
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
				if (ref.#listeners.size === 0) ref.#deactivate();
			}, 0);
		};
	}

	/**
	 * Registers for cache events, fetches when needed and installs background refetch triggers.
	 */
	#activate(): void {
		const ref = this;
		const { pollInterval, refetchOnFocus, refetchOnReconnect, fetchPolicy } = this.#options;

		this.#teardowns.push(
			this.#host.register({
				receive(data: TData): void {
					ref.#pushes++;
					ref.#fetched = true;
					ref.#optimistic = ref.#host.optimistic();
					ref.#setState({ data, error: undefined });
				},
				current(): TData | undefined {
					return ref.#state.data;
				},
				replace(data: TData | undefined): void {
					ref.#pushes++;
					ref.#optimistic = ref.#host.optimistic();
					ref.#setState({ data });
				},
				invalidate(): void {
					ref.#stale = true;
					if (ref.#listeners.size > 0) ref.#refresh();
				},
			}),
		);

		// Catch up with anything that happened while inactive: newer cached data, invalidation or expiry.
		const cached = this.#host.peek();

		// Optimistic data shown before going inactive was never confirmed: once its layers settled, drop it.
		if (this.#optimistic && !this.#host.optimistic()) {
			this.#optimistic = false;
			this.#setState({ data: cached });
		}

		if (cached !== undefined) this.#setState({ data: cached });

		if (this.#host.invalidatedSince(this.#freshAsOf)) this.#stale = true;

		// `initialData` stands in for the cache only until the first fetch.
		const trustsCache = this.#host.hasCache() && (this.#options.initialData === undefined || this.#fetched);
		const missing = trustsCache ? cached === undefined : this.#state.data === undefined;

		const fetches = missing || this.#stale || fetchPolicy === "network-only" || fetchPolicy === "cache-and-network";

		// With data shown, `cache-and-network` revalidates as a refetch: its outcome (an error, `loading`) reaches the
		// state instead of being detached from it.
		const refreshes =
			this.#stale ||
			fetchPolicy === "network-only" ||
			(fetchPolicy === "cache-and-network" && this.#state.data !== undefined);

		if (fetches) {
			void this.#fetch(refreshes ? this.#refreshPolicy() : (fetchPolicy ?? "cache-first"));
		} else if (this.#state.loading) {
			// Data arrived (e.g. in the cache) between construction and activation (it is shown: nothing is missing),
			// nothing left to load.
			this.#setState({ loading: false });
		}

		// `Infinity` (or any delay an interval cannot hold, which would fire back to back) disables polling.
		if (isTimerDelay(pollInterval)) {
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
		const pushes = this.#pushes;

		this.#stale = false;
		this.#freshAsOf = this.#host.epoch();
		this.#setState({ loading: true });

		try {
			const data = await this.#host.fetch(fetchPolicy);

			if (version === this.#version) {
				this.#fetched = true;
				this.#optimistic = this.#host.optimistic();
				// Data pushed by the cache while fetching (this fetch's own result, a newer write, a rollback) is at
				// least as recent as the fetch's result: it wins.
				// A `no-cache` fetch is never stored, so nothing pushes its result: it always wins.
				const pushed = this.#pushes !== pushes && fetchPolicy !== "no-cache";

				this.#setState({ data: pushed ? this.#state.data : data, error: undefined, loading: false });
			}
		} catch (error) {
			if (version === this.#version) this.#setState({ error, loading: false });
		} finally {
			if (this.#refreshing === version) this.#refreshing = 0;
		}

		return this.#state;
	}

	/**
	 * Refetches because the data is outdated (invalidated), remembering it until that refetch settles.
	 */
	#refresh(): void {
		void this.refetch();
		this.#refreshing = this.#version;
	}

	/**
	 * Merges changes into the state (a new object) and notifies listeners, unless nothing changed.
	 *
	 * @param changes - The fields to change
	 */
	#setState(changes: Partial<QueryState<TData>>): void {
		const state = this.#state;
		const next = { ...state, ...changes };

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
