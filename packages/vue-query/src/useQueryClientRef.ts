import { inject, shallowReadonly, shallowRef } from 'vue-demi'
import { useQueryClient } from './useQueryClient'
import { getClientRefKey } from './utils'
import type { Ref } from 'vue-demi'
import type { QueryClient } from './queryClient'

/**
 * @internal Resolves the `QueryClient` a composable should use as a `ref`. When the composable relies on
 * the client installed by `VueQueryPlugin`, the `ref` follows later `app.provide` calls that replace it,
 * so the composable can drop everything it bound to the previous client.
 */
export function useQueryClientRef(
  queryClient?: QueryClient,
): Readonly<Ref<QueryClient>> {
  if (queryClient) {
    return shallowReadonly(shallowRef(queryClient))
  }

  const client = useQueryClient()
  const appClient = inject<Readonly<Ref<QueryClient>> | null>(
    getClientRefKey(),
    null,
  )

  // A component further up may provide its own client under the same key, which takes precedence.
  if (appClient && appClient.value === client) {
    return appClient
  }

  return shallowReadonly(shallowRef(client))
}
