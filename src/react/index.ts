import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactElement,
	type ReactNode,
} from "react";
import type { Client } from "../client";
import type { QueryRef } from "../query-ref";
import type {
	FetchMoreOptions,
	QueryState,
	RequestOptions,
	SubscribeOptions,
	RequiredKeys,
	TypedDocumentString,
	WatchOptions,
	WithSkippableVariables,
	WithVariables,
} from "../types";
import { stableStringify } from "../utils";

/**
 * React context carrying the client.
 */
const ClientContext = createContext<Client | null>(null);

/**
 * Settled or pending suspense requests per client, keyed by query identity.
 */
const suspenseCache = new WeakMap<Client, Map<string, SuspenseEntry>>();

/**
 * State returned while a query is skipped.
 */
const SKIPPED: QueryState<never> = Object.freeze({ data: undefined, error: undefined, loading: false });

/**
 * A suspense request.
 */
interface SuspenseEntry {
	/** The live query loading while suspended, adopted by the component once it can render */
	ref: QueryRef<unknown, unknown>;
	/** Resolves once `ref` has data or failed, thrown to suspend */
	promise: Promise<void>;
	/** Failure of the initial load, thrown to the nearest error boundary */
	error?: unknown | undefined;
	/** Whether the initial load failed */
	failed: boolean;
	/** Stops the entry's own subscription, which keeps the query active until its component subscribes */
	release(): void;
}

/**
 * A query executed by {@link useLazyQuery}, bound to the client and document it was executed with.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
interface LazyExecution<TData, TVariables> {
	/** The client that executed it */
	client: Client;
	/** The executed document */
	query: string;
	/** The live query */
	ref: QueryRef<TData, TVariables>;
}

/**
 * How long a failed suspense entry outlives the render that threw it, covering React's error-recovery render.
 */
const FAILURE_RETENTION = 100;

/**
 * How long a settled suspense entry waits for its component to mount before being dropped.
 */
const SUSPENSE_RETENTION = 10_000;

/**
 * Props of {@link GraphQLProvider}.
 */
export interface GraphQLProviderProps {
	/** The client exposed to the tree */
	client: Client;
	/** The tree */
	children?: ReactNode | undefined;
}

/**
 * Options for {@link useQuery} and {@link useSuspenseQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseQueryOptions<TData, TVariables> extends WatchOptions<TData, TVariables> {
	/** Skip the query entirely (no fetch, no subscription) */
	skip?: boolean | undefined;
	/**
	 * While the variables (or document) change, keep showing the previous data until the new data arrives,
	 * instead of an empty loading state. `isPreviousData` tells when it is shown.
	 */
	keepPreviousData?: boolean | undefined;
}

/**
 * Result of {@link useQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseQueryResult<TData, TVariables = Record<string, unknown>> extends QueryState<TData> {
	/** Refetches from the network, keeping current data visible. Never rejects. */
	refetch(): Promise<QueryState<TData>>;
	/** Fetches another page and merges it into the data (pagination). Never rejects. */
	fetchMore(options: FetchMoreOptions<TData, TVariables>): Promise<QueryState<TData>>;
	/** Whether `data` belongs to the previous variables (see `keepPreviousData`) */
	isPreviousData: boolean;
}

/**
 * Result of {@link useSuspenseQuery}: `data` is always defined.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseSuspenseQueryResult<TData, TVariables = Record<string, unknown>> extends UseQueryResult<
	TData,
	TVariables
> {
	/** The query data */
	data: TData;
}

/**
 * State of a mutation hook.
 *
 * @template TData - The shape of the `data` field
 */
export interface MutationState<TData> extends QueryState<TData> {
	/** Resets the state to idle */
	reset(): void;
}

/**
 * Executes the mutation. Rejects on failure (the error is also exposed in the hook state).
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type MutateFunction<TData, TVariables> = [RequiredKeys<TVariables>] extends [never]
	? (variables?: TVariables, options?: MutateOptions<TData, TVariables>) => Promise<TData>
	: (variables: TVariables, options?: MutateOptions<TData, TVariables>) => Promise<TData>;

/**
 * Per-call options of a {@link MutateFunction}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type MutateOptions<TData, TVariables> = Omit<RequestOptions<TData, TVariables>, "query" | "variables">;

/**
 * Options for {@link useSubscription}.
 *
 * @template TData - The shape of each payload
 * @template TVariables - The shape of the operation variables
 */
