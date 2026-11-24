/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/preact'
import { QueryClient, useQueries, useQuery } from '@tanstack/preact-query'
import { persistQueryClientSave } from '@tanstack/query-persist-client-core'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'
import type { QueryClient as QueryClientType } from '@tanstack/preact-query'

/**
 * Spec for cross-account cache isolation in PersistQueryClientProvider.
 * These tests fail while a buster, persister, or client change leaves the
 * previous account's cache in memory, keeps saving under the old buster, or
 * applies a restore that finished after a newer one started.
 */

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  })
}

function createSleepPersister(): {
  persister: Persister
  read: () => PersistedClient | undefined
} {
  let storedState: PersistedClient | undefined

  return {
    persister: {
      persistClient(persistClient: PersistedClient) {
        storedState = persistClient
      },
      async restoreClient() {
        await sleep(10)
        return storedState
      },
      removeClient() {
        storedState = undefined
      },
    },
    read() {
      return storedState
    },
  }
}

function createGatedPersister(): {
  persister: Persister
  setStored: (next: PersistedClient | undefined) => void
  pendingCount: () => number
  releaseNewest: () => void
  releaseOldest: () => void
} {
  let storedState: PersistedClient | undefined
  const pending: Array<() => void> = []

  return {
    persister: {
      persistClient(persistClient: PersistedClient) {
        storedState = persistClient
      },
      restoreClient() {
        const snapshot = storedState
        return new Promise((resolve) => {
          pending.push(() => resolve(snapshot))
        })
      },
      removeClient() {
        storedState = undefined
      },
    },
    setStored(next) {
      storedState = next
    },
    pendingCount() {
      return pending.length
    },
    releaseNewest() {
      const release = pending.pop()
      if (!release) {
        throw new Error('no pending restore')
      }
      release()
    },
    releaseOldest() {
      const release = pending.shift()
      if (!release) {
        throw new Error('no pending restore')
      }
      release()
    },
  }
}

function rememberPausedDraft(client: QueryClientType, variables: string): void {
  client.getMutationCache().build(
    client,
    {
      mutationKey: ['save-draft'],
      mutationFn: async () => 'saved',
    },
    {
      context: undefined,
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: 'pending',
      variables,
      submittedAt: 1,
    },
  )
}

