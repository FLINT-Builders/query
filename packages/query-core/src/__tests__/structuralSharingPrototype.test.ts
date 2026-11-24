import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import { QueriesObserver, QueryClient, QueryObserver, focusManager } from '..'
import { replaceEqualDeep } from '../utils'
import type { QueryObserverResult } from '..'

const injectedUrl = 'https://evil.example/redirect'

const cleanRecord = '{"id":1,"name":"ada"}'
const poisonedRecord =
  '{"id":1,"name":"ada","__proto__":{"role":"admin","url":"https://evil.example/redirect"}}'
const previousWithProto =
  '{"id":1,"name":"ada","__proto__":{"role":"user","url":"https://evil.example/old"}}'
const nextWithProto =
  '{"id":2,"name":"ada","__proto__":{"role":"admin","url":"https://evil.example/redirect"}}'
const nestedClean = '{"id":1,"profile":{"name":"ada"}}'
const nestedPoisoned =
  '{"id":1,"profile":{"name":"ada","__proto__":{"role":"admin","url":"https://evil.example/redirect"}}}'
const arrayClean = '[{"id":1,"name":"ada"}]'
const arrayPoisoned =
  '[{"id":1,"name":"ada","__proto__":{"role":"admin","url":"https://evil.example/redirect"}}]'
const nullPrototypeRecord = '{"id":1,"name":"ada","__proto__":null}'

type RecordData = {
  id: number
  name: string
  label?: string
  profile?: { name: string }
}

/**
 * The cached object must not treat fields that arrived under a JSON `__proto__`
 * key as real data. Those fields are absent from the parsed record; reading
 * them, `in`, and `Object.keys` all have to agree.
 */
function assertNoInjectedPrototype(value: object): void {
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect('role' in value).toBe(false)
  expect('url' in value).toBe(false)
  expect(Object.hasOwn(value, 'role')).toBe(false)
  expect(Object.hasOwn(value, 'url')).toBe(false)
  expect(Object.keys(value)).not.toContain('role')
  expect(Object.keys(value)).not.toContain('url')

  const record = value as { role?: unknown; url?: unknown }
  expect(record.role).toBeUndefined()
  expect(record.url).toBe(undefined)

  expect('role' in {}).toBe(false)
  expect('url' in {}).toBe(false)
  expect(({} as { url?: string }).url).not.toBe(injectedUrl)
}