export interface UseSubscriptionOptions<TData, TVariables> extends Omit<SubscribeOptions<TData, TVariables>, "signal"> {
	/** Do not connect */
	skip?: boolean | undefined;
	/** Called for every payload (latest closure is always used) */
	onData?: ((data: TData) => void) | undefined;
}

/**
 * Result of {@link useSubscription}.
 *
 * @template TData - The shape of each payload
 */
export interface UseSubscriptionResult<TData> {
	/** The latest payload */
	data: TData | undefined;
	/** Connection or GraphQL error */
	error: unknown;
	/** Whether the stream is open */
	active: boolean;
}

/**
 * Provides a client to the component tree.
 *
 * @param props - The provider props
 * @returns The provider element
 */
export function GraphQLProvider(props: GraphQLProviderProps): ReactElement {
	return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

/**
 * Returns the client from the nearest {@link GraphQLProvider}.
 *
 * @returns The client
 * @throws {Error} When used outside a provider
 */
export function useClient(): Client {
	const client = useContext(ClientContext);

	if (!client) throw new Error("useClient: wrap your tree in <GraphQLProvider client={client}>.");

	return client;
}

/**
 * Subscribes to a live query: cached data renders synchronously, refetches keep stale data visible,
 * and the component re-renders on invalidation, polling, focus, reconnect, `client.write()` and any other
 * fetch of the same entry. SSR-safe: the server snapshot is the cache content.
 *
 * @example
 * const { data, loading, error, refetch } = useQuery({ key: ["todos"], query: TODOS });
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The query and watch options
 * @returns The query state and `refetch`
 */
export function useQuery<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: WithSkippableVariables<UseQueryOptions<TData, TVariables>, TVariables>,
): UseQueryResult<TData, TVariables> {
	const ref = useQueryRef(options);

	return useQueryRefResult(options.skip === true ? undefined : ref, options.keepPreviousData === true);
}

/**
 * Like {@link useQuery}, but suspends until data is available and throws errors to the nearest error boundary.
 * Background refetch errors after the first load are exposed in `error` instead, keeping the data on screen.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The query and watch options
 * @returns The query state with defined `data`
 */
export function useSuspenseQuery<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: WithVariables<Omit<UseQueryOptions<TData, TVariables>, "skip">, TVariables>,
): UseSuspenseQueryResult<TData, TVariables> {
	const client = useClient();
	const identity = getIdentity(options);
	const requests = getSuspenseRequests(client);

	// Suspended renders discard memoized values, so the ref that loaded while suspended is adopted from the entry.
	// Reusing the same ref (instead of seeding a new one) keeps its freshness tracking, e.g. missed invalidations.
	const ref = useMemo(
		function resolveRef(): QueryRef<TData, TVariables> {
			const entry = requests.get(identity);

			return (entry?.ref as QueryRef<TData, TVariables> | undefined) ?? createSuspenseRef(client, options);
		},
		// `identity` captures every option that defines the query.
		[client, requests, identity],
	);
	const state = useSyncExternalStore(ref.subscribe, ref.getState, ref.getState);

	useEffect(function updateLatestOptions(): void {
		const latest = latestSuspenseOptions.get(ref as QueryRef<unknown, unknown>);

		if (latest) latest.current = options;
	});

	useEffect(
		function releaseSuspenseEntry(): void {
			const entry = requests.get(identity);

			// Runs after `useSyncExternalStore` subscribed: the query stays active (no refetch) across the handover.
			if (entry?.ref === ref) {
				requests.delete(identity);
				entry.release();
			}
		},
		[requests, identity, ref],
	);

	if (state.data === undefined) {
		const entry = requests.get(identity);

		if (entry?.failed) {
			// Kept briefly: React retries a failed render once more (in a later task), which must rethrow the same error
			// instead of sending another request. A boundary reset after that starts a fresh request.
			const timer = setTimeout(function forgetFailure(): void {
				if (requests.get(identity) === entry) requests.delete(identity);

				entry.release();
			}, FAILURE_RETENTION);

			// Bookkeeping only: never keep a Node process alive.
			(timer as { unref?: () => void }).unref?.();
			throw entry.error;
		}

		throw (entry ?? startSuspenseRequest(requests, identity, ref as QueryRef<unknown, unknown>)).promise;
	}

	return { ...state, data: state.data, isPreviousData: false, refetch: ref.refetch, fetchMore: ref.fetchMore };
}

