import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type { QueryObserverResult } from '@tanstack/query-core'

const BUSTER = 'build-1'
const MAX_AGE = 1000 * 60 * 60 * 24
const YEAR_MS = 1000 * 60 * 60 * 24 * 365
const QUERY_KEY = ['account'] as const
const CLIENT_STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const INFINITY_TOKEN = '__INFINITY_TOKEN__'

const SERVER_PERMISSIONS = { permissions: ['read'] }
const FRESH_PERMISSIONS = { permissions: ['read', 'write'] }
const ATTACK_PERMISSIONS = { permissions: ['admin'] }
const SWAPPED_ATTACK_PERMISSIONS = { permissions: ['owner'] }

type PermissionData = { permissions: Array<string> }

interface StringStorage {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
  removeItem: (key: string) => Promise<void>
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
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function futureTime(): number {
  return Date.now() + YEAR_MS
}

function encodeStorageRecord(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested: unknown) =>
    nested === Number.POSITIVE_INFINITY ? INFINITY_TOKEN : nested,
  )
  return encoded.replaceAll(`"${INFINITY_TOKEN}"`, '1e309')
}

function plantClient(
  serialized: string,
  timestamp: unknown,
  dataUpdatedAt: unknown,
  data: PermissionData = ATTACK_PERMISSIONS,
): string {
  const parsed: unknown = JSON.parse(serialized)
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.clientState) ||
    !Array.isArray(parsed.clientState.queries)
  ) {
    throw new Error('persisted client is missing queries')
  }
  parsed.timestamp = timestamp
  const query: unknown = parsed.clientState.queries[0]
  if (!isRecord(query) || !isRecord(query.state)) {
    throw new Error('persisted client query is missing state')
  }
  query.state.data = data
  query.state.dataUpdatedAt = dataUpdatedAt
  const planted = encodeStorageRecord(parsed)
  const checked: unknown = JSON.parse(planted)
  if (!isRecord(checked) || checked.buster !== BUSTER) {
    throw new Error('planting changed the cache buster')
  }
  return planted
}

