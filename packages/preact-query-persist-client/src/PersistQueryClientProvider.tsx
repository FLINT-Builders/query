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
import type { PersistQueryClientOptions } from '@tanstack/query-persist-client-core'
import type {
  OmitKeyof,
  QueryClientProviderProps,
} from '@tanstack/preact-query'

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
}: PersistQueryClientProviderProps): VNode => {
  const [isRestoring, setIsRestoring] = useState(true)
  const refs = useRef({ persistOptions, onSuccess, onError })
  const restoredBuster = useRef<string | undefined>(undefined)
  const restoreGeneration = useRef(0)
  const buster = persistOptions.buster ?? ''

  useEffect(() => {
    refs.current = { persistOptions, onSuccess, onError }
  })

  useEffect(() => {
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
        .then(() => {
          if (isCurrent()) return refs.current.onSuccess?.()
        })
        .catch(() => {
          if (isCurrent()) return refs.current.onError?.()
        })
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