/**
 * Returns a mutate function and the state of its latest call.
 *
 * @example
 * const [addTodo, { loading }] = useMutation(ADD_TODO, { invalidates: [["todos"]] });
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param query - The mutation document
 * @param options - Default request options for every call
 * @returns The mutate function and the mutation state
 */
export function useMutation<TData = unknown, TVariables extends object = Record<string, unknown>>(
	query: string | TypedDocumentString<TData, TVariables>,
	options?: Omit<RequestOptions<TData, TVariables>, "query" | "variables">,
): [MutateFunction<TData, TVariables>, MutationState<TData>] {
	const client = useClient();
	const [state, setState] = useState<QueryState<TData>>(SKIPPED);
	const latestCall = useRef(0);
	const latestOptions = useLatest(options);

	const mutate = useCallback(
		async function mutate(variables?: TVariables, overrides?: MutateOptions<TData, TVariables>): Promise<TData> {
			const call = ++latestCall.current;

			setState(function start(previous: QueryState<TData>): QueryState<TData> {
				return { data: previous.data, error: undefined, loading: true };
			});

			try {
				const data = await client.gql<TData, TVariables>({
					...latestOptions.current,
					...overrides,
					query,
					variables,
				} as WithVariables<RequestOptions<TData, TVariables>, TVariables>);

				if (call === latestCall.current) setState({ data, error: undefined, loading: false });

				return data;
			} catch (error) {
				if (call === latestCall.current) setState({ data: undefined, error, loading: false });

				throw error;
			}
		},
		[client, query, latestOptions],
	);

	const reset = useCallback(function reset(): void {
		latestCall.current++;
		setState(SKIPPED);
	}, []);

	return [
		mutate,
		useMemo(
			function createState(): MutationState<TData> {
				return { ...state, reset };
			},
			[state, reset],
		),
	];
}

/**
 * Executes the lazy query with the given variables and resolves with its data.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export type LazyQueryExecute<TData, TVariables> = [RequiredKeys<TVariables>] extends [never]
	? (variables?: TVariables) => Promise<TData>
	: (variables: TVariables) => Promise<TData>;

/**
 * Result of {@link useLazyQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseLazyQueryResult<TData, TVariables> extends UseQueryResult<TData, TVariables> {
	/** Whether `execute` was called at least once */
	called: boolean;
}

/**
 * A query that runs on demand (e.g. a search button). Nothing is fetched until `execute` is called; from then on the
 * result is live like {@link useQuery}: it re-renders on invalidation, writes and refetches.
 * Calling `execute` again with other variables switches the query (with `keepPreviousData`, the old data stays
 * visible meanwhile).
 *
 * @example
 * const [search, { data, loading, called }] = useLazyQuery(SEARCH, { keepPreviousData: true });
 * // <button onClick={function () { search({ term }); }}>Search</button>
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param query - The query document
 * @param options - Query options (everything but `query`, `variables` and `skip`)
 * @returns The execute function and the live query state
 */
