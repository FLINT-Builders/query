import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import {
  InfiniteQueryObserver,
  QueryClient,
  focusManager,
  hashKey,
  onlineManager,
} from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
  persistQueryClientRestore,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type {
  InfiniteData,
  InfiniteQueryObserverOptions,
  QueryFunctionContext,
} from '@tanstack/query-core'
import type {
  PersistedClient,
  PersistedQuery,
} from '@tanstack/query-persist-client-core'

type PageObserverOptions = InfiniteQueryObserverOptions<
  Page,
  Error,
  InfiniteData<Page>,
  Array<string>,
  number
>

/**
 * Stored page list planted by someone who can write the persister storage.
 * The app under test never fetched these pages.
 */
const STORED_PAGE_COUNT = 8
const ATTACKER_PAGE_PARAM = 5000
const INITIAL_PAGE_PARAM = 0
const CONFIGURED_MAX_PAGES = 2

type Page = { id: number; next: number }
type InfiniteCache = { pages: Array<Page>; pageParams: Array<number> }

function attackerPages(): InfiniteCache {
  const pageParams = Array.from(
    { length: STORED_PAGE_COUNT },
    (_, index) => ATTACKER_PAGE_PARAM + index,
  )
  return {
    pageParams,
    pages: pageParams.map((pageParam) => ({
      id: pageParam,
      next: pageParam + 1,
    })),
  }
}

function queryState(data: InfiniteCache, dataUpdatedAt: number) {
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
    status: 'success' as const,
    fetchStatus: 'idle' as const,
  }
}

function persistedClient(
  key: ReadonlyArray<string>,
  now: number,
  options?: { queryType?: 'infinite' | undefined },
): PersistedClient {
  const data = attackerPages()
  return {
    timestamp: now,
    buster: '',
    clientState: {
      mutations: [],
      queries: [
        {
          dehydratedAt: now,
          queryHash: hashKey(key),
          queryKey: [...key],
          // Omitted on purpose in one case: the infinite observer sets the
          // type itself before refetching, so a snapshot does not need it.
          ...(options?.queryType ? { queryType: options.queryType } : {}),
          state: queryState(data, 1),
        },
      ],
    },
  }
}

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
    entries: () => Array.from(items.entries()),
    plant(key: string, value: unknown) {
      // The persister's default deserializer is JSON.parse. Plant the
      // serialized form so the value that reaches the cache is whatever
      // that parse produces, not the in-memory object above.
      items.set(key, JSON.stringify(value))
    },
  }
}

function assert(pageParams: Array<number>, limit: number): void {
  expect(pageParams.length).toBeGreaterThan(0)
  expect(pageParams).toEqual(
    Array.from(
      { length: Math.min(pageParams.length, limit) },
      (_, index) => INITIAL_PAGE_PARAM + index,
    ),
  )
}

async function waitForRefetch(
  queryClient: QueryClient,
  pageParams: Array<number>,
): Promise<void> {
  await vi.waitFor(() => {
    expect(pageParams.length).toBeGreaterThan(0)
    expect(queryClient.isFetching()).toBe(0)
  })
}

