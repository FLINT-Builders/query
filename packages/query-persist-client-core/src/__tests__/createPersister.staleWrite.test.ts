import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  environmentManager,
  focusManager,
  hashKey,
  isServer,
  onlineManager,
} from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import type { QueryClient as QueryClientType } from '@tanstack/query-core'

/**
 * Spec for the per-query persister writing a removed query's state back to
 * storage. These tests fail while that write still happens.
 */

type StorageSlot = {
  getItem: (key: string) => Promise<string | undefined>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  entries: () => Promise<Array<[string, string]>>
}

type Persister = ReturnType<typeof experimental_createQueryPersister>

function createStorage(): StorageSlot {
  const storage = new Map<string, string>()
  return {
    getItem: (key) => Promise.resolve(storage.get(key)),
    setItem: (key, value) => {
      storage.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key) => {
      storage.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(storage.entries())),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function storageKeyFor(queryKey: ReadonlyArray<unknown>) {
  return `${PERSISTER_KEY_PREFIX}-${hashKey(queryKey)}`
}

async function storedData(
  storage: StorageSlot,
  queryKey: ReadonlyArray<unknown>,
): Promise<unknown> {
  const raw = await storage.getItem(storageKeyFor(queryKey))
  if (raw == null) return undefined
  return JSON.parse(raw).state.data
}

const mountedClients: Array<QueryClientType> = []

function mountClient(
  persister: Persister,
  queries?: Record<string, unknown>,
): QueryClientType {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        persister: persister.persisterFn,
        retry: false,
        gcTime: Infinity,
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        ...queries,
      },
    },
  })
  client.mount()
  mountedClients.push(client)
  return client
}