export function useLazyQuery<TData = unknown, TVariables extends object = Record<string, unknown>>(
	query: string | TypedDocumentString<TData, TVariables>,
	options?: Omit<UseQueryOptions<TData, TVariables>, "query" | "variables" | "skip">,
): [LazyQueryExecute<TData, TVariables>, UseLazyQueryResult<TData, TVariables>] {
	const client = useClient();
	const latestOptions = useLatest(options);
	const [executed, setExecuted] = useState<LazyExecution<TData, TVariables> | undefined>(undefined);
	// A query executed with another client or document (e.g. after a logout) no longer belongs to this hook.
	const ref = executed?.client === client && executed.query === String(query) ? executed.ref : undefined;
	const result = useQueryRefResult(ref, options?.keepPreviousData === true);

	const execute = useCallback(
		function execute(variables?: TVariables): Promise<TData> {
			// The live query performs the request itself: exactly one request (and one onError) per execution.
			const next = client.watch<TData, TVariables>(
				withLatestRequestOptions(
					{ ...latestOptions.current, query, variables } as UseQueryOptions<TData, TVariables>,
					latestOptions,
				),
			);

			setExecuted({ client, query: String(query), ref: next });

			return firstSettled(next);
		},
		[client, query, latestOptions],
	);

	return [
		execute as LazyQueryExecute<TData, TVariables>,
		useMemo(
			function createResult(): UseLazyQueryResult<TData, TVariables> {
				return { ...result, called: ref !== undefined };
			},
			[result, ref],
		),
	];
}

/**
 * Subscribes to a streamed operation (SSE subscription or `@defer` / `@stream` query) while mounted.
 * Reconnects when the document or variables change, and disconnects on unmount.
 *
 * @template TData - The shape of each payload
 * @template TVariables - The shape of the operation variables
 * @param options - The subscription options
 * @returns The latest payload, error and connection status
 */
export function useSubscription<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: WithSkippableVariables<UseSubscriptionOptions<TData, TVariables>, TVariables>,
): UseSubscriptionResult<TData> {
	const client = useClient();
	const identity = getIdentity(options);
	const latestOptions = useLatest(options);
	const [state, setState] = useState<UseSubscriptionResult<TData>>({ data: undefined, error: undefined, active: false });

	useEffect(
		function connect(): (() => void) | undefined {
			if (options.skip) {
				setState(function idle(previous: UseSubscriptionResult<TData>): UseSubscriptionResult<TData> {
					return previous.active || previous.data !== undefined || previous.error !== undefined
						? { data: undefined, error: undefined, active: false }
						: previous;
				});

				return undefined;
			}

			const controller = new AbortController();
			const { query, variables, operationName, headers } = latestOptions.current;

			/**
			 * Consumes the stream into state until it ends, fails or is aborted.
			 */
			async function consume(): Promise<void> {
				// Payloads of other variables or documents never show as this stream's.
				setState({ data: undefined, error: undefined, active: true });

				try {
					const stream = client.subscribe<TData, TVariables>({
						query,
						variables,
						operationName,
						headers,
						signal: controller.signal,
					} as WithVariables<SubscribeOptions<TData, TVariables>, TVariables>);

					for await (const data of stream) {
						// A payload already in flight when the stream was torn down belongs to the old variables.
						if (controller.signal.aborted) break;

						setState({ data, error: undefined, active: true });
						latestOptions.current.onData?.(data);
					}

					// An aborted stream ends quietly: its successor already owns the state.
					if (!controller.signal.aborted) setState(close);
				} catch (error) {
					if (!controller.signal.aborted) {
						setState(function fail(previous: UseSubscriptionResult<TData>): UseSubscriptionResult<TData> {
							return { data: previous.data, error, active: false };
						});
					}
				}
			}

			void consume();

			return function disconnect(): void {
				controller.abort();
			};
		},
		// `identity` captures every option that defines the stream; the latest closure is read through the ref.
		[client, identity, options.skip, latestOptions],
	);

	return state;
}

/**
 * Subscribes to a live query (or the idle state when `ref` is undefined) and builds the hook result.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param ref - The live query, or `undefined` when skipped / not executed yet
 * @param keepPreviousData - Keep showing the last data while a new query loads
 * @returns The hook result
 */
