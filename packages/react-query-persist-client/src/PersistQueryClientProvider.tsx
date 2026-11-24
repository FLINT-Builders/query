'use client'
import * as React from 'react'

import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { IsRestoringProvider, QueryClientProvider } from '@tanstack/react-query'
import type { PersistQueryClientOptions } from '@tanstack/query-persist-client-core'
import type { OmitKeyof, QueryClientProviderProps } from '@tanstack/react-query'

export type PersistQueryClientProviderProps = QueryClientProviderProps & {
  persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
  onSuccess?: () => Promise<unknown> | unknown
  onError?: () => Promise<unknown> | unknown
}

export const PersistQueryClientProvider = ({
  children,
  persistOptions,
  onSuccess,
  onError,
  ...props
}: PersistQueryClientProviderProps): React.JSX.Element => {
  const [isRestoring, setIsRestoring] = React.useState(true)
  const refs = React.useRef({ persistOptions, onSuccess, onError })
  const restoredBuster = React.useRef<string | undefined>(undefined)
  const restoreGeneration = React.useRef(0)
  const buster = persistOptions.buster ?? ''

  React.useEffect(() => {
    refs.current = { persistOptions, onSuccess, onError }
  })

  React.useEffect(() => {
    const options = {
      ...refs.current.persistOptions,
      queryClient: props.client,
    }
    if (restoredBuster.current !== buster) {
      if (restoredBuster.current !== undefined) {
        props.client.clear()
        setIsRestoring(true)
      }
      restoredBuster.current = buster
      const generation = ++restoreGeneration.current
      const isCurrent = () => generation === restoreGeneration.current
      persistQueryClientRestore(options)
        .then(() => (isCurrent() ? refs.current.onSuccess?.() : undefined))
        .catch(() => (isCurrent() ? refs.current.onError?.() : undefined))
        .finally(() => {
          if (isCurrent()) setIsRestoring(false)
        })
      return undefined
    }
    return isRestoring ? undefined : persistQueryClientSubscribe(options)
  }, [props.client, isRestoring, buster])

  return (
    <QueryClientProvider {...props}>
      <IsRestoringProvider value={isRestoring}>{children}</IsRestoringProvider>
    </QueryClientProvider>
  )
}
