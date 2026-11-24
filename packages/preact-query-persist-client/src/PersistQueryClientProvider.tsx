import { useEffect, useRef, useState } from 'preact/hooks'
import type { VNode } from 'preact'

import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import {
  IsRestoringProvider,
  QueryClientProvider,
} from '@tanstack/preact-query'
import type {
  PersistQueryClientOptions,
  Persister,
} from '@tanstack/query-persist-client-core'
import type {
  OmitKeyof,
  QueryClient,
  QueryClientProviderProps,
} from '@tanstack/preact-query'

export type PersistQueryClientProviderProps = QueryClientProviderProps & {
  persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
  onSuccess?: () => Promise<unknown> | unknown
  onError?: () => Promise<unknown> | unknown
}

type RestoreTarget = {
  client: QueryClient
  persister: Persister
  buster: string | undefined
}

export const PersistQueryClientProvider = ({
  children,
  persistOptions,
  onSuccess,
  onError,
  ...props
}: PersistQueryClientProviderProps): VNode => {
  const [isRestoring, setIsRestoring] = useState(true)
  const refs = useRef({ persistOptions, onSuccess, onError })
  const restoredTarget = useRef<RestoreTarget | null>(null)
  const restoreId = useRef(0)
  const { persister, buster } = persistOptions

  useEffect(() => {
    refs.current = { persistOptions, onSuccess, onError }
  })

  useEffect(() => {
    const options = {
      ...refs.current.persistOptions,
      queryClient: props.client,
    }
    const previous = restoredTarget.current
    if (
      previous &&
      previous.client === props.client &&
      previous.persister === persister &&
      previous.buster === buster
    ) {
      return isRestoring ? undefined : persistQueryClientSubscribe(options)
    }

    const target = { client: props.client, persister, buster }
    restoredTarget.current = target
    const id = ++restoreId.current
    const isCurrent = () => restoreId.current === id
    // A snapshot read for another persister or buster belongs to a different
    // cache and must never be applied once that cache has been replaced.
    const mayApply = () =>
      restoredTarget.current?.persister === target.persister &&
      restoredTarget.current.buster === target.buster
    // Any restore after the first replaces the cache identity, so nothing
    // already in memory may outlive it.
    const clearFirst = previous !== null
    if (clearFirst) {
      props.client.clear()
      setIsRestoring(true)
    }

    let passedGuard = false
    const restoring = persistQueryClientRestore({
      ...options,
      persister: {
        persistClient: (persistedClient) =>
          persister.persistClient(persistedClient),
        restoreClient: async () => {
          try {
            const persistedClient = await persister.restoreClient()
            if (!mayApply()) return undefined
            passedGuard = true
            if (clearFirst) props.client.clear()
            return persistedClient
          } catch (error) {
            if (!mayApply()) return undefined
            if (clearFirst) props.client.clear()
            throw error
          }
        },
        removeClient: () => (mayApply() ? persister.removeClient() : undefined),
      },
    })
    // Hydration happens after the guard above, so the cache can be replaced
    // in between; drop whatever this restore applied if that happened.
    const dropIfReplaced = () => {
      if (
        passedGuard &&
        !mayApply() &&
        restoredTarget.current?.client === target.client
      ) {
        target.client.clear()
      }
    }
    restoring.then(dropIfReplaced, dropIfReplaced)
    restoring
      .then(() => (isCurrent() ? refs.current.onSuccess?.() : undefined))
      .catch(() => (isCurrent() ? refs.current.onError?.() : undefined))
      .finally(() => {
        if (isCurrent()) setIsRestoring(false)
      })
    return undefined
  }, [props.client, persister, buster, isRestoring])

  return (
    <QueryClientProvider {...props}>
      <IsRestoringProvider value={isRestoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  )
}
