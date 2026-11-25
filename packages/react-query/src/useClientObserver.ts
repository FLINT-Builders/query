'use client'
import * as React from 'react'
import type { QueryClient } from '@tanstack/query-core'

/**
 * Returns an observer created for `client`, and creates a new one whenever a
 * different client is passed. Observers act on the client they were created
 * with, so one must never be reused once the resolved client changes.
 */
export function useClientObserver<TObserver>(
  client: QueryClient,
  createObserver: () => TObserver,
): TObserver {
  const [state, setState] = React.useState(() => ({
    client,
    observer: createObserver(),
  }))

  if (state.client !== client) {
    const observer = createObserver()
    setState({ client, observer })
    return observer
  }

  return state.observer
}
