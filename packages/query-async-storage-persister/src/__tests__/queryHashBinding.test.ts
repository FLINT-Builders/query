import { describe, expect, it } from 'vitest'
import { QueryClient, hashKey } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type {
  DehydratedState,
  QueryKey,
  QueryState,
} from '@tanstack/query-core'

const trustedKey: QueryKey = ['current-user']
const attackerKey: QueryKey = ['billing', 'other-account']
const storageKey = 'OFFLINE_QUERY_CACHE'

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

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => Promise.resolve(items.get(key) ?? null),
    setItem: (key: string, value: string) => {
      items.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      items.delete(key)
      return Promise.resolve()
    },
  }
}

describe('async storage restore query hash binding', () => {
  it('does not let a tampered persisted snapshot answer or refetch the trusted key', async () => {
    const forged = 'forged'
    const clientState: DehydratedState = {
      mutations: [],
      queries: [
        {
          queryHash: hashKey(trustedKey),
          queryKey: attackerKey,
          dehydratedAt: Date.now(),
          state: successState(forged, Date.now() + 60_000),
        },
      ],
    }
    const storage = memoryStorage({
      [storageKey]: JSON.stringify({
        timestamp: Date.now(),
        buster: '',
        clientState,
      }),
    })
    const client = new QueryClient()

    await persistQueryClientRestore({
      queryClient: client,
      persister: createAsyncStoragePersister({ storage, key: storageKey }),
    })

    expect(client.getQueryData(trustedKey)).toBeUndefined()
    expect(client.getQueryData(attackerKey)).toBe(forged)

    await client.invalidateQueries({
      queryKey: trustedKey,
      exact: true,
      refetchType: 'none',
    })
    const calls: Array<QueryKey> = []
    const data = await client.query({
      queryKey: trustedKey,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return 'network'
      },
    })

    expect(data).toBe('network')
    expect(calls).toEqual([trustedKey])
  })
})
