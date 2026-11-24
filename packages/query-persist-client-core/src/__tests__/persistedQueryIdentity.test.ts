import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, hashKey } from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import type { PersistedQuery } from '../createPersister'
import type {
  QueryClient as QueryClientType,
  QueryKey,
} from '@tanstack/query-core'

/**
 * Storage-key identity for the experimental per-query persister.
 *
 * The storage key is the record identity. Filters and restored cache writes
 * have to use a saved query key whose hash is that storage key. A queryHash
 * or queryKey edited inside the JSON must not move a delete onto a different
 * record, spare a record the filter named, or publish data under a query the
 * caller did not restore. A second storage read between the decision and the
 * write or delete has to obey the same rule.
 */

function createMemoryStorage() {
  const map = new Map<string, string>()
  const afterRead: Array<() => void> = []
  const consumeDeferredEdits = () => {
    const pending = afterRead.splice(0, afterRead.length)
    for (const edit of pending) edit()
  }

  return {
    getItem: (key: string) => {
      const value = map.get(key)
      consumeDeferredEdits()
      return Promise.resolve(value)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      map.delete(key)
      return Promise.resolve()
    },
    entries: () => {
      const snapshot = Array.from(map.entries())
      consumeDeferredEdits()
      return Promise.resolve(snapshot)
    },
    afterNextRead(edit: () => void) {
      afterRead.push(edit)
    },
    peek(key: string) {
      return map.get(key)
    },
  }
}

type MemoryStorage = ReturnType<typeof createMemoryStorage>

function storageKeyFor(queryKey: QueryKey) {
  return `${PERSISTER_KEY_PREFIX}-${hashKey(queryKey)}`
}

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

async function persist(
  persister: ReturnType<typeof experimental_createQueryPersister>,
  client: QueryClientType,
  queryKey: QueryKey,
  data: string,
) {
  await client.query({
    queryKey,
    queryFn: () => data,
  })
  await persister.persistQueryByKey(queryKey, client)
  const storageKey = storageKeyFor(queryKey)
  return storageKey
}

async function rewrite(
  storage: MemoryStorage,
  storageKey: string,
  edit: (record: PersistedQuery) => void,
) {
  const raw = storage.peek(storageKey)
  if (raw == null) {
    throw new Error(`missing persisted record ${storageKey}`)
  }
  const record = JSON.parse(raw) as PersistedQuery
  edit(record)
  record.state = {
    ...record.state,
    dataUpdatedAt: Date.now(),
  }
  await storage.setItem(storageKey, JSON.stringify(record))
}

async function readThroughPersister(
  persister: ReturnType<typeof experimental_createQueryPersister>,
  queryKey: QueryKey,
) {
  const client = createClient()
  const queryFn = vi.fn(() => 'network')
  const restored = await client.query({
    queryKey,
    queryFn,
    persister: persister.persisterFn,
    staleTime: 60_000,
  })
  return { restored, queryFnCalls: queryFn.mock.calls.length }
}

async function readFreshCache(client: QueryClientType, queryKey: QueryKey) {
  const screen = screenState(client, queryKey)
  const queryFn = vi.fn(() => 'network')
  const restored = await client.query({
    queryKey,
    queryFn,
    staleTime: 60_000,
  })
  return {
    restored,
    queryFnCalls: queryFn.mock.calls.length,
    screen,
  }
}

function screenState(client: QueryClientType, queryKey: QueryKey) {
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: () => 'network',
    enabled: false,
    staleTime: 60_000,
  })
  const unsubscribe = observer.subscribe(() => undefined)
  const data = observer.getCurrentResult().data
  unsubscribe()
  const query = client.getQueryCache().find({ queryKey, exact: true })
  return {
    data,
    fresh: query?.state.data !== undefined && !query.isStaleByTime(60_000),
  }
}