async function flushPersist() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('per-query persister stale write after logout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // localStorage persistence runs in the browser. The node test runtime
    // otherwise looks like a server and skips refetch intervals.
    environmentManager.setIsServer(() => false)
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  afterEach(() => {
    for (const client of mountedClients) {
      client.clear()
      client.unmount()
    }
    mountedClients.length = 0
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    environmentManager.setIsServer(() => isServer)
    vi.useRealTimers()
  })

  async function seedAndRefetch(options: {
    trigger: 'focus' | 'online' | 'interval' | 'infinite'
    logout: 'clear' | 'removeQueries'
  }) {
    const storage = createStorage()
    const persister = experimental_createQueryPersister({ storage })
    const queryClient = mountClient(
      persister,
      options.trigger === 'interval' ? { refetchInterval: 50 } : undefined,
    )
    const queryKey = ['account']
    let current = deferred<string>()
    let queryFnCalls = 0

    const queryFn = () => {
      queryFnCalls += 1
      // Deliberately ignore the abort signal. Reading it is optional.
      return current.promise
    }

    const observer =
      options.trigger === 'infinite'
        ? new InfiniteQueryObserver(queryClient, {
            queryKey,
            initialPageParam: 0,
            queryFn: () => queryFn().then((name) => ({ name })),
            getNextPageParam: () => undefined,
          })
        : new QueryObserver(queryClient, {
            queryKey,
            queryFn,
          })

    const unsubscribe = observer.subscribe(() => undefined)

    current.resolve('account-a')
    await flushPersist()
    expect(await storedData(storage, queryKey)).toEqual(
      options.trigger === 'infinite'
        ? { pages: [{ name: 'account-a' }], pageParams: [0] }
        : 'account-a',
    )

    current = deferred<string>()
    if (options.trigger === 'focus' || options.trigger === 'infinite') {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      // QueryClient's focus listener resumes mutations before refetching.
      await vi.advanceTimersByTimeAsync(0)
    } else if (options.trigger === 'online') {
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      await vi.advanceTimersByTimeAsync(0)
    } else {
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(queryFnCalls).toBe(2)

    if (options.logout === 'clear') {
      queryClient.clear()
    } else {
      queryClient.removeQueries()
    }
    await persister.removeQueries()
    expect(await storedData(storage, queryKey)).toBeUndefined()

    current.resolve('account-a-inflight')
    await flushPersist()

    return { storage, persister, queryKey, unsubscribe, queryClient }
  }

  it.each(['clear', 'removeQueries'] as const)(
    'does not restore the previous account after a focus refetch is cleaned up with %s',
    async (logout) => {
      const { storage, persister, queryKey, unsubscribe } =
        await seedAndRefetch({
          trigger: 'focus',
          logout,
        })
      unsubscribe()

      expect(await storedData(storage, queryKey)).toBeUndefined()

      const nextClient = mountClient(persister)
      let fetchedForNextAccount = false
      const next = new QueryObserver(nextClient, {
        queryKey,
        queryFn: () => {
          fetchedForNextAccount = true
          return Promise.resolve('account-b')
        },
      })
      const seen: Array<unknown> = []
      const unsubscribeNext = next.subscribe((result) => {
        if (result.data !== undefined) seen.push(result.data)
      })
      await flushPersist()

      expect(seen[0]).toBe('account-b')
      expect(fetchedForNextAccount).toBe(true)
      expect(await storedData(storage, queryKey)).toEqual('account-b')
      unsubscribeNext()
      nextClient.clear()
    },
  )

  it('does not write the previous account back when a polling refetch outlives logout', async () => {
    const { storage, queryKey, unsubscribe, queryClient } =
      await seedAndRefetch({
        trigger: 'interval',
        logout: 'clear',
      })
    unsubscribe()
    queryClient.clear()

    expect(await storedData(storage, queryKey)).toBeUndefined()
  })

  it('does not write the previous account back when a reconnect refetch outlives logout', async () => {
    const { storage, queryKey, unsubscribe, queryClient } =
      await seedAndRefetch({
        trigger: 'online',
        logout: 'clear',
      })
    unsubscribe()
    queryClient.clear()

    expect(await storedData(storage, queryKey)).toBeUndefined()
  })

  it('does not write an infinite query page back when its refetch outlives logout', async () => {
    const { storage, queryKey, unsubscribe, queryClient } =
      await seedAndRefetch({
        trigger: 'infinite',
        logout: 'clear',
      })
    unsubscribe()
    queryClient.clear()

    expect(await storedData(storage, queryKey)).toBeUndefined()
  })

  it('drops a persist that is already serializing when removeQueries runs', async () => {
    const storage = createStorage()
    let queryClient!: QueryClientType
    let persister!: Persister
    let raceArmed = false

    persister = experimental_createQueryPersister({
      storage,
      serialize: async (persistedQuery) => {
        const serialized = JSON.stringify(persistedQuery)
        if (raceArmed) {
          raceArmed = false
          queryClient.clear()
          await persister.removeQueries()
        }
        return serialized
      },
    })
    queryClient = mountClient(persister)
    const queryKey = ['account']
    let current = deferred<string>()
    const observer = new QueryObserver(queryClient, {
      queryKey,
      queryFn: () => current.promise,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    current.resolve('account-a')
    await flushPersist()
    expect(await storedData(storage, queryKey)).toBe('account-a')

    current = deferred<string>()
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    current.resolve('account-a-fresh')
    // The persister schedules the write on a timer so query.state is updated
    // first. Arm the race before that timer runs serialize.
    raceArmed = true
    await flushPersist()

    expect(await storedData(storage, queryKey)).toBeUndefined()
    unsubscribe()
  })

  it('drops persistQueryByKey when removal lands during serialize, before setItem', async () => {
    const storage = createStorage()
    let queryClient!: QueryClientType
    let persister!: Persister

    persister = experimental_createQueryPersister({
      storage,
      serialize: async (persistedQuery) => {
        const serialized = JSON.stringify(persistedQuery)
        queryClient.clear()
        await persister.removeQueries()
        return serialized
      },
    })
    queryClient = mountClient(persister)
    const queryKey = ['account']
    queryClient.setQueryData(queryKey, 'account-a')

    await persister.persistQueryByKey(queryKey, queryClient)

    expect(await storedData(storage, queryKey)).toBeUndefined()
    expect(await storage.entries()).toEqual([])
  })

  it('drops persistQuery when removal lands during serialize, before setItem', async () => {
    const storage = createStorage()
    let queryClient!: QueryClientType
    let persister!: Persister

    persister = experimental_createQueryPersister({
      storage,
      serialize: async (persistedQuery) => {
        const serialized = JSON.stringify(persistedQuery)
        queryClient.clear()
        await persister.removeQueries()
        return serialized
      },
    })
    queryClient = mountClient(persister)
    const queryKey = ['account']
    queryClient.setQueryData(queryKey, 'account-a')
    const query = queryClient.getQueryCache().find({ queryKey })!

    await persister.persistQuery(query)

    expect(await storedData(storage, queryKey)).toBeUndefined()
    expect(await storage.entries()).toEqual([])
  })
})
