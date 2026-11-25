<script lang="ts">
  import {
    persistQueryClientRestore,
    persistQueryClientSubscribe,
  } from '@tanstack/query-persist-client-core'
  import {
    QueryClientProvider,
    setIsRestoringContext,
  } from '@tanstack/svelte-query'
  import { box } from './utils.svelte.js'
  import type { PersistQueryClientOptions } from '@tanstack/query-persist-client-core'
  import type {
    OmitKeyof,
    QueryClientProviderProps,
  } from '@tanstack/svelte-query'

  type PersistQueryClientProviderProps = QueryClientProviderProps & {
    persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
    onSuccess?: () => void
    onError?: () => void
  }

  let {
    client,
    children,
    persistOptions,
    ...props
  }: PersistQueryClientProviderProps = $props()

  let isRestoring = box(true)

  setIsRestoringContext(isRestoring)

  const options = $derived({
    ...persistOptions,
    queryClient: client,
  })

  let hasRestored = false

  $effect(() => {
    const restoreOptions = options
    let isCurrent = true

    isRestoring.current = true
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
          isRestoring.current = false
        }
      })

    return () => {
      isCurrent = false
    }
  })

  // Declared after the restore effect so that, when the options change,
  // restoring is already true again before this effect re-runs.
  $effect(() => {
    return isRestoring.current ? () => {} : persistQueryClientSubscribe(options)
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
