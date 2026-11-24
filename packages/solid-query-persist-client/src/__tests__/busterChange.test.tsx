import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, useQuery } from '@tanstack/solid-query'
import { persistQueryClientSave } from '@tanstack/query-persist-client-core'
import { createSignal } from 'solid-js'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

/**
 * Same account-switch contract as the Svelte provider.
 * `PersistQueryClientProvider` restores again when `buster` or `persister`
 * changes. The previous account's queries must not stay in memory or be
 * written for the next account, including when an older restore finishes late.
 */

const PROFILE_KEY = ['account', 'profile']
const INBOX_KEY = ['account', 'inbox']
const PREVIOUS_PROFILE = 'previous-account-profile'
const PREVIOUS_INBOX = 'previous-account-inbox'
const FETCHED_PROFILE = 'fetched-for-current-account'

const PRIVATE_VALUES = new Set([PREVIOUS_PROFILE, PREVIOUS_INBOX])

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: Infinity,
      },
    },
  })
}

function privateQueries(client: PersistedClient | undefined) {
  return (client?.clientState.queries ?? [])
    .filter((query) => PRIVATE_VALUES.has(String(query.state.data)))
    .map((query) => ({
      buster: client?.buster,
      data: query.state.data,
      queryKey: query.queryKey,
    }))
}

function createMemoryPersister() {
  let stored: PersistedClient | undefined
  const writes: Array<PersistedClient> = []
  const pending: Array<() => void> = []
  let manual = false

  const persister: Persister = {
    persistClient(next) {
      stored = structuredClone(next)
      writes.push(stored)
    },
    restoreClient() {
      if (!manual) {
        return Promise.resolve(stored)
      }
      const seen = stored
      return new Promise((resolve) => {
        pending.push(() => resolve(seen))
      })
    },
    removeClient() {
      stored = undefined
    },
  }

  return {
    persister,
    writes,
    read: () => stored,
    armManualRestores() {
      manual = true
    },
    resolveOldest() {
      const resolve = pending.shift()
      if (!resolve) {
        throw new Error('no restore is waiting')
      }
      resolve()
    },
    resolveNewest() {
      const resolve = pending.pop()
      if (!resolve) {
        throw new Error('no restore is waiting')
      }
      resolve()
    },
  }
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}

