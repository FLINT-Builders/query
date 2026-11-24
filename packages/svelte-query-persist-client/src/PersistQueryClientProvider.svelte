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
    const restoreOptions = options
    let isCurrent = true
    let unsubscribe = () => {}

    isRestoring.current = true
    persistQueryClientRestore(restoreOptions)
      .then(() => (isCurrent ? props.onSuccess?.() : undefined))
      .catch(() => (isCurrent ? props.onError?.() : undefined))
      .finally(() => {
        if (!isCurrent) return
        isRestoring.current = false
        unsubscribe = persistQueryClientSubscribe(restoreOptions)
      })

    // Stop saving before the next restore starts, so the previous
    // persister or buster never receives the next restore's data.
    return () => {
      isCurrent = false
      unsubscribe()
    }
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
