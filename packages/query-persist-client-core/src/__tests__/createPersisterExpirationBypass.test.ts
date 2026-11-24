import { describe, expect, it, vi } from 'vitest'
import { Query, QueryClient, hashKey } from '@tanstack/query-core'
import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
} from '../createPersister'
import type { QueryFunctionContext, QueryKey } from '@tanstack/query-core'

const QUERY_KEY: QueryKey = ['persisted-profile']
const MINUTE = 60 * 1000
const YEAR = 365 * 24 * 60 * 60 * 1000

function attackCases() {
  const now = Date.now()
  return [
    {
      name: 'dataUpdatedAt one minute ahead of the clock',
      dataUpdatedAt: now + MINUTE,
      data: 'forged-soon',
    },
    {
      name: 'dataUpdatedAt one year ahead of the clock',
      dataUpdatedAt: now + YEAR,
      data: 'forged-future',
    },
    {
      name: 'non-numeric word dataUpdatedAt',
      dataUpdatedAt: 'not-a-time',
      data: 'forged-word',
    },
    {
      name: 'numeric string dataUpdatedAt',
      dataUpdatedAt: String(now + YEAR),
      data: 'forged-numeric-string',
    },
    {
      name: 'object dataUpdatedAt',
      dataUpdatedAt: { writtenAt: now + MINUTE },
      data: 'forged-object',
    },
    {
      name: 'single-element array dataUpdatedAt',
      dataUpdatedAt: [now + MINUTE],
      data: 'forged-array',
    },
  ]
}

function storedQuery(data: string, dataUpdatedAt: unknown, buster = '') {
  return JSON.stringify({
    buster,
    queryHash: hashKey(QUERY_KEY),
    queryKey: QUERY_KEY,
    state: { data, dataUpdatedAt },
  })
}

function createStorage(initial: string, replacement?: string) {
  const storageKey = `${PERSISTER_KEY_PREFIX}-${hashKey(QUERY_KEY)}`
  const items = new Map<string, string>([[storageKey, initial]])
  let swapped = false
  const cacheSizesAtRemove: Array<number> = []
  let queryClient: QueryClient | undefined

  const storage = {
    getItem: (key: string) => {
      const value = items.get(key)
      if (value !== undefined && replacement !== undefined && !swapped) {
        items.set(key, replacement)
        swapped = true
      }
      return Promise.resolve(value)
    },
    setItem: (key: string, value: string) => {
      items.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      if (queryClient) {
        cacheSizesAtRemove.push(queryClient.getQueryCache().getAll().length)
      }
      items.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(items.entries())),
  }

  return {
    storage,
    storageKey,
    items,
    cacheSizesAtRemove,
    bind(client: QueryClient) {
      queryClient = client
    },
  }
}

function setup(stored: string, replacement?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const bag = createStorage(stored, replacement)
  bag.bind(client)
  const queryKey = QUERY_KEY
  const queryHash = hashKey(queryKey)
  const context = {
    meta: { foo: 'bar' },
    client,
    queryKey,
    // @ts-expect-error signal is unused by the persister
    signal: undefined as AbortSignal,
  } satisfies QueryFunctionContext
  const persister = experimental_createQueryPersister({ storage: bag.storage })
  const query = new Query({ client, queryHash, queryKey })
  return { ...bag, client, context, persister, query, queryHash, queryKey }
}

function expectStorageRejected(result: ReturnType<typeof setup>) {
  expect(result.items.has(result.storageKey)).toBe(false)
  expect(result.client.getQueryCache().getAll()).toHaveLength(0)
  expect(result.cacheSizesAtRemove.length).toBeGreaterThan(0)
  expect(result.cacheSizesAtRemove.every((size) => size === 0)).toBe(true)
}

describe('experimental_createQueryPersister expiration bypass', () => {
  it.each(attackCases())(
    'retrieveQuery does not return a stored query with a $name',
    async ({ dataUpdatedAt, data }) => {
      const result = setup(storedQuery(data, dataUpdatedAt))
      await expect(
        result.persister.retrieveQuery(result.queryHash),
      ).resolves.toBeUndefined()
      expectStorageRejected(result)

      await expect(
        result.persister.retrieveQuery(result.queryHash),
      ).resolves.toBeUndefined()
    },
  )

  it.each(attackCases())(
    'persisterFn fetches instead of restoring a stored query with a $name',
    async ({ dataUpdatedAt, data }) => {
      const result = setup(storedQuery(data, dataUpdatedAt))
      const queryFn = vi.fn(() => Promise.resolve('from-network'))
      result.query.fetch = vi.fn()

      await expect(
        result.persister.persisterFn(queryFn, result.context, result.query),
      ).resolves.toBe('from-network')
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(queryFn).toHaveBeenCalledOnce()
      expect(result.client.getQueryData(QUERY_KEY)).not.toBe(data)
      const stored = result.items.get(result.storageKey)
      expect(stored ?? '').not.toContain(data)
      expect(result.cacheSizesAtRemove.length).toBeGreaterThan(0)
      expect(result.cacheSizesAtRemove.every((size) => size === 0)).toBe(true)
    },
  )

  it.each(attackCases())(
    'restoreQueries does not copy a stored query with a $name into the client',
    async ({ dataUpdatedAt, data }) => {
      const result = setup(storedQuery(data, dataUpdatedAt))
      await result.persister.restoreQueries(result.client)
      expect(result.client.getQueryData(QUERY_KEY)).toBeUndefined()
      expectStorageRejected(result)
    },
  )

  it.each(attackCases())(
    'persisterGc deletes a stored query with a $name',
    async ({ dataUpdatedAt, data }) => {
      const result = setup(storedQuery(data, dataUpdatedAt))
      await result.persister.persisterGc()
      expect(result.items.has(result.storageKey)).toBe(false)
    },
  )

  it('does not restore a query loaded again between the age check and use', async () => {
    const first = storedQuery('forged-first-read', Date.now() + MINUTE)
    const second = storedQuery('forged-second-read', 'not-a-time')
    const result = setup(first, second)

    await expect(
      result.persister.retrieveQuery(result.queryHash),
    ).resolves.toBeUndefined()
    expectStorageRejected(result)
    const values = result.client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
    expect(values).not.toContain('forged-first-read')
    expect(values).not.toContain('forged-second-read')
  })

  it('still restores a query whose dataUpdatedAt is within maxAge', async () => {
    const result = setup(storedQuery('saved-profile', Date.now()))
    await expect(
      result.persister.retrieveQuery(result.queryHash),
    ).resolves.toBe('saved-profile')
    expect(result.items.has(result.storageKey)).toBe(true)
    expect(result.cacheSizesAtRemove).toEqual([])
  })
})