function useQueryRefResult<TData, TVariables>(
	ref: QueryRef<TData, TVariables> | undefined,
	keepPreviousData: boolean,
): UseQueryResult<TData, TVariables> {
	const state = useSyncExternalStore<QueryState<TData>>(
		ref ? ref.subscribe : subscribeNothing,
		ref ? ref.getState : getSkippedState,
		ref ? ref.getState : getSkippedState,
	);
	const previousData = useRef<TData | undefined>(undefined);
	// Skipped or idle queries show the idle state, never stale data.
	const showPrevious =
		keepPreviousData && ref !== undefined && state.data === undefined && previousData.current !== undefined;

	useEffect(
		function rememberData(): void {
			if (state.data !== undefined) previousData.current = state.data;
		},
		[state.data],
	);

	return useMemo(
		function createResult(): UseQueryResult<TData, TVariables> {
			return {
				...state,
				data: showPrevious ? previousData.current : state.data,
				isPreviousData: showPrevious,
				refetch: ref ? ref.refetch : resolveIdle,
				fetchMore: ref ? ref.fetchMore : resolveIdle,
			};
		},
		[state, ref, showPrevious],
	);
}

/**
 * Resolves once a live query settles (not loading), with its data or its error.
 *
 * @template TData - The shape of the `data` field
 * @param ref - The live query
 * @returns Its data
 */
function firstSettled<TData>(ref: QueryRef<TData, unknown>): Promise<TData> {
	return new Promise<TData>(function wait(resolve, reject): void {
		let unsubscribe: (() => void) | undefined;

		/**
		 * Settles on the first state that is not loading.
		 *
		 * @param state - The query state
		 * @returns Whether it settled
		 */
		function settle(state: QueryState<TData>): boolean {
			if (state.loading) return false;

			if (state.error !== undefined || state.data === undefined) reject(state.error);
			else resolve(state.data);

			unsubscribe?.();
			return true;
		}

		// Subscribing activates the query; only then does the state tell whether a fetch is running.
		unsubscribe = ref.subscribe(function observe(state: QueryState<TData>): void {
			if (unsubscribe) settle(state);
		});

		settle(ref.getState());
	});
}

/**
 * `refetch` / `fetchMore` of an idle (skipped or not executed) query.
 *
 * @returns The idle state
 */
function resolveIdle(): Promise<QueryState<never>> {
	return Promise.resolve(SKIPPED);
}

/**
 * Creates (once per query identity) the observable query behind the hooks.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The query and watch options
 * @returns The query ref
 */
function useQueryRef<TData, TVariables extends object>(
	options: UseQueryOptions<TData, TVariables>,
): QueryRef<TData, TVariables> {
	const client = useClient();
	const identity = getIdentity(options);
	const latestOptions = useLatest(options);

	return useMemo(
		function createQueryRef(): QueryRef<TData, TVariables> {
			return client.watch<TData, TVariables>(withLatestRequestOptions(options, latestOptions));
		},
		// `identity` captures every option that defines the query.
		[client, identity],
	);
}

/**
 * Latest options of each suspense query. The query is created during a suspended render whose hooks React discards,
 * so the box is attached to the query itself and updated by whichever committed render uses it.
 */
const latestSuspenseOptions = new WeakMap<QueryRef<unknown, unknown>, { current: unknown }>();

/**
 * Creates the live query of a suspense hook, reading request settings from its latest committed options.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param client - The client
 * @param options - The options of the render creating it
 * @returns The live query
 */
function createSuspenseRef<TData, TVariables extends object>(
	client: Client,
	options: Partial<UseQueryOptions<TData, TVariables>>,
): QueryRef<TData, TVariables> {
	const latest = { current: options };
	const ref = client.watch<TData, TVariables>(withLatestRequestOptions(options, latest));

	latestSuspenseOptions.set(ref as QueryRef<unknown, unknown>, latest as { current: unknown });

	return ref;
}

/**
 * Wraps query options so request-level settings (`headers`, `timeout`, `retry`) are read from the latest render
 * whenever the live query fetches (refetch, polling, invalidation), e.g. after an auth token rotated.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The options the query is created with
 * @param latest - Ref to the latest options
 * @returns Watch options with live request settings
 */
function withLatestRequestOptions<TData, TVariables>(
	options: Partial<UseQueryOptions<TData, TVariables>>,
	latest: { readonly current: Partial<UseQueryOptions<TData, TVariables>> | undefined },
): WithVariables<WatchOptions<TData, TVariables>, TVariables> {
	const wrapped = { ...options };

	for (const name of ["headers", "timeout", "retry"] as const) {
		Object.defineProperty(wrapped, name, {
			enumerable: true,
			get(): unknown {
				return latest.current?.[name];
			},
		});
	}

	return wrapped as WithVariables<WatchOptions<TData, TVariables>, TVariables>;
}

