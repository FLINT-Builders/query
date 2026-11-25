// Had to disable the lint rule because isServer type is defined as false
// in solid-js/web package. I'll create a GitHub issue with them to see
// why that happens.
import { hydrate, notifyManager, shouldThrowError } from '@tanstack/query-core'
import { isServer } from 'solid-js/web'
import {
  createComputed,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from 'solid-js'
import { createStore, reconcile, unwrap } from 'solid-js/store'
import { useQueryClientResolver } from './QueryClientProvider'
import { useIsRestoring } from './isRestoring'
import type { UseBaseQueryOptions } from './types'
import type { Accessor, Signal } from 'solid-js'
import type { QueryClient } from './QueryClient'
import type {
  Query,
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'

function reconcileFn<TData, TError>(
  store: QueryObserverResult<TData, TError>,
  result: QueryObserverResult<TData, TError>,
  reconcileOption:
    | string
    | false
    | ((oldData: TData | undefined, newData: TData) => TData),
  queryHash?: string,
): QueryObserverResult<TData, TError> {
  if (reconcileOption === false) return result
  if (typeof reconcileOption === 'function') {
    const newData = reconcileOption(store.data, result.data as TData)
    return { ...result, data: newData } as typeof result
  }
  let data = result.data
  if (store.data === undefined) {
    try {
      data = structuredClone(data)
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        if (error instanceof Error) {
          console.warn(
            `Unable to correctly reconcile data for query key: ${queryHash}. ` +
              `Possibly because the query data contains data structures that aren't supported ` +
              `by the 'structuredClone' algorithm. Consider using a callback function instead ` +
              `to manage the reconciliation manually.\n\n Error Received: ${error.name} - ${error.message}`,
          )
        }
      }
    }
  }
  const newData = reconcile(data, { key: reconcileOption })(store.data)
  return { ...result, data: newData } as typeof result
}

/**
 * Solid's `onHydrated` functionality will silently "fail" (hydrate with an empty object)
 * if the resource data is not serializable.
 */
const hydratableObserverResult = <
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
  TDataHydratable,
>(
  query: Query<TQueryFnData, TError, TData, TQueryKey>,
  result: QueryObserverResult<TDataHydratable, TError>,
) => {
  if (!isServer) return result
  const obj: any = {
    ...unwrap(result),
    // During SSR, functions cannot be serialized, so we need to remove them
    // This is safe because we will add these functions back when the query is hydrated
    refetch: undefined,
  }

  // If the query is an infinite query, we need to remove additional properties
  if ('fetchNextPage' in result) {
    obj.fetchNextPage = undefined
    obj.fetchPreviousPage = undefined
  }

  // We will also attach the dehydrated state of the query to the result
  // This will be removed on client after hydration
  obj.hydrationData = {
    state: query.state,
    queryKey: query.queryKey,
    queryHash: query.queryHash,
    ...(query.meta && { meta: query.meta }),
  }

  return obj
}

// Base Query Function that is used to create the query.
export function useBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  options: Accessor<
    UseBaseQueryOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>
  >,
  Observer: typeof QueryObserver,
  queryClient?: Accessor<QueryClient>,
) {
  type ResourceData = QueryObserverResult<TData, TError>
  type Obs = QueryObserver<TQueryFnData, TError, TData, TQueryData, TQueryKey>

  const resolveClient = useQueryClientResolver(queryClient)
  const client = createMemo(() => resolveClient())
  const isRestoring = useIsRestoring()
  // There are times when we run a query on the server but the resource is never read
  // This could lead to times when the queryObserver is unsubscribed before the resource has loaded
  // Causing a time out error. To prevent this we will queue the unsubscribe if the cleanup is called
  // before the resource has loaded
  let unsubscribeQueued = false

  const defaultedOptions = createMemo(() => {
    const defaultOptions = client().defaultQueryOptions(options())
    defaultOptions._optimisticResults = isRestoring()
      ? 'isRestoring'
      : 'optimistic'
    defaultOptions.structuralSharing = false
    if (isServer) {
      defaultOptions.retry = false
      defaultOptions.throwOnError = true
    }
    return defaultOptions
  })
  const initialOptions = defaultedOptions()

  let observerClient = client()
  const [observer, setObserver] = createSignal(
    new Observer(observerClient, defaultedOptions()),
  )

  let observerResult = observer().getOptimisticResult(defaultedOptions())
  // The resource settles asynchronously, so remember which observer produced
  // each resolved result and refuse to store it once that observer is replaced
  const resultSources = new WeakMap<object, Obs>()
  const resolveFrom = (
    obs: Obs,
    resolve: (data: ResourceData) => void,
    data: ResourceData,
  ) => {
    resultSources.set(data, obs)
    resolve(data)
  }
  const [state, setState] =
    createStore<QueryObserverResult<TData, TError>>(observerResult)

  const createServerSubscriber = (
    obs: Obs,
    resolve: (
      data: ResourceData | PromiseLike<ResourceData | undefined> | undefined,
    ) => void,
    reject: (reason?: any) => void,
  ) => {
    return obs.subscribe((result) => {
      notifyManager.batchCalls(() => {
        const query = obs.getCurrentQuery()
        const unwrappedResult = hydratableObserverResult(query, result)

        if (result.data !== undefined && unwrappedResult.isError) {
          reject(unwrappedResult.error)
          unsubscribeIfQueued()
        } else {
          resolveFrom(obs, resolve, unwrappedResult)
          unsubscribeIfQueued()
        }
      })()
    })
  }

  const unsubscribeIfQueued = () => {
    if (unsubscribeQueued) {
      unsubscribe?.()
      unsubscribeQueued = false
    }
  }

  const createClientSubscriber = (obs: Obs) => {
    return obs.subscribe((result) => {
      // `observerResult` must only ever hold results of the current observer
      if (obs !== observer()) return
      observerResult = result
      queueMicrotask(() => {
        if (unsubscribe) {
          refetch()
        }
      })
    })
  }

  function setStateWithReconciliation(res: typeof observerResult) {
    const opts = observer().options
    // @ts-expect-error - Reconcile option is not correctly typed internally
    const reconcileOptions = opts.reconcile

    setState((store) => {
      return reconcileFn(
        store,
        res,
        reconcileOptions === undefined ? false : reconcileOptions,
        opts.queryHash,
      )
    })
  }

  function createDeepSignal<T>(): Signal<T> {
    return [
      () => state,
      (v: any) => {
        const unwrapped = unwrap(state)
        if (typeof v === 'function') {
          v = v(unwrapped)
        }
        const source = v && resultSources.get(v)
        if (source && source !== observer()) return
        // Hydration data exists on first load after SSR,
        // and should be removed from the observer result
        if (v?.hydrationData) {
          const { hydrationData, ...rest } = v
          v = rest
        }
        setStateWithReconciliation(v)
      },
    ] as Signal<T>
  }

  /**
   * Unsubscribe is set lazily, so that we can subscribe after hydration when needed.
   */
  let unsubscribe: (() => void) | null = null

  /*
    Fixes #7275
    In a few cases, the observer could unmount before the resource is loaded.
    This leads to Suspense boundaries to be suspended indefinitely.
    This resolver will be called when the observer is unmounting
    but the resource is still in a loading state
  */
  let resolver: ((value: ResourceData) => void) | null = null
  const [queryResource, { refetch }] = createResource<ResourceData | undefined>(
    () => {
      const obs = observer()
      return new Promise((resolve, reject) => {
        resolver = resolve
        if (isServer) {
          unsubscribe = createServerSubscriber(obs, resolve, reject)
        } else if (!unsubscribe && !isRestoring()) {
          unsubscribe = createClientSubscriber(obs)
        }
        obs.updateResult()

        if (
          observerResult.isError &&
          !observerResult.isFetching &&
          !isRestoring() &&
          shouldThrowError(obs.options.throwOnError, [
            observerResult.error,
            obs.getCurrentQuery(),
          ])
        ) {
          setStateWithReconciliation(observerResult)
          return reject(observerResult.error)
        }
        if (!observerResult.isLoading) {
          resolver = null
          return resolveFrom(
            obs,
            resolve,
            hydratableObserverResult(obs.getCurrentQuery(), observerResult),
          )
        }

        setStateWithReconciliation(observerResult)
      })
    },
    {
      storage: createDeepSignal,

      get deferStream() {
        return options().deferStream
      },

      /**
       * If this resource was populated on the server (either sync render, or streamed in over time), onHydrated
       * will be called. This is the point at which we can hydrate the query cache state, and setup the query subscriber.
       *
       * Leveraging onHydrated allows us to plug into the async and streaming support that solidjs resources already support.
       *
       * Note that this is only invoked on the client, for queries that were originally run on the server.
       */
      onHydrated(_k, info) {
        if (info.value && 'hydrationData' in info.value) {
          hydrate(client(), {
            // @ts-expect-error - hydrationData is not correctly typed internally
            queries: [{ ...info.value.hydrationData }],
          })
        }

        if (unsubscribe) return
        /**
         * Do not refetch query on mount if query was fetched on server,
         * even if `staleTime` is not set.
         */
        const newOptions = { ...initialOptions }
        if (
          (initialOptions.staleTime || !initialOptions.initialData) &&
          info.value
        ) {
          newOptions.refetchOnMount = false
        }
        // Setting the options as an immutable object to prevent
        // wonky behavior with observer subscriptions
        const obs = observer()
        obs.setOptions(newOptions)
        setStateWithReconciliation(obs.getOptimisticResult(newOptions))
        unsubscribe = createClientSubscriber(obs)
      },
    },
  )

  onCleanup(() => {
    if (isServer && queryResource.loading) {
      unsubscribeQueued = true
      return
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    if (resolver && !isServer) {
      resolver(observerResult)
      resolver = null
    }
  })

  // Client, options and restoring changes (`defaultedOptions` tracks
  // `isRestoring`) are handled in one computation, so the resource never
  // reloads from a previous client's observer or with outdated options
  createComputed(
    on(
      [client, defaultedOptions],
      ([c, opts]) => {
        if (c !== observerClient) {
          observerClient = c
          if (unsubscribe) {
            unsubscribe()
            unsubscribe = null
          }
          const obs = new Observer(c, opts)
          setObserver(obs)
          setStateWithReconciliation(obs.getOptimisticResult(opts))
          // As on mount, `observerResult` follows the store until the new
          // observer notifies, so nothing from the previous observer remains
          observerResult = unwrap(state)
          if (!isRestoring()) {
            unsubscribe = createClientSubscriber(obs)
          }
        } else {
          const obs = observer()
          obs.setOptions(opts)
          setStateWithReconciliation(obs.getOptimisticResult(opts))
        }
        refetch()
      },
      { defer: true },
    ),
  )

  const handler = {
    get(
      target: QueryObserverResult<TData, TError>,
      prop: keyof QueryObserverResult<TData, TError>,
    ): any {
      if (prop === 'data') {
        if (state.data !== undefined) {
          return queryResource.latest?.data
        }
        return queryResource()?.data
      }
      return Reflect.get(target, prop)
    },
  }

  return new Proxy(state, handler)
}
