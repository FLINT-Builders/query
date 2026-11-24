import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'
import {
  nextProfile,
  previousProfile,
  profileKey,
} from './busterRestoreRace.helper'

function createGatedStorage() {
  const records = new Map<string, string>()
  const pending: Array<() => void> = []
  let gateReads = false

  const wait = async () => {
    if (!gateReads) return
    await new Promise<void>((resolve) => {
      pending.push(resolve)
    })
  }

  return {
    records,
    arm() {
      gateReads = true
    },
    pending: () => pending.length,
    releaseAll() {
      const batch = pending.splice(0, pending.length)
      for (const resolve of batch) resolve()
    },
    storage: {
      getItem: async (key: string) => {
        const snapshot = records.get(key) ?? null
        await wait()
        return snapshot
      },
      setItem: (key: string, value: string) => {
        records.set(key, value)
        return Promise.resolve()
      },
      removeItem: (key: string) => {
        records.delete(key)
        return Promise.resolve()
      },
      entries: async () => {
        const snapshot = [...records.entries()]
        await wait()
        return snapshot
      },
    },
  }
}

async function settle(
  storage: { releaseAll: () => void },
  work: Promise<unknown>,
) {
  const done = work.then(
    () => undefined,
    () => undefined,
  )
  for (let attempt = 0; attempt < 8; attempt++) {
    storage.releaseAll()
    const status = await Promise.race([
      done.then(() => 'done' as const),
      new Promise<'wait'>((resolve) => {
        setTimeout(() => resolve('wait'), 0)
      }),
    ])
    if (status === 'done') {
      await done
      return
    }
  }
  throw new Error('restore did not settle')
}

function storedAccount(records: Map<string, string>) {
  const raw = records.values().next().value
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as {
    buster: string
    state: { data?: { accountId?: string } }
  }
  return parsed
}

async function seedAccounts() {
  const memory = createGatedStorage()
  const previousClient = new QueryClient()
  previousClient.setQueryData(profileKey, previousProfile)
  const previousQuery = previousClient
    .getQueryCache()
    .find({ queryKey: profileKey })
  const nextClient = new QueryClient()
  nextClient.setQueryData(profileKey, nextProfile)
  const nextQuery = nextClient.getQueryCache().find({ queryKey: profileKey })
  if (!previousQuery || !nextQuery) {
    throw new Error('expected profile queries')
  }

  const previousPersister = experimental_createQueryPersister({
    storage: memory.storage,
    buster: 'account-previous',
  })
  const nextPersister = experimental_createQueryPersister({
    storage: memory.storage,
    buster: 'account-next',
  })
  await previousPersister.persistQuery(previousQuery)

  return { memory, previousPersister, nextPersister, nextQuery }
}

describe('per-query persister account buster changes during restore', () => {
  afterEach(() => {
    onlineManager.setOnline(true)
  })

  it('does not let a superseded restoreQueries copy or delete the other account', async () => {
    const { memory, previousPersister, nextPersister, nextQuery } =
      await seedAccounts()
    const queryClient = new QueryClient()
    memory.arm()

    const first = previousPersister.restoreQueries(queryClient)
    const second = nextPersister.restoreQueries(queryClient)
    expect(memory.pending()).toBe(2)
    await nextPersister.persistQuery(nextQuery)
    await settle(memory, Promise.allSettled([first, second]))

    expect(queryClient.getQueryData(profileKey)).toEqual(nextProfile)
    expect(storedAccount(memory.records)?.buster).toBe('account-next')
    expect(storedAccount(memory.records)?.state.data).toEqual(nextProfile)
  })

  it('does not let retrieveQuery delete a cache written during its read', async () => {
    const { memory, nextPersister, nextQuery } = await seedAccounts()
    memory.arm()

    const restored = nextPersister.retrieveQuery(nextQuery.queryHash)
    expect(memory.pending()).toBe(1)
    await nextPersister.persistQuery(nextQuery)
    await settle(memory, restored)

    await expect(restored).resolves.toEqual(nextProfile)
    expect(storedAccount(memory.records)?.buster).toBe('account-next')
    expect(storedAccount(memory.records)?.state.data).toEqual(nextProfile)
  })

  it('does not let persisterGc delete a cache written during its read', async () => {
    const { memory, nextPersister, nextQuery } = await seedAccounts()
    memory.arm()

    const collected = nextPersister.persisterGc()
    expect(memory.pending()).toBe(1)
    await nextPersister.persistQuery(nextQuery)
    await settle(memory, collected)

    expect(storedAccount(memory.records)?.buster).toBe('account-next')
    expect(storedAccount(memory.records)?.state.data).toEqual(nextProfile)
  })
})
