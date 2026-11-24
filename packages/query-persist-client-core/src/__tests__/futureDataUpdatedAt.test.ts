import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  dehydrate,
  hashKey,
} from '@tanstack/query-core'
import { queryKey } from '@tanstack/query-test-utils'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import { persistQueryClientRestore } from '../persist'
import type { PersistedClient, Persister } from '../persist'
import type { DehydratedState } from '@tanstack/query-core'

/**
 * Spec for a future `dataUpdatedAt` restored from persisted storage.
 * These tests fail while the restored timestamp keeps the default stale time
 * from refetching, and they pass once that timestamp counts as the current time.
 */

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
const FORGED_PROFILE = { name: 'forged', role: 'admin' }
const SERVER_PROFILE = { name: 'real', role: 'member' }

function futureUpdatedAt(): number {
  return Date.now() + ONE_YEAR_MS
}

function memoryStorage() {
  const storage = new Map<string, string>()
  return {
    getItem: (key: string) => Promise.resolve(storage.get(key)),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      storage.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(storage.entries())),
  }
}

function attackerClientState(dataUpdatedAt: number): {
  key: Array<string>
  clientState: DehydratedState
} {
  const setup = new QueryClient()
  const key = queryKey()
  setup.setQueryData(key, SERVER_PROFILE)
  const clientState = JSON.parse(
    JSON.stringify(dehydrate(setup)),
  ) as DehydratedState
  setup.clear()

  const entry = clientState.queries[0]
  if (!entry) {
    throw new Error('expected a dehydrated query to tamper with')
  }
  entry.state = {
    ...entry.state,
    data: FORGED_PROFILE,
    dataUpdatedAt,
    status: 'success',
    fetchStatus: 'idle',
    isInvalidated: false,
  }
  return { key, clientState }
}

function memoryPersister(clientState: DehydratedState): Persister {
  const stored: PersistedClient = {
    timestamp: Date.now(),
    buster: '',
    clientState,
  }
  return {
    persistClient(next) {
      stored.timestamp = next.timestamp
      stored.buster = next.buster
      stored.clientState = next.clientState
    },
    restoreClient() {
      return stored
    },
    removeClient() {
      stored.clientState = { queries: [], mutations: [] }
    },
  }
}