async function settle(): Promise<void> {
  for (let step = 0; step < 8; step++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('async storage client timestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function seedClient(storage: StringStorage): Promise<void> {
    const client = new QueryClient()
    client.mount()
    client.setQueryData(QUERY_KEY, SERVER_PERMISSIONS)
    const persister = createAsyncStoragePersister({
      storage,
      key: CLIENT_STORAGE_KEY,
      throttleTime: 0,
    })
    await persistQueryClientSave({
      queryClient: client,
      persister,
      buster: BUSTER,
    })
    client.clear()
    client.unmount()
    expect(await storage.getItem(CLIENT_STORAGE_KEY)).not.toBeNull()
  }

  async function restoreAndWatch(storage: StringStorage): Promise<{
    seen: Array<PermissionData | undefined>
    data: PermissionData | undefined
    isStale: boolean
    dataUpdatedAt: number
    queryFn: ReturnType<typeof vi.fn<() => Promise<PermissionData>>>
    stored: string | null
  }> {
    const client = new QueryClient()
    client.mount()
    const persister = createAsyncStoragePersister({
      storage,
      key: CLIENT_STORAGE_KEY,
      throttleTime: 0,
    })
    await persistQueryClientRestore({
      queryClient: client,
      persister,
      buster: BUSTER,
      maxAge: MAX_AGE,
    })

    const seen: Array<PermissionData | undefined> = []
    const queryFn = vi.fn(() => Promise.resolve(FRESH_PERMISSIONS))
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
    const result = observer.getCurrentResult()
    unsubscribe()
    client.clear()
    client.unmount()

    return {
      seen,
      data: result.data,
      isStale: result.isStale,
      dataUpdatedAt: result.dataUpdatedAt,
      queryFn,
      stored: await storage.getItem(CLIENT_STORAGE_KEY),
    }
  }

  it.each([
    ['a future number', () => futureTime()],
    ['a future numeric string', () => String(futureTime())],
    ['Infinity', () => Number.POSITIVE_INFINITY],
    ['a non-numeric string', () => 'not-a-time'],
    ['an object', () => ({ forged: true })],
  ])(
    'does not hydrate a client whose timestamp is %s',
    async (_label, plant) => {
      const storage = createStringStorage()
      await seedClient(storage)
      const original = await storage.getItem(CLIENT_STORAGE_KEY)
      if (original == null) {
        throw new Error('expected the seeded client')
      }
      await storage.setItem(
        CLIENT_STORAGE_KEY,
        plantClient(original, plant(), futureTime()),
      )

      const visit = await restoreAndWatch(storage)

      expect(visit.data).toEqual(FRESH_PERMISSIONS)
      expect(visit.queryFn).toHaveBeenCalledTimes(1)
      expect(visit.seen).not.toContainEqual(ATTACK_PERMISSIONS)
      expect(visit.isStale).toBe(true)
      expect(Number.isFinite(visit.dataUpdatedAt)).toBe(true)
      expect(visit.dataUpdatedAt).toBeLessThanOrEqual(Date.now())
      expect(visit.stored ?? '').not.toContain('"admin"')
    },
  )

  it('does not keep a future dataUpdatedAt when the client timestamp is within maxAge', async () => {
    const storage = createStringStorage()
    await seedClient(storage)
    const original = await storage.getItem(CLIENT_STORAGE_KEY)
    if (original == null) {
      throw new Error('expected the seeded client')
    }
    await storage.setItem(
      CLIENT_STORAGE_KEY,
      plantClient(original, Date.now() - 1000, futureTime()),
    )

    const visit = await restoreAndWatch(storage)

    expect(visit.data).toEqual(FRESH_PERMISSIONS)
    expect(visit.queryFn).toHaveBeenCalledTimes(1)
    expect(visit.seen).not.toContainEqual(ATTACK_PERMISSIONS)
    expect(visit.isStale).toBe(true)
    expect(visit.dataUpdatedAt).toBeLessThanOrEqual(Date.now())
  })

  it('does not accept a second storage read that swaps in another future client', async () => {
    const storage = createStringStorage()
    await seedClient(storage)
    const original = await storage.getItem(CLIENT_STORAGE_KEY)
    if (original == null) {
      throw new Error('expected the seeded client')
    }
    const first = plantClient(original, futureTime(), futureTime())
    const second = plantClient(
      original,
      futureTime(),
      futureTime(),
      SWAPPED_ATTACK_PERMISSIONS,
    )
    let reads = 0
    const swapping: StringStorage = {
      getItem: (key) => {
        if (key !== CLIENT_STORAGE_KEY) {
          return storage.getItem(key)
        }
        reads += 1
        return Promise.resolve(reads === 1 ? first : second)
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    }

    const visit = await restoreAndWatch(swapping)

    expect(visit.data).toEqual(FRESH_PERMISSIONS)
    expect(visit.queryFn).toHaveBeenCalledTimes(1)
    expect(visit.seen).not.toContainEqual(ATTACK_PERMISSIONS)
    expect(visit.seen).not.toContainEqual(SWAPPED_ATTACK_PERMISSIONS)
    expect(visit.isStale).toBe(true)
  })

  it('still hydrates a client whose timestamp is within maxAge', async () => {
    const storage = createStringStorage()
    await seedClient(storage)
    const client = new QueryClient()
    client.mount()
    const persister = createAsyncStoragePersister({
      storage,
      key: CLIENT_STORAGE_KEY,
      throttleTime: 0,
    })
    await persistQueryClientRestore({
      queryClient: client,
      persister,
      buster: BUSTER,
      maxAge: MAX_AGE,
    })

    expect(client.getQueryData(QUERY_KEY)).toEqual(SERVER_PERMISSIONS)
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

    expect(seen).toContainEqual(SERVER_PERMISSIONS)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(FRESH_PERMISSIONS)

    unsubscribe()
    client.clear()
    client.unmount()
  })
})
