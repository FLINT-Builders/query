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
import { noop, shouldThrowError } from '@tanstack/query-core'
import { useQueryClientRef } from './useQueryClientRef'
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
 * will be used. Pass a `ref` or getter to switch clients while the component stays mounted.
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
  queryClient?: MaybeRefOrGetter<QueryClient>,
): UseBaseQueryReturnType<TData, TError> {
  if (process.env.NODE_ENV === 'development') {
    if (!getCurrentScope()) {
      console.warn(
        'vue-query composable like "useQuery()" should only be used inside a "setup()" function or a running effect scope. They might otherwise lead to memory leaks.',
      )
    }
  }

  const client = useQueryClientRef(queryClient)

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

  let unsubscribe: () => void = noop

  const subscribe = () => {
    unsubscribe()
    unsubscribe = observer.subscribe((result) => {
      updateState(state, result)
    })
  }

  // Every read and write goes through the observer returned here, so it is always bound to the current client.
  const getObserver = () => {
    const currentClient = client.value
    if (currentClient !== observerClient) {
      unsubscribe()
      unsubscribe = noop
      observerClient = currentClient
      observer = new Observer(currentClient, defaultedOptions.value)
      updateState(state, observer.getCurrentResult())
      if (currentClient.isRestoring && !currentClient.isRestoring.value) {
        subscribe()
      }
    }
    return observer
  }

  watch(client, () => getObserver(), { flush: 'sync' })

  watch(
    () => client.value.isRestoring?.value,
    (isRestoring) => {
      if (isRestoring === false) {
        subscribe()
      }
    },
    { immediate: true },
  )

  const updater = () => {
    const currentObserver = getObserver()
    currentObserver.setOptions(defaultedOptions.value)
    updateState(state, currentObserver.getCurrentResult())
  }

  watch(defaultedOptions, updater)

  onScopeDispose(() => {
    unsubscribe()
  })

  // fix #5910
  const refetch = (...args: Parameters<(typeof state)['refetch']>) => {
    updater()
    return getObserver().refetch(...args)
  }

  const suspense = () => {
    return new Promise<QueryObserverResult<TData, TError>>(
      (resolve, reject) => {
        let stopWatch = () => {
          // noop
        }
        const run = () => {
          if (defaultedOptions.value.enabled !== false) {
            const currentObserver = getObserver()
            // fix #6133
            currentObserver.setOptions(defaultedOptions.value)
            const optimisticResult = currentObserver.getOptimisticResult(
              defaultedOptions.value,
            )
            if (optimisticResult.isStale) {
              stopWatch()
              currentObserver
                .fetchOptimistic(defaultedOptions.value)
                .then(resolve, (error: TError) => {
                  if (
                    shouldThrowError(defaultedOptions.value.throwOnError, [
                      error,
                      currentObserver.getCurrentQuery(),
                    ])
                  ) {
                    reject(error)
                  } else {
                    resolve(currentObserver.getCurrentResult())
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
          getObserver().getCurrentQuery(),
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
      // Result methods are bound to the observer that created them, so delegate to the current one.
      object[key] = (...args: Array<any>) => {
        getObserver()
        return (state as any)[key](...args)
      }
    }
  }

  object.suspense = suspense
  object.refetch = refetch

  return object as UseBaseQueryReturnType<TData, TError>
}
