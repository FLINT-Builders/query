import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueryCache,
  QueryClient,
  QueryObserver,
  hashKey,
  matchMutation,
  matchQuery,
} from '..'
import { Mutation } from '../mutation'
import { hashQueryKeyByOptions } from '../utils'

/**
 * Filters an application would parse from a link or other JSON payload and
 * place directly in a query or mutation key.
 */
function keyFromJson(json: string) {
  return ['items', JSON.parse(json)] as const
}

const canonicalKey = ['items', { status: 'open' }]
const alteredKey = keyFromJson(
  '{"status":"open","__proto__":{"injected":true}}',
)
const otherAlteredKey = keyFromJson(
  '{"status":"open","__proto__":{"injected":false}}',
)

describe('query key hashing of an own __proto__ field', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient()
  })

  afterEach(() => {
    queryClient.clear()
  })

  describe('hashKey', () => {
    it('keeps an own __proto__ object in the hash', () => {
      expect(hashKey(alteredKey)).not.toEqual(hashKey(canonicalKey))
      expect(hashKey(alteredKey)).not.toEqual(hashKey(otherAlteredKey))
    })

    it('keeps an own __proto__ object nested inside the key', () => {
      const canonical = ['items', { filter: { status: 'open' } }]
      const altered = [
        'items',
        JSON.parse(
          '{"filter":{"status":"open","__proto__":{"injected":true}}}',
        ),
      ]

      expect(hashKey(altered)).not.toEqual(hashKey(canonical))
    })

    it('keeps an own __proto__ value that is null, a string, or an array', () => {
      expect(
        hashKey(keyFromJson('{"status":"open","__proto__":null}')),
      ).not.toEqual(hashKey(canonicalKey))
      expect(
        hashKey(keyFromJson('{"status":"open","__proto__":"x"}')),
      ).not.toEqual(hashKey(canonicalKey))
      expect(
        hashKey(keyFromJson('{"status":"open","__proto__":[1]}')),
      ).not.toEqual(hashKey(canonicalKey))
      expect(
        hashKey(keyFromJson('{"status":"open","__proto__":null}')),
      ).not.toEqual(hashKey(keyFromJson('{"status":"open","__proto__":"x"}')))
    })

    it('still hashes a sibling field when __proto__ is present', () => {
      expect(
        hashKey(keyFromJson('{"status":"open","__proto__":{"injected":true}}')),
      ).not.toEqual(
        hashKey(
          keyFromJson('{"status":"closed","__proto__":{"injected":true}}'),
        ),
      )
    })

    it('keeps own constructor and prototype fields in the hash', () => {
      expect(
        hashKey(keyFromJson('{"status":"open","constructor":{"x":1}}')),
      ).not.toEqual(hashKey(canonicalKey))
      expect(
        hashKey(keyFromJson('{"status":"open","prototype":{"x":1}}')),
      ).not.toEqual(hashKey(canonicalKey))
    })
  })

  describe('hashQueryKeyByOptions', () => {
    it('uses the default hash for keys that differ by an own __proto__ field', () => {
      expect(hashQueryKeyByOptions(alteredKey)).toEqual(hashKey(alteredKey))
      expect(hashQueryKeyByOptions(alteredKey)).not.toEqual(
        hashQueryKeyByOptions(canonicalKey),
      )
    })
  })

  describe('QueryClient.defaultQueryOptions', () => {
    it('assigns distinct query hashes', () => {
      const canonical = queryClient.defaultQueryOptions({
        queryKey: canonicalKey,
      })
      const altered = queryClient.defaultQueryOptions({
        queryKey: alteredKey,
      })

      expect(canonical.queryHash).not.toBe(altered.queryHash)
    })
  })

  describe('QueryCache.build', () => {
    it('stores keys that differ only by an own __proto__ field as separate queries', () => {
      const cache = new QueryCache()
      const canonical = cache.build(queryClient, { queryKey: canonicalKey })
      const altered = cache.build(queryClient, { queryKey: alteredKey })

      expect(altered).not.toBe(canonical)
      expect(cache.getAll()).toHaveLength(2)
    })
  })

  describe('QueryClient cache reads and writes', () => {
    it('does not return data fetched for the altered key from the canonical key', async () => {
      await queryClient.query({
        queryKey: alteredKey,
        queryFn: () => 'from-altered-request',
      })

      expect(queryClient.getQueryData(canonicalKey)).toBeUndefined()
      expect(queryClient.getQueryState(canonicalKey)).toBeUndefined()
      expect(queryClient.getQueryData(alteredKey)).toBe('from-altered-request')
    })

    it('does not let a later fetch for the altered key overwrite the canonical entry', async () => {
      await queryClient.query({
        queryKey: canonicalKey,
        queryFn: () => 'from-canonical-request',
      })
      await queryClient.query({
        queryKey: alteredKey,
        queryFn: () => 'from-altered-request',
      })

      expect(queryClient.getQueryData(canonicalKey)).toBe(
        'from-canonical-request',
      )
      expect(queryClient.getQueryData(alteredKey)).toBe('from-altered-request')
    })

    it('does not serve a static canonical entry for the altered key', async () => {
      const alteredQueryFn = vi.fn(() => 'from-altered-request')

      await queryClient.query({
        queryKey: canonicalKey,
        queryFn: () => 'from-canonical-request',
      })
      const result = await queryClient.query({
        queryKey: alteredKey,
        queryFn: alteredQueryFn,
        staleTime: 'static',
      })

      expect(alteredQueryFn).toHaveBeenCalledOnce()
      expect(result).toBe('from-altered-request')
      expect(queryClient.getQueryData(canonicalKey)).toBe(
        'from-canonical-request',
      )
    })

    it('does not let setQueryData for the altered key overwrite the canonical entry', () => {
      queryClient.setQueryData(canonicalKey, 'from-canonical-request')
      queryClient.setQueryData(alteredKey, 'from-altered-request')

      expect(queryClient.getQueryData(canonicalKey)).toBe(
        'from-canonical-request',
      )
      expect(queryClient.getQueryData(alteredKey)).toBe('from-altered-request')
    })

    it('does not let an infinite query for the altered key overwrite the canonical pages', async () => {
      await queryClient.infiniteQuery({
        queryKey: canonicalKey,
        queryFn: () => 'canonical-page',
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      })
      await queryClient.infiniteQuery({
        queryKey: alteredKey,
        queryFn: () => 'altered-page',
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      })

      expect(
        queryClient.getQueryData<{ pages: Array<string> }>(canonicalKey)
          ?.pages[0],
      ).toBe('canonical-page')
      expect(
        queryClient.getQueryData<{ pages: Array<string> }>(alteredKey)
          ?.pages[0],
      ).toBe('altered-page')
    })
  })

  describe('QueryObserver', () => {
    it('keeps showing the canonical request on a subscribed observer', async () => {
      await queryClient.query({
        queryKey: canonicalKey,
        queryFn: () => 'from-canonical-request',
      })

      const observer = new QueryObserver(queryClient, {
        queryKey: canonicalKey,
        queryFn: () => 'from-canonical-request',
        staleTime: 'static',
      })
      const unsubscribe = observer.subscribe(() => {})

      expect(observer.getCurrentResult().data).toBe('from-canonical-request')

      await queryClient.query({
        queryKey: alteredKey,
        queryFn: () => 'from-altered-request',
      })

      expect(observer.getCurrentResult().data).toBe('from-canonical-request')
      unsubscribe()
    })
  })

  describe('matchQuery', () => {
    it('does not exact-match a key that only adds an own __proto__ field', () => {
      const query = queryClient.getQueryCache().build(queryClient, {
        queryKey: canonicalKey,
      })

      expect(matchQuery({ queryKey: alteredKey, exact: true }, query)).toBe(
        false,
      )
    })
  })

  describe('query and mutation defaults', () => {
    it('keeps query defaults registered under both keys', () => {
      queryClient.setQueryDefaults(canonicalKey, { staleTime: 111 })
      queryClient.setQueryDefaults(alteredKey, { gcTime: 222 })

      expect(queryClient.getQueryDefaults(canonicalKey).staleTime).toBe(111)
      expect(queryClient.getQueryDefaults(alteredKey).gcTime).toBe(222)
    })

    it('keeps mutation defaults registered under both keys', () => {
      queryClient.setMutationDefaults(canonicalKey, { retry: 1 })
      queryClient.setMutationDefaults(alteredKey, { gcTime: 222 })

      expect(queryClient.getMutationDefaults(canonicalKey).retry).toBe(1)
      expect(queryClient.getMutationDefaults(alteredKey).gcTime).toBe(222)
    })
  })

  describe('matchMutation', () => {
    it('does not exact-match a mutation key that only adds an own __proto__ field', () => {
      const mutation = new Mutation({
        client: queryClient,
        mutationId: 1,
        mutationCache: queryClient.getMutationCache(),
        options: { mutationKey: canonicalKey },
      })

      expect(
        matchMutation({ mutationKey: alteredKey, exact: true }, mutation),
      ).toBe(false)
    })
  })

  describe('MutationObserver', () => {
    it('resets when the mutation key changes by an own __proto__ field', () => {
      const observer = new MutationObserver(queryClient, {
        mutationKey: canonicalKey,
        mutationFn: () => Promise.resolve('ok'),
      })
      const reset = vi.spyOn(observer, 'reset')

      observer.setOptions({
        mutationKey: alteredKey,
        mutationFn: () => Promise.resolve('ok'),
      })

      expect(reset).toHaveBeenCalled()
    })
  })
})
