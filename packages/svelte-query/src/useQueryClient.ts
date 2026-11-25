import {
  getQueryClientContext,
  getQueryClientContextAccessor,
} from './context.js'
import type { QueryClient } from '@tanstack/query-core'
import type { Accessor } from './types.js'

/**
 * The `useQueryClient` function returns the current `QueryClient` instance.
 *
 * @param queryClient - Use this to use a custom `QueryClient`. Otherwise, the one from the nearest context will
 * be used.
 * @returns The current `QueryClient` instance.
 * @throws If no `queryClient` argument is passed and no `QueryClientProvider` is found in the component tree.
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useQueryClient } from '@tanstack/svelte-query'
 *
 *   const queryClient = useQueryClient()
 *
 *   function refreshPosts() {
 *     queryClient.invalidateQueries({ queryKey: ['posts'] })
 *   }
 * </script>
 * ```
 */
export function useQueryClient(queryClient?: QueryClient): QueryClient {
  if (queryClient) return queryClient
  return getQueryClientContext()
}

/**
 * Like {@link useQueryClient}, but returns a function that resolves the client on every call, so reactive
 * readers follow a `queryClient` accessor or a `QueryClientProvider` whose client changes.
 *
 * Must be called during component initialization unless `queryClient` always resolves to a client.
 *
 * @internal
 */
export function useQueryClientAccessor(
  queryClient?: QueryClient | Accessor<QueryClient | undefined>,
): Accessor<QueryClient> {
  if (typeof queryClient !== 'function') {
    if (queryClient) return () => queryClient
    return getQueryClientContextAccessor()
  }
  let fromContext = queryClient() ? undefined : getQueryClientContextAccessor()
  return () =>
    queryClient() ?? (fromContext ??= getQueryClientContextAccessor())()
}
