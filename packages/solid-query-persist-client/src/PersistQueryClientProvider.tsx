import {
  persistQueryClientRestore,
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
import type {
  PersistQueryClientOptions,
  Persister,
} from '@tanstack/query-persist-client-core'
import type {
  OmitKeyof,
  QueryClient,
  QueryClientProviderProps,
} from '@tanstack/solid-query'
import type { JSX } from 'solid-js'

export type PersistQueryClientProviderProps = QueryClientProviderProps & {
  persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
  onSuccess?: () => void
  onError?: () => void
}

type RestoreTarget = {
  client: QueryClient
  persister: Persister
  buster: string | undefined
}

export const PersistQueryClientProvider = (
  props: PersistQueryClientProviderProps,
): JSX.Element => {
  const [isRestoring, setIsRestoring] = createSignal(true)
  let restoredTarget: RestoreTarget | null = null
  let restoreId = 0
  let stopSaving = () => {}

  const options = createMemo(() => ({
    ...props.persistOptions,
    queryClient: props.client,
  }))

  createEffect(() => {
    const target: RestoreTarget = {
      client: props.client,
      persister: props.persistOptions.persister,
      buster: props.persistOptions.buster,
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
      setIsRestoring(true)
      if (clearFirst) {
        stopSaving()
        target.client.clear()
      }

      let passedGuard = false
      const restoring = persistQueryClientRestore({
        ...options(),
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
          if (isCurrent()) setIsRestoring(false)
        })
    })
  })

  createEffect(() => {
    if (isRestoring()) return
    const unsubscribe = persistQueryClientSubscribe(options())
    stopSaving = unsubscribe
    onCleanup(unsubscribe)
  })

  return (
    <QueryClientProvider client={props.client}>
      <IsRestoringProvider value={isRestoring}>
        {props.children}
      </IsRestoringProvider>
    </QueryClientProvider>
  )
}
