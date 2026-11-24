import { describe, expect, it } from 'vitest'
import { QueryClient, QueryObserver, hashKey } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'
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
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
  }
}

describe('sync storage restore query hash binding', () => {
  it('rebinds a tampered persisted snapshot with the client hash function', async () => {
    const queryKeyHashFn = (queryKey: QueryKey) => `app:${hashKey(queryKey)}`
    const forged = { id: 'forged-user' }
    const clientState: DehydratedState = {
      mutations: [],
      queries: [
        {
          queryHash: queryKeyHashFn(trustedKey),
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
    const client = new QueryClient({
      defaultOptions: { queries: { queryKeyHashFn } },
    })

    await persistQueryClientRestore({
      queryClient: client,
      persister: createSyncStoragePersister({ storage, key: storageKey }),
    })

    expect(client.getQueryData(trustedKey)).toBeUndefined()
    expect(client.getQueryData(attackerKey)).toEqual(forged)

    const calls: Array<QueryKey> = []
    const observer = new QueryObserver(client, {
      queryKey: trustedKey,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return { id: 'network-user' }
      },
    })
    await observer.refetch()

    expect(calls).toEqual([trustedKey])
  })
})
