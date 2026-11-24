import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'
import type { QueryObserverResult } from '@tanstack/query-core'
import type { AsyncStorage } from '../createPersister'

const BUSTER = 'build-1'
const MAX_AGE = 1000 * 60 * 60 * 24
const YEAR_MS = 1000 * 60 * 60 * 24 * 365
const QUERY_KEY = ['account'] as const

const SERVER_PERMISSIONS = { permissions: ['read'] }
const FRESH_PERMISSIONS = { permissions: ['read', 'write'] }
const ATTACK_PERMISSIONS = { permissions: ['admin'] }
const SWAPPED_ATTACK_PERMISSIONS = { permissions: ['owner'] }

type PermissionData = { permissions: Array<string> }

interface StringStorage extends AsyncStorage<string> {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
  entries: () => Promise<Array<[string, string]>>
}

function createStringStorage(): StringStorage {
  const records = new Map<string, string>()
  return {
    getItem: (key) => Promise.resolve(records.get(key) ?? null),
    setItem: (key, value) => {
      records.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key) => {
      records.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(records.entries())),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedQuery(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.state)) {
    throw new Error('persisted query is missing state')
  }
  return value
}

function futureTime(): number {
  return Date.now() + YEAR_MS
}

const INFINITY_TOKEN = '__INFINITY_TOKEN__'

/**
 * JSON.stringify cannot represent Infinity. A storage editor can still write
 * the token 1e309, and JSON.parse yields Infinity for that token.
 */
function encodeStorageRecord(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested: unknown) =>
    nested === Number.POSITIVE_INFINITY ? INFINITY_TOKEN : nested,
  )
  return encoded.replaceAll(`"${INFINITY_TOKEN}"`, '1e309')
}

function plantField(
  serialized: string,
  field: 'dataUpdatedAt' | 'timestamp',
  planted: unknown,
): string {
  const parsed: unknown = JSON.parse(serialized)
  if (!isRecord(parsed)) {
    throw new Error('persisted record is not an object')
  }

  if (field === 'timestamp') {
    parsed.timestamp = planted
  } else {
    const query = storedQuery(parsed)
    const state = query.state
    if (!isRecord(state)) {
      throw new Error('persisted query is missing state')
    }
    state.data = ATTACK_PERMISSIONS
    state.dataUpdatedAt = planted
  }

  return encodeStorageRecord(parsed)
}

function plantQuery(serialized: string, dataUpdatedAt: unknown): string {
  return plantField(serialized, 'dataUpdatedAt', dataUpdatedAt)
}

