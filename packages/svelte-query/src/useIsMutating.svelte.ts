import { useQueryClientAccessor } from './useQueryClient.js'
import { ReactiveValue } from './containers.svelte.js'
import type { MutationFilters, QueryClient } from '@tanstack/query-core'
import type { Accessor } from './types.js'

/**
 * `useIsMutating` is an optional function that returns the `number` of mutations that your application is
 * running (useful for app-wide loading indicators).
 *
 * @param filters - {@link MutationFilters} to narrow down which mutations to count. Pass a function returning
 * them to recount when they change.
 * @param queryClient - Use this to use a custom `QueryClient`, or pass a function returning it to follow a
 * client that changes. Otherwise, the one from the nearest context will be used.
 * @returns A reactive value — read `.current` to get how many matching mutations are currently running.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useIsMutating } from '@tanstack/svelte-query'
 *
 *   // How many mutations matching the posts prefix are in progress?
 *   const isMutatingPosts = useIsMutating({ mutationKey: ['posts'] })
 * </script>
 *
 * {#if isMutatingPosts.current}
 *   <span>Saving posts...</span>
 * {/if}
 * ```
 */
export function useIsMutating(
  filters?: MutationFilters | Accessor<MutationFilters | undefined>,
  queryClient?: QueryClient | Accessor<QueryClient>,
): ReactiveValue<number> {
  const getClient = useQueryClientAccessor(queryClient)
  const getFilters = typeof filters === 'function' ? filters : () => filters
  const client = $derived(getClient())

  return new ReactiveValue(
    () => client.isMutating(getFilters()),
    (update) =>
      $effect.root(() => {
        $effect.pre(() => client.getMutationCache().subscribe(update))
      }),
  )
}
