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
import type { QueryState, RequestOptions, SubscribeOptions, TypedDocumentString, WatchOptions } from "../types";
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
	/** The in-flight request, thrown to suspend */
	promise: Promise<unknown>;
	/** Resolved data */
	data?: unknown;
	/** Rejection reason */
	error?: unknown;
	/** Whether the request settled */
	settled: boolean;
}

/**
 * Props of {@link GraphQLProvider}.
 */
export interface GraphQLProviderProps {
	/** The client exposed to the tree */
	client: Client;
	/** The tree */
	children?: ReactNode;
}

/**
 * Options for {@link useQuery} and {@link useSuspenseQuery}.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 */
export interface UseQueryOptions<TData, TVariables> extends WatchOptions<TData, TVariables> {
	/** Skip the query entirely (no fetch, no subscription) */
	skip?: boolean;
}

/**
 * Result of {@link useQuery}.
 *
 * @template TData - The shape of the `data` field
 */
export interface UseQueryResult<TData> extends QueryState<TData> {
	/** Refetches from the network, keeping current data visible. Never rejects. */
	refetch(): Promise<QueryState<TData>>;
}

/**
 * Result of {@link useSuspenseQuery}: `data` is always defined.
 *
 * @template TData - The shape of the `data` field
 */
export interface UseSuspenseQueryResult<TData> extends UseQueryResult<TData> {
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
export type MutateFunction<TData, TVariables> = (
	variables?: TVariables,
	options?: Omit<RequestOptions<TData, TVariables>, "query" | "variables">,
) => Promise<TData>;

/**
 * Options for {@link useSubscription}.
 *
 * @template TData - The shape of each payload
 * @template TVariables - The shape of the operation variables
 */
export interface UseSubscriptionOptions<TData, TVariables> extends Omit<SubscribeOptions<TData, TVariables>, "signal"> {
	/** Do not connect */
	skip?: boolean;
	/** Called for every payload (latest closure is always used) */
	onData?: (data: TData) => void;
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
	options: UseQueryOptions<TData, TVariables>,
): UseQueryResult<TData> {
	const ref = useQueryRef(options);
	const skip = options.skip === true;
	const state = useSyncExternalStore<QueryState<TData>>(
		skip ? subscribeNothing : ref.subscribe,
		skip ? getSkippedState : ref.getState,
		skip ? getSkippedState : ref.getState,
	);

	return useMemo(
		function createResult(): UseQueryResult<TData> {
			return { ...state, refetch: ref.refetch };
		},
		[state, ref],
	);
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
	options: Omit<UseQueryOptions<TData, TVariables>, "skip">,
): UseSuspenseQueryResult<TData> {
	const client = useClient();
	const identity = getIdentity(options);
	const requests = getSuspenseRequests(client);
	const entry = requests.get(identity);
	const ref = useQueryRef<TData, TVariables>(
		entry?.settled && !entry.error ? { ...options, initialData: entry.data as TData } : options,
	);
	const state = useSyncExternalStore(ref.subscribe, ref.getState, ref.getState);

	useEffect(
		function releaseSuspenseEntry(): void {
			requests.delete(identity);
		},
		[requests, identity],
	);

	if (state.data === undefined) {
		if (entry?.settled) {
			requests.delete(identity);
			throw entry.error;
		}

		throw (entry ?? startSuspenseRequest(requests, identity, client.gql<TData, TVariables>(options))).promise;
	}

	return { ...state, data: state.data, refetch: ref.refetch };
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

	const mutate = useCallback<MutateFunction<TData, TVariables>>(
		async function mutate(variables, overrides) {
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
				});

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
 * Subscribes to a streamed operation (SSE subscription or `@defer` / `@stream` query) while mounted.
 * Reconnects when the document or variables change, and disconnects on unmount.
 *
 * @template TData - The shape of each payload
 * @template TVariables - The shape of the operation variables
 * @param options - The subscription options
 * @returns The latest payload, error and connection status
 */
export function useSubscription<TData = unknown, TVariables extends object = Record<string, unknown>>(
	options: UseSubscriptionOptions<TData, TVariables>,
): UseSubscriptionResult<TData> {
	const client = useClient();
	const identity = getIdentity(options);
	const latestOptions = useLatest(options);
	const [state, setState] = useState<UseSubscriptionResult<TData>>({ data: undefined, error: undefined, active: false });

	useEffect(
		function connect(): (() => void) | undefined {
			if (options.skip) return undefined;

			const controller = new AbortController();
			const { query, variables, operationName, headers } = latestOptions.current;

			/**
			 * Consumes the stream into state until it ends, fails or is aborted.
			 */
			async function consume(): Promise<void> {
				setState(function open(previous: UseSubscriptionResult<TData>): UseSubscriptionResult<TData> {
					return { data: previous.data, error: undefined, active: true };
				});

				try {
					const stream = client.subscribe<TData, TVariables>({
						query,
						variables,
						operationName,
						headers,
						signal: controller.signal,
					});

					for await (const data of stream) {
						setState({ data, error: undefined, active: true });
						latestOptions.current.onData?.(data);
					}

					setState(close);
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
 * Creates (once per query identity) the observable query behind the hooks.
 *
 * @template TData - The shape of the `data` field
 * @template TVariables - The shape of the operation variables
 * @param options - The query and watch options
 * @returns The query ref
 */
function useQueryRef<TData, TVariables extends object>(options: UseQueryOptions<TData, TVariables>): QueryRef<TData> {
	const client = useClient();
	const identity = getIdentity(options);

	return useMemo(
		function createQueryRef(): QueryRef<TData> {
			return client.watch<TData, TVariables>(options);
		},
		// `identity` captures every option that defines the query.
		[client, identity],
	);
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
function getIdentity(options: Partial<UseQueryOptions<unknown, unknown>>): string {
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
 * Tracks a suspense request so re-renders throw the same promise and read its outcome.
 *
 * @param requests - The client's suspense requests
 * @param identity - The query identity
 * @param request - The request
 * @returns The entry
 */
function startSuspenseRequest(
	requests: Map<string, SuspenseEntry>,
	identity: string,
	request: Promise<unknown>,
): SuspenseEntry {
	const entry: SuspenseEntry = {
		settled: false,
		promise: request.then(
			function resolve(data: unknown): void {
				entry.data = data;
				entry.settled = true;
			},
			function reject(error: unknown): void {
				entry.error = error;
				entry.settled = true;
			},
		),
	};

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
