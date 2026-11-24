import { cleanup, render } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { QueryClient } from '@tanstack/svelte-query'
import { persistQueryClientSave } from '@tanstack/query-persist-client-core'
import Provider from './AccountSwitch/Provider.svelte'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

/**
 * Spec for account switches that reuse one query client.
 * Changing `buster` or `persister` is how two accounts share a browser.
 * After that change settles, the previous account's queries must be gone
 * from memory and must not be written under the new buster or persister.
 * A restore that started before the change must not hydrate or delete
 * storage once a newer restore has started.
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
  await tick()
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
    const view = render(Provider, {
      props: {
        queryClient,
        persister: storage.persister,
        buster: 'account-a',
        showProfile: true,
        onFetch: () => {
          fetches += 1
        },
      },
    })

    await settle()
    expect(view.getByTestId('profile')).toHaveTextContent(PREVIOUS_PROFILE)
    expect(fetches).toBe(0)

    const writesBeforeSwitch = storage.writes.length
    await view.rerender({ buster: 'account-b' })
    await settle()

    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(PREVIOUS_PROFILE)
    expect(view.getByTestId('profile')).not.toHaveTextContent(PREVIOUS_PROFILE)
    expect(view.getByTestId('profile')).toHaveTextContent(FETCHED_PROFILE)
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

    view.unmount()

    const laterClient = createClient()
    const later = render(Provider, {
      props: {
        queryClient: laterClient,
        persister: storage.persister,
        buster: 'account-b',
        showProfile: true,
        onFetch: () => {},
      },
    })
    await settle()

    expect(later.getByTestId('profile')).toHaveTextContent(FETCHED_PROFILE)
    expect(later.getByTestId('profile')).not.toHaveTextContent(PREVIOUS_PROFILE)
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

    const view = render(Provider, {
      props: {
        queryClient,
        persister: previousStorage.persister,
        buster: 'account-a',
        showProfile: true,
        onFetch: () => {},
      },
    })
    await settle()
    expect(view.getByTestId('profile')).toHaveTextContent(PREVIOUS_PROFILE)

    const writesBeforeSwitch = nextStorage.writes.length
    await view.rerender({ persister: nextStorage.persister })
    await settle()

    expect(queryClient.getQueryData(INBOX_KEY)).toBeUndefined()
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(PREVIOUS_PROFILE)
    expect(view.getByTestId('profile')).not.toHaveTextContent(PREVIOUS_PROFILE)

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

    const view = render(Provider, {
      props: {
        queryClient,
        persister: storage.persister,
        buster: 'account-a',
      },
    })
    await settle()
    await view.rerender({ buster: 'account-b' })
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

    const view = render(Provider, {
      props: {
        queryClient,
        persister: storage.persister,
        buster: 'account-a',
      },
    })
    await settle()
    storage.resolveOldest()
    await settle()
    expect(queryClient.getQueryData(PROFILE_KEY)).toBe(PREVIOUS_PROFILE)

    const writesBeforeSwitch = storage.writes.length
    await view.rerender({ buster: 'account-b' })
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
