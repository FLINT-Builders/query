import {
  computed,
  getCurrentScope,
  onScopeDispose,
  reactive,
  readonly,
  shallowReactive,
  shallowReadonly,
  toRefs,
  watch,
} from 'vue-demi'
import { shouldThrowError } from '@tanstack/query-core'
import { useTrackedQueryClient } from './useTrackedQueryClient'
import { cloneDeepUnref, updateState } from './utils'
import type { Ref } from 'vue-demi'
import type {
  DefaultedQueryObserverOptions,
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'
import type { QueryClient } from './queryClient'
import type { UseQueryOptions } from './queryOptions'
import type { UseInfiniteQueryOptions } from './useInfiniteQuery'
import type { MaybeRefOrGetter } from './types'

export type UseBaseQueryReturnType<
  TData,
  TError,
  TResult = QueryObserverResult<TData, TError>,
> = {
  [K in keyof TResult]: K extends
    | 'fetchNextPage'
    | 'fetchPreviousPage'
    | 'refetch'
    ? TResult[K]
    : Ref<Readonly<TResult>[K]>
} & {
  suspense: () => Promise<TResult>
}

type UseQueryOptionsGeneric<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> =
  | UseQueryOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>
  | UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>

/**
 * Base implementation shared by `useQuery` and `useInfiniteQuery`.
 *
 * @param Observer - The observer class from query-core (`QueryObserver` or `InfiniteQueryObserver`).
 * @param options - A `ref`, plain value, or reactive getter resolving to the query options.
 * @param queryClient - Use this to use a custom `QueryClient`. Otherwise, the one provided by `VueQueryPlugin`
 * will be used.
 */
export function useBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
  TPageParam,
>(
  Observer: typeof QueryObserver,
  options: MaybeRefOrGetter<
    UseQueryOptionsGeneric<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey,
      TPageParam
    >
  >,
  queryClient?: QueryClient,
): UseBaseQueryReturnType<TData, TError> {
  if (process.env.NODE_ENV === 'development') {
    if (!getCurrentScope()) {
      console.warn(
        'vue-query composable like "useQuery()" should only be used inside a "setup()" function or a running effect scope. They might otherwise lead to memory leaks.',
      )
    }
  }

  const client = useTrackedQueryClient(queryClient)

  const defaultedOptions = computed(() => {
    let resolvedOptions = options
    if (typeof resolvedOptions === 'function') {
      resolvedOptions = resolvedOptions()
    }
    const clonedOptions = cloneDeepUnref(resolvedOptions as any)

    if (typeof clonedOptions.enabled === 'function') {
      clonedOptions.enabled = clonedOptions.enabled()
    }

    const defaulted: DefaultedQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    > = client.value.defaultQueryOptions(clonedOptions)

    defaulted._optimisticResults = client.value.isRestoring?.value
      ? 'isRestoring'
      : 'optimistic'

    return defaulted
  })

  let observerClient = client.value
  let observer = new Observer(observerClient, defaultedOptions.value)
  // @ts-expect-error
  const state = defaultedOptions.value.shallow
    ? shallowReactive(observer.getCurrentResult())
    : reactive(observer.getCurrentResult())

  let unsubscribe = () => {
    // noop
  }

  const subscribe = () => {
    unsubscribe()
    unsubscribe = observer.subscribe((result) => {
      updateState(state, result)
    })
  }

  // Replaces the observer once the provided client changes, so nothing keeps fetching on the previous client.
  const bindObserver = () => {
    const current = client.value
    if (current === observerClient) {
      return false
    }
    unsubscribe()
    unsubscribe = () => {
      // noop
    }
    observerClient = current
    observer = new Observer(current, defaultedOptions.value)
    if (current.isRestoring && !current.isRestoring.value) {
      subscribe()
    }
    updateState(state, observer.getCurrentResult())
    return true
  }

  watch(
    () => client.value.isRestoring?.value,
    (isRestoring) => {
      if (!bindObserver() && client.value.isRestoring && !isRestoring) {
        subscribe()
      }
    },
    { immediate: true },
  )

  const syncObserver = () => {
    if (!bindObserver()) {
      observer.setOptions(defaultedOptions.value)
    }
  }

  const updater = () => {
    syncObserver()
    updateState(state, observer.getCurrentResult())
  }

  // Keeps the returned state in step with the client and options as soon as they change. Fetching for new
  // options still waits for `updater`, so several changes in one tick start a single fetch.
  watch(
    defaultedOptions,
    (nextOptions) => {
      if (!bindObserver()) {
        updateState(state, observer.getOptimisticResult(nextOptions))
      }
    },
    { flush: 'sync' },
  )

  watch(defaultedOptions, updater)

  onScopeDispose(() => {
    unsubscribe()
  })

  // fix #5910
  const refetch = (...args: Parameters<(typeof state)['refetch']>) => {
    updater()
    return state.refetch(...args)
  }

  const suspense = () => {
    return new Promise<QueryObserverResult<TData, TError>>(
      (resolve, reject) => {
        let stopWatch = () => {
          // noop
        }
        const run = () => {
          if (defaultedOptions.value.enabled !== false) {
            // fix #6133
            syncObserver()
            const optimisticResult = observer.getOptimisticResult(
              defaultedOptions.value,
            )
            if (optimisticResult.isStale) {
              stopWatch()
              observer
                .fetchOptimistic(defaultedOptions.value)
                .then(resolve, (error: TError) => {
                  if (
                    shouldThrowError(defaultedOptions.value.throwOnError, [
                      error,
                      observer.getCurrentQuery(),
                    ])
                  ) {
                    reject(error)
                  } else {
                    resolve(observer.getCurrentResult())
                  }
                })
            } else {
              stopWatch()
              resolve(optimisticResult)
            }
          }
        }

        run()

        stopWatch = watch(defaultedOptions, run)
      },
    )
  }

  // Handle error boundary
  watch(
    () => state.error,
    (error) => {
      if (
        state.isError &&
        !state.isFetching &&
        shouldThrowError(defaultedOptions.value.throwOnError, [
          error as TError,
          observer.getCurrentQuery(),
        ])
      ) {
        throw error
      }
    },
  )

  // @ts-expect-error
  const readonlyState = defaultedOptions.value.shallow
    ? shallowReadonly(state)
    : readonly(state)

  const object: any = toRefs(readonlyState)
  for (const key in state) {
    if (typeof state[key as keyof typeof state] === 'function') {
      object[key] = (...args: Array<unknown>) => {
        bindObserver()
        return (state as any)[key](...args)
      }
    }
  }

  object.suspense = suspense
  object.refetch = refetch

  return object as UseBaseQueryReturnType<TData, TError>
}
