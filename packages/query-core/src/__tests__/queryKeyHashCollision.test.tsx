import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueriesObserver,
  QueryClient,
  QueryObserver,
  dehydrate,
  hashKey,
  hashQueryKeyByOptions,
  hydrate,
} from '..'
import type { QueryClient as QueryClientType, QueryKey } from '..'

/**
 * Spec for cache identity. `undefined`, `null`, `NaN`, and `Infinity` are
 * different query-key values. The default hash must not collapse them, and
 * every cache operation that keys off that hash must keep their records apart.
 *
 * An undefined object property is still the same key as a missing property.
 * That equality is documented and is not part of this bug.
 */

const PRIVATE = 'private-current-user'
const PUBLIC = 'public-profile'

const arraySpellings = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
] as const

const objectSpellings = [
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
] as const

describe('query key hash collisions', () => {
  let queryClient: QueryClientType

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    queryClient = new QueryClient()
    queryClient.mount()
  })

  afterEach(() => {
    queryClient.clear()
    queryClient.unmount()
    vi.useRealTimers()
  })

  describe('hashKey', () => {
    it('gives each array spelling its own hash', () => {
      const hashes = arraySpellings.map(([, value]) =>
        hashKey(['profile', value]),
      )

      expect(new Set(hashes).size).toBe(arraySpellings.length)
      expect(hashQueryKeyByOptions(['profile', undefined])).not.toBe(
        hashQueryKeyByOptions(['profile', Number.NaN]),
      )
    })

    it('gives NaN and Infinity object values hashes distinct from null', () => {
      const hashes = objectSpellings.map(([, value]) =>
        hashKey(['profile', { id: value }]),
      )

      expect(new Set(hashes).size).toBe(objectSpellings.length)
      expect(hashKey(['profile', { ids: [Number.NaN] }])).not.toBe(
        hashKey(['profile', { ids: [null] }]),
      )
      expect(hashKey(['profile', { user: { id: Number.NaN } }])).not.toBe(
        hashKey(['profile', { user: { id: null } }]),
      )
    })

    it('keeps an undefined object property equal to a missing property', () => {
      expect(hashKey(['todos', { filters: undefined }])).toBe(
        hashKey(['todos', {}]),
      )
      expect(hashKey(['profile', { id: undefined }])).not.toBe(
        hashKey(['profile', { id: null }]),
      )
    })
  })

  describe('QueryClient cache identity', () => {
    it('does not serve one array spelling from the cache entry of another', async () => {
      for (const [leftName, left] of arraySpellings) {
        for (const [rightName, right] of arraySpellings) {
          if (leftName === rightName) continue

          const client = new QueryClient()
          client.mount()
          await client.query({
            queryKey: ['profile', left],
            queryFn: () => `data:${leftName}`,
            staleTime: 60_000,
          })

          const seen = await client.query({
            queryKey: ['profile', right],
            queryFn: () => `data:${rightName}`,
            staleTime: 60_000,
          })

          expect(seen, `${rightName} reused the ${leftName} entry`).toBe(
            `data:${rightName}`,
          )
          expect(client.getQueryData(['profile', left])).toBe(
            `data:${leftName}`,
          )
          expect(client.getQueryCache().findAll().length).toBe(2)
          client.clear()
          client.unmount()
        }
      }
    })

    it('does not serve a NaN or Infinity object id from the null object entry', async () => {
      for (const [leftName, left] of objectSpellings) {
        for (const [rightName, right] of objectSpellings) {
          if (leftName === rightName) continue

          const client = new QueryClient()
          client.mount()
          await client.query({
            queryKey: ['profile', { id: left }],
            queryFn: () => `data:${leftName}`,
            staleTime: 60_000,
          })

          const seen = await client.query({
            queryKey: ['profile', { id: right }],
            queryFn: () => `data:${rightName}`,
            staleTime: 60_000,
          })

          expect(seen, `${rightName} reused the ${leftName} entry`).toBe(
            `data:${rightName}`,
          )
          expect(client.getQueryData(['profile', { id: left }])).toBe(
            `data:${leftName}`,
          )
          client.clear()
          client.unmount()
        }
      }
    })

    it('returns the current-user record only for the key that fetched it', async () => {
      const received: Array<QueryKey> = []

      await queryClient.query({
        queryKey: ['profile', undefined],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PRIVATE
        },
        staleTime: 60_000,
      })

      const seen = await queryClient.query({
        queryKey: ['profile', Number('not-a-number')],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PUBLIC
        },
        staleTime: 60_000,
      })

      expect(seen).toBe(PUBLIC)
      expect(received.map((key) => key[1])).toEqual([undefined, Number.NaN])
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(
        queryClient.getQueryData(['profile', Number('not-a-number')]),
      ).toBe(PUBLIC)
    })

    it('passes the requested key to a refetch instead of the key stored earlier', async () => {
      const received: Array<QueryKey> = []

      await queryClient.query({
        queryKey: ['profile', undefined],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PRIVATE
        },
      })

      const seen = await queryClient.query({
        queryKey: ['profile', Number('Infinity')],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PUBLIC
        },
      })

      expect(seen).toBe(PUBLIC)
      expect(received[1]).toEqual(['profile', Number.POSITIVE_INFINITY])
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
    })

    it('does not let a static query reuse a coerced key', async () => {
      await queryClient.query({
        queryKey: ['profile', undefined],
        queryFn: () => PRIVATE,
        staleTime: 'static',
      })

      const seen = await queryClient.query({
        queryKey: ['profile', Number.NaN],
        queryFn: () => PUBLIC,
        staleTime: 'static',
      })

      expect(seen).toBe(PUBLIC)
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
    })

    it('does not let infiniteQuery reuse a coerced key', async () => {
      await queryClient.infiniteQuery({
        queryKey: ['profile', undefined],
        queryFn: () => PRIVATE,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        staleTime: 60_000,
      })

      const seen = await queryClient.infiniteQuery({
        queryKey: ['profile', Number.NaN],
        queryFn: ({ queryKey }) => {
          expect(queryKey).toEqual(['profile', Number.NaN])
          return PUBLIC
        },
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        staleTime: 60_000,
      })

      expect(seen.pages).toEqual([PUBLIC])
      expect(queryClient.getQueryData(['profile', undefined])).toEqual({
        pages: [PRIVATE],
        pageParams: [0],
      })
    })

    it('keeps setQueryData for one spelling from overwriting another', () => {
      queryClient.setQueryData(['profile', undefined], PRIVATE)
      queryClient.setQueryData(['profile', Number.NaN], PUBLIC)
      queryClient.setQueryData(['profile', { id: null }], PRIVATE)
      queryClient.setQueryData(['profile', { id: Number.NaN }], PUBLIC)

      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', Number.NaN])).toBe(PUBLIC)
      expect(queryClient.getQueryData(['profile', null])).toBeUndefined()
      expect(queryClient.getQueryData(['profile', { id: null }])).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', { id: Number.NaN }])).toBe(
        PUBLIC,
      )
    })

    it('leaves the undefined entry in place when a partial null filter does not name it, without letting NaN read it', () => {
      queryClient.setQueryData(['profile', undefined], PRIVATE)

      queryClient.removeQueries({ queryKey: ['profile', null] })

      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', null])).toBeUndefined()
      expect(queryClient.getQueryData(['profile', Number.NaN])).toBeUndefined()
      expect(
        queryClient.getQueryData(['profile', Number.POSITIVE_INFINITY]),
      ).toBeUndefined()
    })

    it('does not let an exact filter for one spelling remove another', () => {
      queryClient.setQueryData(['profile', undefined], PRIVATE)
      queryClient.setQueryData(['profile', Number.NaN], PUBLIC)

      queryClient.removeQueries({
        queryKey: ['profile', null],
        exact: true,
      })

      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', Number.NaN])).toBe(PUBLIC)

      queryClient.removeQueries({
        queryKey: ['profile', Number.NaN],
        exact: true,
      })

      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', Number.NaN])).toBeUndefined()
      expect(
        queryClient.getQueryCache().find({
          queryKey: ['profile', undefined],
          exact: true,
        }),
      ).toBeDefined()
      expect(
        queryClient.getQueryCache().find({
          queryKey: ['profile', Number.NaN],
          exact: true,
        }),
      ).toBeUndefined()
    })

    it('stores query defaults for null and NaN separately', () => {
      queryClient.setQueryDefaults(['profile', null], { staleTime: 5_000 })
      queryClient.setQueryDefaults(['profile', Number.NaN], {
        staleTime: 9_000,
      })

      expect(queryClient.getQueryDefaults(['profile', null]).staleTime).toBe(
        5_000,
      )
      expect(
        queryClient.getQueryDefaults(['profile', Number.NaN]).staleTime,
      ).toBe(9_000)
    })

    it('stores mutation defaults for null and NaN separately', () => {
      queryClient.setMutationDefaults(['save-profile', null], {
        retry: 1,
      })
      queryClient.setMutationDefaults(['save-profile', Number.NaN], {
        retry: 4,
      })

      expect(
        queryClient.getMutationDefaults(['save-profile', null]).retry,
      ).toBe(1)
      expect(
        queryClient.getMutationDefaults(['save-profile', Number.NaN]).retry,
      ).toBe(4)
    })
  })

  describe('observers', () => {
    it('does not show the current-user result to an observer whose key is NaN', async () => {
      const currentUser = new QueryObserver(queryClient, {
        queryKey: ['profile', undefined],
        queryFn: () => PRIVATE,
        staleTime: 60_000,
      })
      const unsubscribeCurrentUser = currentUser.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(currentUser.getCurrentResult().data).toBe(PRIVATE)

      const visitor = new QueryObserver(queryClient, {
        queryKey: ['profile', Number('not-a-number')],
        queryFn: () => PUBLIC,
        staleTime: 60_000,
      })
      const unsubscribeVisitor = visitor.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(visitor.getCurrentQuery()).not.toBe(currentUser.getCurrentQuery())
      expect(visitor.getCurrentQuery().queryKey).toEqual([
        'profile',
        Number.NaN,
      ])
      expect(visitor.getCurrentResult().data).toBe(PUBLIC)
      expect(currentUser.getCurrentResult().data).toBe(PRIVATE)
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)

      unsubscribeVisitor()
      unsubscribeCurrentUser()
    })

    it('refetches with the observer key when the observer switches onto a coerced spelling', async () => {
      const received: Array<QueryKey> = []
      const observer = new QueryObserver(queryClient, {
        queryKey: ['profile', undefined],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PRIVATE
        },
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(observer.getCurrentResult().data).toBe(PRIVATE)

      observer.setOptions({
        queryKey: ['profile', Number('not-a-number')],
        queryFn: ({ queryKey }) => {
          received.push(queryKey)
          return PUBLIC
        },
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(observer.getCurrentResult().data).toBe(PUBLIC)
      expect(observer.getCurrentQuery().queryKey).toEqual([
        'profile',
        Number.NaN,
      ])
      expect(received[1]).toEqual(['profile', Number.NaN])
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)

      unsubscribe()
    })

    it('does not let QueriesObserver share one result across coerced keys', () => {
      queryClient.setQueryData(['profile', undefined], PRIVATE)

      const queries = [
        {
          queryKey: ['profile', undefined],
          queryFn: () => PRIVATE,
          staleTime: Number.POSITIVE_INFINITY,
        },
        {
          queryKey: ['profile', Number('not-a-number')],
          queryFn: () => PUBLIC,
          staleTime: Number.POSITIVE_INFINITY,
        },
      ]
      const observer = new QueriesObserver(queryClient, queries)
      const [results] = observer.getOptimisticResult(queries, undefined)

      expect(results[0]?.data).toBe(PRIVATE)
      expect(results[1]?.data).not.toBe(PRIVATE)
      expect(observer.getObservers()[0]).not.toBe(observer.getObservers()[1])
      expect(observer.getObservers()[0]?.getCurrentQuery()).not.toBe(
        observer.getObservers()[1]?.getCurrentQuery(),
      )
    })
  })

  describe('hydration', () => {
    it('does not hydrate a current-user snapshot onto a NaN key that is already cached', () => {
      queryClient.setQueryData(['profile', Number.NaN], PUBLIC)

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
      const source = new QueryClient()
      source.setQueryData(['profile', undefined], PRIVATE)
      const snapshot = dehydrate(source)

      hydrate(queryClient, snapshot)

      expect(queryClient.getQueryData(['profile', Number.NaN])).toBe(PUBLIC)
      expect(queryClient.getQueryData(['profile', undefined])).toBe(PRIVATE)
      source.clear()
    })

    it('restores the snapshot only under the key that was dehydrated', () => {
      queryClient.setQueryData(['profile', undefined], PRIVATE)
      const snapshot = dehydrate(queryClient)

      const restored = new QueryClient()
      hydrate(restored, snapshot)

      expect(restored.getQueryData(['profile', undefined])).toBe(PRIVATE)
      expect(restored.getQueryData(['profile', null])).toBeUndefined()
      expect(restored.getQueryData(['profile', Number.NaN])).toBeUndefined()
      expect(
        restored.getQueryData(['profile', Number.POSITIVE_INFINITY]),
      ).toBeUndefined()
      restored.clear()
    })
  })

  describe('mutations', () => {
    it('does not count a NaN mutation key as an exact null mutation', async () => {
      let finish = (_value: string) => {}
      const observer = new MutationObserver(queryClient, {
        mutationKey: ['save-profile', Number.NaN],
        mutationFn: () =>
          new Promise<string>((resolve) => {
            finish = resolve
          }),
      })

      const pending = observer.mutate(undefined)

      expect(
        queryClient.isMutating({
          mutationKey: ['save-profile', null],
          exact: true,
        }),
      ).toBe(0)
      expect(
        queryClient.isMutating({
          mutationKey: ['save-profile', Number.NaN],
          exact: true,
        }),
      ).toBe(1)

      finish('done')
      await pending
    })
  })

  describe('QueryCache.build', () => {
    it('does not attach a new key to the query stored for a different spelling', () => {
      const cache = queryClient.getQueryCache()
      const currentUser = cache.build(queryClient, {
        queryKey: ['profile', undefined],
        queryFn: () => PRIVATE,
      })
      currentUser.setData(PRIVATE)

      const visitor = cache.build(queryClient, {
        queryKey: ['profile', Number.NaN],
        queryFn: () => PUBLIC,
      })

      expect(visitor).not.toBe(currentUser)
      expect(visitor.queryKey).toEqual(['profile', Number.NaN])
      expect(visitor.state.data).toBeUndefined()
      expect(currentUser.state.data).toBe(PRIVATE)
      expect(currentUser.queryKey).toEqual(['profile', undefined])
    })
  })
})
