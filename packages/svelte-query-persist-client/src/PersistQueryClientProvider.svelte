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

  $effect(() => {
    const currentOptions = options
    let isCurrent = true
    let unsubscribe = () => {}

    isRestoring.current = true
    persistQueryClientRestore(currentOptions)
      .then(() => (isCurrent ? props.onSuccess?.() : undefined))
      .catch(() => (isCurrent ? props.onError?.() : undefined))
      .finally(() => {
        if (isCurrent) {
          unsubscribe = persistQueryClientSubscribe(currentOptions)
          isRestoring.current = false
        }
      })

    return () => {
      isCurrent = false
      unsubscribe()
    }
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
