import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QueryClient,
  injectInfiniteQuery,
  injectIsRestoring,
  injectQuery,
  noop,
  provideTanStackQuery,
} from '@tanstack/angular-query-experimental'
import { persistQueryClientSave } from '@tanstack/query-persist-client-core'
import {
  Component,
  effect,
  provideZonelessChangeDetection,
} from '@angular/core'
import { render } from '@testing-library/angular'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { createAsyncStoragePersister } from '../../../query-async-storage-persister/src/index'
import { injectQueries } from '../../../angular-query-experimental/src/inject-queries'
import { withPersistQueryClient } from '../with-persist-query-client'
import type { QueryKey } from '@tanstack/query-core'
import type {
  AsyncStorage,
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

const createMockPersister = (): Persister => {
  let storedState: PersistedClient | undefined

  return {
    persistClient(persistClient: PersistedClient) {
      storedState = persistClient
    },
    async restoreClient() {
      return sleep(10).then(() => storedState)
    },
    removeClient() {
      storedState = undefined
    },
  }
}

const createMockErrorPersister = (
  removeClient: Persister['removeClient'],
): [Error, Persister] => {
  const error = new Error('restore failed')
  return [
    error,
    {
      async persistClient() {
        // noop
      },
      async restoreClient() {
        await sleep(10)
        throw error
      },
      removeClient,
    },
  ]
}

describe('withPersistQueryClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should restore cache from persister', async () => {
    const key = queryKey()
    const states: Array<{
      status: string
      fetchStatus: string
      data: string | undefined
    }> = []

    const queryClient = new QueryClient()
    void queryClient
      .query({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'hydrated'),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(10)

    const persister = createMockPersister()

    persistQueryClientSave({ queryClient, persister })
    await vi.advanceTimersByTimeAsync(0)

    queryClient.clear()

    @Component({
      template: `
        <div>
          <h1>{{ state.data() }}</h1>
          <h2>fetchStatus: {{ state.fetchStatus() }}</h2>
        </div>
      `,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'fetched'),
      }))

      constructor() {
        effect(() => {
          states.push({
            status: this.state.status(),
            fetchStatus: this.state.fetchStatus(),
            data: this.state.data(),
          })
        })
      }
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({ persistOptions: { persister } }),
        ),
      ],
    })

    expect(rendered.getByText('fetchStatus: idle')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(10)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('hydrated')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(11)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('fetched')).toBeInTheDocument()

    expect(states).toHaveLength(3)

    expect(states[0]).toMatchObject({
      status: 'pending',
      fetchStatus: 'idle',
      data: undefined,
    })

    expect(states[1]).toMatchObject({
      status: 'success',
      fetchStatus: 'fetching',
      data: 'hydrated',
    })

    expect(states[2]).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      data: 'fetched',
    })
  })

  it.todo(
    '(Once injectQueries is functional) verify that injectQueries transitions to an idle state',
  )

  it('should show initialData while restoring', async () => {
    const key = queryKey()
    const states: Array<{
      status: string
      fetchStatus: string
      data: string | undefined
    }> = []

    const queryClient = new QueryClient()
    void queryClient
      .query({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'hydrated'),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(10)

    const persister = createMockPersister()

    persistQueryClientSave({ queryClient, persister })
    await vi.advanceTimersByTimeAsync(0)

    queryClient.clear()

    @Component({
      template: `
        <div>
          <h1>{{ state.data() }}</h1>
          <h2>fetchStatus: {{ state.fetchStatus() }}</h2>
        </div>
      `,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'fetched'),
        initialData: 'initial',
        // make sure that initial data is older than the hydration data
        // otherwise initialData would be newer and takes precedence
        initialDataUpdatedAt: 1,
      }))

      constructor() {
        effect(() => {
          states.push({
            status: this.state.status(),
            fetchStatus: this.state.fetchStatus(),
            data: this.state.data(),
          })
        })
      }
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({ persistOptions: { persister } }),
        ),
      ],
    })

    expect(rendered.getByText('initial')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(10)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('hydrated')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(11)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('fetched')).toBeInTheDocument()

    expect(states).toHaveLength(3)

    expect(states[0]).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      data: 'initial',
    })

    expect(states[1]).toMatchObject({
      status: 'success',
      fetchStatus: 'fetching',
      data: 'hydrated',
    })

    expect(states[2]).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      data: 'fetched',
    })
  })

  it('should not refetch after restoring when data is fresh', async () => {
    const key = queryKey()
    const states: Array<{
      status: string
      fetchStatus: string
      data: string | undefined
    }> = []

    const queryClient = new QueryClient()
    void queryClient
      .query({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'hydrated'),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(10)

    const persister = createMockPersister()

    persistQueryClientSave({ queryClient, persister })
    await vi.advanceTimersByTimeAsync(0)

    queryClient.clear()

    let fetched = false

    @Component({
      template: `
        <div>
          <h1>data: {{ state.data() ?? 'null' }}</h1>
          <h2>fetchStatus: {{ state.fetchStatus() }}</h2>
        </div>
      `,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () =>
          sleep(10).then(() => {
            fetched = true
            return 'fetched'
          }),
        staleTime: Infinity,
      }))

      constructor() {
        effect(() => {
          states.push({
            status: this.state.status(),
            fetchStatus: this.state.fetchStatus(),
            data: this.state.data(),
          })
        })
      }
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({ persistOptions: { persister } }),
        ),
      ],
    })

    expect(rendered.getByText('data: null')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(10)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('data: hydrated')).toBeInTheDocument()

    expect(states).toHaveLength(2)

    expect(fetched).toBe(false)

    expect(states[0]).toMatchObject({
      status: 'pending',
      fetchStatus: 'idle',
      data: undefined,
    })

    expect(states[1]).toMatchObject({
      status: 'success',
      fetchStatus: 'idle',
      data: 'hydrated',
    })
  })

  it('should call onSuccess after successful restoring', async () => {
    const key = queryKey()
    const queryClient = new QueryClient()
    void queryClient
      .query({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'hydrated'),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(10)

    const persister = createMockPersister()
    persistQueryClientSave({ queryClient, persister })
    await vi.advanceTimersByTimeAsync(0)

    queryClient.clear()

    @Component({
      template: `
        <div>
          <h1>{{ state.data() }}</h1>
          <h2>fetchStatus: {{ state.fetchStatus() }}</h2>
        </div>
      `,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'fetched'),
      }))
    }

    const onSuccess = vi.fn()

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister },
            onSuccess,
          }),
        ),
      ],
    })

    expect(onSuccess).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(10)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('hydrated')).toBeInTheDocument()
    expect(onSuccess).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(11)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('fetched')).toBeInTheDocument()
  })

  it('should remove cache after non-successful restoring', async () => {
    const key = queryKey()
    const onErrorMock = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const queryClient = new QueryClient()
    const removeClient = vi.fn()
    const [error, persister] = createMockErrorPersister(removeClient)
    const onSuccess = vi.fn()
    const onError = vi.fn()

    @Component({
      template: `
        <div>
          <h1>{{ state.data() }}</h1>
          <h2>fetchStatus: {{ state.fetchStatus() }}</h2>
        </div>
      `,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => sleep(10).then(() => 'fetched'),
      }))
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister },
            onSuccess,
            onError,
          }),
        ),
      ],
    })

    await vi.advanceTimersByTimeAsync(10)
    rendered.fixture.detectChanges()
    expect(removeClient).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledTimes(0)
    expect(onError).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(11)
    rendered.fixture.detectChanges()
    expect(rendered.getByText('fetched')).toBeInTheDocument()

    expect(onErrorMock).toHaveBeenCalledTimes(1)
    expect(onErrorMock).toHaveBeenNthCalledWith(1, error)
    onErrorMock.mockRestore()
  })

  // The previous account's cache is whatever that session persisted. These are
  // placeholders for that private query data, not credentials.
  const PREVIOUS_INBOX = 'previous-account-private-inbox'
  const CURRENT_INBOX = 'current-account-inbox'
  const PREVIOUS_PAGE = 'previous-account-private-page'
  const CURRENT_PAGE = 'current-account-page'
  const PREVIOUS_PROFILE = 'previous-account-private-profile'
  const CURRENT_PROFILE = 'current-account-profile'
  const SESSION_CHECK_MS = 50
  const FETCH_MS = 10

  /**
   * Storage client with the same methods the async persister reads and writes.
   * @returns The storage client and every value written through it.
   */
  function createMemoryAsyncStorage(): {
    storage: AsyncStorage<string>
    writes: Array<string>
  } {
    const records = new Map<string, string>()
    const writes: Array<string> = []
    return {
      writes,
      storage: {
        async getItem(key: string) {
          await sleep(FETCH_MS)
          return records.get(key) ?? null
        },
        setItem(key: string, value: string) {
          writes.push(value)
          records.set(key, value)
        },
        removeItem(key: string) {
          records.delete(key)
        },
      },
    }
  }

  /**
   * Save successful queries the way a previous browser session would.
   * @param persister - Persister that writes the serialized client.
   * @param queries - Queries to fetch and persist.
   */
  async function persistPreviousQueries(
    persister: Persister,
    queries: Array<{ key: QueryKey; data: string; infinite?: boolean }>,
  ) {
    const previous = new QueryClient()
    for (const query of queries) {
      const execute = query.infinite
        ? previous.infiniteQuery({
            queryKey: query.key,
            queryFn: () => sleep(FETCH_MS).then(() => query.data),
            initialPageParam: 0,
            getNextPageParam: () => undefined,
          })
        : previous.query({
            queryKey: query.key,
            queryFn: () => sleep(FETCH_MS).then(() => query.data),
          })
      void execute.catch(noop)
      await vi.advanceTimersByTimeAsync(FETCH_MS)
    }
    const saved = persistQueryClientSave({ queryClient: previous, persister })
    await vi.advanceTimersByTimeAsync(0)
    await saved
  }

  it('keeps a restored query paused until async onSuccess settles, so the previous account is not shown, fetched again, or written back', async () => {
    const key = queryKey()
    const { storage, writes } = createMemoryAsyncStorage()
    const previousPersister = createAsyncStoragePersister({ storage })
    await persistPreviousQueries(previousPersister, [
      { key, data: PREVIOUS_INBOX },
    ])
    const seededWrites = writes.length
    expect(writes.some((value) => value.includes(PREVIOUS_INBOX))).toBe(true)

    const queryClient = new QueryClient()
    const victimPersister = createAsyncStoragePersister({ storage })
    let fetches = 0
    let checkStarted = false
    let checkFinished = false
    const renderedValues: Array<string | undefined> = []

    @Component({
      template: `<h1>{{ state.data() }}</h1>`,
    })
    class Page {
      restoring = injectIsRestoring()
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => {
          fetches++
          return sleep(FETCH_MS).then(() => CURRENT_INBOX)
        },
      }))

      constructor() {
        effect(() => {
          renderedValues.push(this.state.data())
        })
      }
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister: victimPersister },
            onSuccess: async () => {
              checkStarted = true
              await sleep(SESSION_CHECK_MS)
              queryClient.clear()
              await victimPersister.removeClient()
              checkFinished = true
            },
          }),
        ),
      ],
    })

    const page = rendered.fixture.componentInstance
    expect(checkStarted).toBe(false)

    await vi.advanceTimersByTimeAsync(FETCH_MS)
    rendered.fixture.detectChanges()

    expect(checkStarted).toBe(true)
    expect(checkFinished).toBe(false)
    expect({
      restoring: page.restoring(),
      rendered: page.state.data(),
      visible: rendered.queryByText(PREVIOUS_INBOX)?.textContent ?? null,
      fetches,
    }).toEqual({
      restoring: true,
      rendered: undefined,
      visible: null,
      fetches: 0,
    })

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()

    expect(checkFinished).toBe(false)
    expect(fetches).toBe(0)
    expect(page.state.data()).toBeUndefined()
    expect(rendered.queryByText(PREVIOUS_INBOX)).not.toBeInTheDocument()
    expect(
      writes
        .slice(seededWrites)
        .some((value) => value.includes(PREVIOUS_INBOX)),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS)
    rendered.fixture.detectChanges()

    expect(checkFinished).toBe(true)
    expect(rendered.queryByText(PREVIOUS_INBOX)).not.toBeInTheDocument()
    expect(renderedValues).not.toContain(PREVIOUS_INBOX)
    expect(
      writes.some(
        (value, index) =>
          index >= seededWrites && value.includes(PREVIOUS_INBOX),
      ),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(rendered.getByText(CURRENT_INBOX)).toBeInTheDocument()
    expect(page.state.data()).toBe(CURRENT_INBOX)
  })

  it('keeps a restored infinite query paused until async onSuccess settles', async () => {
    const key = queryKey()
    const { storage, writes } = createMemoryAsyncStorage()
    const previousPersister = createAsyncStoragePersister({ storage })
    await persistPreviousQueries(previousPersister, [
      { key, data: PREVIOUS_PAGE, infinite: true },
    ])
    const seededWrites = writes.length
    expect(writes.some((value) => value.includes(PREVIOUS_PAGE))).toBe(true)

    const queryClient = new QueryClient()
    const victimPersister = createAsyncStoragePersister({ storage })
    let fetches = 0
    let checkStarted = false
    let checkFinished = false

    @Component({
      template: `<h1>{{ state.data()?.pages?.[0] }}</h1>`,
    })
    class Page {
      restoring = injectIsRestoring()
      state = injectInfiniteQuery(() => ({
        queryKey: key,
        queryFn: () => {
          fetches++
          return sleep(FETCH_MS).then(() => CURRENT_PAGE)
        },
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }))
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister: victimPersister },
            onSuccess: async () => {
              checkStarted = true
              await sleep(SESSION_CHECK_MS)
              queryClient.clear()
              await victimPersister.removeClient()
              checkFinished = true
            },
          }),
        ),
      ],
    })

    const page = rendered.fixture.componentInstance
    await vi.advanceTimersByTimeAsync(FETCH_MS)
    rendered.fixture.detectChanges()

    expect(checkStarted).toBe(true)
    expect(checkFinished).toBe(false)
    expect(page.restoring()).toBe(true)
    expect(page.state.data()?.pages[0]).toBeUndefined()
    expect(fetches).toBe(0)
    expect(rendered.queryByText(PREVIOUS_PAGE)).not.toBeInTheDocument()
    expect(
      writes.slice(seededWrites).some((value) => value.includes(PREVIOUS_PAGE)),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(checkFinished).toBe(false)
    expect(fetches).toBe(0)
    expect(rendered.queryByText(PREVIOUS_PAGE)).not.toBeInTheDocument()
    expect(
      writes.slice(seededWrites).some((value) => value.includes(PREVIOUS_PAGE)),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS)
    rendered.fixture.detectChanges()
    expect(checkFinished).toBe(true)
    expect(rendered.queryByText(PREVIOUS_PAGE)).not.toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(rendered.getByText(CURRENT_PAGE)).toBeInTheDocument()
  })

  it('keeps restored injectQueries paused until async onSuccess settles', async () => {
    const inboxKey = queryKey()
    const profileKey = queryKey()
    const { storage, writes } = createMemoryAsyncStorage()
    const previousPersister = createAsyncStoragePersister({ storage })
    await persistPreviousQueries(previousPersister, [
      { key: inboxKey, data: PREVIOUS_INBOX },
      { key: profileKey, data: PREVIOUS_PROFILE },
    ])
    const seededWrites = writes.length
    expect(writes.some((value) => value.includes(PREVIOUS_INBOX))).toBe(true)
    expect(writes.some((value) => value.includes(PREVIOUS_PROFILE))).toBe(true)

    const queryClient = new QueryClient()
    const victimPersister = createAsyncStoragePersister({ storage })
    let fetches = 0
    let checkStarted = false
    let checkFinished = false

    @Component({
      template: `
        <h1>{{ queries()[0].data() }}</h1>
        <h2>{{ queries()[1].data() }}</h2>
      `,
    })
    class Page {
      restoring = injectIsRestoring()
      queries = injectQueries(() => ({
        queries: [
          {
            queryKey: inboxKey,
            queryFn: () => {
              fetches++
              return sleep(FETCH_MS).then(() => CURRENT_INBOX)
            },
          },
          {
            queryKey: profileKey,
            queryFn: () => {
              fetches++
              return sleep(FETCH_MS).then(() => CURRENT_PROFILE)
            },
          },
        ],
      }))
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister: victimPersister },
            onSuccess: async () => {
              checkStarted = true
              await sleep(SESSION_CHECK_MS)
              queryClient.clear()
              await victimPersister.removeClient()
              checkFinished = true
            },
          }),
        ),
      ],
    })

    const page = rendered.fixture.componentInstance
    await vi.advanceTimersByTimeAsync(FETCH_MS)
    rendered.fixture.detectChanges()

    expect(checkStarted).toBe(true)
    expect(checkFinished).toBe(false)
    expect(page.restoring()).toBe(true)
    expect(page.queries()[0].data()).toBeUndefined()
    expect(page.queries()[1].data()).toBeUndefined()
    expect(fetches).toBe(0)
    expect(rendered.queryByText(PREVIOUS_INBOX)).not.toBeInTheDocument()
    expect(rendered.queryByText(PREVIOUS_PROFILE)).not.toBeInTheDocument()
    expect(
      writes
        .slice(seededWrites)
        .some(
          (value) =>
            value.includes(PREVIOUS_INBOX) || value.includes(PREVIOUS_PROFILE),
        ),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(checkFinished).toBe(false)
    expect(fetches).toBe(0)
    expect(
      writes
        .slice(seededWrites)
        .some(
          (value) =>
            value.includes(PREVIOUS_INBOX) || value.includes(PREVIOUS_PROFILE),
        ),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS)
    rendered.fixture.detectChanges()
    expect(checkFinished).toBe(true)
    expect(rendered.queryByText(PREVIOUS_INBOX)).not.toBeInTheDocument()
    expect(rendered.queryByText(PREVIOUS_PROFILE)).not.toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(rendered.getByText(CURRENT_INBOX)).toBeInTheDocument()
    expect(rendered.getByText(CURRENT_PROFILE)).toBeInTheDocument()
  })

  it('keeps queries paused until an async onError callback settles', async () => {
    const key = queryKey()
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const { storage } = createMemoryAsyncStorage()
    await storage.setItem('REACT_QUERY_OFFLINE_CACHE', 'not-json')
    const persister = createAsyncStoragePersister({ storage })
    const queryClient = new QueryClient()
    let fetches = 0
    let errorStarted = false
    let errorFinished = false

    @Component({
      template: `<h1>{{ state.data() }}</h1>`,
    })
    class Page {
      restoring = injectIsRestoring()
      state = injectQuery(() => ({
        queryKey: key,
        queryFn: () => {
          fetches++
          return sleep(FETCH_MS).then(() => CURRENT_INBOX)
        },
      }))
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister },
            onError: async () => {
              errorStarted = true
              await sleep(SESSION_CHECK_MS)
              errorFinished = true
            },
          }),
        ),
      ],
    })

    const page = rendered.fixture.componentInstance
    await vi.advanceTimersByTimeAsync(FETCH_MS)
    rendered.fixture.detectChanges()

    expect(errorStarted).toBe(true)
    expect(errorFinished).toBe(false)
    expect(page.restoring()).toBe(true)
    expect(fetches).toBe(0)
    expect(page.state.data()).toBeUndefined()

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(errorFinished).toBe(false)
    expect(fetches).toBe(0)

    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MS)
    rendered.fixture.detectChanges()
    expect(errorFinished).toBe(true)

    await vi.advanceTimersByTimeAsync(FETCH_MS + 5)
    rendered.fixture.detectChanges()
    expect(fetches).toBe(1)
    expect(rendered.getByText(CURRENT_INBOX)).toBeInTheDocument()

    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
