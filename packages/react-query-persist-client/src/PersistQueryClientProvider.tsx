'use client'
import * as React from 'react'

import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { IsRestoringProvider, QueryClientProvider } from '@tanstack/react-query'
import type {
  PersistQueryClientOptions,
  Persister,
} from '@tanstack/query-persist-client-core'
import type {
  OmitKeyof,
  QueryClient,
  QueryClientProviderProps,
} from '@tanstack/react-query'

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
}: PersistQueryClientProviderProps): React.JSX.Element => {
  const { client } = props
  const { persister, buster } = persistOptions
  const [isRestoring, setIsRestoring] = React.useState(true)
  const [restored, setRestored] = React.useState<RestoreTarget | null>(null)
  const refs = React.useRef({ persistOptions, onSuccess, onError })
  const currentRestore = React.useRef<RestoreTarget | null>(null)

  const isRestored = isRestoreTarget(restored, client, persister, buster)

  React.useEffect(() => {
    refs.current = { persistOptions, onSuccess, onError }
  })

  React.useEffect(() => {
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

  React.useEffect(() => {
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
