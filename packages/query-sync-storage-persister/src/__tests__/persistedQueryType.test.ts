import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, dehydrate } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'
import type { PersistedClient } from '@tanstack/query-persist-client-core'

const storageKey = 'offline-cache'
const buster = 'app'
const profileKey = ['user', 'profile'] as const
const profile = { id: 'user-1', name: 'ada' }

interface MemoryStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function memoryStorage(): MemoryStorage {
  const items = new Map<string, string>()
  return {
    getItem(key) {
      return items.get(key) ?? null
    },
    setItem(key, value) {
      items.set(key, value)
    },
    removeItem(key) {
      items.delete(key)
    },
  }
}

async function poisonedCache(): Promise<string> {
  const seed = new QueryClient()
  await seed.query({
    queryKey: profileKey,
    queryFn: () => Promise.resolve(profile),
  })
  const persisted: PersistedClient = {
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(seed),
  }
  seed.clear()

  const query = persisted.clientState.queries[0]
  if (!query) {
    throw new Error('expected the ordinary query to be dehydrated')
  }
  query.queryType = 'infinite'
  query.state.data = {
    pages: [{ id: 'forged-1' }, { id: 'forged-2' }],
    pageParams: [0, 1],
  }
  query.state.dataUpdatedAt = 0
  return JSON.stringify(persisted)
}

describe('sync storage persister restores untrusted queryType', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    for (const client of clients) {
      client.clear()
    }
    clients.length = 0
  })

  it('fetches an ordinary query on the normal path after sync storage restore', async () => {
    const storage = memoryStorage()
    storage.setItem(storageKey, await poisonedCache())
    const persister = createSyncStoragePersister({
      storage,
      key: storageKey,
      throttleTime: 0,
    })
    const queryClient = new QueryClient()
    clients.push(queryClient)
    await persistQueryClientRestore({ queryClient, persister, buster })

    expect(queryClient.getQueryData(profileKey)).toEqual({
      pages: [{ id: 'forged-1' }, { id: 'forged-2' }],
      pageParams: [0, 1],
    })

    const queryFn = vi.fn((_context: { queryKey: ReadonlyArray<unknown> }) =>
      Promise.resolve(profile),
    )
    const observer = new QueryObserver(queryClient, {
      queryKey: profileKey,
      queryFn,
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    await expect(
      queryClient.query({
        queryKey: profileKey,
        queryFn,
        retry: false,
        staleTime: 0,
      }),
    ).resolves.toEqual(profile)

    expect(queryFn).toHaveBeenCalledTimes(1)
    for (const [context] of queryFn.mock.calls) {
      expect(Object.hasOwn(context as object, 'pageParam')).toBe(false)
    }
    expect(queryClient.getQueryState(profileKey)?.status).toBe('success')
    expect(queryClient.getQueryData(profileKey)).toEqual(profile)
    unsubscribe()
  })
})
