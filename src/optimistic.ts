import type { CacheTarget, OptimisticUpdate } from "./types";

/**
 * Builds a typed optimistic update: `TData` and `TVariables` are inferred from the target's document.
 *
 * @example
 * await client.gql({
 *   query: ADD_TODO,
 *   variables: { title },
 *   optimistic: [optimistic({ key: ["todos"], query: TODOS }, function add(current) {
 *     return { todos: [...(current?.todos ?? []), { id: "temp", title }] };
 *   })],
 *   invalidates: [["todos"]],
 * });
 *
 * @template TData - The shape of the entry's data
 * @template TVariables - The shape of the entry's variables
 * @param target - The cache entry to update
 * @param update - Computes the optimistic data from the cached one
 * @returns The optimistic update
 */
export function optimistic<TData, TVariables>(
	target: CacheTarget<TData, TVariables>,
	update: (current: TData | undefined) => TData,
): OptimisticUpdate<unknown, unknown> {
	return { target, update } as OptimisticUpdate<unknown, unknown>;
}
