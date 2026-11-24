import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import { InfiniteQueryObserver } from '../infiniteQueryObserver'
import { QueriesObserver } from '../queriesObserver'
import { QueryClient } from '../queryClient'
import { QueryObserver } from '../queryObserver'
import { dehydrate, hydrate } from '../hydration'
import { focusManager } from '../focusManager'
import { onlineManager } from '../onlineManager'
import { timeoutManager } from '../timeoutManager'
import { timeUntilStale } from '../utils'
import { setIsServer } from './utils'
import type { DehydratedState } from '../hydration'

/**
 * Spec for a future `dataUpdatedAt` supplied by a restored snapshot.
 * These tests fail while a timestamp ahead of the clock keeps a query fresh
 * for the default stale time of 0, and they pass once that timestamp counts
 * as the current time.
 */

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
const FORGED_PROFILE = { name: 'forged', role: 'admin' }
const SERVER_PROFILE = { name: 'real', role: 'member' }

function futureUpdatedAt(): number {
  return Date.now() + ONE_YEAR_MS
}

function attackerSnapshot(
  dataUpdatedAt: number,
  data: unknown = FORGED_PROFILE,
): { key: Array<string>; snapshot: DehydratedState } {
  const setup = new QueryClient()
  const key = queryKey()
  setup.setQueryData(key, SERVER_PROFILE)
  const roundTripped = JSON.parse(
    JSON.stringify(dehydrate(setup)),
  ) as DehydratedState
  setup.clear()

  const entry = roundTripped.queries[0]
  if (!entry) {
    throw new Error('expected a dehydrated query to tamper with')
  }
  entry.state = {
    ...entry.state,
    data,
    dataUpdatedAt,
    status: 'success',
    fetchStatus: 'idle',
    isInvalidated: false,
  }
  return { key, snapshot: roundTripped }
}

function restoredClient(snapshot: DehydratedState): QueryClient {
  const client = new QueryClient()
  hydrate(client, snapshot)
  return client
}

