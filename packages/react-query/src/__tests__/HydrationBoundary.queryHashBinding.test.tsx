import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { render, waitFor } from '@testing-library/react'
import { hashKey } from '@tanstack/query-core'
import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '..'
import type {
  DehydratedState,
  QueryKey,
  QueryState,
} from '@tanstack/query-core'

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

describe('HydrationBoundary query hash binding', () => {
  it('does not render a snapshot whose hash is not the hash of its query key', async () => {
    const calls: Array<QueryKey> = []
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const state: DehydratedState = {
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
      <QueryClientProvider client={client}>
        <HydrationBoundary state={state}>
          <Screen />
        </HydrationBoundary>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(rendered.container.textContent).toBe('network')
    })
    expect(calls).toEqual([trustedKey])
    expect(rendered.container.textContent).not.toContain('forged')
  })
})
