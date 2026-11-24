import { describe, expect, it } from 'vitest'
import { QueryClient, dehydrate } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const QUERY_KEY = ['persisted-profile']
const MINUTE = 60 * 1000
const YEAR = 365 * 24 * 60 * 60 * 1000

function attackCases() {
  const now = Date.now()
  return [
    {
      name: 'timestamp one minute ahead of the clock',
      timestamp: now + MINUTE,
      data: 'forged-soon',
    },
    {
      name: 'timestamp one year ahead of the clock',
      timestamp: now + YEAR,
      data: 'forged-future',
    },
    {
      name: 'non-numeric word timestamp',
      timestamp: 'not-a-time',
      data: 'forged-word',
    },
    {
      name: 'numeric string timestamp',
      timestamp: String(now + YEAR),
      data: 'forged-numeric-string',
    },
    {
      name: 'object timestamp',
      timestamp: { writtenAt: now + MINUTE },
      data: 'forged-object',
    },
    {
      name: 'single-element array timestamp',
      timestamp: [now + MINUTE],
      data: 'forged-array',
    },
  ]
}

function persistedRecord(data: string, timestamp: unknown, buster = '') {
  const source = new QueryClient()
  source.setQueryData(QUERY_KEY, data)
  return JSON.stringify({
    buster,
    timestamp,
    clientState: dehydrate(source),
  })
}

function webStorage(initial: string, replacement?: string) {
  const items = new Map<string, string>([[STORAGE_KEY, initial]])
  let swapped = false
  const cacheSizesAtRemove: Array<number> = []
  let queryClient: QueryClient | undefined

  return {
    items,
    cacheSizesAtRemove,
    bind(client: QueryClient) {
      queryClient = client
    },
    storage: {
      getItem: (key: string) => {
        const value = items.get(key)
        if (value !== undefined && replacement !== undefined && !swapped) {
          items.set(key, replacement)
          swapped = true
        }
        return Promise.resolve(value ?? null)
      },
      setItem: (key: string, value: string) => {
        items.set(key, value)
        return Promise.resolve()
      },
      removeItem: (key: string) => {
        if (queryClient) {
          cacheSizesAtRemove.push(queryClient.getQueryCache().getAll().length)
          cacheSizesAtRemove.push(
            queryClient.getMutationCache().getAll().length,
          )
        }
        items.delete(key)
      },
    },
  }
}

async function restoreStored(stored: string, replacement?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const bag = webStorage(stored, replacement)
  bag.bind(queryClient)
  const persister = createAsyncStoragePersister({ storage: bag.storage })

  await persistQueryClientRestore({ queryClient, persister })
  await persistQueryClientRestore({ queryClient, persister })

  return { queryClient, ...bag }
}

describe('createAsyncStoragePersister restore expiration', () => {
  it.each(attackCases())(
    'does not hydrate a web storage snapshot with a $name',
    async ({ timestamp, data }) => {
      const result = await restoreStored(persistedRecord(data, timestamp))
      expect(result.queryClient.getQueryCache().getAll()).toHaveLength(0)
      expect(result.queryClient.getMutationCache().getAll()).toHaveLength(0)
      expect(result.items.has(STORAGE_KEY)).toBe(false)
      expect(result.cacheSizesAtRemove.length).toBeGreaterThan(0)
      expect(result.cacheSizesAtRemove.every((size) => size === 0)).toBe(true)
    },
  )

  it('does not hydrate a snapshot read again from storage between the age check and hydrate', async () => {
    const result = await restoreStored(
      persistedRecord('forged-first-read', Date.now() + MINUTE),
      persistedRecord('forged-second-read', 'not-a-time'),
    )
    const values = result.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
    expect(values).toEqual([])
    expect(values).not.toContain('forged-first-read')
    expect(values).not.toContain('forged-second-read')
    expect(result.items.has(STORAGE_KEY)).toBe(false)
    expect(result.cacheSizesAtRemove.every((size) => size === 0)).toBe(true)
  })

  it('still hydrates a fresh snapshot from web storage', async () => {
    const stored = persistedRecord('saved-profile', Date.now())
    const queryClient = new QueryClient()
    const bag = webStorage(stored)
    const persister = createAsyncStoragePersister({ storage: bag.storage })

    await persistQueryClientRestore({ queryClient, persister })

    expect(queryClient.getQueryData(QUERY_KEY)).toBe('saved-profile')
    expect(bag.items.get(STORAGE_KEY)).toBe(stored)
    expect(bag.cacheSizesAtRemove).toEqual([])
  })
})
