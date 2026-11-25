'use client'
import * as React from 'react'
import type { QueryClient } from '@tanstack/query-core'

export const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/**
 * Returns an observer bound to `client`, creating a new one with
 * `createObserver` whenever the resolved client changes. Observers read from
 * and write to the caches of the client they were created with, so one must
 * never outlive a change of client.
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
