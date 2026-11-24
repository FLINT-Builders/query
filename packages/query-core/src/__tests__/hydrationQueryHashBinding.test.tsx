import { describe, expect, it } from 'vitest'
import { QueryClient } from '../queryClient'
import { QueryObserver } from '../queryObserver'
import { dehydrate, hydrate } from '../hydration'
import { hashKey } from '../utils'
import type { DehydratedState, QueryKey, QueryState } from '../index'
import type { Query } from '../query'

const trustedKey: QueryKey = ['current-user']
const attackerKey: QueryKey = ['billing', 'other-account']

function successState<TData>(
  data: TData,
  dataUpdatedAt: number,
): QueryState<TData> {
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

function tamperedState(
  queryHash: string,
  data: unknown,
  queryType?: 'infinite',
): DehydratedState {
  return {
    mutations: [],
    queries: [
      {
        queryHash,
        queryKey: attackerKey,
        dehydratedAt: Date.now(),
        state: successState(data, Date.now() + 60_000),
        ...(queryType ? { queryType } : {}),
      },
    ],
  }
}

function restoredQuery(client: QueryClient): Query {
  const query = client
    .getQueryCache()
    .getAll()
    .find((entry) => {
      return JSON.stringify(entry.queryKey) === JSON.stringify(attackerKey)
    })
  if (!query) {
    throw new Error('restored query was not cached')
  }
  return query
}

describe('hydration query hash binding', () => {
  it('keeps a consistent dehydrated snapshot on its own key', () => {
    const source = new QueryClient()
    source.setQueryData(trustedKey, 'legitimate')

    const client = new QueryClient()
    hydrate(client, dehydrate(source))

    expect(client.getQueryData(trustedKey)).toBe('legitimate')
    expect(client.getQueryData(attackerKey)).toBeUndefined()
  })

  it('does not serve a snapshot under a hash that is not the hash of its query key', () => {
    const client = new QueryClient()
    hydrate(client, tamperedState(hashKey(trustedKey), { id: 'forged-user' }))

    expect(client.getQueryData(trustedKey)).toBeUndefined()
    expect(client.getQueryData(attackerKey)).toEqual({ id: 'forged-user' })
    expect(restoredQuery(client).queryKey).toEqual(attackerKey)
    expect(restoredQuery(client).queryHash).toBe(hashKey(attackerKey))
  })

  it('uses the client hash function when rebinding a restored snapshot', () => {
    const queryKeyHashFn = (queryKey: QueryKey) => `app:${hashKey(queryKey)}`
    const client = new QueryClient({
      defaultOptions: { queries: { queryKeyHashFn } },
    })
    hydrate(
      client,
      tamperedState(queryKeyHashFn(trustedKey), { id: 'forged-user' }),
    )

    expect(client.getQueryData(trustedKey)).toBeUndefined()
    expect(client.getQueryData(attackerKey)).toEqual({ id: 'forged-user' })
    expect(restoredQuery(client).queryHash).toBe(queryKeyHashFn(attackerKey))
  })

  it('does not overwrite an existing trusted query when only the snapshot hash matches it', () => {
    const client = new QueryClient()
    client.setQueryData(trustedKey, 'legitimate')
    hydrate(client, tamperedState(hashKey(trustedKey), 'forged'))

    expect(client.getQueryData(trustedKey)).toBe('legitimate')
    expect(client.getQueryData(attackerKey)).toBe('forged')
  })

  it('calls the query function with the key from the active fetch options', async () => {
    const client = new QueryClient()
    const forged = { id: 'forged-user' }
    hydrate(client, tamperedState(hashKey(trustedKey), forged))
    const calls: Array<QueryKey> = []

    const data = await restoredQuery(client).fetch({
      queryKey: trustedKey,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return { id: 'network-user' }
      },
    })

    expect(calls).toEqual([trustedKey])
    expect(data).toEqual({ id: 'network-user' })
  })

  it('calls an infinite query function with the key from the active fetch options', async () => {
    const client = new QueryClient()
    const forged = { pages: ['forged-page'], pageParams: [0] }
    hydrate(client, tamperedState(hashKey(trustedKey), forged, 'infinite'))
    const calls: Array<QueryKey> = []

    await restoredQuery(client).fetch({
      queryKey: trustedKey,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return 'network-page'
      },
    })

    expect(calls).toEqual([trustedKey])
  })

  it('uses the observer key when a restored entry is fetched again', async () => {
    const client = new QueryClient()
    hydrate(client, tamperedState(hashKey(trustedKey), 'forged'))
    const calls: Array<QueryKey> = []
    const observer = new QueryObserver(client, {
      queryKey: trustedKey,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return 'network'
      },
    })

    await observer.refetch()

    expect(calls).toEqual([trustedKey])
    expect(client.getQueryData(trustedKey)).toBe('network')
  })

  it('uses the observer key when refetchQueries finds the entry by hash', async () => {
    const client = new QueryClient()
    hydrate(client, tamperedState(hashKey(trustedKey), 'forged'))
    const calls: Array<QueryKey> = []
    const observer = new QueryObserver(client, {
      queryKey: trustedKey,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return 'network'
      },
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await client.refetchQueries({ queryKey: trustedKey, exact: true })
    unsubscribe()

    expect(calls).toEqual([trustedKey])
  })

  it('uses the caller key when a fresh restored entry is invalidated and queried again', async () => {
    const client = new QueryClient()
    hydrate(client, tamperedState(hashKey(trustedKey), 'forged'))
    const calls: Array<QueryKey> = []

    await client.invalidateQueries({
      queryKey: trustedKey,
      exact: true,
      refetchType: 'none',
    })
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

  it('does not return the forged payload for a fresh trusted read', async () => {
    const client = new QueryClient()
    hydrate(client, tamperedState(hashKey(trustedKey), 'forged'))
    const calls: Array<QueryKey> = []

    const data = await client.query({
      queryKey: trustedKey,
      staleTime: 0,
      queryFn: ({ queryKey }) => {
        calls.push(queryKey)
        return 'network'
      },
    })

    expect(data).toBe('network')
    expect(calls).toEqual([trustedKey])
  })
})
