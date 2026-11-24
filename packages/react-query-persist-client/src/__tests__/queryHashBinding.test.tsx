import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, hashKey, useQuery } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type {
  DehydratedState,
  QueryKey,
  QueryState,
} from '@tanstack/react-query'
import type { Persister } from '@tanstack/query-persist-client-core'

const trustedKey: QueryKey = ['current-user']
const attackerKey: QueryKey = ['billing', 'other-account']

function successState(data: unknown, dataUpdatedAt: number): QueryState {
  return {
    data,
    dataUpdateCount: 1,
    dataUpdatedAt,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: 'success',
    fetchStatus: 'idle',
  }
}

describe('PersistQueryClientProvider query hash binding', () => {
  it('does not restore a tampered snapshot into the trusted screen', async () => {
    const calls: Array<QueryKey> = []
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const clientState: DehydratedState = {
      mutations: [],
      queries: [
        {
          queryHash: hashKey(trustedKey),
          queryKey: attackerKey,
          dehydratedAt: Date.now(),
          state: successState('forged', Date.now() + 60_000),
        },
      ],
    }
    const persister: Persister = {
      persistClient() {
        return undefined
      },
      restoreClient() {
        return {
          timestamp: Date.now(),
          buster: '',
          clientState,
        }
      },
      removeClient() {
        return undefined
      },
    }

    function Screen() {
      const query = useQuery({
        queryKey: trustedKey,
        queryFn: ({ queryKey }) => {
          calls.push(queryKey)
          return 'network'
        },
      })
      return <span>{query.data ?? 'empty'}</span>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={client}
        persistOptions={{ persister }}
      >
        <Screen />
      </PersistQueryClientProvider>,
    )

    await waitFor(() => {
      expect(rendered.container.textContent).toBe('network')
    })
    expect(calls).toEqual([trustedKey])
    expect(rendered.container.textContent).not.toContain('forged')
  })
})
