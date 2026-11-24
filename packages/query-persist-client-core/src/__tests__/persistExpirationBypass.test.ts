import { describe, expect, it } from 'vitest'
import { QueryClient, dehydrate } from '@tanstack/query-core'
import { persistQueryClient, persistQueryClientRestore } from '../persist'
import type { PersistedClient, Persister } from '../persist'

const QUERY_KEY = ['persisted-profile']
const MINUTE = 60 * 1000
const YEAR = 365 * 24 * 60 * 60 * 1000

/**
 * Same steps `createAsyncStoragePersister` / `createSyncStoragePersister`
 * take on restore: read the stored string, and JSON.parse it when present.
 * The storage packages also drive `persistQueryClientRestore` through the
 * real persisters.
 */
function jsonStoragePersister(
  state: { current: string | undefined },
  onRemove: () => void,
  replacement?: string,
): Persister {
  let swapped = false
  return {
    persistClient(client) {
      state.current = JSON.stringify(client)
    },
    restoreClient() {
      const cacheString = state.current
      if (!cacheString) {
        return
      }
      if (replacement !== undefined && !swapped) {
        state.current = replacement
        swapped = true
      }
      return JSON.parse(cacheString) as PersistedClient
    },
    removeClient() {
      onRemove()
      state.current = undefined
    },
  }
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

async function restoreStored(
  stored: string,
  options?: { buster?: string; maxAge?: number; replacement?: string },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const state = { current: stored as string | undefined }
  const cacheSizesAtRemove: Array<number> = []
  const persister = jsonStoragePersister(
    state,
    () => {
      cacheSizesAtRemove.push(queryClient.getQueryCache().getAll().length)
      cacheSizesAtRemove.push(queryClient.getMutationCache().getAll().length)
    },
    options?.replacement,
  )

  await persistQueryClientRestore({
    queryClient,
    persister,
    buster: options?.buster,
    maxAge: options?.maxAge,
  })

  return { queryClient, state, cacheSizesAtRemove, persister }
}

function expectRejected(result: {
  queryClient: QueryClient
  state: { current: string | undefined }
  cacheSizesAtRemove: Array<number>
}) {
  expect(result.queryClient.getQueryCache().getAll()).toHaveLength(0)
  expect(result.queryClient.getMutationCache().getAll()).toHaveLength(0)
  expect(result.state.current).toBeUndefined()
  expect(result.cacheSizesAtRemove.length).toBeGreaterThan(0)
  expect(result.cacheSizesAtRemove.every((size) => size === 0)).toBe(true)
}

describe('persistQueryClientRestore expiration bypass', () => {
  it.each(attackCases())(
    'does not hydrate a persisted client with a $name',
    async ({ timestamp, data }) => {
      const stored = persistedRecord(data, timestamp)
      const first = await restoreStored(stored)
      expectRejected(first)

      await persistQueryClientRestore({
        queryClient: first.queryClient,
        persister: first.persister,
      })
      expect(first.queryClient.getQueryCache().getAll()).toHaveLength(0)
      expect(first.state.current).toBeUndefined()
    },
  )

  it('does not hydrate when a matching buster accompanies a future timestamp', async () => {
    const stored = persistedRecord(
      'forged-buster',
      Date.now() + MINUTE,
      'release-7',
    )
    const result = await restoreStored(stored, { buster: 'release-7' })
    expect(result.queryClient.getQueryData(QUERY_KEY)).toBeUndefined()
    expectRejected(result)
  })

  it('does not hydrate a snapshot loaded again between the age check and hydrate', async () => {
    const first = persistedRecord('forged-first-read', Date.now() + MINUTE)
    const second = persistedRecord('forged-second-read', 'not-a-time')
    const result = await restoreStored(first, { replacement: second })
    expectRejected(result)
    const values = result.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
    expect(values).not.toContain('forged-first-read')
    expect(values).not.toContain('forged-second-read')
  })

  it('still hydrates a finite timestamp that is not ahead of the clock and not older than maxAge', async () => {
    const stored = persistedRecord('saved-profile', Date.now())
    const { queryClient, state, cacheSizesAtRemove } =
      await restoreStored(stored)
    expect(queryClient.getQueryData(QUERY_KEY)).toBe('saved-profile')
    expect(state.current).toBe(stored)
    expect(cacheSizesAtRemove).toEqual([])
  })

  it('still discards a timestamp older than maxAge', async () => {
    const stored = persistedRecord('stale-profile', Date.now() - 5_000)
    const result = await restoreStored(stored, { maxAge: 1_000 })
    expect(result.queryClient.getQueryData(QUERY_KEY)).toBeUndefined()
    expectRejected(result)
  })

  it('still discards a NaN timestamp', async () => {
    const queryClient = new QueryClient()
    let removed = false
    const persister: Persister = {
      persistClient() {
        return undefined
      },
      restoreClient() {
        return {
          buster: '',
          timestamp: Number.NaN,
          clientState: { mutations: [], queries: [] },
        }
      },
      removeClient() {
        removed = true
      },
    }

    await persistQueryClientRestore({ queryClient, persister })

    expect(removed).toBe(true)
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })
})

describe('persistQueryClient expiration bypass', () => {
  it.each(attackCases())(
    'does not hydrate on startup when the persisted client has a $name',
    async ({ timestamp, data }) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      const state = {
        current: persistedRecord(data, timestamp) as string | undefined,
      }
      const cacheSizesAtRemove: Array<number> = []
      const persister = jsonStoragePersister(state, () => {
        cacheSizesAtRemove.push(queryClient.getQueryCache().getAll().length)
      })

      const [unsubscribe, restorePromise] = persistQueryClient({
        queryClient,
        persister,
      })
      await restorePromise
      unsubscribe()

      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
      expect(state.current).toBeUndefined()
      expect(cacheSizesAtRemove).toEqual([0])
    },
  )
})
