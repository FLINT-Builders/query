import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  QueriesObserver,
  QueryClient,
  QueryObserver,
  dehydrate,
  focusManager,
  onlineManager,
} from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type { PersistedClient } from '@tanstack/query-persist-client-core'

const storageKey = 'offline-cache'
const buster = 'app'
const profileKey = ['user', 'profile'] as const
const profile = { id: 'user-1', name: 'ada' }

type Tamper = 'flag' | 'one-page' | 'many-pages'

interface MemoryStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
}

function memoryStorage(): MemoryStorage {
  const items = new Map<string, string>()
  return {
    getItem(key) {
      return Promise.resolve(items.get(key) ?? null)
    },
    setItem(key, value) {
      items.set(key, value)
      return Promise.resolve()
    },
    removeItem(key) {
      items.delete(key)
      return Promise.resolve()
    },
  }
}

function storedData(mode: Tamper): unknown {
  if (mode === 'one-page') {
    return { pages: [{ id: 'forged' }], pageParams: [0] }
  }
  if (mode === 'many-pages') {
    return {
      pages: [{ id: 'forged-1' }, { id: 'forged-2' }],
      pageParams: [0, 1],
    }
  }
  return profile
}

/**
 * Build the JSON a browser persister would have saved for an ordinary query,
 * then edit it the way a same-origin storage writer can: set `queryType` to
 * `infinite` and, for the page cases, replace `state.data`.
 */
async function poisonedCache(mode: Tamper): Promise<string> {
  const seed = new QueryClient()
  await seed.query({
    queryKey: profileKey,
    queryFn: () => Promise.resolve(profile),
  })
  const persisted: PersistedClient = {
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(seed),
  }
  seed.clear()

  const query = persisted.clientState.queries[0]
  if (!query) {
    throw new Error('expected the ordinary query to be dehydrated')
  }
  query.queryType = 'infinite'
  query.state.data = storedData(mode)
  query.state.dataUpdatedAt = 0
  return JSON.stringify(persisted)
}

async function restorePoisoned(mode: Tamper) {
  const storage = memoryStorage()
  await storage.setItem(storageKey, await poisonedCache(mode))
  const persister = createAsyncStoragePersister({
    storage,
    key: storageKey,
    throttleTime: 0,
  })
  const queryClient = new QueryClient()
  await persistQueryClientRestore({ queryClient, persister, buster })
  return { storage, persister, queryClient }
}

function ordinaryQueryFn() {
  return vi.fn((_context: { queryKey: ReadonlyArray<unknown> }) =>
    Promise.resolve(profile),
  )
}

function assertNoPageParam(queryFn: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> }
}) {
  expect(queryFn.mock.calls).toHaveLength(1)
  const context = queryFn.mock.calls[0]?.[0]
  expect(Object.hasOwn(context as object, 'pageParam')).toBe(false)
  expect(Object.hasOwn(context as object, 'direction')).toBe(false)
}

function assertPlainProfile(queryClient: QueryClient) {
  expect(queryClient.getQueryData(profileKey)).toEqual(profile)
  expect(queryClient.getQueryState(profileKey)?.status).toBe('success')
  expect(queryClient.getQueryState(profileKey)?.error).toBeNull()
}