describe('future dataUpdatedAt persisted restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('refetches after persistQueryClientRestore copies a future dataUpdatedAt', async () => {
    const { key, clientState } = attackerClientState(futureUpdatedAt())
    const client = new QueryClient()

    await persistQueryClientRestore({
      queryClient: client,
      persister: memoryPersister(clientState),
      maxAge: 24 * 60 * 60 * 1000,
      buster: '',
    })

    const query = client.getQueryCache().find({ queryKey: key })
    if (!query) {
      throw new Error('expected restored query')
    }
    expect(query.state.data).toEqual(FORGED_PROFILE)
    expect(query.state.dataUpdatedAt).toBeLessThanOrEqual(Date.now())

    const queryFn = vi.fn(() => SERVER_PROFILE)
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)
    expect(query.isStale()).toBe(true)

    unsubscribe()
    client.clear()
  })

  it('refetches a per-query persister entry whose dataUpdatedAt is in the future', async () => {
    const storage = memoryStorage()
    const key = queryKey()
    const setup = new QueryClient()
    setup.setQueryData(key, SERVER_PROFILE)
    const storedQuery = setup.getQueryCache().find({ queryKey: key })
    if (!storedQuery) {
      throw new Error('expected query to persist')
    }

    const writer = experimental_createQueryPersister({ storage })
    await writer.persistQuery(storedQuery)
    const storageKey = `${PERSISTER_KEY_PREFIX}-${hashKey(key)}`
    const raw = await storage.getItem(storageKey)
    if (!raw) {
      throw new Error('expected persisted query')
    }
    const tampered = JSON.parse(raw) as {
      state: { data: unknown; dataUpdatedAt: number }
    }
    tampered.state.data = FORGED_PROFILE
    tampered.state.dataUpdatedAt = futureUpdatedAt()
    await storage.setItem(storageKey, JSON.stringify(tampered))
    setup.clear()

    const client = new QueryClient()
    const persister = experimental_createQueryPersister({ storage })
    let resolveQuery: ((value: typeof SERVER_PROFILE) => void) | undefined
    const queryFn = vi.fn(
      () =>
        new Promise<typeof SERVER_PROFILE>((resolve) => {
          resolveQuery = resolve
        }),
    )
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      persister: persister.persisterFn,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const query = client.getQueryCache().find({ queryKey: key })
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(query?.state.data).toEqual(FORGED_PROFILE)
    expect(query?.state.dataUpdatedAt).toBeLessThanOrEqual(Date.now())
    resolveQuery?.(SERVER_PROFILE)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)
    expect(query?.isStale()).toBe(true)

    unsubscribe()
    client.clear()
  })

  it('refetches an infinite query restored by the per-query persister', async () => {
    const storage = memoryStorage()
    const key = queryKey()
    const setup = new QueryClient()
    setup.setQueryData(key, {
      pages: [SERVER_PROFILE],
      pageParams: [0],
    })
    const storedQuery = setup.getQueryCache().find({ queryKey: key })
    if (!storedQuery) {
      throw new Error('expected query to persist')
    }

    const writer = experimental_createQueryPersister({ storage })
    await writer.persistQuery(storedQuery)
    const storageKey = `${PERSISTER_KEY_PREFIX}-${hashKey(key)}`
    const raw = await storage.getItem(storageKey)
    if (!raw) {
      throw new Error('expected persisted query')
    }
    const tampered = JSON.parse(raw) as {
      state: { data: { pages: Array<unknown> }; dataUpdatedAt: number }
    }
    tampered.state.data = { pages: [FORGED_PROFILE], pageParams: [0] }
    tampered.state.dataUpdatedAt = futureUpdatedAt()
    await storage.setItem(storageKey, JSON.stringify(tampered))
    setup.clear()

    const client = new QueryClient()
    const persister = experimental_createQueryPersister({ storage })
    const queryFn = vi.fn(() => SERVER_PROFILE)
    const observer = new InfiniteQueryObserver(client, {
      queryKey: key,
      queryFn,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      persister: persister.persisterFn,
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

  it('restoreQueries clamps a future dataUpdatedAt and the screen refetches', async () => {
    const storage = memoryStorage()
    const key = queryKey()
    const setup = new QueryClient()
    setup.setQueryData(key, SERVER_PROFILE)
    const storedQuery = setup.getQueryCache().find({ queryKey: key })
    if (!storedQuery) {
      throw new Error('expected query to persist')
    }

    const persister = experimental_createQueryPersister({ storage })
    await persister.persistQuery(storedQuery)
    const storageKey = `${PERSISTER_KEY_PREFIX}-${hashKey(key)}`
    const raw = await storage.getItem(storageKey)
    if (!raw) {
      throw new Error('expected persisted query')
    }
    const tampered = JSON.parse(raw) as {
      state: { data: unknown; dataUpdatedAt: number }
    }
    tampered.state.data = FORGED_PROFILE
    tampered.state.dataUpdatedAt = futureUpdatedAt()
    await storage.setItem(storageKey, JSON.stringify(tampered))
    setup.clear()

    const client = new QueryClient()
    await persister.restoreQueries(client)

    const query = client.getQueryCache().find({ queryKey: key })
    if (!query) {
      throw new Error('expected restored query')
    }
    expect(query.state.data).toEqual(FORGED_PROFILE)
    expect(query.state.dataUpdatedAt).toBeLessThanOrEqual(Date.now())

    const queryFn = vi.fn(() => SERVER_PROFILE)
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)

    unsubscribe()
    client.clear()
  })

  it('still refetches a persisted entry whose timestamp is in the past', async () => {
    const { key, clientState } = attackerClientState(Date.now() - 60_000)
    const client = new QueryClient()
    await persistQueryClientRestore({
      queryClient: client,
      persister: memoryPersister(clientState),
    })

    const queryFn = vi.fn(() => SERVER_PROFILE)
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)

    unsubscribe()
    client.clear()
  })
})
