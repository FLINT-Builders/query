'use client'
import * as React from 'react'
import type { QueryClient } from '@tanstack/query-core'

/**
 * Returns an observer created for `client`. Observers read and write the cache
 * of the client they were created with, so a new one is created when the
 * client changes.
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
    const next = { client, observer: createObserver() }
    setState(next)
    return next.observer
  }

  return state.observer
}
