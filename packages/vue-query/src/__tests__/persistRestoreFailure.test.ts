import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue-demi'
import { createApp, defineComponent, h } from 'vue'
import { queryKey } from '@tanstack/query-test-utils'
import { persistQueryClient } from '../../../query-persist-client-core/src/index'
import { createSyncStoragePersister } from '../../../query-sync-storage-persister/src/index'
import { createAsyncStoragePersister } from '../../../query-async-storage-persister/src/index'
import { QueryClient } from '../queryClient'
import { VueQueryPlugin } from '../vueQueryPlugin'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { useQueries } from '../useQueries'
import { useQuery } from '../useQuery'
import type { App } from 'vue'
import type { Persister } from '../../../query-persist-client-core/src/index'

/**
 * Spec for a failed persisted-cache restore.
 *
 * These tests fail while a rejected `clientPersister` promise leaves
 * `queryClient.isRestoring` true. `useQuery`, `useInfiniteQuery`, and
 * `useQueries` then never subscribe, so their query functions never run.
 * They pass once a rejected restore clears that flag, subscribes observers,
 * lets them fetch, and still deletes the unreadable storage entry.
 */

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function unreadableJson(): string {
  return '{"truncated":'
}

function queriesFieldNotArray(): string {
  return JSON.stringify({
    timestamp: Date.now(),
    buster: '',
    clientState: {
      queries: { poisoned: true },
    },
  })
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
}

function boot(
  persister: Persister,
  setup: (client: QueryClient) => void,
): { app: App; client: QueryClient } {
  const client = createClient()
  const app = createApp(
    defineComponent({
      name: 'PersistRestoreHarness',
      setup() {
        setup(client)
        return () => h('div')
      },
    }),
  )

  app.use(VueQueryPlugin, {
    queryClient: client,
    clientPersister: (queryClient) => {
      return persistQueryClient({
        queryClient,
        persister,
      })
    },
  })

  app.mount(document.createElement('div'))
  return { app, client }
}