/**
 * Keeps a ref pointing at the latest value, updated after each commit.
 *
 * @template T - The value type
 * @param value - The latest value
 * @returns The ref
 */
function useLatest<T>(value: T): { readonly current: T } {
	const ref = useRef(value);

	useEffect(function updateLatest(): void {
		ref.current = value;
	});

	return ref;
}

/**
 * Serializes the options that define a query's identity (functions, signals and headers excluded).
 *
 * @param options - Query options
 * @returns The identity string
 */
function getIdentity<TData, TVariables>(options: Partial<UseQueryOptions<TData, TVariables>>): string {
	return stableStringify([
		options.key ?? [],
		String(options.query),
		options.variables ?? null,
		options.operationName ?? null,
		options.fetchPolicy ?? null,
		options.pollInterval ?? null,
		options.refetchOnFocus ?? false,
		options.refetchOnReconnect ?? false,
	]);
}

/**
 * Returns the suspense requests of a client.
 *
 * @param client - The client
 * @returns Its suspense request map
 */
function getSuspenseRequests(client: Client): Map<string, SuspenseEntry> {
	let requests = suspenseCache.get(client);

	if (!requests) {
		requests = new Map();
		suspenseCache.set(client, requests);
	}

	return requests;
}

/**
 * Loads a live query while its component is suspended, and tracks it so re-renders throw the same promise.
 *
 * @param requests - The client's suspense requests
 * @param identity - The query identity
 * @param ref - The live query to load
 * @returns The entry
 */
function startSuspenseRequest(
	requests: Map<string, SuspenseEntry>,
	identity: string,
	ref: QueryRef<unknown, unknown>,
): SuspenseEntry {
	const entry: SuspenseEntry = { ref, failed: false, promise: Promise.resolve(), release: noop };

	entry.promise = new Promise<void>(function load(resolve): void {
		let settled = false;

		/**
		 * Settles once the query has data or failed. The subscription stays until the component takes over (or the
		 * entry expires): React may commit long after the data arrived, and an idle query would refetch on resume.
		 *
		 * @param state - The query state
		 */
		function observe(state: QueryState<unknown>): void {
			if (settled || (state.data === undefined && (state.loading || state.error === undefined))) return;

			settled = true;
			entry.failed = state.data === undefined;
			entry.error = state.error;
			resolve();
			const timer = setTimeout(function expire(): void {
				if (requests.get(identity) === entry) requests.delete(identity);

				entry.release();
			}, SUSPENSE_RETENTION);

			// Bookkeeping only: never keep a Node process (SSR, scripts, tests) alive.
			(timer as { unref?: () => void }).unref?.();
			// On the server no component ever takes over (effects never run): stop background work (polling) now,
			// keeping the settled ref (and its state) for the render retrying after the suspension.
			// (`release` is read late: settling may happen synchronously, before `subscribe` returned it.)
			if (typeof document === "undefined") {
				void Promise.resolve().then(function releaseOnServer(): void {
					entry.release();
				});
			}
		}

		entry.release = ref.subscribe(observe);
	});

	requests.set(identity, entry);

	return entry;
}

/**
 * Marks a subscription as closed.
 *
 * @template TData - The payload type
 * @param previous - The previous state
 * @returns The closed state
 */
function close<TData>(previous: UseSubscriptionResult<TData>): UseSubscriptionResult<TData> {
	return { data: previous.data, error: previous.error, active: false };
}

/**
 * `useSyncExternalStore` subscribe function for skipped queries.
 *
 * @returns A no-op unsubscribe
 */
function subscribeNothing(): () => void {
	return noop;
}

/**
 * Snapshot of a skipped query.
 *
 * @returns The skipped state
 */
function getSkippedState(): QueryState<never> {
	return SKIPPED;
}

/**
 * No-op.
 */
function noop(): void {}