describe('persisted infinite query refetch', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    clients.forEach((client) => {
      client.clear()
      client.unmount()
    })
    clients.length = 0
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  async function restoreWholeCache(options?: {
    queryType?: 'infinite'
    timestamp?: number
  }) {
    const key = queryKey()
    const now = Date.now()
    const storage = memoryStorage()
    const storageKey = 'REACT_QUERY_OFFLINE_CACHE'
    storage.plant(
      storageKey,
      persistedClient(key, options?.timestamp ?? now, {
        queryType: options?.queryType ?? 'infinite',
      }),
    )
    const persister = createAsyncStoragePersister({
      storage,
      key: storageKey,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    clients.push(queryClient)
    queryClient.mount()
    await persistQueryClientRestore({
      queryClient,
      persister,
      buster: '',
    })
    return { key, queryClient }
  }

  function trackPages(queryClient: QueryClient, key: ReadonlyArray<string>) {
    const pageParams: Array<number> = []
    const queryFn = vi.fn((context: QueryFunctionContext) => {
      const pageParam = context.pageParam as number
      pageParams.push(pageParam)
      // Grow the cached page list while the refetch loop is in progress.
      // A bound that is read again off this live array, instead of a count
      // fixed before the request, must still stop at the same limit.
      const cached = queryClient.getQueryCache().find({ queryKey: key })
      const data = cached?.state.data as InfiniteCache | undefined
      data?.pages.push({ id: -1, next: pageParam + 1 })
      if (pageParams.length > STORED_PAGE_COUNT + 2) {
        throw new Error('infinite refetch did not stop')
      }
      const page: Page = { id: pageParam, next: pageParam + 1 }
      return page
    })
    return { pageParams, queryFn }
  }

  function observe(
    queryClient: QueryClient,
    key: ReadonlyArray<string>,
    queryFn: (context: QueryFunctionContext) => Page | Promise<Page>,
    options?: {
      maxPages?: number
      refetchOnMount?: boolean
      persister?: PageObserverOptions['persister']
    },
  ) {
    return new InfiniteQueryObserver<
      Page,
      Error,
      InfiniteData<Page>,
      Array<string>,
      number
    >(queryClient, {
      queryKey: [...key],
      queryFn,
      initialPageParam: INITIAL_PAGE_PARAM,
      getNextPageParam: (lastPage) => lastPage.next,
      retry: false,
      maxPages: options?.maxPages,
      refetchOnMount: options?.refetchOnMount,
      persister: options?.persister,
    })
  }

  it('refetches a fresh query once from initialPageParam when storage is empty', async () => {
    const key = queryKey()
    const storage = memoryStorage()
    const persister = createAsyncStoragePersister({
      storage,
      key: 'REACT_QUERY_OFFLINE_CACHE',
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(queryClient)
    await persistQueryClientRestore({ queryClient, persister, buster: '' })
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await observer.refetch()
    unsubscribe()
    expect(pageParams).toEqual([INITIAL_PAGE_PARAM])
  })

  it('does not restore an expired snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache({
      timestamp: Date.now() - 1000 * 60 * 60 * 48,
    })
    expect(queryClient.getQueryData(key)).toBeUndefined()
  })

  it('bounds a mounted infinite query to maxPages and starts at initialPageParam', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds the refetch when the snapshot omits queryType', async () => {
    const key = queryKey()
    const storage = memoryStorage()
    const storageKey = 'REACT_QUERY_OFFLINE_CACHE'
    const planted = persistedClient(key, Date.now())
    delete planted.clientState.queries[0]?.queryType
    storage.plant(storageKey, planted)
    const persister = createAsyncStoragePersister({
      storage,
      key: storageKey,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    clients.push(queryClient)
    await persistQueryClientRestore({ queryClient, persister, buster: '' })
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('does not replay a stored page list when maxPages is unset', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn)
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, 1)
  })

  it('bounds observer.refetch after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    expect(pageParams).toEqual([])
    await observer.refetch()
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds queryClient.refetchQueries after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await queryClient.refetchQueries({ queryKey: key })
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds queryClient.invalidateQueries after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await queryClient.invalidateQueries({ queryKey: key })
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds a focus refetch after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    focusManager.setFocused(false)
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    focusManager.setFocused(true)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds a reconnect refetch after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    onlineManager.setOnline(false)
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    onlineManager.setOnline(true)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds queryClient.infiniteQuery to maxPages and starts at initialPageParam', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    await queryClient.infiniteQuery({
      queryKey: key,
      queryFn,
      initialPageParam: INITIAL_PAGE_PARAM,
      getNextPageParam: (lastPage: Page) => lastPage.next,
      maxPages: CONFIGURED_MAX_PAGES,
    })
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('starts queryClient.infiniteQuery pages option at initialPageParam', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    await queryClient.infiniteQuery({
      queryKey: key,
      queryFn,
      initialPageParam: INITIAL_PAGE_PARAM,
      getNextPageParam: (lastPage: Page) => lastPage.next,
      maxPages: CONFIGURED_MAX_PAGES,
      pages: 4,
    })
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds fetchInfiniteQuery after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    // eslint-disable-next-line no-restricted-syntax -- same refetch loop as infiniteQuery
    await queryClient.fetchInfiniteQuery({
      queryKey: key,
      queryFn,
      initialPageParam: INITIAL_PAGE_PARAM,
      getNextPageParam: (lastPage: Page) => lastPage.next,
      maxPages: CONFIGURED_MAX_PAGES,
    })
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds prefetchInfiniteQuery after a restored snapshot', async () => {
    const { key, queryClient } = await restoreWholeCache()
    const { pageParams, queryFn } = trackPages(queryClient, key)
    // eslint-disable-next-line no-restricted-syntax -- same refetch loop as infiniteQuery
    await queryClient.prefetchInfiniteQuery({
      queryKey: key,
      queryFn,
      initialPageParam: INITIAL_PAGE_PARAM,
      getNextPageParam: (lastPage: Page) => lastPage.next,
      maxPages: CONFIGURED_MAX_PAGES,
    })
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds a refetch after experimental per-query storage is restored', async () => {
    const key = queryKey()
    const storage = memoryStorage()
    const now = Date.now()
    const data = attackerPages()
    const persisted: PersistedQuery = {
      buster: '',
      queryHash: hashKey(key),
      queryKey: [...key],
      state: queryState(data, now - 1000),
    }
    storage.plant(`${PERSISTER_KEY_PREFIX}-${hashKey(key)}`, persisted)
    const persister = experimental_createQueryPersister({ storage })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    clients.push(queryClient)
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
      persister: persister.persisterFn as PageObserverOptions['persister'],
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds a refetch after experimental restoreQueries writes the snapshot', async () => {
    const key = queryKey()
    const storage = memoryStorage()
    const now = Date.now()
    const persisted: PersistedQuery = {
      buster: '',
      queryHash: hashKey(key),
      queryKey: [...key],
      state: queryState(attackerPages(), now - 1000),
    }
    storage.plant(`${PERSISTER_KEY_PREFIX}-${hashKey(key)}`, persisted)
    const persister = experimental_createQueryPersister({ storage })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    clients.push(queryClient)
    await persister.restoreQueries(queryClient, { queryKey: key, exact: true })
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })

  it('bounds a refetch after cache state is replaced the way a broadcast message does', async () => {
    const key = queryKey()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    clients.push(queryClient)
    const queryHash = hashKey(key)
    const state = queryState(attackerPages(), 1)
    queryClient.getQueryCache().build(
      queryClient,
      { queryKey: key, queryHash },
      // Broadcast delivers the remote state object as-is.
      state,
    )
    const restored = queryClient.getQueryCache().get(queryHash)
    restored?.setState(state)
    const { pageParams, queryFn } = trackPages(queryClient, key)
    const observer = observe(queryClient, key, queryFn, {
      maxPages: CONFIGURED_MAX_PAGES,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await waitForRefetch(queryClient, pageParams)
    unsubscribe()
    assert(pageParams, CONFIGURED_MAX_PAGES)
  })
})
