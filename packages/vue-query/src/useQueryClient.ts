import {
  getCurrentInstance,
  hasInjectionContext,
  inject,
  isVue2,
} from 'vue-demi'

import { VUE_QUERY_APP, getClientKey } from './utils'
import type { QueryClient } from './queryClient'

type Provides = Record<PropertyKey, unknown>

type InjectingInstance = {
  parent?: { provides?: Provides } | null
  ce?: unknown
  vnode?: { appContext?: { provides?: Provides } | null }
}

type ProvidingApp = {
  _context: { provides: Provides }
}

/**
 * Retrieves the `QueryClient` installed by `VueQueryPlugin`, via Vue's `inject`. Must be called inside
 * `setup()` or another function that supports an injection context.
 *
 * @param id - The `queryClientKey` passed to `VueQueryPlugin` — only needed when multiple `QueryClient`s are
 * installed in the same app.
 * @throws If called outside an injection context, or if no `QueryClient` was installed via `VueQueryPlugin`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useQueryClient } from '@tanstack/vue-query'
 *
 * const queryClient = useQueryClient()
 *
 * function invalidate() {
 *   queryClient.invalidateQueries({ queryKey: ['todos'] })
 * }
 * </script>
 * ```
 */
export function useQueryClient(id = ''): QueryClient {
  // ensures that `inject()` can be used
  if (!hasInjectionContext()) {
    throw new Error(
      'vue-query hooks can only be used inside setup() function or functions that support injection context.',
    )
  }

  const key = getClientKey(id)
  const queryClient = inject<QueryClient>(key)

  if (!queryClient) {
    throw new Error(
      "No 'queryClient' found in Vue context, use 'VueQueryPlugin' to properly initialize the library.",
    )
  }

  return queryClient
}

/**
 * @internal Resolves the `QueryClient` like {@link useQueryClient} and returns a function that reads the client
 * provided to the same injection context again. Composables outlive `setup()`, and the app can provide a
 * different client afterwards (for example when the signed-in account changes), so every read returns the
 * client provided now. Callers must read it once per operation and use that one client for the whole operation.
 */
export function useQueryClientGetter(id = ''): () => QueryClient {
  const setupClient = useQueryClient(id)
  const readProvided = captureProvidedReader(getClientKey(id))

  // Vue 2 cannot replace a provided value once it has been injected, and an injection context the reader
  // cannot reproduce keeps the client `inject` returned.
  if (!readProvided || readProvided() !== setupClient) {
    return () => setupClient
  }

  return () => {
    const client = readProvided() as QueryClient | undefined
    if (!client) {
      throw new Error(
        "No 'queryClient' found in Vue context, use 'VueQueryPlugin' to properly initialize the library.",
      )
    }
    return client
  }
}

function captureProvidedReader(key: string): (() => unknown) | undefined {
  if (isVue2) {
    return undefined
  }

  const instance = getCurrentInstance() as InjectingInstance | null
  if (instance) {
    // Same lookup as Vue's `inject` for a component instance: the parent's provides, or the app's for a root.
    return () => {
      const provides =
        instance.parent == null || instance.ce
          ? instance.vnode?.appContext?.provides
          : instance.parent.provides
      return provides?.[key]
    }
  }

  // Without an instance the injection context is `app.runWithContext`, which reads the app's provides.
  const app = inject<ProvidingApp | undefined>(VUE_QUERY_APP, undefined)
  return app ? () => app._context.provides[key] : undefined
}
