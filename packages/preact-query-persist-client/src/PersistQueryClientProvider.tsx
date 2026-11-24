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

function isRestoreTarget(
  target: RestoreTarget | null,
  client: QueryClient,
  persister: Persister,
  buster: string | undefined,
): boolean {
  return (
    target?.client === client &&
    target.persister === persister &&
    target.buster === buster
  )
}

export const PersistQueryClientProvider = ({
  children,
  persistOptions,
  onSuccess,
  onError,
  ...props
}: PersistQueryClientProviderProps): VNode => {
  const { client } = props
  const { persister, buster } = persistOptions
  const [isRestoring, setIsRestoring] = useState(true)
  const [restored, setRestored] = useState<RestoreTarget | null>(null)
  const refs = useRef({ persistOptions, onSuccess, onError })
  const currentRestore = useRef<RestoreTarget | null>(null)

  const isRestored = isRestoreTarget(restored, client, persister, buster)

  useEffect(() => {
    refs.current = { persistOptions, onSuccess, onError }
  })

  useEffect(() => {
    if (isRestoreTarget(currentRestore.current, client, persister, buster)) {
      return
    }

    const target: RestoreTarget = { client, persister, buster }
    const isCurrent = () => currentRestore.current === target
    currentRestore.current = target
    setRestored(null)

    persistQueryClientRestore({
      ...refs.current.persistOptions,
      queryClient: client,
    })
      .then(() => (isCurrent() ? refs.current.onSuccess?.() : undefined))
      .catch(() => (isCurrent() ? refs.current.onError?.() : undefined))
      .finally(() => {
        if (isCurrent()) {
          setIsRestoring(false)
          setRestored(target)
        }
      })
  }, [client, persister, buster])

  useEffect(() => {
    if (!isRestored) return undefined
    return persistQueryClientSubscribe({
      ...refs.current.persistOptions,
      queryClient: client,
    })
  }, [client, isRestored])

  return (
    <QueryClientProvider {...props}>
      <IsRestoringProvider value={isRestoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  )
}