function seedPreviousAccount(queryClient: QueryClient) {
  queryClient.setQueryData(PROFILE_KEY, PREVIOUS_PROFILE)
  queryClient.setQueryData(INBOX_KEY, PREVIOUS_INBOX)
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PersistQueryClientProvider account switch', () => {
  it('drops the previous account cache when the buster changes and does not save it under the new buster', async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    seedPreviousAccount(queryClient)
    const storage = createMemoryPersister()
    await persistQueryClientSave({
      queryClient,
      persister: storage.persister,
      buster: 'account-a',
    })
    storage.writes.length = 0

    let fetches = 0
    let setBuster: (buster: string) => void = () => {
      throw new Error('buster setter was not installed')
    }

    function Profile() {
      const profile = useQuery(() => ({
        queryKey: PROFILE_KEY,
        staleTime: Infinity,
        queryFn: () => {
          fetches += 1
          return FETCHED_PROFILE
        },
      }))

      return (
        <div>
          <div data-testid="profile">{profile.data ?? ''}</div>
          <div data-testid="fetch-status">{profile.fetchStatus}</div>
        </div>
      )
    }

    function App() {
      const [buster, setBusterSignal] = createSignal('account-a')
      setBuster = setBusterSignal
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: storage.persister, buster: buster() }}
        >
          <Profile />
        </PersistQueryClientProvider>
      )
    }

    render(() => <App />)
    await settle()
    expect(screen.getByTestId('profile')).toHaveTextContent(PREVIOUS_PROFILE)
    expect(fetches).toBe(0)

    const writesBeforeSwitch = storage.writes.length
    setBuster('account-b')
    await settle()

    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(PREVIOUS_PROFILE)
    expect(screen.getByTestId('profile')).not.toHaveTextContent(
      PREVIOUS_PROFILE,
    )
    expect(screen.getByTestId('profile')).toHaveTextContent(FETCHED_PROFILE)
    expect(fetches).toBeGreaterThan(0)

    queryClient.setQueryData(['account', 'session'], 'current-session')
    await settle()

    const writesAfterSwitch = storage.writes.slice(writesBeforeSwitch)
    expect(writesAfterSwitch.flatMap((write) => privateQueries(write))).toEqual(
      [],
    )
    expect(privateQueries(storage.read())).toEqual([])
    expect(storage.read()?.buster).toBe('account-b')
    expect(
      storage
        .read()
        ?.clientState.queries.some(
          (query) => query.state.data === 'current-session',
        ),
    ).toBe(true)

    cleanup()

    const laterClient = createClient()
    function LaterProfile() {
      const profile = useQuery(() => ({
        queryKey: PROFILE_KEY,
        staleTime: Infinity,
        queryFn: () => FETCHED_PROFILE,
      }))
      return <div data-testid="profile">{profile.data ?? ''}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={laterClient}
        persistOptions={{ persister: storage.persister, buster: 'account-b' }}
      >
        <LaterProfile />
      </PersistQueryClientProvider>
    ))
    await settle()

    expect(screen.getByTestId('profile')).toHaveTextContent(FETCHED_PROFILE)
    expect(screen.getByTestId('profile')).not.toHaveTextContent(
      PREVIOUS_PROFILE,
    )
    expect(laterClient.getQueryData(PROFILE_KEY)).not.toBe(PREVIOUS_PROFILE)
    expect(laterClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(privateQueries(storage.read())).toEqual([])
  })

  it('does not copy the previous account cache when the persister changes', async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    seedPreviousAccount(queryClient)
    const previousStorage = createMemoryPersister()
    const nextStorage = createMemoryPersister()
    await persistQueryClientSave({
      queryClient,
      persister: previousStorage.persister,
      buster: 'account-a',
    })

    const nextClient = createClient()
    nextClient.setQueryData(PROFILE_KEY, 'current-account-profile')
    await vi.advanceTimersByTimeAsync(5)
    await persistQueryClientSave({
      queryClient: nextClient,
      persister: nextStorage.persister,
      buster: 'account-a',
    })
    nextStorage.writes.length = 0

    let setPersister: (persister: Persister) => void = () => {
      throw new Error('persister setter was not installed')
    }

    function Profile() {
      const profile = useQuery(() => ({
        queryKey: PROFILE_KEY,
        staleTime: Infinity,
        queryFn: () => 'fetched-for-current-account',
      }))
      return <div data-testid="profile">{profile.data ?? ''}</div>
    }

    function App() {
      const [persister, setPersisterSignal] = createSignal(
        previousStorage.persister,
      )
      setPersister = setPersisterSignal
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: persister(), buster: 'account-a' }}
        >
          <Profile />
        </PersistQueryClientProvider>
      )
    }

    render(() => <App />)
    await settle()
    expect(screen.getByTestId('profile')).toHaveTextContent(PREVIOUS_PROFILE)

    const writesBeforeSwitch = nextStorage.writes.length
    setPersister(nextStorage.persister)
    await settle()

    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(PREVIOUS_PROFILE)
    expect(screen.getByTestId('profile')).not.toHaveTextContent(
      PREVIOUS_PROFILE,
    )

    queryClient.setQueryData(['account', 'session'], 'current-session')
    await settle()

    const writesAfterSwitch = nextStorage.writes.slice(writesBeforeSwitch)
    expect(writesAfterSwitch.flatMap((write) => privateQueries(write))).toEqual(
      [],
    )
    expect(privateQueries(nextStorage.read())).toEqual([])
    expect(
      nextStorage
        .read()
        ?.clientState.queries.some(
          (query) => query.state.data === 'current-session',
        ),
    ).toBe(true)
  })

  it('ignores a restore that started for an older buster', async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    const storage = createMemoryPersister()
    const seedClient = createClient()
    seedPreviousAccount(seedClient)
    await persistQueryClientSave({
      queryClient: seedClient,
      persister: storage.persister,
      buster: 'account-a',
    })
    storage.writes.length = 0
    storage.armManualRestores()

    let setBuster: (buster: string) => void = () => {
      throw new Error('buster setter was not installed')
    }

    function App() {
      const [buster, setBusterSignal] = createSignal('account-a')
      setBuster = setBusterSignal
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: storage.persister, buster: buster() }}
        >
          <div>persist-idle</div>
        </PersistQueryClientProvider>
      )
    }

    render(() => <App />)
    await settle()
    setBuster('account-b')
    await settle()

    storage.resolveNewest()
    await settle()

    queryClient.setQueryData(['account', 'session'], 'current-session')
    await settle()
    expect(privateQueries(storage.read())).toEqual([])
    expect(
      storage
        .read()
        ?.clientState.queries.some(
          (query) => query.state.data === 'current-session',
        ),
    ).toBe(true)

    const writesBeforeStaleRestore = storage.writes.length
    storage.resolveOldest()
    await settle()

    expect(queryClient.getQueryData(PROFILE_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(
      storage.writes
        .slice(writesBeforeStaleRestore)
        .flatMap((write) => privateQueries(write)),
    ).toEqual([])
    expect(privateQueries(storage.read())).toEqual([])
    expect(
      storage
        .read()
        ?.clientState.queries.some(
          (query) => query.state.data === 'current-session',
        ),
    ).toBe(true)
  })

  it('does not save the previous account while a newer restore is still in flight', async () => {
    vi.useFakeTimers()
    const queryClient = createClient()
    seedPreviousAccount(queryClient)
    const storage = createMemoryPersister()
    await persistQueryClientSave({
      queryClient,
      persister: storage.persister,
      buster: 'account-a',
    })
    storage.writes.length = 0
    storage.armManualRestores()

    let setBuster: (buster: string) => void = () => {
      throw new Error('buster setter was not installed')
    }

    function App() {
      const [buster, setBusterSignal] = createSignal('account-a')
      setBuster = setBusterSignal
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: storage.persister, buster: buster() }}
        >
          <div>persist-idle</div>
        </PersistQueryClientProvider>
      )
    }

    render(() => <App />)
    await settle()
    storage.resolveOldest()
    await settle()
    expect(queryClient.getQueryData(PROFILE_KEY)).toBe(PREVIOUS_PROFILE)

    const writesBeforeSwitch = storage.writes.length
    setBuster('account-b')
    await settle()

    queryClient.setQueryData(['account', 'during-restore'], 'while-restoring')
    await settle()
    expect(
      storage.writes
        .slice(writesBeforeSwitch)
        .flatMap((write) => privateQueries(write)),
    ).toEqual([])

    storage.resolveOldest()
    await settle()
    queryClient.setQueryData(['account', 'session'], 'current-session')
    await settle()

    expect(queryClient.getQueryData(PROFILE_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(
      storage.writes
        .slice(writesBeforeSwitch)
        .flatMap((write) => privateQueries(write)),
    ).toEqual([])
    expect(privateQueries(storage.read())).toEqual([])
    expect(storage.read()?.buster).toBe('account-b')
  })
})
