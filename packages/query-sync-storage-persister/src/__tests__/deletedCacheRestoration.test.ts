import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'
import type { Persister } from '@tanstack/query-persist-client-core'

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const queryKey = ['account', 'profile']
const buster = 'app-build'
const throttleTime = 1000
const maxAge = 1000 * 60 * 60 * 24
const previousUser = {
  viewer: 'previous-user',
  profile: 'cached-profile',
}

const clients: Array<QueryClient> = []

function createMemoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem(key: string) {
      return items.get(key) ?? null
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
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: maxAge },
    },
  })
  clients.push(queryClient)
  return queryClient
}

async function restoredProfile(
  persister: Persister,
  restoreBuster: string | undefined = buster,
) {
  const next = createClient()
  await persistQueryClientRestore({
    queryClient: next,
    persister,
    buster: restoreBuster,
    maxAge,
  })
  return next.getQueryData(queryKey)
}

describe('deleted cache restoration through a pending sync throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clients.splice(0).forEach((queryClient) => {
      queryClient.clear()
    })
    vi.useRealTimers()
  })

  it('hydrates the saved client on the next load when nothing removes it', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({
      storage,
      key: STORAGE_KEY,
      throttleTime,
    })
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister, buster })
    await vi.advanceTimersByTimeAsync(throttleTime)

    await expect(restoredProfile(persister)).resolves.toEqual(previousUser)
  })

  it('does not hydrate the previous client when removeClient runs while the throttled save is waiting', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({
      storage,
      key: STORAGE_KEY,
      throttleTime,
    })
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    const pendingSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })
    await pendingSave
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(throttleTime)

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not hydrate the latest subscribed client when removeClient runs before the throttle fires', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({
      storage,
      key: STORAGE_KEY,
      throttleTime,
    })
    const queryClient = createClient()
    const unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister,
      buster,
    })

    queryClient.setQueryData(queryKey, previousUser)
    await vi.advanceTimersByTimeAsync(0)
    queryClient.setQueryData(queryKey, {
      ...previousUser,
      profile: 'updated-while-signed-in',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    unsubscribe()
    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(throttleTime)

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('persists a client saved after the removed throttle has fired', async () => {
    const storage = createMemoryStorage()
    const persister = createSyncStoragePersister({
      storage,
      key: STORAGE_KEY,
      throttleTime,
    })
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister, buster })
    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(throttleTime)

    const nextUser = { viewer: 'next-user', profile: 'fresh-profile' }
    queryClient.setQueryData(queryKey, nextUser)
    await persistQueryClientSave({ queryClient, persister, buster })
    await vi.advanceTimersByTimeAsync(throttleTime)

    await expect(restoredProfile(persister)).resolves.toEqual(nextUser)
  })
})
