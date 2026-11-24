import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { experimental_createQueryPersister } from '../createPersister'
import type { QueryPersister } from '@tanstack/query-core'
import type { AsyncStorage } from '../createPersister'

type Profile = { viewer: string; profile: string }

const queryKey = ['account', 'profile'] as const

function queryPersister(
  persister: ReturnType<typeof experimental_createQueryPersister>,
): QueryPersister<Profile, typeof queryKey> {
  return persister.persisterFn as QueryPersister<Profile, typeof queryKey>
}
const buster = 'app-build'
const previousUser = {
  viewer: 'previous-user',
  profile: 'cached-profile',
}
const nextUser = { viewer: 'next-user', profile: 'fresh-profile' }

const clients: Array<QueryClient> = []

function createMemoryStorage(): AsyncStorage<string> {
  const items = new Map<string, string>()
  return {
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key) => {
      items.delete(key)
      return Promise.resolve()
    },
    entries: () => Promise.resolve(Array.from(items.entries())),
  }
}

function createClient() {
  const queryClient = new QueryClient()
  clients.push(queryClient)
  return queryClient
}

describe('deleted cache restoration through a scheduled experimental persist', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clients.splice(0).forEach((queryClient) => {
      queryClient.clear()
    })
    vi.useRealTimers()
  })

  it('restores a query that was persisted and not removed', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({
      storage,
      buster,
    })
    const queryClient = createClient()

    await queryClient.query({
      queryKey,
      queryFn: () => previousUser,
      persister: queryPersister(persister),
    })
    await vi.advanceTimersByTimeAsync(0)

    const next = createClient()
    await expect(
      next.query({
        queryKey,
        queryFn: () => nextUser,
        persister: queryPersister(persister),
      }),
    ).resolves.toEqual(previousUser)
  })

  it('does not restore a query whose persist was still scheduled when removeQueries ran', async () => {
    const storage = createMemoryStorage()
    const persister = experimental_createQueryPersister({
      storage,
      buster,
    })
    const queryClient = createClient()

    await queryClient.query({
      queryKey,
      queryFn: () => previousUser,
      persister: queryPersister(persister),
    })

    await persister.removeQueries()
    await vi.advanceTimersByTimeAsync(0)

    const next = createClient()
    const queryFn = vi.fn(() => nextUser)
    await expect(
      next.query({
        queryKey,
        queryFn,
        persister: queryPersister(persister),
      }),
    ).resolves.toEqual(nextUser)
    expect(queryFn).toHaveBeenCalled()
  })
})
