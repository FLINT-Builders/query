import {
  persistQueryClientRestoreLatest,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from 'solid-js'
import { IsRestoringProvider, QueryClientProvider } from '@tanstack/solid-query'
import type { PersistQueryClientOptions } from '@tanstack/query-persist-client-core'
import type { OmitKeyof, QueryClientProviderProps } from '@tanstack/solid-query'
import type { JSX } from 'solid-js'

export type PersistQueryClientProviderProps = QueryClientProviderProps & {
  persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
  onSuccess?: () => void
  onError?: () => void
}

export const PersistQueryClientProvider = (
  props: PersistQueryClientProviderProps,
): JSX.Element => {
  const [isRestoring, setIsRestoring] = createSignal(true)

  const options = createMemo(() => ({
    ...props.persistOptions,
    queryClient: props.client,
  }))

  createEffect(() => {
    const restoreOptions = options()
    let active = true
    let unsubscribe = () => {}

    untrack(() => {
      setIsRestoring(true)
      const [isLatest, restorePromise] =
        persistQueryClientRestoreLatest(restoreOptions)
      restorePromise
        .then(() => (active ? props.onSuccess?.() : undefined))
        .catch(() => (active ? props.onError?.() : undefined))
        .finally(() => {
          if (!active) return
          if (isLatest()) {
            unsubscribe = persistQueryClientSubscribe(restoreOptions)
          }
          setIsRestoring(false)
        })
    })

    onCleanup(() => {
      active = false
      unsubscribe()
    })
  })

  return (
    <QueryClientProvider client={props.client}>
      <IsRestoringProvider value={isRestoring}>
        {props.children}
      </IsRestoringProvider>
    </QueryClientProvider>
  )
}
