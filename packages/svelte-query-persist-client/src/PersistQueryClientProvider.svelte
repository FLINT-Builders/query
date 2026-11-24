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
    return isRestoring.current ? () => {} : persistQueryClientSubscribe(options)
  })

  let restoreGeneration = 0
  let restoredBuster: string | undefined

  $effect(() => {
    const currentOptions = options
    const generation = ++restoreGeneration
    const buster = currentOptions.buster ?? ''
    if (restoredBuster !== undefined && restoredBuster !== buster) {
      currentOptions.queryClient.clear()
    }
    restoredBuster = buster

    isRestoring.current = true
    persistQueryClientRestore(currentOptions)
      .then(() => {
        if (generation === restoreGeneration) return props.onSuccess?.()
      })
      .catch(() => {
        if (generation === restoreGeneration) return props.onError?.()
      })
      .finally(() => {
        if (generation === restoreGeneration) isRestoring.current = false
      })
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