async function saveSnapshot(options: {
  buster: string
  profileKey: ReadonlyArray<string>
  profile: string
  inboxKey?: ReadonlyArray<string>
  inbox?: string
  draft?: string
  updatedAt?: number
}): Promise<PersistedClient> {
  const seed = createQueryClient()
  seed.setQueryData(options.profileKey, options.profile)
  if (options.inboxKey && options.inbox !== undefined) {
    seed.setQueryData(options.inboxKey, options.inbox)
  }
  if (options.draft !== undefined) {
    rememberPausedDraft(seed, options.draft)
  }

  const { persister, read } = createSleepPersister()
  await persistQueryClientSave({
    queryClient: seed,
    persister,
    buster: options.buster,
  })
  await vi.advanceTimersByTimeAsync(0)
  const snapshot = read()
  if (!snapshot) {
    throw new Error('expected a persisted snapshot')
  }
  if (options.updatedAt !== undefined) {
    for (const query of snapshot.clientState.queries) {
      query.state = { ...query.state, dataUpdatedAt: options.updatedAt }
      query.dehydratedAt = options.updatedAt
    }
  }
  return snapshot
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PersistQueryClientProvider account isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the previous account from fresh useQuery and useQueries readers when the buster changes', async () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    let profileFetches = 0
    const storage = createSleepPersister()
    const snapshot = await saveSnapshot({
      buster: 'account-a',
      profileKey,
      profile: 'account-a-profile',
      inboxKey,
      inbox: 'account-a-inbox',
      draft: 'account-a-draft',
    })
    storage.persister.persistClient(snapshot)

    const queryClient = createQueryClient()

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: async () => {
          profileFetches++
          await sleep(10)
          return 'fetched-profile'
        },
        staleTime: Infinity,
      })
      const [inbox] = useQueries({
        queries: [
          {
            queryKey: inboxKey,
            queryFn: async () => {
              await sleep(10)
              return 'fetched-inbox'
            },
            staleTime: Infinity,
          },
        ],
      })

      return (
        <div>
          <h1>profile: {profile.data ?? 'null'}</h1>
          <h2>inbox: {inbox.data ?? 'null'}</h2>
        </div>
      )
    }

    function App({ buster }: { buster: string }) {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: storage.persister, buster }}
        >
          <Page />
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(<App buster="account-a" />)

    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByText('profile: account-a-profile')).toBeInTheDocument()
    expect(screen.getByText('inbox: account-a-inbox')).toBeInTheDocument()
    const fetchesBeforeSwitch = profileFetches
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toContain('account-a-draft')

    rendered.rerender(<App buster="account-b" />)
    await act(() => vi.advanceTimersByTimeAsync(20))
    await act(() => vi.advanceTimersByTimeAsync(30))

    expect(screen.getByText('profile: fetched-profile')).toBeInTheDocument()
    expect(screen.getByText('inbox: fetched-inbox')).toBeInTheDocument()
    expect(
      screen.queryByText('profile: account-a-profile'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('inbox: account-a-inbox')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(profileKey)).toBe('fetched-profile')
    expect(queryClient.getQueryData(inboxKey)).toBe('fetched-inbox')
    expect(profileFetches).toBeGreaterThan(fetchesBeforeSwitch)
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).not.toContain('account-a-draft')
  })

  it('does not let a slower restore for the previous buster overwrite the current account', async () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const gate = createGatedPersister()
    const accountA = await saveSnapshot({
      buster: 'account-a',
      profileKey,
      profile: 'account-a-profile',
      inboxKey,
      inbox: 'account-a-inbox',
      draft: 'account-a-draft',
      updatedAt: Date.now() + 1_000_000,
    })
    const accountB = await saveSnapshot({
      buster: 'account-b',
      profileKey,
      profile: 'account-b-profile',
      updatedAt: Date.now() + 500_000,
    })
    gate.setStored(accountA)

    const queryClient = createQueryClient()

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: async () => {
          await sleep(100_000)
          return 'fetched-profile'
        },
        staleTime: Infinity,
      })

      return <h1>profile: {profile.data ?? 'null'}</h1>
    }

    function App({ buster }: { buster: string }) {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: gate.persister, buster }}
        >
          <Page />
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(<App buster="account-a" />)
    expect(gate.pendingCount()).toBe(1)

    gate.setStored(accountB)
    rendered.rerender(<App buster="account-b" />)

    while (gate.pendingCount() > 1) {
      await settle(() => gate.releaseNewest())
    }
    await settle(() => gate.releaseOldest())

    expect(screen.getByText('profile: account-b-profile')).toBeInTheDocument()
    expect(queryClient.getQueryData(profileKey)).toBe('account-b-profile')
    expect(queryClient.getQueryData(inboxKey)).toBeUndefined()
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).not.toContain('account-a-draft')
  })

  it('saves later cache writes with the buster from after the account switch', async () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const storage = createSleepPersister()
    const snapshot = await saveSnapshot({
      buster: 'account-a',
      profileKey,
      profile: 'account-a-profile',
      inboxKey,
      inbox: 'account-a-inbox',
      draft: 'account-a-draft',
    })
    storage.persister.persistClient(snapshot)

    const queryClient = createQueryClient()

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: async () => {
          await sleep(10)
          return 'fetched-profile'
        },
        staleTime: Infinity,
      })
      return <h1>profile: {profile.data ?? 'null'}</h1>
    }

    function App({ buster }: { buster: string }) {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister: storage.persister, buster }}
        >
          <Page />
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(<App buster="account-a" />)
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByText('profile: account-a-profile')).toBeInTheDocument()

    rendered.rerender(<App buster="account-b" />)
    await act(() => vi.advanceTimersByTimeAsync(40))

    act(() => {
      queryClient.setQueryData(profileKey, 'typed-by-b')
    })
    await act(() => vi.advanceTimersByTimeAsync(0))

    const stored = storage.read()
    expect(stored?.buster).toBe('account-b')
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain('account-a-inbox')
    expect(serialized).not.toContain('account-a-draft')
    expect(serialized).toContain('typed-by-b')
  })

  it('restores the replacement persister and drops entries that snapshot does not contain', async () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const current = createSleepPersister()
    const next = createSleepPersister()
    current.persister.persistClient(
      await saveSnapshot({
        buster: 'build-1',
        profileKey,
        profile: 'account-a-profile',
        inboxKey,
        inbox: 'account-a-inbox',
        draft: 'account-a-draft',
        updatedAt: 1_000,
      }),
    )
    next.persister.persistClient(
      await saveSnapshot({
        buster: 'build-1',
        profileKey,
        profile: 'persister-b-profile',
        updatedAt: Date.now() + 500_000,
      }),
    )

    const queryClient = createQueryClient()

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: async () => {
          await sleep(100_000)
          return 'fetched-profile'
        },
        staleTime: Infinity,
      })
      useQuery({
        queryKey: inboxKey,
        queryFn: async () => {
          await sleep(100_000)
          return 'fetched-inbox'
        },
        staleTime: Infinity,
      })
      return <h1>profile: {profile.data ?? 'null'}</h1>
    }

    function App({ persister }: { persister: Persister }) {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister, buster: 'build-1' }}
        >
          <Page />
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(<App persister={current.persister} />)
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByText('profile: account-a-profile')).toBeInTheDocument()
    expect(queryClient.getQueryData(inboxKey)).toBe('account-a-inbox')

    rendered.rerender(<App persister={next.persister} />)
    await act(() => vi.advanceTimersByTimeAsync(20))

    expect(screen.getByText('profile: persister-b-profile')).toBeInTheDocument()
    expect(queryClient.getQueryData(profileKey)).toBe('persister-b-profile')
    expect(queryClient.getQueryData(inboxKey)).toBeUndefined()
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).not.toContain('account-a-draft')
  })

  it('restores a persisted snapshot into a query client that replaces the previous one', async () => {
    const profileKey = queryKey()
    const storage = createSleepPersister()
    storage.persister.persistClient(
      await saveSnapshot({
        buster: 'account-a',
        profileKey,
        profile: 'account-a-profile',
        updatedAt: Date.now() + 500_000,
      }),
    )

    const firstClient = createQueryClient()
    const secondClient = createQueryClient()

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: async () => {
          await sleep(100_000)
          return 'fetched-profile'
        },
        staleTime: Infinity,
      })
      return <h1>profile: {profile.data ?? 'null'}</h1>
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <PersistQueryClientProvider
          client={client}
          persistOptions={{ persister: storage.persister, buster: 'account-a' }}
        >
          <Page />
        </PersistQueryClientProvider>
      )
    }

    const rendered = render(<App client={firstClient} />)
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByText('profile: account-a-profile')).toBeInTheDocument()

    rendered.rerender(<App client={secondClient} />)
    await act(() => vi.advanceTimersByTimeAsync(20))

    expect(screen.getByText('profile: account-a-profile')).toBeInTheDocument()
    expect(secondClient.getQueryData(profileKey)).toBe('account-a-profile')
  })
})
