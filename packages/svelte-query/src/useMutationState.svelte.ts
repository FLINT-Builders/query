import { untrack } from 'svelte'
import { replaceEqualDeep } from '@tanstack/query-core'
import { useQueryClientAccessor } from './useQueryClient.js'
import type {
  Mutation,
  MutationCache,
  MutationState,
  QueryClient,
} from '@tanstack/query-core'
import type {
  Accessor,
  MutationStateOptions,
  MutationTypeFromResult,
} from './types.js'

function getResult<
  TResult = MutationState,
  TMutation extends Mutation<any, any, any, any> =
    MutationTypeFromResult<TResult>,
>(
  mutationCache: MutationCache,
  options: MutationStateOptions<TResult, TMutation>,
): Array<TResult> {
  return mutationCache
    .findAll(options.filters)
    .map(
      (mutation): TResult =>
        (options.select
          ? options.select(mutation as TMutation)
          : mutation.state) as TResult,
    )
}

/**
 * `useMutationState` gives you access to all mutations (matching the given `filters`), including ones that
 * were created by a different component or hook instance, or even ones no longer mounted.
 *
 * @param options - The `filters` to narrow down matched mutations, and an optional `select` to transform the
 * mutation state. Pass a function returning them to re-filter when they change.
 * @param queryClient - Use this to use a custom `QueryClient`, or pass a function returning it to follow a
 * client that changes. Otherwise, the one from the nearest context will be used.
 * @returns An Array of whatever `select` returns for each matching mutation.
 *
 * @example
 * Get all variables of all running mutations:
 * ```svelte
 * <script lang="ts">
 *   import { useMutationState } from '@tanstack/svelte-query'
 *
 *   const pendingVariables = useMutationState({
 *     filters: { status: 'pending' },
 *     select: (mutation) => mutation.state.variables,
 *   })
 * </script>
 *
 * {pendingVariables.length} posts saving...
 * ```
 *
 * @example
 * Get all data for specific mutations via the `mutationKey`:
 * ```svelte
 * <script lang="ts">
 *   import { createMutation, useMutationState } from '@tanstack/svelte-query'
 *
 *   const mutationKey = ['posts']
 *
 *   // Some mutation that we want to get the state for
 *   const mutation = createMutation(() => ({
 *     mutationKey,
 *     mutationFn: createPosts,
 *   }))
 *
 *   const savedPosts = useMutationState({
 *     // this mutation key needs to match the mutation key of the given mutation (see above)
 *     filters: { mutationKey, status: 'success' },
 *     select: (mutation) => mutation.state.data,
 *   })
 * </script>
 *
 * <button onclick={() => mutation.mutate(['New Post'])}>
 *   Create post ({savedPosts.length} saved so far)
 * </button>
 * ```
 *
 * @example
 * Access the latest mutation data via the `mutationKey`. Each invocation of `mutate` adds a new entry to the
 * mutation cache for `gcTime` milliseconds — check the last item that `useMutationState` returns to get the
 * latest successful mutation (the `status: 'success'` filter above excludes pending/errored ones):
 * ```svelte
 * <script lang="ts">
 *   import { useMutationState } from '@tanstack/svelte-query'
 *
 *   const savedPosts = useMutationState({
 *     filters: { mutationKey: ['posts'], status: 'success' },
 *     select: (mutation) => mutation.state.data,
 *   })
 *
 *   const latestSavedPost = $derived(savedPosts[savedPosts.length - 1])
 * </script>
 *
 * {latestSavedPost ? 'Saved' : 'Nothing saved yet'}
 * ```
 */
export function useMutationState<
  TResult = MutationState,
  TMutation extends Mutation<any, any, any, any> =
    MutationTypeFromResult<TResult>,
>(
  options:
    | MutationStateOptions<TResult, TMutation>
    | Accessor<MutationStateOptions<TResult, TMutation>> = {},
  queryClient?: QueryClient | Accessor<QueryClient>,
): Array<TResult> {
  const getClient = useQueryClientAccessor(queryClient)
  const getOptions = typeof options === 'function' ? options : () => options
  const mutationCache = $derived(getClient().getMutationCache())
  // svelte-ignore state_referenced_locally - intentional, initial value
  const result = $state(getResult(mutationCache, getOptions()))

  function setResult(nextResult: Array<TResult>) {
    const merged = replaceEqualDeep(result, nextResult)
    if (result !== merged) {
      result.splice(0, result.length, ...merged)
    }
  }

  // Re-runs whenever the client or the options change, so the previous cache's snapshot is replaced
  // straight away rather than on that cache's next event, which may never come.
  $effect.pre(() => {
    const cache = mutationCache
    const opts = getOptions()
    const nextResult = getResult(cache, opts)
    untrack(() => setResult(nextResult))

    return cache.subscribe(() => setResult(getResult(cache, opts)))
  })

  return result
}
