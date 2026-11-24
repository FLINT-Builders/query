import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
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
    let isCurrent = true
    let unsubscribe = () => {}
    // Stop saving before the next restore starts, so the previous
    // persister or buster never receives the next restore's data.
    onCleanup(() => {
      isCurrent = false
      unsubscribe()
    })

    setIsRestoring(true)
    persistQueryClientRestore(restoreOptions)
      .then(() => (isCurrent ? props.onSuccess?.() : undefined))
      .catch(() => (isCurrent ? props.onError?.() : undefined))
      .finally(() => {
        if (!isCurrent) return
        setIsRestoring(false)
        unsubscribe = persistQueryClientSubscribe(restoreOptions)
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
