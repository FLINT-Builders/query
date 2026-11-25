import { computed, inject } from 'vue-demi'
import { useQueryClient } from './useQueryClient'
import { getClientKey, getClientSourceKey } from './utils'
import type { Ref } from 'vue-demi'
import type { QueryClient } from './queryClient'
import type { QueryClientSource } from './utils'

/**
 * @internal Resolves the `QueryClient` a composable acts on. An explicit `queryClient` is used as is. Otherwise the
 * client comes from `useQueryClient`, and if that client is the one the app provides, the returned ref follows
 * any client the app provides later.
 */
export function useTrackedQueryClient(
  queryClient?: QueryClient,
): Readonly<Ref<QueryClient>> {
  if (queryClient) {
    return computed(() => queryClient)
  }

  const source = inject<QueryClientSource | undefined>(
    getClientSourceKey(getClientKey()),
    undefined,
  )
  let client!: QueryClient
  const read = () => {
    client = useQueryClient()
  }

  if (!source) {
    read()
    return computed(() => client)
  }
  if (!source.readsFromApp(read)) {
    return computed(() => client)
  }

  return computed(() => {
    const current = source.current()
    if (!current) {
      throw new Error(
        "No 'queryClient' found in Vue context, use 'VueQueryPlugin' to properly initialize the library.",
      )
    }
    return current
  })
}
