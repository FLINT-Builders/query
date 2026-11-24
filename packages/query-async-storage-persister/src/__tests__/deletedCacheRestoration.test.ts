import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type { AsyncPersistRetryer } from '../index'
import type {
  AsyncStorage,
  Persister,
} from '@tanstack/query-persist-client-core'

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

function createMemoryStorage(): AsyncStorage<string> & {
  snapshot: () => string | null
} {
  const items = new Map<string, string>()
  return {
    getItem(key: string) {
      return Promise.resolve(items.get(key) ?? null)
    },
    setItem(key: string, value: string) {
      items.set(key, value)
      return Promise.resolve()
    },
    removeItem(key: string) {
      items.delete(key)
      return Promise.resolve()
    },
    snapshot() {
      return items.get(STORAGE_KEY) ?? null
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

function createPersister(
  storage: AsyncStorage<string>,
  retry?: AsyncPersistRetryer,
) {
  return createAsyncStoragePersister({
    storage,
    key: STORAGE_KEY,
    throttleTime,
    retry,
  })
}

async function restoredProfile(persister: Persister, restoreBuster = buster) {
  const next = createClient()
  await persistQueryClientRestore({
    queryClient: next,
    persister,
    buster: restoreBuster,
    maxAge,
  })
  return next.getQueryData(queryKey)
}

describe('deleted cache restoration through a pending throttled write', () => {
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
    const persister = createPersister(storage)
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister, buster })

    await expect(restoredProfile(persister)).resolves.toEqual(previousUser)
  })

  it('does not hydrate the previous client when removeClient runs while the next save is waiting out the throttle', async () => {
    const storage = createMemoryStorage()
    const persister = createPersister(storage)
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister, buster })
    expect(storage.snapshot()).not.toBeNull()

    queryClient.setQueryData(queryKey, {
      ...previousUser,
      profile: 'updated-while-signed-in',
    })
    const pendingSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })

    await persister.removeClient()
    expect(storage.snapshot()).toBeNull()

    await vi.advanceTimersByTimeAsync(throttleTime)
    await pendingSave

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(storage.snapshot()).toBeNull()
  })

  it('does not hydrate the previous client when removal uses the default buster from the offline example', async () => {
    const storage = createMemoryStorage()
    const persister = createAsyncStoragePersister({
      storage,
      throttleTime,
    })
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister })

    const pendingSave = persistQueryClientSave({ queryClient, persister })
    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(throttleTime)
    await pendingSave

    const next = createClient()
    await persistQueryClientRestore({
      queryClient: next,
      persister,
      maxAge,
    })

    expect(next.getQueryData(queryKey)).toBeUndefined()
    expect(storage.snapshot()).toBeNull()
  })

  it('does not hydrate the previous client when unsubscribe and removeClient run during a subscribed save', async () => {
    const storage = createMemoryStorage()
    const persister = createPersister(storage)
    const queryClient = createClient()
    const unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister,
      buster,
    })

    queryClient.setQueryData(queryKey, previousUser)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(throttleTime)
    expect(storage.snapshot()).toContain('previous-user')

    queryClient.setQueryData(queryKey, {
      ...previousUser,
      profile: 'updated-while-signed-in',
    })
    await vi.advanceTimersByTimeAsync(0)

    unsubscribe()
    await persister.removeClient()
    expect(storage.snapshot()).toBeNull()

    await vi.advanceTimersByTimeAsync(throttleTime)

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(storage.snapshot()).toBeNull()
  })

  it('does not write a save that is queued behind an in-flight persist when removeClient runs during that wait', async () => {
    const items = new Map<string, string>()
    let writes = 0
    let releaseFirstWrite: (() => void) | undefined
    const storage: AsyncStorage<string> = {
      getItem(key: string) {
        return Promise.resolve(items.get(key) ?? null)
      },
      setItem(key: string, value: string) {
        writes += 1
        items.set(key, value)
        if (writes === 1) {
          return new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
          })
        }
        return Promise.resolve()
      },
      removeItem(key: string) {
        items.delete(key)
        return Promise.resolve()
      },
    }
    const persister = createPersister(storage)
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    const firstSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })
    queryClient.setQueryData(queryKey, {
      ...previousUser,
      profile: 'queued-behind-in-flight-save',
    })
    const queuedSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(items.get(STORAGE_KEY)).toContain('previous-user')

    await persister.removeClient()
    expect(items.get(STORAGE_KEY)).toBeUndefined()

    if (!releaseFirstWrite) {
      throw new Error('the in-flight persist never reached storage.setItem')
    }
    releaseFirstWrite()
    await firstSave
    await vi.advanceTimersByTimeAsync(throttleTime)
    await queuedSave

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(items.get(STORAGE_KEY)).toBeUndefined()
  })

  it('does not write the client when removeClient runs during an async persist retry', async () => {
    const storage = createMemoryStorage()
    let attempts = 0
    const innerSetItem = storage.setItem.bind(storage)
    storage.setItem = (key: string, value: string) => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(new Error('transient storage failure'))
      }
      return innerSetItem(key, value)
    }

    let releaseRetry: (() => void) | undefined
    const persister = createPersister(storage, ({ persistedClient }) => {
      return new Promise<void>((resolve) => {
        releaseRetry = resolve
      }).then(() => persistedClient)
    })
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    const pendingSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })
    await vi.advanceTimersByTimeAsync(0)
    if (!releaseRetry) {
      throw new Error('persist retry did not start')
    }

    await persister.removeClient()
    releaseRetry()
    await pendingSave

    await expect(restoredProfile(persister)).resolves.toBeUndefined()
    expect(storage.snapshot()).toBeNull()
  })

  it('persists a client saved after the removed save has settled', async () => {
    const storage = createMemoryStorage()
    const persister = createPersister(storage)
    const queryClient = createClient()
    queryClient.setQueryData(queryKey, previousUser)

    await persistQueryClientSave({ queryClient, persister, buster })
    const removedSave = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })
    await persister.removeClient()
    await vi.advanceTimersByTimeAsync(throttleTime)
    await removedSave

    const nextUser = { viewer: 'next-user', profile: 'fresh-profile' }
    queryClient.setQueryData(queryKey, nextUser)
    const followUp = persistQueryClientSave({
      queryClient,
      persister,
      buster,
    })
    await vi.advanceTimersByTimeAsync(throttleTime)
    await followUp

    await expect(restoredProfile(persister)).resolves.toEqual(nextUser)
  })
})
