import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'
import type { PersistedQuery } from '../createPersister'

const BUSTER = 'build-hash'
const SYSTEM_TIME = new Date('2026-06-01T12:00:00Z')

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createMemoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => {
      const value = items.get(key)
      return value === undefined ? null : value
    },
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
    entries: () => Array.from(items.entries()),
    size: () => items.size,
  }
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity },
    },
  })
}

describe('experimental_createQueryPersister scheduled persist', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not restore a query removed while the post-fetch persist is still scheduled', async () => {
    vi.useFakeTimers({ now: SYSTEM_TIME })
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({
      storage,
      buster: BUSTER,
    })
    const signedIn = createClient()

    await signedIn.query({
      queryKey: ['session'],
      queryFn: () => ({ viewer: 'previous-user' }),
      persister: persister.persisterFn,
    })
    await persister.removeQueries()
    await vi.advanceTimersByTimeAsync(0)

    const nextVisitor = createClient()
    await persister.restoreQueries(nextVisitor)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.size()).toBe(0)
  })

  it('does not write after removeQueries once serialize has started for the scheduled persist', async () => {
    vi.useFakeTimers({ now: SYSTEM_TIME })
    const storage = createMemoryStorage()
    const started = deferred()
    const release = deferred()
    const persister = experimental_createQueryPersister({
      storage,
      buster: BUSTER,
      serialize: async (persisted: PersistedQuery) => {
        started.resolve()
        await release.promise
        return JSON.stringify(persisted)
      },
    })
    const signedIn = createClient()

    const fetched = signedIn.query({
      queryKey: ['session'],
      queryFn: () => ({ viewer: 'previous-user' }),
      persister: persister.persisterFn,
    })
    await fetched
    await vi.advanceTimersByTime(0)
    await started.promise
    await persister.removeQueries()
    release.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const nextVisitor = createClient()
    await persister.restoreQueries(nextVisitor)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.size()).toBe(0)
  })

  it('does not let persistQueryByKey finish a write that was still serializing when removeQueries ran', async () => {
    const storage = createMemoryStorage()
    const started = deferred()
    const release = deferred()
    const persister = experimental_createQueryPersister({
      storage,
      buster: BUSTER,
      serialize: async (persisted: PersistedQuery) => {
        started.resolve()
        await release.promise
        return JSON.stringify(persisted)
      },
    })
    const signedIn = createClient()
    signedIn.setQueryData(['session'], { viewer: 'previous-user' })

    const pending = persister.persistQueryByKey(['session'], signedIn)
    await started.promise
    await persister.removeQueries()
    release.resolve()
    await pending

    const nextVisitor = createClient()
    await persister.restoreQueries(nextVisitor)
    expect(nextVisitor.getQueryData(['session'])).toBeUndefined()
    expect(storage.size()).toBe(0)
  })
})