describe('structural sharing prototype assignment', () => {
  describe('replaceEqualDeep', () => {
    it('does not let a __proto__ key become the prototype of the copied object', () => {
      const previous = JSON.parse(cleanRecord) as RecordData
      const next = JSON.parse(poisonedRecord) as RecordData

      const shared = replaceEqualDeep(previous, next)

      expect(shared.id).toBe(1)
      expect(shared.name).toBe('ada')
      assertNoInjectedPrototype(shared)
    })

    it('does not let a nested __proto__ key become that nested object’s prototype', () => {
      const previous = JSON.parse(nestedClean) as RecordData
      const next = JSON.parse(nestedPoisoned) as RecordData

      const shared = replaceEqualDeep(previous, next)

      expect(shared.profile?.name).toBe('ada')
      assertNoInjectedPrototype(shared.profile as object)
    })

    it('does not let an array element’s __proto__ key become that element’s prototype', () => {
      const previous = JSON.parse(arrayClean) as Array<RecordData>
      const next = JSON.parse(arrayPoisoned) as Array<RecordData>

      const shared = replaceEqualDeep(previous, next)

      expect(shared[0]?.name).toBe('ada')
      assertNoInjectedPrototype(shared[0] as object)
    })

    it('does not change the prototype when the __proto__ value is null', () => {
      const previous = JSON.parse(cleanRecord) as RecordData
      const next = JSON.parse(nullPrototypeRecord) as RecordData

      const shared = replaceEqualDeep(previous, next)

      expect(shared.id).toBe(1)
      expect(shared.name).toBe('ada')
      expect(Object.getPrototypeOf(shared)).toBe(Object.prototype)
    })

    it('does not set the prototype when both values already contain a __proto__ object', () => {
      const previous = JSON.parse(previousWithProto) as RecordData
      const next = JSON.parse(nextWithProto) as RecordData

      const shared = replaceEqualDeep(previous, next)

      expect(shared.id).toBe(2)
      expect(shared.name).toBe('ada')
      assertNoInjectedPrototype(shared)
    })
  })

  describe('query cache', () => {
    let queryClient: QueryClient

    beforeEach(() => {
      vi.useFakeTimers()
      queryClient = new QueryClient()
      queryClient.mount()
    })

    afterEach(() => {
      queryClient.clear()
      focusManager.setFocused(undefined)
      vi.useRealTimers()
    })

    it('keeps the first fetched record free of inherited fields and the refetch the same way', async () => {
      const key = queryKey()
      let json = cleanRecord

      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      const first = queryClient.getQueryData<RecordData>(key)
      expect(first?.name).toBe('ada')
      assertNoInjectedPrototype(first as object)

      json = poisonedRecord
      const returned = await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      // The query function's return value is still the parsed JSON object.
      // The cached copy is what observers read.
      expect(Object.getPrototypeOf(returned)).toBe(Object.prototype)
      expect(Object.hasOwn(returned, '__proto__')).toBe(true)
      expect('role' in returned).toBe(false)

      const cached = queryClient.getQueryData<RecordData>(key)
      expect(cached?.id).toBe(1)
      expect(cached?.name).toBe('ada')
      assertNoInjectedPrototype(cached as object)
    })

    it('does not expose inherited fields when a refetch changes another field and both payloads contain __proto__', async () => {
      const key = queryKey()
      let json = previousWithProto

      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      json = nextWithProto
      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      const cached = queryClient.getQueryData<RecordData>(key)
      expect(cached?.id).toBe(2)
      expect(cached?.name).toBe('ada')
      assertNoInjectedPrototype(cached as object)
    })

    it('does not expose inherited fields on a nested record after refetch', async () => {
      const key = queryKey()
      let json = nestedClean

      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      json = nestedPoisoned
      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as RecordData,
      })

      const cached = queryClient.getQueryData<RecordData>(key)
      expect(cached?.profile?.name).toBe('ada')
      assertNoInjectedPrototype(cached?.profile as object)
    })

    it('does not expose inherited fields on an array element after refetch', async () => {
      const key = queryKey()
      let json = arrayClean

      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as Array<RecordData>,
      })

      json = arrayPoisoned
      await queryClient.query({
        queryKey: key,
        queryFn: () => JSON.parse(json) as Array<RecordData>,
      })

      const cached = queryClient.getQueryData<Array<RecordData>>(key)
      expect(cached?.[0]?.name).toBe('ada')
      assertNoInjectedPrototype(cached?.[0] as object)
    })

    it('does not expose inherited fields on an infinite-query page after refetch', async () => {
      const key = queryKey()
      let json = cleanRecord

      await queryClient.infiniteQuery({
        queryKey: key,
        initialPageParam: 0,
        queryFn: () => JSON.parse(json) as RecordData,
        getNextPageParam: () => undefined,
      })

      json = poisonedRecord
      await queryClient.infiniteQuery({
        queryKey: key,
        initialPageParam: 0,
        queryFn: () => JSON.parse(json) as RecordData,
        getNextPageParam: () => undefined,
      })

      const cached = queryClient.getQueryData<{
        pages: Array<RecordData>
        pageParams: Array<unknown>
      }>(key)
      expect(cached?.pages[0]?.name).toBe('ada')
      assertNoInjectedPrototype(cached?.pages[0] as object)
    })

    it('does not expose inherited fields when setQueryData writes a second parsed object', () => {
      const key = queryKey()

      queryClient.setQueryData(key, JSON.parse(cleanRecord) as RecordData)
      queryClient.setQueryData(key, JSON.parse(poisonedRecord) as RecordData)

      const cached = queryClient.getQueryData<RecordData>(key)
      expect(cached?.id).toBe(1)
      expect(cached?.name).toBe('ada')
      assertNoInjectedPrototype(cached as object)
    })

    it('does not expose inherited fields after a window-focus refetch of a stale query', async () => {
      const key = queryKey()
      const payloads = [cleanRecord, poisonedRecord]
      let call = 0
      const queryFn = vi.fn(() => {
        const json = payloads[Math.min(call, payloads.length - 1)]!
        call++
        return JSON.parse(json) as RecordData
      })

      focusManager.setFocused(true)
      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn,
        staleTime: 0,
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(1)
      const first = observer.getCurrentResult().data
      expect(first?.name).toBe('ada')
      assertNoInjectedPrototype(first as object)

      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(queryFn).toHaveBeenCalledTimes(2)
      const shown = observer.getCurrentResult().data
      expect(shown?.id).toBe(1)
      expect(shown?.name).toBe('ada')
      assertNoInjectedPrototype(shown as object)
      assertNoInjectedPrototype(
        queryClient.getQueryData<RecordData>(key) as object,
      )

      unsubscribe()
    })

    it('does not expose inherited fields when placeholder data is structurally shared', () => {
      const key = queryKey()
      const queryFn = () => {
        throw new Error('disabled query should not fetch')
      }

      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn,
        enabled: false,
        placeholderData: JSON.parse(cleanRecord) as RecordData,
      })
      const unsubscribe = observer.subscribe(() => undefined)

      const first = observer.getCurrentResult().data
      expect(first?.name).toBe('ada')
      assertNoInjectedPrototype(first as object)

      observer.setOptions({
        queryKey: key,
        queryFn,
        enabled: false,
        placeholderData: JSON.parse(poisonedRecord) as RecordData,
      })

      const shown = observer.getCurrentResult().data
      expect(shown?.name).toBe('ada')
      assertNoInjectedPrototype(shown as object)

      unsubscribe()
    })

    it('does not expose inherited fields when a new select structurally shares the previous selection', async () => {
      const key = queryKey()
      const queryFn = () => JSON.parse(poisonedRecord) as RecordData

      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn,
        select: (data: RecordData) => ({ ...data, label: 'one' }),
      })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      const first = observer.getCurrentResult().data
      expect(first?.label).toBe('one')
      expect(first?.name).toBe('ada')
      assertNoInjectedPrototype(first as object)

      observer.setOptions({
        queryKey: key,
        queryFn,
        select: (data: RecordData) => ({ ...data, label: 'two' }),
      })

      const shown = observer.getCurrentResult().data
      expect(shown?.label).toBe('two')
      expect(shown?.name).toBe('ada')
      assertNoInjectedPrototype(shown as object)

      unsubscribe()
    })

    it('does not expose inherited fields on the value QueriesObserver combine structurally shares', async () => {
      const key = queryKey()
      let json = cleanRecord
      const queries = [
        {
          queryKey: key,
          structuralSharing: false as const,
          queryFn: () => JSON.parse(json) as RecordData,
        },
      ]
      const combine = (results: Array<QueryObserverResult<RecordData>>) => ({
        record: results[0]?.data,
        stamp: results[0]?.dataUpdatedAt,
      })
      const observer = new QueriesObserver(queryClient, queries, { combine })
      const unsubscribe = observer.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      const [, readCombined] = observer.getOptimisticResult(queries, combine)
      const first = readCombined()
      expect(first.record?.name).toBe('ada')
      assertNoInjectedPrototype(first.record as object)

      json = poisonedRecord
      await queryClient.query({
        queryKey: key,
        structuralSharing: false,
        queryFn: () => JSON.parse(json) as RecordData,
      })
      await vi.advanceTimersByTimeAsync(0)

      // A new combine function is what a render passes to getOptimisticResult.
      // Identity has to change so the observer recomputes against the latest
      // query data; the cached query keeps structural sharing off, so only
      // this combine copy can assign `__proto__`.
      const combineAgain = (
        results: Array<QueryObserverResult<RecordData>>,
      ) => ({
        record: results[0]?.data,
        stamp: results[0]?.dataUpdatedAt,
      })
      const [, readUpdated] = observer.getOptimisticResult(
        queries,
        combineAgain,
      )
      const second = readUpdated()
      expect(second.record?.name).toBe('ada')
      assertNoInjectedPrototype(second.record as object)
      assertNoInjectedPrototype(
        queryClient.getQueryData<RecordData>(key) as object,
      )
      expect(
        Object.hasOwn(
          queryClient.getQueryData<RecordData>(key) as object,
          '__proto__',
        ),
      ).toBe(true)

      unsubscribe()
      observer.destroy()
    })
  })
})
