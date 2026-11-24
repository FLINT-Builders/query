import { untrack } from 'svelte'
import { hydrate } from '@tanstack/query-core'
import { getQueryClientContext } from './context.js'
import { useQueryClient } from './useQueryClient.js'
import type { HydrateOptions, QueryClient } from '@tanstack/query-core'
import type { Accessor } from './types.js'

const toAccessor = <T>(value: T | Accessor<T>): Accessor<T> =>
  typeof value === 'function' ? (value as Accessor<T>) : () => value

/**
 * Adds a previously dehydrated `state` into the `queryClient` (from the nearest context, or the one
 * passed explicitly). If the client already contains data, the new queries will be intelligently merged based
 * on update timestamp. `HydrationBoundary` wraps this — use it directly only if you need to hydrate from your
 * own component instead.
 *
 * Each argument can be passed as a value or as an {@link Accessor}. Values are hydrated once, when the
 * component initializes. Accessors are hydrated when the component initializes and again whenever any of them
 * returns something new, so pass accessors when `state` comes from props or other reactive state that can
 * change while the component stays mounted (e.g. on client-side navigation).
 *
 * @param state - The dehydrated state to hydrate into the cache, as produced by `dehydrate`.
 * @param options - {@link HydrateOptions} to control the hydration.
 * @param queryClient - Use this to use a custom `QueryClient`. Otherwise, the one from the nearest context will
 * be used.
 *
 * @example
 * Server-side prefetch handed off to the client via `dehydrate` — `dehydratedState` would typically come
 * from a server load function that prefetched with `queryClient.query` and called `dehydrate(queryClient)`:
 * ```svelte
 * <script lang="ts">
 *   import { HydrationBoundary } from '@tanstack/svelte-query'
 *   import type { DehydratedState } from '@tanstack/svelte-query'
 *   import Posts from './Posts.svelte'
 *
 *   let { dehydratedState }: { dehydratedState: DehydratedState } = $props()
 * </script>
 *
 * <HydrationBoundary state={dehydratedState}>
 *   <Posts />
 * </HydrationBoundary>
 * ```
 */
export function useHydrate(
  state?: unknown,
  options?: HydrateOptions | Accessor<HydrateOptions | undefined>,
  queryClient?: QueryClient | Accessor<QueryClient | undefined>,
) {
  const getState = toAccessor(state)
  const getOptions = toAccessor(options)
  const getQueryClient = toAccessor(queryClient)

  // Svelte context can only be read while the component initializes.
  let contextClient: QueryClient | undefined
  try {
    contextClient = getQueryClientContext()
  } catch {
    contextClient = undefined
  }

  const read = () => ({
    client: useQueryClient(getQueryClient() ?? contextClient),
    state: getState(),
    options: getOptions(),
  })

  const apply = (current: ReturnType<typeof read>) => {
    if (current.state) {
      hydrate(current.client, current.state, current.options)
    }
  }

  // Hydrate during initialization so the cache is filled before children render, including during SSR.
  let hydrated = read()
  apply(hydrated)

  $effect.pre(() => {
    const next = read()
    if (
      next.client === hydrated.client &&
      next.state === hydrated.state &&
      next.options === hydrated.options
    ) {
      return
    }
    hydrated = next
    untrack(() => apply(next))
  })
}
