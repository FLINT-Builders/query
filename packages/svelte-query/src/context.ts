import { getContext, setContext } from 'svelte'
import type { QueryClient } from '@tanstack/query-core'
import type { Box } from './containers.svelte'
import type { Accessor } from './types.js'

const _contextKey = Symbol('QueryClient')

/**
 * Returns a function that reads the `QueryClient` currently set on Svelte's context, so callers follow
 * a provider whose `client` changes after they were created.
 *
 * @internal
 * @throws If no `QueryClient` was found in context.
 */
export const getQueryClientContextAccessor = (): Accessor<QueryClient> => {
  const getClient = getContext<Accessor<QueryClient | undefined> | undefined>(
    _contextKey,
  )
  const read = (): QueryClient => {
    const client = getClient?.()
    if (!client) {
      throw new Error(
        'No QueryClient was found in Svelte context. Did you forget to wrap your component with QueryClientProvider?',
      )
    }
    return client
  }
  read()
  return read
}

/**
 * Retrieves the `QueryClient` set on Svelte's context by `QueryClientProvider` (or by
 * {@link setQueryClientContext} directly). This is what {@link useQueryClient} calls internally.
 *
 * @throws If no `QueryClient` was found in context.
 * @returns The `QueryClient` set on context, whether by `QueryClientProvider` or {@link setQueryClientContext}.
 */
export const getQueryClientContext = (): QueryClient =>
  getQueryClientContextAccessor()()

/**
 * Sets a `QueryClient` on Svelte's context, so it can be read with {@link getQueryClientContext} (or
 * {@link useQueryClient}) from any descendant component. `QueryClientProvider` wraps this — use it directly
 * only if you need to set the client from your own component instead.
 *
 * @param client - The `QueryClient` to make available to descendant components, or a function returning it.
 * Pass a function when the client can change while descendants stay mounted, so they switch to the new one.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'
 *
 *   const queryClient = new QueryClient()
 * </script>
 *
 * <QueryClientProvider client={queryClient}>
 *   ...
 * </QueryClientProvider>
 * ```
 */
export const setQueryClientContext = (
  client: QueryClient | Accessor<QueryClient>,
): void => {
  setContext(_contextKey, typeof client === 'function' ? client : () => client)
}

const _isRestoringContextKey = Symbol('isRestoring')

/** Retrieves a `isRestoring` from Svelte's context */
export const getIsRestoringContext = (): Box<boolean> => {
  try {
    const isRestoring = getContext<Box<boolean> | undefined>(
      _isRestoringContextKey,
    )
    return isRestoring ?? { current: false }
  } catch (error) {
    return { current: false }
  }
}

/** Sets a `isRestoring` on Svelte's context */
export const setIsRestoringContext = (isRestoring: Box<boolean>): void => {
  setContext(_isRestoringContextKey, isRestoring)
}
