import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, dehydrate } from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type { PersistedClient } from '@tanstack/query-persist-client-core'

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const BUSTER = 'build-hash'
const SYSTEM_TIME = new Date('2026-06-01T12:00:00Z')

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createMemoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem(key: string) {
      const value = items.get(key)
      return value === undefined ? null : value
    },
    setItem(key: string, value: string) {
      items.set(key, value)
    },
    removeItem(key: string) {
      items.delete(key)
    },
    snapshot() {
      return items.get(STORAGE_KEY) ?? null
    },
  }
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity },
    },
  })
}

function persistedClient(
  queryClient: QueryClient,
  timestamp = SYSTEM_TIME.getTime(),
): PersistedClient {
  return {
    buster: BUSTER,
    timestamp,
    clientState: dehydrate(queryClient),
  }
}

async function restoreVisitor(
  persister: ReturnType<typeof createAsyncStoragePersister>,
) {
  const nextVisitor = createClient()
  await persistQueryClientRestore({
    queryClient: nextVisitor,
    persister,
    buster: BUSTER,
  })
  return nextVisitor
}

describe('createAsyncStoragePersister pending throttled write', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: SYSTEM_TIME })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not hydrate a cache removed while a follow-up save is waiting out the default throttle', async () => {
    const storage = createMemoryStorage()
    const persister = createAsyncStoragePersister({ storage })
    const signedIn = createClient()
    const unsubscribe = persistQueryClientSubscribe({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })

    signedIn.setQueryData(['session'], { viewer: 'first' })
    await vi.waitFor(() => {
      expect(storage.snapshot()).not.toBeNull()
    })

    signedIn.setQueryData(['session'], { viewer: 'previous-user' })
    unsubscribe()
    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(1000)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.snapshot()).toBeNull()

    const nextSession = createClient()
    nextSession.setQueryData(['session'], { viewer: 'next-user' })
    const saved = persistQueryClientSave({
      queryClient: nextSession,
      persister,
      buster: BUSTER,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await saved
    const restoredNext = await restoreVisitor(persister)
    expect(restoredNext.getQueryData(['session'])).toEqual({
      viewer: 'next-user',
    })
  })

  it('does not publish a save that is awaiting serialize when removeClient runs', async () => {
    const storage = createMemoryStorage()
    const started = deferred()
    const release = deferred()
    const persister = createAsyncStoragePersister({
      storage,
      serialize: async (client) => {
        started.resolve()
        await release.promise
        return JSON.stringify(client)
      },
    })
    const signedIn = createClient()
    signedIn.setQueryData(['session'], { viewer: 'previous-user' })

    const pending = persister.persistClient(persistedClient(signedIn))
    await started.promise
    await persister.removeClient()
    release.resolve()
    await pending

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.snapshot()).toBeNull()
  })

  it('does not let a retry after a failed in-flight write put the removed cache back', async () => {
    const storage = createMemoryStorage()
    const started = deferred()
    const release = deferred()
    let attempts = 0
    const persister = createAsyncStoragePersister({
      storage: {
        getItem: (key) => storage.getItem(key),
        removeItem: (key) => storage.removeItem(key),
        setItem: async (key, value) => {
          attempts++
          if (attempts === 1) {
            started.resolve()
            await release.promise
            throw new Error('quota')
          }
          storage.setItem(key, value)
        },
      },
      retry: ({ persistedClient: client }) => client,
    })
    const signedIn = createClient()
    signedIn.setQueryData(['session'], { viewer: 'previous-user' })

    const pending = persister.persistClient(persistedClient(signedIn))
    await started.promise
    await persister.removeClient()
    release.resolve()
    await pending

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.snapshot()).toBeNull()
    expect(attempts).toBe(1)
  })
})