describe('future dataUpdatedAt freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  describe('timeUntilStale and isStaleByTime', () => {
    it('counts a timestamp in the future as now for the configured stale time', () => {
      const now = Date.now()

      expect(timeUntilStale(now + ONE_YEAR_MS, 0)).toBe(0)
      expect(timeUntilStale(now + ONE_YEAR_MS, 5_000)).toBe(5_000)
      expect(timeUntilStale(now - 10_000, 0)).toBe(0)
      expect(timeUntilStale(now, 5_000)).toBe(5_000)
      expect(timeUntilStale(now - 1_000, 5_000)).toBe(4_000)
    })

    it('treats a future dataUpdatedAt as stale at the default stale time of 0', () => {
      const client = new QueryClient()
      const key = queryKey()
      client.setQueryData(key, SERVER_PROFILE)
      const query = client.getQueryCache().find({ queryKey: key })
      if (!query) {
        throw new Error('expected query')
      }
      query.state = {
        ...query.state,
        data: FORGED_PROFILE,
        dataUpdatedAt: futureUpdatedAt(),
        status: 'success',
        dataUpdateCount: 1,
        isInvalidated: false,
      }

      expect(query.isStaleByTime()).toBe(true)
      expect(query.isStaleByTime(0)).toBe(true)
      expect(query.isStaleByTime(5_000)).toBe(false)
      expect(query.isStaleByTime('static')).toBe(false)

      query.state = { ...query.state, isInvalidated: true }
      expect(query.isStaleByTime(60_000)).toBe(true)

      client.clear()
    })
  })

  describe('hydrate', () => {
    it('refetches a new query whose restored timestamp is in the future', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      const query = client.getQueryCache().find({ queryKey: key })
      if (!query) {
        throw new Error('expected hydrated query')
      }

      expect(query.state.data).toEqual(FORGED_PROFILE)
      expect(query.state.dataUpdatedAt).toBeLessThanOrEqual(Date.now())

      const seen = await observeUntilFetched(client, key)
      expect(seen.queryFn).toHaveBeenCalledTimes(1)
      expect(seen.data).toEqual(SERVER_PROFILE)
      expect(client.getQueryData(key)).toEqual(SERVER_PROFILE)

      client.clear()
    })

    it('refetches when staleTime is explicitly 0', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)
      const result = await client.query({
        queryKey: key,
        queryFn,
        staleTime: 0,
      })

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(SERVER_PROFILE)

      client.clear()
    })

    it('overwrites older cached data from the snapshot and still refetches', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = new QueryClient()
      client.setQueryData(key, SERVER_PROFILE, {
        updatedAt: Date.now() - 60_000,
      })

      hydrate(client, snapshot)

      const query = client.getQueryCache().find({ queryKey: key })
      if (!query) {
        throw new Error('expected hydrated query')
      }
      expect(query.state.data).toEqual(FORGED_PROFILE)
      expect(query.state.dataUpdatedAt).toBeLessThanOrEqual(Date.now())

      const seen = await observeUntilFetched(client, key)
      expect(seen.queryFn).toHaveBeenCalledTimes(1)
      expect(seen.data).toEqual(SERVER_PROFILE)

      client.clear()
    })

    it('still refetches a tampered snapshot whose timestamp is in the past', async () => {
      const { key, snapshot } = attackerSnapshot(Date.now() - 60_000)
      const client = restoredClient(snapshot)
      const seen = await observeUntilFetched(client, key)

      expect(seen.queryFn).toHaveBeenCalledTimes(1)
      expect(seen.data).toEqual(SERVER_PROFILE)

      client.clear()
    })

    it('keeps a recent snapshot fresh for a positive staleTime', async () => {
      const { key, snapshot } = attackerSnapshot(Date.now(), SERVER_PROFILE)
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => FORGED_PROFILE)
      const result = await client.query({
        queryKey: key,
        queryFn,
        staleTime: 60_000,
      })

      expect(queryFn).not.toHaveBeenCalled()
      expect(result).toEqual(SERVER_PROFILE)

      client.clear()
    })

    it('does not schedule a stale timer past the configured staleTime', () => {
      const restoreIsServer = setIsServer(false)
      try {
        const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
        const client = restoredClient(snapshot)
        const queryFn = vi.fn(() => SERVER_PROFILE)
        const setTimeoutSpy = vi.spyOn(timeoutManager, 'setTimeout')
        setTimeoutSpy.mockClear()

        const observer = new QueryObserver(client, {
          queryKey: key,
          queryFn,
          staleTime: 5_000,
        })
        const unsubscribe = observer.subscribe(() => undefined)

        const delays = setTimeoutSpy.mock.calls.map((call) => call[1])
        expect(queryFn).not.toHaveBeenCalled()
        expect(observer.getCurrentResult().isStale).toBe(false)
        expect(Math.max(...delays, 0)).toBeLessThanOrEqual(5_001)
        expect(delays).toContain(5_001)

        unsubscribe()
        setTimeoutSpy.mockRestore()
        client.clear()
      } finally {
        restoreIsServer()
      }
    })

    it('does not refetch a future timestamp when staleTime is static', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)
      const result = await client.query({
        queryKey: key,
        queryFn,
        staleTime: 'static',
      })

      expect(queryFn).not.toHaveBeenCalled()
      expect(result).toEqual(FORGED_PROFILE)

      client.clear()
    })

    it.each(['query', 'fetchQuery', 'prefetchQuery'] as const)(
      'refetches through %s',
      async (method) => {
        const executed = await executePath(method)
        expect(executed.queryFn).toHaveBeenCalledTimes(1)
        expect(executed.data).toEqual(SERVER_PROFILE)
      },
    )

    it.each([
      'infiniteQuery',
      'fetchInfiniteQuery',
      'prefetchInfiniteQuery',
    ] as const)('refetches through %s', async (method) => {
      const executed = await executeInfinitePath(method)
      expect(executed.queryFn).toHaveBeenCalledTimes(1)
    })

    it('revalidates ensureQueryData when revalidateIfStale is set', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)

      // ensureQueryData is the operation under test: its revalidateIfStale
      // branch calls isStaleByTime, which query() with staleTime static does not.
      // eslint-disable-next-line no-restricted-syntax
      const returned = await client.ensureQueryData({
        queryKey: key,
        queryFn,
        revalidateIfStale: true,
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(returned).toEqual(FORGED_PROFILE)
      expect(queryFn).toHaveBeenCalledTimes(1)

      client.clear()
    })

    it('revalidates ensureInfiniteQueryData when revalidateIfStale is set', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt(), {
        pages: [FORGED_PROFILE],
        pageParams: [0],
      })
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)

      // Same staleness branch as ensureQueryData, for infinite queries.
      // eslint-disable-next-line no-restricted-syntax
      await client.ensureInfiniteQueryData({
        queryKey: key,
        queryFn,
        initialPageParam: 0,
        revalidateIfStale: true,
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)

      client.clear()
    })

    it('refetches on focus when mount refetch is disabled', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      client.mount()
      focusManager.setFocused(false)

      const queryFn = vi.fn(() => SERVER_PROFILE)
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn,
        refetchOnMount: false,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      expect(queryFn).not.toHaveBeenCalled()

      focusManager.setFocused(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)

      unsubscribe()
      client.unmount()
      client.clear()
    })

    it('refetches on reconnect when mount refetch is disabled', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      client.mount()
      onlineManager.setOnline(false)

      const queryFn = vi.fn(() => SERVER_PROFILE)
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn,
        refetchOnMount: false,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      expect(queryFn).not.toHaveBeenCalled()

      onlineManager.setOnline(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)

      unsubscribe()
      client.unmount()
      client.clear()
    })

    it('refetches from QueriesObserver', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)
      const observer = new QueriesObserver(client, [{ queryKey: key, queryFn }])
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(client.getQueryData(key)).toEqual(SERVER_PROFILE)

      unsubscribe()
      client.clear()
    })

    it('refetches an infinite query observer', async () => {
      const { key, snapshot } = attackerSnapshot(futureUpdatedAt(), {
        pages: [FORGED_PROFILE],
        pageParams: [0],
      })
      const client = restoredClient(snapshot)
      const queryFn = vi.fn(() => SERVER_PROFILE)
      const observer = new InfiniteQueryObserver(client, {
        queryKey: key,
        queryFn,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(observer.getCurrentResult().data).toEqual({
        pages: [SERVER_PROFILE],
        pageParams: [0],
      })

      unsubscribe()
      client.clear()
    })

    it('refetches initialData whose initialDataUpdatedAt is in the future', async () => {
      const client = new QueryClient()
      const key = queryKey()
      const queryFn = vi.fn(() => SERVER_PROFILE)
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn,
        initialData: FORGED_PROFILE,
        initialDataUpdatedAt: futureUpdatedAt(),
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)

      unsubscribe()
      client.clear()
    })

    it('refetches after setQueryData records a future updatedAt', async () => {
      const client = new QueryClient()
      const key = queryKey()
      client.setQueryData(key, FORGED_PROFILE, { updatedAt: futureUpdatedAt() })
      const queryFn = vi.fn(() => SERVER_PROFILE)

      const result = await client.query({ queryKey: key, queryFn })

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(SERVER_PROFILE)
      client.clear()
    })

    it('refetches after setQueriesData records a future updatedAt', async () => {
      const client = new QueryClient()
      const key = queryKey()
      client.setQueryData(key, SERVER_PROFILE)
      client.setQueriesData({ queryKey: key }, FORGED_PROFILE, {
        updatedAt: futureUpdatedAt(),
      })
      const queryFn = vi.fn(() => SERVER_PROFILE)

      const result = await client.query({ queryKey: key, queryFn })

      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(result).toEqual(SERVER_PROFILE)
      client.clear()
    })
  })
})