describe('per-query persister storage identity', () => {
  it('returns an unmodified record for the same query hash on the next session', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const queryKey = ['account', 'alice', 'profile'] as const

    await persist(persister, client, queryKey, 'alice-profile')

    await expect(readThroughPersister(persister, queryKey)).resolves.toEqual({
      restored: 'alice-profile',
      queryFnCalls: 0,
    })
  })

  it('removes an unmodified record for both an exact key and a key prefix', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const exactKey = ['account', 'alice', 'profile'] as const
    const prefixKey = ['account', 'alice', 'settings'] as const
    const exactStorageKey = await persist(
      persister,
      client,
      exactKey,
      'alice-profile',
    )
    const prefixStorageKey = await persist(
      persister,
      client,
      prefixKey,
      'alice-settings',
    )

    await persister.removeQueries({ queryKey: exactKey, exact: true })
    await persister.removeQueries({ queryKey: ['account', 'alice'] })

    expect(storage.peek(exactStorageKey)).toBeUndefined()
    expect(storage.peek(prefixStorageKey)).toBeUndefined()
  })

  it('prefix logout still deletes the account record when the saved query key was replaced, and the next session does not load it', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const accountKey = ['account', 'alice', 'profile'] as const
    const otherKey = ['public', 'notice'] as const
    const accountStorageKey = await persist(
      persister,
      client,
      accountKey,
      'alice-profile',
    )
    const otherStorageKey = await persist(
      persister,
      client,
      otherKey,
      'public-notice',
    )
    const otherRecord = storage.peek(otherStorageKey)

    await rewrite(storage, accountStorageKey, (record) => {
      record.queryKey = ['public', 'unrelated']
      record.queryHash = hashKey(record.queryKey)
    })

    await persister.removeQueries({ queryKey: ['account', 'alice'] })
    const storedAfterRemove = storage.peek(accountStorageKey)
    const nextSession = await readThroughPersister(persister, accountKey)

    expect({
      storedAfterRemove,
      nextSession,
      otherRecord: storage.peek(otherStorageKey),
    }).toEqual({
      storedAfterRemove: undefined,
      nextSession: { restored: 'network', queryFnCalls: 1 },
      otherRecord,
    })
  })

  it('exact logout still deletes the account record when the saved query hash was replaced', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const accountKey = ['account', 'alice', 'profile'] as const
    const accountStorageKey = await persist(
      persister,
      client,
      accountKey,
      'alice-profile',
    )

    await rewrite(storage, accountStorageKey, (record) => {
      record.queryHash = hashKey(['public', 'unrelated'])
    })

    await persister.removeQueries({ queryKey: accountKey, exact: true })
    const storedAfterRemove = storage.peek(accountStorageKey)
    const nextSession = await readThroughPersister(persister, accountKey)

    expect({ storedAfterRemove, nextSession }).toEqual({
      storedAfterRemove: undefined,
      nextSession: { restored: 'network', queryFnCalls: 1 },
    })
  })

  it('exact logout still deletes the account record when the saved query key and hash were both replaced', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const accountKey = ['account', 'alice', 'profile'] as const
    const accountStorageKey = await persist(
      persister,
      client,
      accountKey,
      'alice-profile',
    )

    await rewrite(storage, accountStorageKey, (record) => {
      record.queryKey = ['public', 'unrelated']
      record.queryHash = hashKey(record.queryKey)
    })

    await persister.removeQueries({ queryKey: accountKey, exact: true })
    const storedAfterRemove = storage.peek(accountStorageKey)
    const nextSession = await readThroughPersister(persister, accountKey)

    expect({ storedAfterRemove, nextSession }).toEqual({
      storedAfterRemove: undefined,
      nextSession: { restored: 'network', queryFnCalls: 1 },
    })
  })

  it('exact remove does not delete a different query when only its saved hash equals the filter, including after a later read', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const requestedKey = ['account', 'alice', 'profile'] as const
    const keptKey = ['account', 'bob', 'profile'] as const
    const alsoKeptKey = ['account', 'cara', 'profile'] as const
    const keptStorageKey = await persist(
      persister,
      client,
      keptKey,
      'bob-profile',
    )
    const alsoKeptStorageKey = await persist(
      persister,
      client,
      alsoKeptKey,
      'cara-profile',
    )
    await rewrite(storage, keptStorageKey, (record) => {
      record.queryHash = hashKey(requestedKey)
    })
    const keptRecord = storage.peek(keptStorageKey)
    storage.afterNextRead(() => {
      const current = storage.peek(alsoKeptStorageKey)
      if (current == null) return
      const record = JSON.parse(current) as PersistedQuery
      record.queryHash = hashKey(requestedKey)
      mapSet(storage, alsoKeptStorageKey, JSON.stringify(record))
    })

    await persister.removeQueries({ queryKey: requestedKey, exact: true })

    expect(storage.peek(keptStorageKey)).toBe(keptRecord)
    expect(
      JSON.parse(storage.peek(alsoKeptStorageKey) ?? 'null'),
    ).toMatchObject({
      queryKey: alsoKeptKey,
      state: { data: 'cara-profile' },
    })
  })

  it('prefix remove still deletes the authorized storage key when a later read of that record no longer matches the filter', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const accountKey = ['account', 'alice', 'profile'] as const
    const accountStorageKey = await persist(
      persister,
      client,
      accountKey,
      'alice-profile',
    )

    storage.afterNextRead(() => {
      const current = storage.peek(accountStorageKey)
      if (current == null) return
      const record = JSON.parse(current) as PersistedQuery
      record.queryKey = ['public', 'unrelated']
      record.queryHash = hashKey(record.queryKey)
      mapSet(storage, accountStorageKey, JSON.stringify(record))
    })

    await persister.removeQueries({ queryKey: ['account', 'alice'] })

    expect(storage.peek(accountStorageKey)).toBeUndefined()
  })

  it('exact restore does not publish attacker data under a saved query key the caller did not name, even if a later read names another key', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const requestedKey = ['account', 'alice', 'profile'] as const
    const firstVictimKey = ['account', 'bob', 'profile'] as const
    const secondVictimKey = ['account', 'cara', 'profile'] as const
    const firstStorageKey = await persist(
      persister,
      client,
      firstVictimKey,
      'bob-profile',
    )

    await rewrite(storage, firstStorageKey, (record) => {
      record.queryHash = hashKey(requestedKey)
      record.state.data = 'attacker-chosen-1'
    })
    storage.afterNextRead(() => {
      const current = storage.peek(firstStorageKey)
      if (current == null) return
      const record = JSON.parse(current) as PersistedQuery
      record.queryKey = secondVictimKey
      record.queryHash = hashKey(requestedKey)
      record.state.data = 'attacker-chosen-2'
      mapSet(storage, firstStorageKey, JSON.stringify(record))
    })

    client.clear()
    await persister.restoreQueries(client, {
      queryKey: requestedKey,
      exact: true,
    })

    expect({
      firstVictim: await readFreshCache(client, firstVictimKey),
      secondVictim: await readFreshCache(client, secondVictimKey),
      requested: client.getQueryData(requestedKey),
    }).toEqual({
      firstVictim: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
      secondVictim: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
      requested: undefined,
    })
  })

  it('exact restore ignores a record stored under the requested hash when the saved query key hashes elsewhere', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const requestedKey = ['account', 'alice', 'profile'] as const
    const victimKey = ['account', 'bob', 'profile'] as const
    const requestedStorageKey = await persist(
      persister,
      client,
      requestedKey,
      'alice-profile',
    )

    await rewrite(storage, requestedStorageKey, (record) => {
      record.queryKey = victimKey
      record.queryHash = hashKey(requestedKey)
      record.state.data = 'attacker-chosen'
    })

    client.clear()
    await persister.restoreQueries(client, {
      queryKey: requestedKey,
      exact: true,
    })

    expect({
      victim: await readFreshCache(client, victimKey),
      requested: await readFreshCache(client, requestedKey),
    }).toEqual({
      victim: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
      requested: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
    })
  })

  it('prefix restore does not publish data under a rewritten query key that still matches the prefix, even if a later read names another key', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const sourceKey = ['account', 'alice', 'profile'] as const
    const firstVictimKey = ['account', 'bob', 'profile'] as const
    const secondVictimKey = ['account', 'cara', 'profile'] as const
    const sourceStorageKey = await persist(
      persister,
      client,
      sourceKey,
      'alice-profile',
    )

    await rewrite(storage, sourceStorageKey, (record) => {
      record.queryKey = firstVictimKey
      record.queryHash = hashKey(firstVictimKey)
      record.state.data = 'attacker-chosen-1'
    })
    storage.afterNextRead(() => {
      const current = storage.peek(sourceStorageKey)
      if (current == null) return
      const record = JSON.parse(current) as PersistedQuery
      record.queryKey = secondVictimKey
      record.queryHash = hashKey(secondVictimKey)
      record.state.data = 'attacker-chosen-2'
      mapSet(storage, sourceStorageKey, JSON.stringify(record))
    })

    client.clear()
    await persister.restoreQueries(client, { queryKey: ['account'] })

    expect({
      firstVictim: await readFreshCache(client, firstVictimKey),
      secondVictim: await readFreshCache(client, secondVictimKey),
      source: client.getQueryData(sourceKey),
    }).toEqual({
      firstVictim: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
      secondVictim: {
        restored: 'network',
        queryFnCalls: 1,
        screen: { data: undefined, fresh: false },
      },
      source: undefined,
    })
  })

  it('does not load a payload whose saved query key does not hash to the storage key the next session reads', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = createClient()
    const accountKey = ['account', 'alice', 'profile'] as const
    const accountStorageKey = await persist(
      persister,
      client,
      accountKey,
      'alice-profile',
    )

    await rewrite(storage, accountStorageKey, (record) => {
      record.queryKey = ['public', 'unrelated']
      record.queryHash = hashKey(record.queryKey)
    })

    await expect(readThroughPersister(persister, accountKey)).resolves.toEqual({
      restored: 'network',
      queryFnCalls: 1,
    })
  })
})

function mapSet(storage: MemoryStorage, key: string, value: string) {
  return storage.setItem(key, value)
}