async function flushVueAndPromises() {
  for (let i = 0; i < 10; i++) {
    await nextTick()
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
}

function onUnhandledRestoreRejection(reason: unknown) {
  // Attaching this listener marks the restore rejection as handled so Vitest
  // reports the assertion below instead of aborting on the rejection itself.
  void reason
}

describe('failed query cache restore still subscribes Vue queries', () => {
  const mounted: Array<App> = []

  beforeEach(() => {
    // A rejected restore promise is reported as an unhandled rejection until
    // the plugin attaches catch or finally. Handle it here so the assertions
    // are what fail, and so a finally that clears the flag can pass.
    process.on('unhandledRejection', onUnhandledRestoreRejection)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRestoreRejection)
    for (const app of mounted) {
      app.unmount()
    }
    mounted.length = 0
    localStorage.clear()
    sessionStorage.clear()
  })

  function expectRestoreHandled(client: QueryClient) {
    expect(client.isRestoring?.value).toBe(false)
  }

  it('reads the default storage key REACT_QUERY_OFFLINE_CACHE', () => {
    const storage: StorageLike = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }

    createSyncStoragePersister({ storage }).restoreClient()
    void createAsyncStoragePersister({ storage }).restoreClient()

    expect(storage.getItem).toHaveBeenCalledWith(STORAGE_KEY)
  })

  it('useQuery fetches after the sync persister rejects unreadable JSON', async () => {
    localStorage.setItem(STORAGE_KEY, unreadableJson())
    const queryFn = vi.fn(() => 'fresh')
    const key = queryKey()
    let query: ReturnType<typeof useQuery> | undefined

    const { app, client } = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        query = useQuery(
          {
            queryKey: key,
            queryFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.status.value).toBe('success')
    expect(query!.data.value).toBe('fresh')
    expect(query!.isFetching.value).toBe(false)
  })

  it('useQuery fetches after the sync persister rejects a non-array queries field', async () => {
    localStorage.setItem(STORAGE_KEY, queriesFieldNotArray())
    const queryFn = vi.fn(() => 'fresh')
    const key = queryKey()
    let query: ReturnType<typeof useQuery> | undefined

    const { app, client } = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        query = useQuery(
          {
            queryKey: key,
            queryFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.status.value).toBe('success')
    expect(query!.data.value).toBe('fresh')
  })

  it('useInfiniteQuery fetches after the sync persister rejects unreadable JSON', async () => {
    localStorage.setItem(STORAGE_KEY, unreadableJson())
    const queryFn = vi.fn(() => 'page')
    const key = queryKey()
    let query: ReturnType<typeof useInfiniteQuery> | undefined

    const { app, client } = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        query = useInfiniteQuery(
          {
            queryKey: key,
            queryFn,
            initialPageParam: 0,
            getNextPageParam: () => undefined,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.status.value).toBe('success')
    expect(query!.data.value).toEqual({
      pages: ['page'],
      pageParams: [0],
    })
  })

  it('useQuery fetches after sessionStorage rejects unreadable JSON', async () => {
    sessionStorage.setItem(STORAGE_KEY, unreadableJson())
    const queryFn = vi.fn(() => 'fresh')
    const key = queryKey()
    let query: ReturnType<typeof useQuery> | undefined

    const { app, client } = boot(
      createSyncStoragePersister({ storage: sessionStorage }),
      (queryClient) => {
        query = useQuery(
          {
            queryKey: key,
            queryFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.data.value).toBe('fresh')
  })

  it('useQueries fetches after the sync persister rejects a non-array queries field', async () => {
    localStorage.setItem(STORAGE_KEY, queriesFieldNotArray())
    const firstFn = vi.fn(() => 'one')
    const secondFn = vi.fn(() => 'two')
    const firstKey = queryKey()
    const secondKey = queryKey()
    let queries: ReturnType<typeof useQueries> | undefined

    const { app, client } = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        queries = useQueries(
          {
            queries: [
              { queryKey: firstKey, queryFn: firstFn },
              { queryKey: secondKey, queryFn: secondFn },
            ],
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(firstFn).toHaveBeenCalled()
    expect(secondFn).toHaveBeenCalled()
    expect(queries!.value).toMatchObject([
      { status: 'success', data: 'one', isFetching: false },
      { status: 'success', data: 'two', isFetching: false },
    ])
  })

  it('useQuery fetches after the async persister rejects unreadable JSON', async () => {
    localStorage.setItem(STORAGE_KEY, unreadableJson())
    const queryFn = vi.fn(() => 'fresh')
    const key = queryKey()
    let query: ReturnType<typeof useQuery> | undefined

    const { app, client } = boot(
      createAsyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        query = useQuery(
          {
            queryKey: key,
            queryFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.status.value).toBe('success')
    expect(query!.data.value).toBe('fresh')
  })

  it('useInfiniteQuery fetches after the async persister rejects a non-array queries field', async () => {
    localStorage.setItem(STORAGE_KEY, queriesFieldNotArray())
    const queryFn = vi.fn(() => 'page')
    const key = queryKey()
    let query: ReturnType<typeof useInfiniteQuery> | undefined

    const { app, client } = boot(
      createAsyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        query = useInfiniteQuery(
          {
            queryKey: key,
            queryFn,
            initialPageParam: 0,
            getNextPageParam: () => undefined,
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(query!.data.value).toEqual({
      pages: ['page'],
      pageParams: [0],
    })
  })

  it('useQueries fetches after the async persister rejects unreadable JSON', async () => {
    localStorage.setItem(STORAGE_KEY, unreadableJson())
    const queryFn = vi.fn(() => 'listed')
    const key = queryKey()
    let queries: ReturnType<typeof useQueries> | undefined

    const { app, client } = boot(
      createAsyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        queries = useQueries(
          {
            queries: [{ queryKey: key, queryFn }],
          },
          queryClient,
        )
      },
    )
    mounted.push(app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(client)
    expect(queryFn).toHaveBeenCalled()
    expect(queries!.value[0]).toMatchObject({
      status: 'success',
      data: 'listed',
      isFetching: false,
    })
  })

  it('fetches again on the next load after the bad entry is written back', async () => {
    localStorage.setItem(STORAGE_KEY, unreadableJson())
    const firstFn = vi.fn(() => 'first-load')
    const firstKey = queryKey()

    const first = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        useQuery(
          {
            queryKey: firstKey,
            queryFn: firstFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(first.app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(first.client)
    expect(firstFn).toHaveBeenCalled()

    localStorage.setItem(STORAGE_KEY, queriesFieldNotArray())

    const secondFn = vi.fn(() => 'second-load')
    const secondKey = queryKey()
    let secondQuery: ReturnType<typeof useQuery> | undefined
    const second = boot(
      createSyncStoragePersister({ storage: localStorage }),
      (queryClient) => {
        secondQuery = useQuery(
          {
            queryKey: secondKey,
            queryFn: secondFn,
          },
          queryClient,
        )
      },
    )
    mounted.push(second.app)

    await flushVueAndPromises()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expectRestoreHandled(second.client)
    expect(secondFn).toHaveBeenCalled()
    expect(secondQuery!.data.value).toBe('second-load')
  })
})