async function observeUntilFetched(
  client: QueryClient,
  key: Array<string>,
): Promise<{ queryFn: ReturnType<typeof vi.fn>; data: unknown }> {
  const queryFn = vi.fn(() => SERVER_PROFILE)
  const observer = new QueryObserver(client, { queryKey: key, queryFn })
  const unsubscribe = observer.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  const data = observer.getCurrentResult().data
  const query = client.getQueryCache().find({ queryKey: key })
  expect(queryFn).toHaveBeenCalledTimes(1)
  expect(query?.isStale()).toBe(true)
  unsubscribe()
  return { queryFn, data }
}

async function executePath(
  method: 'query' | 'fetchQuery' | 'prefetchQuery',
): Promise<{ queryFn: ReturnType<typeof vi.fn>; data: unknown }> {
  const { key, snapshot } = attackerSnapshot(futureUpdatedAt())
  const client = restoredClient(snapshot)
  const queryFn = vi.fn(() => SERVER_PROFILE)
  let data: unknown

  if (method === 'query') {
    data = await client.query({ queryKey: key, queryFn })
  } else if (method === 'fetchQuery') {
    // fetchQuery still skips the fetch when isStaleByTime reports fresh.
    // eslint-disable-next-line no-restricted-syntax
    data = await client.fetchQuery({ queryKey: key, queryFn })
  } else {
    // prefetchQuery delegates to fetchQuery and the same staleness check.
    // eslint-disable-next-line no-restricted-syntax
    await client.prefetchQuery({ queryKey: key, queryFn })
    data = client.getQueryData(key)
  }

  client.clear()
  return { queryFn, data }
}

async function executeInfinitePath(
  method: 'infiniteQuery' | 'fetchInfiniteQuery' | 'prefetchInfiniteQuery',
): Promise<{ queryFn: ReturnType<typeof vi.fn> }> {
  const { key, snapshot } = attackerSnapshot(futureUpdatedAt(), {
    pages: [FORGED_PROFILE],
    pageParams: [0],
  })
  const client = restoredClient(snapshot)
  const queryFn = vi.fn(() => SERVER_PROFILE)
  const options = {
    queryKey: key,
    queryFn,
    initialPageParam: 0,
    getNextPageParam: () => undefined,
  }

  if (method === 'infiniteQuery') {
    await client.infiniteQuery(options)
  } else if (method === 'fetchInfiniteQuery') {
    // fetchInfiniteQuery sets the infinite query type, then uses fetchQuery.
    // eslint-disable-next-line no-restricted-syntax
    await client.fetchInfiniteQuery(options)
  } else {
    // prefetchInfiniteQuery delegates to fetchInfiniteQuery.
    // eslint-disable-next-line no-restricted-syntax
    await client.prefetchInfiniteQuery(options)
  }

  client.clear()
  return { queryFn }
}