describe('persisted queryType must not select infinite fetch behavior', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    for (const client of clients) {
      client.clear()
      client.unmount()
    }
    clients.length = 0
    onlineManager.setOnline(true)
    focusManager.setFocused(undefined)
  })

  async function restored(mode: Tamper) {
    const setup = await restorePoisoned(mode)
    clients.push(setup.queryClient)
    expect(setup.queryClient.getQueryData(profileKey)).toEqual(storedData(mode))
    return setup
  }

  it('fetches an ordinary query with query() when storage only sets queryType', async () => {
    const { queryClient } = await restored('flag')
    const queryFn = ordinaryQueryFn()

    await expect(
      queryClient.query({
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
  })

  it('fetches an ordinary query with query() when storage has one infinite page', async () => {
    const { queryClient, persister } = await restored('one-page')
    const queryFn = ordinaryQueryFn()

    await expect(
      queryClient.query({
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)

    await persistQueryClientSave({ queryClient, persister, buster })
    const next = new QueryClient()
    clients.push(next)
    await persistQueryClientRestore({
      queryClient: next,
      persister,
      buster,
    })
    const queryFnAgain = ordinaryQueryFn()
    await expect(
      next.query({
        queryKey: profileKey,
        queryFn: queryFnAgain,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)
    assertNoPageParam(queryFnAgain)
    assertPlainProfile(next)
  })

  it('fetches an ordinary query with query() when storage has several infinite pages', async () => {
    const { queryClient } = await restored('many-pages')
    const queryFn = ordinaryQueryFn()

    await expect(
      queryClient.query({
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)

    const queryFnAgain = ordinaryQueryFn()
    await expect(
      queryClient.query({
        queryKey: profileKey,
        queryFn: queryFnAgain,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)
    assertNoPageParam(queryFnAgain)
  })

  it('refetches through QueryObserver for an ordinary query', async () => {
    const { queryClient } = await restored('many-pages')
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    const result = await observer.refetch()

    expect(result.data).toEqual(profile)
    expect(result.status).toBe('success')
    expect(result.error).toBeNull()
    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches through QueriesObserver for an ordinary query', async () => {
    const { queryClient } = await restored('one-page')
    const queryFn = ordinaryQueryFn()
    const observer = new QueriesObserver(queryClient, [
      {
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
        refetchOnMount: false,
      },
    ])
    const unsubscribe = observer.subscribe(() => undefined)

    const result = await observer.getObservers()[0]?.refetch()

    expect(result?.data).toEqual(profile)
    expect(result?.status).toBe('success')
    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches with fetchOptimistic without passing a query type', async () => {
    const { queryClient } = await restored('one-page')
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    // fetchOptimistic can settle from the in-flight cache notification before
    // the fetch finishes, so the assertion is on the cache after it goes idle.
    await observer
      .fetchOptimistic({
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
      })
      .catch(() => undefined)
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(profileKey)?.fetchStatus).toBe('idle')
    })

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches with refetchQueries after the ordinary observer attaches', async () => {
    const { queryClient } = await restored('many-pages')
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await queryClient.refetchQueries({ queryKey: profileKey })

    expect(queryClient.getQueryData(profileKey)).toEqual(profile)
    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches with invalidateQueries after the ordinary observer attaches', async () => {
    const { queryClient } = await restored('many-pages')
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await queryClient.invalidateQueries({ queryKey: profileKey })

    expect(queryClient.getQueryData(profileKey)).toEqual(profile)
    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches with resetQueries after the ordinary observer attaches', async () => {
    const { queryClient } = await restored('many-pages')
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await queryClient.resetQueries({ queryKey: profileKey })

    expect(queryClient.getQueryData(profileKey)).toEqual(profile)
    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches an ordinary observer when the window regains focus', async () => {
    const { queryClient } = await restored('many-pages')
    queryClient.mount()
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
      refetchOnReconnect: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    expect(queryFn).not.toHaveBeenCalled()

    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalled()
      expect(queryClient.getQueryState(profileKey)?.fetchStatus).toBe('idle')
    })

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })

  it('refetches an ordinary observer when the client comes back online', async () => {
    const { queryClient } = await restored('one-page')
    queryClient.mount()
    const queryFn = ordinaryQueryFn()
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    expect(queryFn).not.toHaveBeenCalled()

    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalled()
      expect(queryClient.getQueryState(profileKey)?.fetchStatus).toBe('idle')
    })

    assertNoPageParam(queryFn)
    assertPlainProfile(queryClient)
    unsubscribe()
  })
})
