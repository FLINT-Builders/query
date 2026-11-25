import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QueryClient,
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
import { withPersistQueryClient } from '../with-persist-query-client'
import {
  FORGED_MUTATION,
  FORGED_PROFILE,
  FORGED_SESSION,
  PERSIST_STORAGE_KEY,
  createMemoryStorage,
  forgedValuesStillCached,
  plantPoisonedQueryCache,
} from '../../../query-persist-client-core/src/__tests__/poisonedPersistCache'
import type {
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

  it('does not show or republish queries hydrated before a stateless persisted entry', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    const storage = createMemoryStorage()
    plantPoisonedQueryCache(storage)
    const persister = createAsyncStoragePersister({
      storage,
      throttleTime: 0,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(['profile'], 'real-profile')

    const seen: Array<string | undefined> = []

    @Component({
      template: `<h1>{{ state.data() }}</h1>`,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: ['session'],
        queryFn: () => sleep(10).then(() => 'fetched-session'),
      }))

      constructor() {
        effect(() => {
          seen.push(this.state.data())
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

    await vi.advanceTimersByTimeAsync(0)
    rendered.fixture.detectChanges()

    expect(forgedValuesStillCached(queryClient)).toEqual([])
    expect([undefined, 'real-profile']).toContain(
      queryClient.getQueryData(['profile']),
    )
    expect(queryClient.getQueryData(['session'])).not.toBe(FORGED_SESSION)
    expect(seen).not.toContain(FORGED_SESSION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    queryClient.setQueryData(['unrelated'], 'unrelated-value')
    await vi.advanceTimersByTimeAsync(20)
    rendered.fixture.detectChanges()

    const saved = storage.getItem(PERSIST_STORAGE_KEY) ?? ''
    expect(saved).not.toContain(FORGED_PROFILE)
    expect(saved).not.toContain(FORGED_SESSION)
    expect(saved).not.toContain(FORGED_MUTATION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
