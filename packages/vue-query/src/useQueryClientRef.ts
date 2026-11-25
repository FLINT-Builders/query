import { computed, toRaw, unref } from 'vue-demi'
import { useQueryClient } from './useQueryClient'
import type { ComputedRef, Ref } from 'vue-demi'
import type { QueryClient } from './queryClient'
import type { MaybeRefOrGetter } from './types'

/**
 * @internal Resolves the `queryClient` argument of a composable, or the client provided by `VueQueryPlugin`, to a
 * `computed` that always holds the current `QueryClient`. Composables must read the client through it, and rebind
 * their observers and cache subscriptions whenever its identity changes, so a mounted composable never keeps
 * reading from or writing to a client that has been replaced.
 */
export function useQueryClientRef(
  queryClient?: MaybeRefOrGetter<QueryClient>,
): ComputedRef<QueryClient> {
  const source: MaybeRefOrGetter<QueryClient> = queryClient || useQueryClient()

  return computed(() => {
    const client =
      typeof source === 'function'
        ? source()
        : unref(source as QueryClient | Ref<QueryClient>)

    // A client stored in a deep `ref` is a reactive proxy, which cannot reach the private fields of `QueryClient`.
    return toRaw(client)
  })
}
