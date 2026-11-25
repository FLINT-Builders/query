import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'
import type { QueryKey } from '@tanstack/query-core'
import type { PersistedQuery } from '../createPersister'

interface PendingWrite {
  key: string
  value: string
  settled: boolean
  settle: () => void
}

/**
 * Async storage whose setItem commits only when the returned promise settles.
 * AsyncStorage types setItem as MaybePromise and does not require an earlier
 * call to finish before a later one, so an older write can be settled last.
 */
function createCommitOnSettleStorage() {
  const committed = new Map<string, string>()
  const writes: Array<PendingWrite> = []

  const storage = {
    getItem: (key: string) => committed.get(key) ?? null,
    setItem: (key: string, value: string) =>
      new Promise<void>((resolve) => {
        const write: PendingWrite = {
          key,
          value,
          settled: false,
          settle: () => {
            if (write.settled) return
            write.settled = true
            committed.set(key, value)
            resolve()
          },
        }
        writes.push(write)
      }),
    removeItem: (key: string) => {
      committed.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve([...committed.entries()]),
  }

  return { storage, committed, writes }
}

/**
 * Serializer that snapshots synchronously, then waits. The snapshot is fixed
 * when serialization starts, which is the state a late setItem would store.
 */
function createPausableSerialize() {
  const pending: Array<() => void> = []
  const serialize = (persistedQuery: PersistedQuery) => {
    const snapshot = JSON.stringify(persistedQuery)
    return new Promise<string>((resolve) => {
      pending.push(() => resolve(snapshot))
    })
  }
  return { serialize, pending }
}

function createImmediateStorage() {
  const committed = new Map<string, string>()
  const storage = {
    getItem: (key: string) => committed.get(key) ?? null,
    setItem: (key: string, value: string) => {
      committed.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      committed.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve([...committed.entries()]),
  }
  return { storage, committed }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function accountOf(serialized: string) {
  return JSON.parse(serialized).state.data.account as string
}

function createQuery(client: QueryClient, queryKey: QueryKey) {
  client.setQueryData(queryKey, null)
  return client.getQueryCache().find({ queryKey })!
}

function watch(done: Promise<unknown>) {
  let finished = false
  void done.then(
    () => {
      finished = true
    },
    () => {
      finished = true
    },
  )
  return () => finished
}

/**
 * Commit writes already in flight so an older snapshot lands last, then commit
 * any write that appears while those operations finish.
 */
async function settleOlderLast(
  writes: Array<PendingWrite>,
  isOlder: (value: string) => boolean,
  done: Promise<unknown>,
) {
  const isFinished = watch(done)
  await flushMicrotasks()
  const initial = writes.filter((write) => !write.settled)
  for (const write of initial.filter((item) => !isOlder(item.value))) {
    write.settle()
  }
  for (const write of initial.filter((item) => isOlder(item.value))) {
    write.settle()
  }

  for (let step = 0; step < 8; step++) {
    await flushMicrotasks()
    const waiting = writes.filter((write) => !write.settled)
    if (waiting.length === 0) {
      if (isFinished()) return
      continue
    }
    const next = waiting.find((write) => !isOlder(write.value)) ?? waiting[0]
    next.settle()
  }

  if (!isFinished() || writes.some((write) => !write.settled)) {
    throw new Error('persister did not finish after in-flight writes settled')
  }
}

/**
 * Finish paused serializations newest-first when several are waiting, so an
 * older snapshot is handed to setItem after a newer one.
 */
async function releaseSerializes(
  pending: Array<() => void>,
  done: Promise<unknown>,
) {
  const isFinished = watch(done)
  for (let step = 0; step < 8 && !isFinished(); step++) {
    await flushMicrotasks()
    if (pending.length === 0) continue
    const release = pending.length > 1 ? pending.pop() : pending.shift()
    release?.()
  }

  if (!isFinished()) {
    throw new Error('persister did not finish after serialization was released')
  }
}

describe('per-query persister write ordering', () => {
  beforeAll(() => {
    vi.useFakeTimers()
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('restores the newer snapshot when an older setItem from persisterFn settles last', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({
      storage,
    })
    const queryKey = ['session']
    const firstClient = new QueryClient()

    await firstClient.query({
      queryKey,
      persister: persister.persisterFn,
      queryFn: () => ({ account: 'A' }),
    })
    await vi.advanceTimersByTimeAsync(0)

    await firstClient.query({
      queryKey,
      persister: persister.persisterFn,
      queryFn: () => ({ account: 'B' }),
    })
    await vi.advanceTimersByTimeAsync(0)

    await settleOlderLast(
      writes,
      (value) => accountOf(value) === 'A',
      Promise.resolve(),
    )

    const nextClient = new QueryClient()
    const restored = await nextClient.query({
      queryKey,
      persister: persister.persisterFn,
      queryFn: () => ({ account: 'fresh' }),
    })

    expect(restored).toEqual({ account: 'B' })
    expect(JSON.parse((await storage.getItem(writes[0].key))!).buster).toBe('')
  })

  it('keeps the newer snapshot when persistQueryByKey writes overlap on one key', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const queryKey = ['session']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const firstSave = persister.persistQueryByKey(queryKey, client)
    await flushMicrotasks()
    query.setData({ account: 'B' })
    const secondSave = persister.persistQueryByKey(queryKey, client)
    await settleOlderLast(
      writes,
      (value) => accountOf(value) === 'A',
      Promise.all([firstSave, secondSave]),
    )

    await expect(persister.retrieveQuery(query.queryHash)).resolves.toEqual({
      account: 'B',
    })
    expect(await storage.getItem(writes[0].key)).toContain('"account":"B"')
  })

  it('drops an older snapshot whose async serialize finishes after a newer save', async () => {
    const { storage } = createImmediateStorage()
    const { serialize, pending } = createPausableSerialize()
    const persister = experimental_createQueryPersister({
      storage,
      serialize,
    })
    const client = new QueryClient()
    const queryKey = ['session']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const firstSave = persister.persistQuery(query)
    await flushMicrotasks()
    query.setData({ account: 'B' })
    const secondSave = persister.persistQuery(query)
    await releaseSerializes(pending, Promise.all([firstSave, secondSave]))

    await expect(persister.retrieveQuery(query.queryHash)).resolves.toEqual({
      account: 'B',
    })
  })

  it('does not resurrect a query removed while its setItem is still in flight', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const queryKey = ['session']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const save = persister.persistQuery(query)
    await flushMicrotasks()
    const removal = persister.removeQueries({ queryKey, exact: true })
    await settleOlderLast(writes, () => true, Promise.all([save, removal]))

    const nextClient = new QueryClient()
    const restored = await nextClient.query({
      queryKey,
      persister: persister.persisterFn,
      queryFn: () => ({ account: 'signed-out' }),
    })

    expect(restored).toEqual({ account: 'signed-out' })
    expect(await storage.entries()).toEqual([])
  })

  it('does not write a snapshot serialized before removeQueries runs', async () => {
    const { storage } = createImmediateStorage()
    const { serialize, pending } = createPausableSerialize()
    const persister = experimental_createQueryPersister({
      storage,
      serialize,
    })
    const client = new QueryClient()
    const queryKey = ['session']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const save = persister.persistQuery(query)
    const removal = persister.removeQueries({ queryKey, exact: true })
    await releaseSerializes(pending, Promise.all([save, removal]))

    expect(await storage.entries()).toEqual([])
    await expect(
      persister.retrieveQuery(query.queryHash),
    ).resolves.toBeUndefined()
  })

  it('clears every in-flight key when removeQueries is called without a filter', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const session = createQuery(client, ['session'])
    const billing = createQuery(client, ['billing'])

    session.setData({ account: 'A' })
    billing.setData({ account: 'A' })
    const sessionSave = persister.persistQuery(session)
    const billingSave = persister.persistQuery(billing)
    await flushMicrotasks()
    const removal = persister.removeQueries()
    await settleOlderLast(
      writes,
      () => true,
      Promise.all([sessionSave, billingSave, removal]),
    )

    expect(await storage.entries()).toEqual([])
  })

  it('does not resurrect a partial-matched key removed while setItem is in flight', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const queryKey = ['session', 'profile']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const save = persister.persistQuery(query)
    await flushMicrotasks()
    const removal = persister.removeQueries({ queryKey: ['session'] })
    await settleOlderLast(writes, () => true, Promise.all([save, removal]))

    expect(await storage.entries()).toEqual([])
    await expect(
      persister.retrieveQuery(query.queryHash),
    ).resolves.toBeUndefined()
  })

  it('still stores an unrelated key when another key is removed around an in-flight save', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const session = createQuery(client, ['session'])
    const catalog = createQuery(client, ['catalog'])

    session.setData({ account: 'A' })
    catalog.setData({ account: 'public' })
    const sessionSave = persister.persistQuery(session)
    const catalogSave = persister.persistQuery(catalog)
    await flushMicrotasks()
    const removal = persister.removeQueries({
      queryKey: ['session'],
      exact: true,
    })
    await settleOlderLast(
      writes,
      (value) => accountOf(value) === 'A',
      Promise.all([sessionSave, catalogSave, removal]),
    )

    await expect(persister.retrieveQuery(catalog.queryHash)).resolves.toEqual({
      account: 'public',
    })
    await expect(
      persister.retrieveQuery(session.queryHash),
    ).resolves.toBeUndefined()
  })

  it('keeps the newer account when an older save settles after a delete and a newer save', async () => {
    const { storage, writes } = createCommitOnSettleStorage()
    const persister = experimental_createQueryPersister({ storage })
    const client = new QueryClient()
    const queryKey = ['session']
    const query = createQuery(client, queryKey)

    query.setData({ account: 'A' })
    const olderSave = persister.persistQuery(query)
    await flushMicrotasks()
    const removal = persister.removeQueries({ queryKey, exact: true })
    await flushMicrotasks()
    query.setData({ account: 'B' })
    const newerSave = persister.persistQuery(query)
    await settleOlderLast(
      writes,
      (value) => accountOf(value) === 'A',
      Promise.all([olderSave, removal, newerSave]),
    )

    await expect(persister.retrieveQuery(query.queryHash)).resolves.toEqual({
      account: 'B',
    })
  })
})
