import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  hashKey,
} from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import type { InfiniteData, QueryKey } from '@tanstack/query-core'
import type { PersistedQuery } from '../createPersister'

type Profile = {
  accountId: string
  displayName: string
}

const previousSession: Profile = {
  accountId: 'previous-session',
  displayName: 'Previous',
}

const currentSession: Profile = {
  accountId: 'current-session',
  displayName: 'Current',
}

const networkProfile: Profile = {
  accountId: 'network',
  displayName: 'Network',
}

/**
 * Storage whose first read stays pending until the test releases it.
 * Later reads resolve immediately, which is what a follow-up restore does
 * once the payload is already in the map.
 */
function createBlockingStorage(records: Map<string, string>) {
  let releaseRead: (() => void) | undefined
  const readStarted = createDeferred<void>()
  let blocked = false

  const storage = {
    getItem: (key: string) => {
      const value = records.get(key)
      if (!blocked) {
        blocked = true
        readStarted.resolve()
        const gate = createDeferred<void>()
        releaseRead = gate.resolve
        return gate.promise.then(() => value)
      }
      return Promise.resolve(value)
    },
    setItem: (key: string, value: string) => {
      records.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      records.delete(key)
      return Promise.resolve()
    },
    entries: () => {
      if (!blocked) {
        blocked = true
        readStarted.resolve()
        const gate = createDeferred<void>()
        releaseRead = gate.resolve
        return gate.promise.then(() => Array.from(records.entries()))
      }
      return Promise.resolve(Array.from(records.entries()))
    },
  }

  return {
    storage,
    readStarted: readStarted.promise,
    releaseRead: () => {
      if (!releaseRead) {
        throw new Error('storage read has not started')
      }
      releaseRead()
    },
  }
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function storedRecord(
  queryKey: QueryKey,
  data: unknown,
  dataUpdatedAt: number,
): string {
  const queryHash = hashKey(queryKey)
  return JSON.stringify({
    buster: '',
    queryHash,
    queryKey,
    state: {
      data,
      dataUpdatedAt,
      errorUpdatedAt: 0,
      status: 'success',
    },
  })
}

function storageKeyFor(queryKey: QueryKey) {
  return `${PERSISTER_KEY_PREFIX}-${hashKey(queryKey)}`
}

function profileQuery(queryClient: QueryClient, queryKey: QueryKey) {
  return queryClient.getQueryCache().find({ queryKey })!
}

describe('per-query persister stale storage restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a login write that lands while the default persister is reading storage', async () => {
    const queryKey = ['account', 'profile']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, previousSession, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const seen: Array<Profile | undefined> = []
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    // Default buster is ''. The stored record uses that same buster, so a
    // previous session on this storage remains eligible.
    const { persisterFn } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const observer = new QueryObserver<Profile>(queryClient, {
      queryKey,
      queryFn,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })
    const unsubscribe = observer.subscribe((result: { data?: Profile }) => {
      seen.push(result.data)
    })

    await blocking.readStarted
    expect(profileQuery(queryClient, queryKey).state.data).toBeUndefined()

    queryClient.setQueryData(queryKey, currentSession, {
      updatedAt: freshUpdatedAt,
    })
    blocking.releaseRead()
    await vi.advanceTimersByTimeAsync(0)

    const query = profileQuery(queryClient, queryKey)
    expect(observer.getCurrentResult().data).toEqual(currentSession)
    expect(queryClient.getQueryData(queryKey)).toEqual(currentSession)
    expect(query.state.dataUpdatedAt).toBeGreaterThan(storedUpdatedAt)
    expect(seen).not.toContainEqual(previousSession)
    expect(queryFn).not.toHaveBeenCalled()

    unsubscribe()
    queryClient.clear()
  })

  it('keeps a login write when nothing is observing the query', async () => {
    const queryKey = ['account', 'profile', 'imperative']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, previousSession, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    const { persisterFn } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const pending = queryClient.query({
      queryKey,
      queryFn,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })

    await blocking.readStarted
    queryClient.setQueryData(queryKey, currentSession, {
      updatedAt: freshUpdatedAt,
    })
    blocking.releaseRead()

    const result = await pending
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toEqual(currentSession)
    expect(queryClient.getQueryData(queryKey)).toEqual(currentSession)
    expect(
      profileQuery(queryClient, queryKey).state.dataUpdatedAt,
    ).toBeGreaterThan(storedUpdatedAt)
    expect(queryFn).not.toHaveBeenCalled()

    queryClient.clear()
  })

  it('keeps a write that lands after storage returns and before the parsed payload is used', async () => {
    const queryKey = ['account', 'profile', 'deserialize']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const queryClient = new QueryClient()
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    const parsed = createDeferred<void>()
    let finishParse: (() => void) | undefined

    const { persisterFn } = experimental_createQueryPersister({
      storage: {
        getItem: () =>
          Promise.resolve(
            storedRecord(queryKey, previousSession, storedUpdatedAt),
          ),
        setItem: () => Promise.resolve(),
        removeItem: () => Promise.resolve(),
      },
      deserialize: (cached: string) => {
        const payload = JSON.parse(cached) as PersistedQuery
        return {
          then(resolve: (value: PersistedQuery) => void) {
            parsed.resolve()
            finishParse = () => {
              queryClient.setQueryData(queryKey, currentSession, {
                updatedAt: freshUpdatedAt,
              })
              resolve(payload)
            }
          },
        } as Promise<PersistedQuery>
      },
    })

    const pending = queryClient.query({
      queryKey,
      queryFn,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })

    await parsed.promise
    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    finishParse?.()

    const result = await pending
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toEqual(currentSession)
    expect(queryClient.getQueryData(queryKey)).toEqual(currentSession)
    expect(
      profileQuery(queryClient, queryKey).state.dataUpdatedAt,
    ).toBeGreaterThan(storedUpdatedAt)
    expect(queryFn).not.toHaveBeenCalled()

    queryClient.clear()
  })

  it('does not apply a previous session when the fetch is cancelled while storage is in flight', async () => {
    const queryKey = ['account', 'profile', 'cancelled']
    const storedUpdatedAt = Date.now() - 60_000
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, previousSession, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const seen: Array<Profile | undefined> = []
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    const { persisterFn } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const observer = new QueryObserver<Profile>(queryClient, {
      queryKey,
      queryFn,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })
    const unsubscribe = observer.subscribe((result: { data?: Profile }) => {
      seen.push(result.data)
    })

    await blocking.readStarted
    await queryClient.cancelQueries({ queryKey })
    blocking.releaseRead()
    await vi.advanceTimersByTimeAsync(0)

    expect(queryClient.getQueryData(queryKey)).toBeUndefined()
    expect(observer.getCurrentResult().data).toBeUndefined()
    expect(seen).not.toContainEqual(previousSession)
    expect(profileQuery(queryClient, queryKey).state.dataUpdatedAt).not.toBe(
      storedUpdatedAt,
    )

    unsubscribe()
    queryClient.clear()
  })

  it('keeps a fresher write when the fetch is cancelled after that write', async () => {
    const queryKey = ['account', 'profile', 'cancelled-after-write']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, previousSession, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const seen: Array<Profile | undefined> = []
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    const { persisterFn } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const observer = new QueryObserver<Profile>(queryClient, {
      queryKey,
      queryFn,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })
    const unsubscribe = observer.subscribe((result: { data?: Profile }) => {
      seen.push(result.data)
    })

    await blocking.readStarted
    queryClient.setQueryData(queryKey, currentSession, {
      updatedAt: freshUpdatedAt,
    })
    await queryClient.cancelQueries({ queryKey })
    blocking.releaseRead()
    await vi.advanceTimersByTimeAsync(0)

    expect(queryClient.getQueryData(queryKey)).toEqual(currentSession)
    expect(observer.getCurrentResult().data).toEqual(currentSession)
    expect(seen).not.toContainEqual(previousSession)
    expect(
      profileQuery(queryClient, queryKey).state.dataUpdatedAt,
    ).toBeGreaterThan(storedUpdatedAt)
    expect(queryFn).not.toHaveBeenCalled()

    unsubscribe()
    queryClient.clear()
  })

  it('keeps an infinite-query write that lands while storage read is in flight', async () => {
    const queryKey = ['account', 'timeline']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const storedPages: InfiniteData<Profile> = {
      pages: [previousSession],
      pageParams: [0],
    }
    const freshPages: InfiniteData<Profile> = {
      pages: [currentSession],
      pageParams: [0],
    }
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, storedPages, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const seen: Array<InfiniteData<Profile> | undefined> = []
    const queryFn = vi.fn(() => Promise.resolve(networkProfile))
    const { persisterFn } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      persister: persisterFn,
      staleTime: 5 * 60 * 1000,
    })
    const unsubscribe = observer.subscribe(
      (result: { data?: InfiniteData<Profile> }) => {
        seen.push(result.data)
      },
    )

    await blocking.readStarted
    queryClient.setQueryData(queryKey, freshPages, {
      updatedAt: freshUpdatedAt,
    })
    blocking.releaseRead()
    await vi.advanceTimersByTimeAsync(0)

    expect(observer.getCurrentResult().data).toEqual(freshPages)
    expect(queryClient.getQueryData(queryKey)).toEqual(freshPages)
    expect(
      profileQuery(queryClient, queryKey).state.dataUpdatedAt,
    ).toBeGreaterThan(storedUpdatedAt)
    expect(seen).not.toContainEqual(storedPages)
    expect(queryFn).not.toHaveBeenCalled()

    unsubscribe()
    queryClient.clear()
  })

  it('does not let restoreQueries replace a newer write made while storage entries are read', async () => {
    const queryKey = ['account', 'profile', 'bulk-restore']
    const storedUpdatedAt = Date.now() - 60_000
    const freshUpdatedAt = Date.now()
    const records = new Map([
      [
        storageKeyFor(queryKey),
        storedRecord(queryKey, previousSession, storedUpdatedAt),
      ],
    ])
    const blocking = createBlockingStorage(records)
    const queryClient = new QueryClient()
    const { restoreQueries } = experimental_createQueryPersister({
      storage: blocking.storage,
    })

    const pending = restoreQueries(queryClient)
    await blocking.readStarted
    queryClient.setQueryData(queryKey, currentSession, {
      updatedAt: freshUpdatedAt,
    })
    blocking.releaseRead()
    await pending

    expect(queryClient.getQueryData(queryKey)).toEqual(currentSession)
    expect(
      profileQuery(queryClient, queryKey).state.dataUpdatedAt,
    ).toBeGreaterThan(storedUpdatedAt)

    queryClient.clear()
  })
})
