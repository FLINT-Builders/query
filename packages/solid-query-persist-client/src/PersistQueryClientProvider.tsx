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

  let hasRestored = false

  createEffect(() => {
    const restoreOptions = options()
    let isCurrent = true
    onCleanup(() => {
      isCurrent = false
    })

    setIsRestoring(true)
    // Fetches started before this restore must not write into the cache
    // that the new snapshot is about to be hydrated into.
    if (hasRestored) {
      void restoreOptions.queryClient.cancelQueries()
    }
    hasRestored = true

    const { persister } = restoreOptions
    persistQueryClientRestore({
      ...restoreOptions,
      persister: {
        persistClient: (persistedClient) =>
          persister.persistClient(persistedClient),
        restoreClient: async () => {
          const persistedClient = await persister.restoreClient()
          if (!persistedClient || !isCurrent) return undefined
          return {
            ...persistedClient,
            // Read synchronously by `hydrate`, so a restore superseded after
            // this resolved still hydrates nothing.
            get clientState() {
              return isCurrent
                ? persistedClient.clientState
                : { mutations: [], queries: [] }
            },
          }
        },
        removeClient: async () => {
          if (isCurrent) await persister.removeClient()
        },
      },
    })
      .then(() => props.onSuccess?.())
      .catch(() => props.onError?.())
      .finally(() => {
        if (isCurrent) {
          setIsRestoring(false)
        }
      })
  })

  createEffect(() => {
    let unsubscribe = () => {}
    if (!isRestoring()) {
      unsubscribe = persistQueryClientSubscribe(options())
    }
    onCleanup(() => unsubscribe())
  })

  return (
    <QueryClientProvider client={props.client}>
      <IsRestoringProvider value={isRestoring}>
        {props.children}
      </IsRestoringProvider>
    </QueryClientProvider>
  )
}
