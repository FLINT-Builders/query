<script lang="ts">
  import { untrack } from 'svelte'
  import {
    persistQueryClientRestoreLatest,
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
    let active = true
    let unsubscribe: (() => void) | undefined

    untrack(() => {
      isRestoring.current = true
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
          isRestoring.current = false
        })
    })

    return () => {
      active = false
      unsubscribe?.()
    }
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
