<script lang="ts">
  import { untrack } from 'svelte'
  import {
    persistQueryClientRestore,
    persistQueryClientSubscribe,
  } from '@tanstack/query-persist-client-core'
  import {
    QueryClientProvider,
    setIsRestoringContext,
  } from '@tanstack/svelte-query'
  import { box } from './utils.svelte.js'
  import type {
    PersistQueryClientOptions,
    Persister,
  } from '@tanstack/query-persist-client-core'
  import type {
    OmitKeyof,
    QueryClient,
    QueryClientProviderProps,
  } from '@tanstack/svelte-query'

  type PersistQueryClientProviderProps = QueryClientProviderProps & {
    persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
    onSuccess?: () => void
    onError?: () => void
  }

  type RestoreTarget = {
    client: QueryClient
    persister: Persister
    buster: string | undefined
  }

  let {
    client,
    children,
    persistOptions,
    ...props
  }: PersistQueryClientProviderProps = $props()

  let isRestoring = box(true)
  let restoredTarget: RestoreTarget | null = null
  let restoreId = 0
  let stopSaving = () => {}

  setIsRestoringContext(isRestoring)

  const options = $derived({
    ...persistOptions,
    queryClient: client,
  })

  $effect(() => {
    if (isRestoring.current) return
    const unsubscribe = persistQueryClientSubscribe(options)
    stopSaving = unsubscribe
    return unsubscribe
  })

  $effect(() => {
    const target: RestoreTarget = {
      client,
      persister: persistOptions.persister,
      buster: persistOptions.buster,
    }
    const previous = restoredTarget
    if (
      previous &&
      previous.client === target.client &&
      previous.persister === target.persister &&
      previous.buster === target.buster
    ) {
      return
    }

    restoredTarget = target
    const id = ++restoreId
    const isCurrent = () => restoreId === id
    // A snapshot read for another persister or buster belongs to a different
    // cache and must never be applied once that cache has been replaced.
    const mayApply = () =>
      restoredTarget?.persister === target.persister &&
      restoredTarget.buster === target.buster
    // Any restore after the first replaces the cache identity, so nothing
    // already in memory may outlive it.
    const clearFirst = previous !== null

    untrack(() => {
      isRestoring.current = true
      if (clearFirst) {
        stopSaving()
        target.client.clear()
      }

      let passedGuard = false
      const restoring = persistQueryClientRestore({
        ...options,
        persister: {
          persistClient: (persistedClient) =>
            target.persister.persistClient(persistedClient),
          restoreClient: async () => {
            try {
              const persistedClient = await target.persister.restoreClient()
              if (!mayApply()) return undefined
              passedGuard = true
              if (clearFirst) target.client.clear()
              return persistedClient
            } catch (error) {
              if (!mayApply()) return undefined
              if (clearFirst) target.client.clear()
              throw error
            }
          },
          removeClient: () =>
            mayApply() ? target.persister.removeClient() : undefined,
        },
      })
      // Hydration happens after the guard above, so the cache can be replaced
      // in between; drop whatever this restore applied if that happened.
      const dropIfReplaced = () => {
        if (
          passedGuard &&
          !mayApply() &&
          restoredTarget?.client === target.client
        ) {
          target.client.clear()
        }
      }
      restoring.then(dropIfReplaced, dropIfReplaced)
      restoring
        .then(() => (isCurrent() ? props.onSuccess?.() : undefined))
        .catch(() => (isCurrent() ? props.onError?.() : undefined))
        .finally(() => {
          if (isCurrent()) isRestoring.current = false
        })
    })
  })
</script>

<QueryClientProvider {client} {...props}>
  {@render children()}
</QueryClientProvider>
