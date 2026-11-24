import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import {
  persistQueryClient,
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'

/**
 * Default storage key from createSyncStoragePersister.
 * Kept inline so the test fails if a pending write lands on that key.
 */
const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const BUSTER = 'build-hash'
const SYSTEM_TIME = new Date('2026-06-01T12:00:00Z')

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
  }
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  })
}

async function restoreVisitor(
  persister: ReturnType<typeof createSyncStoragePersister>,
) {
  const nextVisitor = createClient()
  await persistQueryClientRestore({
    queryClient: nextVisitor,
    persister,
    buster: BUSTER,
  })
  return nextVisitor
}

describe('createSyncStoragePersister pending throttled write', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: SYSTEM_TIME })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not hydrate a cache removed while the default one-second throttle is pending', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({ storage })
    const signedIn = createClient()
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })
    await restored

    signedIn.setQueryData(['session'], { viewer: 'previous-user' })
    unsubscribe()
    persister.removeClient()

    await vi.advanceTimersByTimeAsync(1000)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    const nextSession = createClient()
    nextSession.setQueryData(['session'], { viewer: 'next-user' })
    await persistQueryClientSave({
      queryClient: nextSession,
      persister,
      buster: BUSTER,
    })
    await vi.advanceTimersByTimeAsync(1000)

    const restoredNext = await restoreVisitor(persister)
    expect(restoredNext.getQueryData(['session'])).toEqual({
      viewer: 'next-user',
    })
  })

  it('drops every payload captured before removeClient, including the latest one', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({ storage })
    const signedIn = createClient()

    signedIn.setQueryData(['session'], { viewer: 'first' })
    await persistQueryClientSave({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })

    signedIn.setQueryData(['session'], { viewer: 'previous-user' })
    await persistQueryClientSave({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })

    persister.removeClient()
    await vi.advanceTimersByTimeAsync(1000)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not write a zero-delay throttle that is still queued when removeClient runs', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({
      storage,
      throttleTime: 0,
    })
    const signedIn = createClient()

    signedIn.setQueryData(['session'], { viewer: 'previous-user' })
    await persistQueryClientSave({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })
    persister.removeClient()
    await vi.advanceTimersByTimeAsync(0)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not hydrate a mutation saved by the mutation-cache subscription after removeClient', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({ storage })
    const signedIn = createClient()
    const unsubscribe = persistQueryClientSubscribe({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
      dehydrateOptions: { shouldDehydrateMutation: () => true },
    })

    signedIn.getMutationCache().build(signedIn, {
      mutationKey: ['sign-in'],
      mutationFn: (viewer: string) => Promise.resolve(viewer),
    })
    unsubscribe()
    persister.removeClient()
    await vi.advanceTimersByTimeAsync(1000)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getMutationCache().getAll()).toHaveLength(0)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not let a retry inside the throttled callback write after removeClient', async () => {
    const storage = createMemoryStorage()
    let attempts = 0
    const persister = createSyncStoragePersister({
      storage: {
        getItem: storage.getItem,
        removeItem: storage.removeItem,
        setItem(key: string, value: string) {
          attempts++
          if (attempts === 1) {
            throw new Error('quota')
          }
          storage.setItem(key, value)
        },
      },
      retry: ({ persistedClient }) => persistedClient,
    })
    const signedIn = createClient()
    signedIn.setQueryData(['session'], { viewer: 'previous-user' })

    await persistQueryClientSave({
      queryClient: signedIn,
      persister,
      buster: BUSTER,
    })
    persister.removeClient()
    await vi.advanceTimersByTimeAsync(1000)

    const nextVisitor = await restoreVisitor(persister)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
    expect(attempts).toBe(0)
  })
})
