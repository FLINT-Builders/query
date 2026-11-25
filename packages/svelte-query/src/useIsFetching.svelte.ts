import { ReactiveValue } from './containers.svelte.js'
import { useQueryClientAccessor } from './useQueryClient.js'
import type { QueryClient, QueryFilters } from '@tanstack/query-core'
import type { Accessor } from './types.js'

/**
 * The `useIsFetching` function returns the `number` of the queries that your application is loading or
 * fetching in the background (useful for app-wide loading indicators).
 *
 * @param filters - {@link QueryFilters} to narrow down which queries to count. Omit to count every fetching
 * query. Pass a function returning them to recount when they change.
 * @param queryClient - Use this to use a custom `QueryClient`, or pass a function returning it to follow a
 * client that changes. Otherwise, the one from the nearest context will be used.
 * @returns A reactive value — read `.current` to get how many matching queries are currently fetching.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useIsFetching } from '@tanstack/svelte-query'
 *
 *   // How many queries matching the posts prefix are fetching?
 *   const isFetchingPosts = useIsFetching({ queryKey: ['posts'] })
 * </script>
 *
 * {#if isFetchingPosts.current}
 *   <span>Refreshing posts...</span>
 * {/if}
 * ```
 *
 * @example
 * A global loading indicator for any query fetching in the background, not just the ones on screen:
 * ```svelte
 * <script lang="ts">
 *   import { useIsFetching } from '@tanstack/svelte-query'
 *
 *   const isFetching = useIsFetching()
 * </script>
 *
 * {#if isFetching.current}
 *   <div>Queries are fetching in the background...</div>
 * {/if}
 * ```
 */
export function useIsFetching(
  filters?: QueryFilters | Accessor<QueryFilters | undefined>,
  queryClient?: QueryClient | Accessor<QueryClient>,
): ReactiveValue<number> {
  const getClient = useQueryClientAccessor(queryClient)
  const getFilters = typeof filters === 'function' ? filters : () => filters
  const client = $derived(getClient())

  return new ReactiveValue(
    () => client.isFetching(getFilters()),
    (update) =>
      $effect.root(() => {
        $effect.pre(() => client.getQueryCache().subscribe(update))
      }),
  )
}
