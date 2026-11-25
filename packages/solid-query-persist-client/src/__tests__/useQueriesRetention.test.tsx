import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@solidjs/testing-library'
import { QueryClient, onlineManager, useQueries } from '@tanstack/solid-query'
import { Show, createSignal } from 'solid-js'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type { QueryKey } from '@tanstack/solid-query'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

const STORAGE_KEY = 'solid-query-retention-test'
const GC_TIME = 50

function createBrowserStoragePersister(): Persister {
  return {
    persistClient(persistClient: PersistedClient) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistClient))
    },
    restoreClient() {
      const stored = localStorage.getItem(STORAGE_KEY)
      return sleep(10).then(() =>
        stored ? (JSON.parse(stored) as PersistedClient) : undefined,
      )
    },
    removeClient() {
      localStorage.removeItem(STORAGE_KEY)
    },
  }
}

function storedQuery(
  key: QueryKey,
): { queryKey: QueryKey; data: unknown } | undefined {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return undefined
  const persisted = JSON.parse(stored) as PersistedClient
  const queries: Array<{ queryKey: QueryKey; data: unknown }> =
    persisted.clientState.queries.map(
      (query: PersistedClient['clientState']['queries'][number]) => ({
        queryKey: query.queryKey,
        data: query.state.data,
      }),
    )
  return queries.find(
    (query) => JSON.stringify(query.queryKey) === JSON.stringify(key),
  )
}

async function refetchFromBrowserEvents(): Promise<void> {
  window.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(20)
  window.dispatchEvent(new Event('offline'))
  window.dispatchEvent(new Event('online'))
  await vi.advanceTimersByTimeAsync(20)
}

describe('useQueries retention across restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.removeItem(STORAGE_KEY)
  })

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    onlineManager.setOnline(true)
    vi.useRealTimers()
  })

  it('drops queries mounted during restore when their page unmounts, and does not refetch or restore them for the next profile', async () => {
    const profileKey = queryKey()
    const settingsKey = queryKey()
    const profileFn = vi.fn(() => sleep(10).then(() => 'alice-profile'))
    const settingsFn = vi.fn(() => sleep(10).then(() => 'alice-settings'))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: GC_TIME } },
    })
    const persister = createBrowserStoragePersister()

    function AccountPage() {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: profileKey,
            queryFn: profileFn,
            gcTime: GC_TIME,
            retry: false,
          },
          {
            queryKey: settingsKey,
            queryFn: settingsFn,
            gcTime: GC_TIME,
            retry: false,
          },
        ],
      }))

      return (
        <div>
          <span data-testid="profile">{String(results[0].data ?? '')}</span>
          <span data-testid="settings">{String(results[1].data ?? '')}</span>
        </div>
      )
    }

    function App() {
      const [showAccount, setShowAccount] = createSignal(true)

      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister }}
        >
          <button type="button" onClick={() => setShowAccount(false)}>
            leave
          </button>
          <Show when={showAccount()}>
            <AccountPage />
          </Show>
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(() => <App />)

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(screen.getByTestId('profile')).toHaveTextContent('alice-profile')
    expect(screen.getByTestId('settings')).toHaveTextContent('alice-settings')
    const profileCalls = profileFn.mock.calls.length
    const settingsCalls = settingsFn.mock.calls.length
    expect(profileCalls).toBeGreaterThan(0)
    expect(settingsCalls).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'leave' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: profileKey })
        ?.getObserversCount() ?? 0,
    ).toBe(0)
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: settingsKey })
        ?.getObserversCount() ?? 0,
    ).toBe(0)

    await vi.advanceTimersByTimeAsync(GC_TIME + 20)

    expect(
      queryClient.getQueryCache().find({ queryKey: profileKey }),
    ).toBeUndefined()
    expect(
      queryClient.getQueryCache().find({ queryKey: settingsKey }),
    ).toBeUndefined()

    await refetchFromBrowserEvents()

    expect(profileFn).toHaveBeenCalledTimes(profileCalls)
    expect(settingsFn).toHaveBeenCalledTimes(settingsCalls)
    expect(storedQuery(profileKey)).toBeUndefined()
    expect(storedQuery(settingsKey)).toBeUndefined()

    rendered.unmount()

    const nextClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: GC_TIME } },
    })

    function NextProfile() {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => sleep(10).then(() => 'someone-else'),
            gcTime: GC_TIME,
            retry: false,
          },
        ],
      }))
      return (
        <span data-testid="next-profile">{String(results[0].data ?? '')}</span>
      )
    }

    render(() => (
      <PersistQueryClientProvider
        client={nextClient}
        persistOptions={{ persister }}
      >
        <NextProfile />
      </PersistQueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(10)
    expect(screen.getByTestId('next-profile')).not.toHaveTextContent(
      'alice-profile',
    )
    expect(
      nextClient.getQueryCache().find({ queryKey: profileKey })?.state.data,
    ).not.toBe('alice-profile')
  })

  it('drops the subscription created when persist options change and restoring runs again', async () => {
    const profileKey = queryKey()
    const profileFn = vi.fn(() => sleep(10).then(() => 'alice-profile'))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: GC_TIME } },
    })
    const persister = createBrowserStoragePersister()

    function Profile() {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: profileKey,
            queryFn: profileFn,
            gcTime: GC_TIME,
            retry: false,
          },
        ],
      }))
      return <span data-testid="profile">{String(results[0].data ?? '')}</span>
    }

    function App() {
      const [showAccount, setShowAccount] = createSignal(false)
      const [maxAge, setMaxAge] = createSignal(1000 * 60 * 60 * 24)

      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister, maxAge: maxAge() }}
        >
          <button type="button" onClick={() => setShowAccount(true)}>
            open
          </button>
          <button type="button" onClick={() => setShowAccount(false)}>
            leave
          </button>
          <button type="button" onClick={() => setMaxAge((age) => age + 1)}>
            restore-again
          </button>
          <Show when={showAccount()}>
            <Profile />
          </Show>
        </PersistQueryClientProvider>
      )
    }

    render(() => <App />)

    await vi.advanceTimersByTimeAsync(10)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(screen.getByTestId('profile')).toHaveTextContent('alice-profile')

    fireEvent.click(screen.getByRole('button', { name: 'restore-again' }))
    await vi.advanceTimersByTimeAsync(30)
    expect(screen.getByTestId('profile')).toHaveTextContent('alice-profile')
    const profileCalls = profileFn.mock.calls.length
    expect(profileCalls).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'leave' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: profileKey })
        ?.getObserversCount() ?? 0,
    ).toBe(0)

    await vi.advanceTimersByTimeAsync(GC_TIME + 20)
    expect(
      queryClient.getQueryCache().find({ queryKey: profileKey }),
    ).toBeUndefined()

    await refetchFromBrowserEvents()

    expect(profileFn).toHaveBeenCalledTimes(profileCalls)
    expect(storedQuery(profileKey)).toBeUndefined()
  })
})