async function settle(): Promise<void> {
  for (let step = 0; step < 8; step++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

async function seedPersistedQuery(storage: StringStorage): Promise<string> {
  const client = new QueryClient()
  client.mount()
  const persister = experimental_createQueryPersister({
    storage,
    buster: BUSTER,
    maxAge: MAX_AGE,
  })
  const queryFn = vi.fn(() => Promise.resolve(SERVER_PERMISSIONS))
  const observer = new QueryObserver(client, {
    queryKey: QUERY_KEY,
    queryFn,
    persister: persister.persisterFn,
  })
  const unsubscribe = observer.subscribe(() => undefined)
  await settle()
  expect(queryFn).toHaveBeenCalledTimes(1)

  unsubscribe()
  client.clear()
  client.unmount()

  const entries = await storage.entries()
  expect(entries).toHaveLength(1)
  const stored = entries[0]
  if (!stored) {
    throw new Error('expected one persisted query')
  }
  const parsed = storedQuery(JSON.parse(stored[1]))
  expect(parsed.buster).toBe(BUSTER)
  return stored[0]
}

function watchQuery(
  client: QueryClient,
  storage: StringStorage,
  queryFn: () => Promise<PermissionData>,
) {
  const persister = experimental_createQueryPersister({
    storage,
    buster: BUSTER,
    maxAge: MAX_AGE,
  })
  const seen: Array<PermissionData | undefined> = []
  const observer = new QueryObserver(client, {
    queryKey: QUERY_KEY,
    queryFn,
    persister: persister.persisterFn,
  })
  const unsubscribe = observer.subscribe(
    (result: QueryObserverResult<PermissionData>) => {
      seen.push(result.data)
    },
  )
  return { observer, seen, unsubscribe }
}

describe('persisted timestamps from storage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('per-query persister', () => {
    async function visitTamperedQuery(dataUpdatedAt: unknown): Promise<{
      seen: Array<PermissionData | undefined>
      data: PermissionData | undefined
      dataUpdatedAt: number
      isStale: boolean
      queryFn: ReturnType<typeof vi.fn<() => Promise<PermissionData>>>
      stored: string | null
    }> {
      const storage = createStringStorage()
      const storageKey = await seedPersistedQuery(storage)
      const original = await storage.getItem(storageKey)
      if (original == null) {
        throw new Error('expected the seeded record')
      }
      const planted = plantQuery(original, dataUpdatedAt)
      const plantedQuery = storedQuery(JSON.parse(planted))
      expect(plantedQuery.buster).toBe(BUSTER)
      expect(plantedQuery.state).toMatchObject({ data: ATTACK_PERMISSIONS })
      await storage.setItem(storageKey, planted)

      const client = new QueryClient()
      client.mount()
      const queryFn = vi.fn(() => Promise.resolve(FRESH_PERMISSIONS))
      const watched = watchQuery(client, storage, queryFn)
      await settle()

      const result = watched.observer.getCurrentResult()
      watched.unsubscribe()
      client.clear()
      client.unmount()

      return {
        seen: watched.seen,
        data: result.data,
        dataUpdatedAt: result.dataUpdatedAt,
        isStale: result.isStale,
        queryFn,
        stored: await storage.getItem(storageKey),
      }
    }

    it.each([
      ['a future number', () => futureTime()],
      ['a future numeric string', () => String(futureTime())],
      ['Infinity', () => Number.POSITIVE_INFINITY],
      ['a non-numeric string', () => 'not-a-time'],
      ['an object', () => ({ forged: true })],
    ])(
      'does not restore a query whose dataUpdatedAt is %s',
      async (_label, plant) => {
        const visit = await visitTamperedQuery(plant())

        expect(visit.data).toEqual(FRESH_PERMISSIONS)
        expect(visit.queryFn).toHaveBeenCalledTimes(1)
        expect(visit.seen).not.toContainEqual(ATTACK_PERMISSIONS)
        expect(visit.isStale).toBe(true)
        expect(Number.isFinite(visit.dataUpdatedAt)).toBe(true)
        expect(visit.dataUpdatedAt).toBeLessThanOrEqual(Date.now())
        expect(visit.stored ?? '').not.toContain('"admin"')
      },
    )

    it('does not accept a second storage read that swaps in another future timestamp', async () => {
      const storage = createStringStorage()
      const storageKey = await seedPersistedQuery(storage)
      const original = await storage.getItem(storageKey)
      if (original == null) {
        throw new Error('expected the seeded record')
      }
      const first = plantQuery(original, futureTime())
      const second = plantQuery(original, futureTime()).replace(
        '"admin"',
        '"owner"',
      )
      let reads = 0
      const swapping: StringStorage = {
        getItem: (key) => {
          if (key !== storageKey) {
            return storage.getItem(key)
          }
          reads += 1
          return Promise.resolve(reads === 1 ? first : second)
        },
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => storage.removeItem(key),
        entries: () => storage.entries(),
      }

      const client = new QueryClient()
      client.mount()
      const queryFn = vi.fn(() => Promise.resolve(FRESH_PERMISSIONS))
      const watched = watchQuery(client, swapping, queryFn)
      await settle()

      expect(watched.observer.getCurrentResult().data).toEqual(
        FRESH_PERMISSIONS,
      )
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(watched.seen).not.toContainEqual(ATTACK_PERMISSIONS)
      expect(watched.seen).not.toContainEqual(SWAPPED_ATTACK_PERMISSIONS)
      expect(watched.observer.getCurrentResult().isStale).toBe(true)

      watched.unsubscribe()
      client.clear()
      client.unmount()
    })

    it('still restores a query whose dataUpdatedAt is within maxAge', async () => {
      const storage = createStringStorage()
      const storageKey = await seedPersistedQuery(storage)
      const original = await storage.getItem(storageKey)
      if (original == null) {
        throw new Error('expected the seeded record')
      }
      const parsed = storedQuery(JSON.parse(original))
      const state = parsed.state
      if (!isRecord(state)) {
        throw new Error('persisted query is missing state')
      }
      state.dataUpdatedAt = Date.now() - 1000
      await storage.setItem(storageKey, JSON.stringify(parsed))

      const client = new QueryClient()
      client.mount()
      const queryFn = vi.fn(() => Promise.resolve(FRESH_PERMISSIONS))
      const watched = watchQuery(client, storage, queryFn)
      await settle()

      expect(watched.seen).toContainEqual(SERVER_PERMISSIONS)
      expect(queryFn).toHaveBeenCalledTimes(1)
      expect(watched.observer.getCurrentResult().data).toEqual(
        FRESH_PERMISSIONS,
      )

      watched.unsubscribe()
      client.clear()
      client.unmount()
    })

    it.each([
      ['a future number', () => futureTime()],
      ['a future numeric string', () => String(futureTime())],
      ['Infinity', () => Number.POSITIVE_INFINITY],
      ['a non-numeric string', () => 'not-a-time'],
      ['an object', () => ({ forged: true })],
    ])(
      'restoreQueries does not hydrate a query whose dataUpdatedAt is %s',
      async (_label, plant) => {
        const storage = createStringStorage()
        const storageKey = await seedPersistedQuery(storage)
        const original = await storage.getItem(storageKey)
        if (original == null) {
          throw new Error('expected the seeded record')
        }
        await storage.setItem(storageKey, plantQuery(original, plant()))

        const client = new QueryClient()
        client.mount()
        const persister = experimental_createQueryPersister({
          storage,
          buster: BUSTER,
          maxAge: MAX_AGE,
        })
        await persister.restoreQueries(client)

        expect(client.getQueryData(QUERY_KEY)).toBeUndefined()
        expect(await storage.getItem(storageKey)).toBeNull()

        const queryFn = vi.fn(() => Promise.resolve(FRESH_PERMISSIONS))
        const seen: Array<PermissionData | undefined> = []
        const observer = new QueryObserver(client, {
          queryKey: QUERY_KEY,
          queryFn,
        })
        const unsubscribe = observer.subscribe(
          (result: QueryObserverResult<PermissionData>) => {
            seen.push(result.data)
          },
        )
        await settle()

        expect(queryFn).toHaveBeenCalledTimes(1)
        expect(seen).not.toContainEqual(ATTACK_PERMISSIONS)
        expect(observer.getCurrentResult().data).toEqual(FRESH_PERMISSIONS)
        expect(observer.getCurrentResult().isStale).toBe(true)

        unsubscribe()
        client.clear()
        client.unmount()
      },
    )

    it.each([
      ['a future number', () => futureTime()],
      ['a future numeric string', () => String(futureTime())],
      ['Infinity', () => Number.POSITIVE_INFINITY],
      ['a non-numeric string', () => 'not-a-time'],
      ['an object', () => ({ forged: true })],
    ])(
      'persisterGc deletes a query whose dataUpdatedAt is %s',
      async (_label, plant) => {
        const storage = createStringStorage()
        const storageKey = await seedPersistedQuery(storage)
        const original = await storage.getItem(storageKey)
        if (original == null) {
          throw new Error('expected the seeded record')
        }
        await storage.setItem(storageKey, plantQuery(original, plant()))

        const persister = experimental_createQueryPersister({
          storage,
          buster: BUSTER,
          maxAge: MAX_AGE,
        })
        await persister.persisterGc()

        expect(await storage.getItem(storageKey)).toBeNull()
      },
    )

    it('persisterGc keeps a query whose dataUpdatedAt is within maxAge', async () => {
      const storage = createStringStorage()
      const storageKey = await seedPersistedQuery(storage)
      const original = await storage.getItem(storageKey)
      if (original == null) {
        throw new Error('expected the seeded record')
      }
      const parsed = storedQuery(JSON.parse(original))
      const state = parsed.state
      if (!isRecord(state)) {
        throw new Error('persisted query is missing state')
      }
      state.dataUpdatedAt = Date.now() - 1000
      await storage.setItem(storageKey, JSON.stringify(parsed))

      const persister = experimental_createQueryPersister({
        storage,
        buster: BUSTER,
        maxAge: MAX_AGE,
      })
      await persister.persisterGc()

      const kept = await storage.getItem(storageKey)
      expect(kept).not.toBeNull()
      expect(storedQuery(JSON.parse(kept ?? '')).state).toMatchObject({
        data: SERVER_PERMISSIONS,
      })
    })
  })
})
