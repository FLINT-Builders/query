/**
 * @vitest-environment node
 *
 * Spec for the Vue suspense promise when a query is disabled.
 * These tests fail while `suspense()` leaves that promise pending.
 */
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, isVue3, ref } from 'vue-demi'
import { skipToken } from '@tanstack/query-core'
import { queryKey } from '@tanstack/query-test-utils'
import { QueryClient } from '../queryClient'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { useQuery } from '../useQuery'
import type { QueryObserverResult } from '@tanstack/query-core'

const SETTLED_WITHIN_MS = 200

type RouteRequest = { params: { id?: string } }

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  })
}

function routeEnablesQuery(request: RouteRequest) {
  const id = request.params.id
  return id != null && id !== ''
}

function settleWithin<T>(promise: Promise<T>, ms = SETTLED_WITHIN_MS) {
  return new Promise<{
    settled: boolean
    value?: T
    error?: unknown
  }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ settled: false })
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ settled: true, value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        resolve({ settled: true, error })
      },
    )
  })
}

// `@vue/server-renderer` ships with Vue 3.5.31 and is not a direct dependency
// of this package. Load both only when the suite is running on Vue 3.
async function loadVue3ServerRenderer() {
  const vue = (await import('vue')) as {
    createSSRApp: (root: { setup: () => unknown }) => object
    h: (type: string, children?: string) => unknown
    onServerPrefetch: (hook: () => unknown) => void
  }
  const { renderToString } = createRequire(
    createRequire(import.meta.url).resolve('vue/package.json'),
  )('@vue/server-renderer') as {
    renderToString: (input: object) => Promise<string>
  }
  return { ...vue, renderToString }
}

function expectDisabledResult(
  result: QueryObserverResult<unknown, unknown> | undefined,
  data: unknown = undefined,
) {
  expect(result).toMatchObject({
    data,
    status: data === undefined ? 'pending' : 'success',
    fetchStatus: 'idle',
    isEnabled: false,
    isFetching: false,
    isStale: false,
  })
}

describe('suspense while a query is disabled', () => {
  let client: QueryClient

  beforeEach(() => {
    client = createClient()
  })

  afterEach(() => {
    client.clear()
  })

  it('resolves useQuery suspense for a missing route id without fetching', async () => {
    const request: RouteRequest = { params: {} }
    const queryFn = vi.fn(() => Promise.resolve({ id: request.params.id }))
    const id = ref(request.params.id)

    const query = useQuery(
      {
        queryKey: ['todo', id],
        queryFn,
        enabled: computed(() =>
          routeEnablesQuery({ params: { id: id.value } }),
        ),
      },
      client,
    )

    expect(query.fetchStatus.value).toBe('idle')
    expect(query.isEnabled.value).toBe(false)

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value)
  })

  it('resolves useQuery suspense for an empty route id without fetching', async () => {
    const request: RouteRequest = { params: { id: '' } }
    const queryFn = vi.fn(() => Promise.resolve('todo'))

    const query = useQuery(
      () => ({
        queryKey: ['todo', request.params.id],
        queryFn,
        enabled: routeEnablesQuery(request),
      }),
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value)
  })

  it('resolves useQuery suspense when enabled is a getter that returns false', async () => {
    const request: RouteRequest = { params: {} }
    const queryFn = vi.fn(() => Promise.resolve('todo'))

    const query = useQuery(
      {
        queryKey: queryKey(),
        queryFn,
        enabled: () => routeEnablesQuery(request),
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value)
  })

  it('resolves useQuery suspense when enabled is a ref that stays false', async () => {
    const enabled = ref(false)
    const queryFn = vi.fn(() => Promise.resolve('todo'))

    const query = useQuery(
      {
        queryKey: queryKey(),
        queryFn,
        enabled,
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value)
  })

  it('resolves useQuery suspense for skipToken without invoking a fetch', async () => {
    const request: RouteRequest = { params: {} }

    const query = useQuery(
      () => ({
        queryKey: ['todo', request.params.id],
        queryFn: routeEnablesQuery(request)
          ? () => Promise.resolve('todo')
          : skipToken,
      }),
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expectDisabledResult(outcome.value)
  })

  it('resolves a disabled query with the result already in the cache', async () => {
    const key = queryKey()
    client.setQueryData(key, 'cached todo')
    const queryFn = vi.fn(() => Promise.resolve('fetched todo'))

    const query = useQuery(
      {
        queryKey: key,
        queryFn,
        enabled: false,
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value, 'cached todo')
  })

  it('resolves a disabled query that has initialData', async () => {
    const queryFn = vi.fn(() => Promise.resolve('fetched todo'))

    const query = useQuery(
      {
        queryKey: queryKey(),
        queryFn,
        enabled: false,
        initialData: 'initial todo',
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value, 'initial todo')
  })

  it('resolves useInfiniteQuery suspense for a missing route id without fetching', async () => {
    const request: RouteRequest = { params: {} }
    const queryFn = vi.fn(() => Promise.resolve(['page']))
    const id = ref(request.params.id)

    const query = useInfiniteQuery(
      {
        queryKey: ['todos', id],
        queryFn,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        enabled: computed(() =>
          routeEnablesQuery({ params: { id: id.value } }),
        ),
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expect(queryFn).not.toHaveBeenCalled()
    expectDisabledResult(outcome.value)
  })

  it('resolves useInfiniteQuery suspense when queryFn is skipToken', async () => {
    const request: RouteRequest = { params: { id: '' } }

    const query = useInfiniteQuery(
      () => ({
        queryKey: ['todos', request.params.id],
        queryFn: routeEnablesQuery(request)
          ? () => Promise.resolve(['page'])
          : skipToken,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }),
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.error).toBeUndefined()
    expect(outcome.settled).toBe(true)
    expectDisabledResult(outcome.value)
  })

  it('still resolves useQuery suspense when the route id enables the query', async () => {
    const request: RouteRequest = { params: { id: '42' } }
    const queryFn = vi.fn(() => Promise.resolve({ id: request.params.id }))

    const query = useQuery(
      {
        queryKey: ['todo', request.params.id],
        queryFn,
        enabled: computed(() => routeEnablesQuery(request)),
      },
      client,
    )

    const outcome = await settleWithin(query.suspense())

    expect(outcome.settled).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(outcome.value?.data).toEqual({ id: '42' })
  })

  describe.skipIf(!isVue3)('server render', () => {
    it('finishes a server render that awaits suspense in async setup when the route id is missing', async () => {
      const request: RouteRequest = { params: {} }
      const queryFn = vi.fn(() => Promise.resolve({ id: request.params.id }))
      const { createSSRApp, h, renderToString } = await loadVue3ServerRenderer()

      const app = createSSRApp({
        setup: async () => {
          const { suspense } = useQuery(
            {
              queryKey: ['todo', request.params.id],
              queryFn,
              enabled: () => routeEnablesQuery(request),
            },
            client,
          )
          await suspense()
          return () => h('p', 'rendered')
        },
      })

      const outcome = await settleWithin(renderToString(app))

      expect(outcome.error).toBeUndefined()
      expect(outcome.settled).toBe(true)
      expect(outcome.value).toContain('rendered')
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('finishes a server render that awaits suspense from onServerPrefetch when the route id is empty', async () => {
      const request: RouteRequest = { params: { id: '' } }
      const queryFn = vi.fn(() => Promise.resolve('todo'))
      const { createSSRApp, h, onServerPrefetch, renderToString } =
        await loadVue3ServerRenderer()

      const app = createSSRApp({
        setup: () => {
          const { suspense } = useQuery(
            {
              queryKey: ['todo', request.params.id],
              queryFn,
              enabled: computed(() => routeEnablesQuery(request)),
            },
            client,
          )
          onServerPrefetch(async () => {
            await suspense()
          })
          return () => h('p', 'rendered')
        },
      })

      const outcome = await settleWithin(renderToString(app))

      expect(outcome.error).toBeUndefined()
      expect(outcome.settled).toBe(true)
      expect(outcome.value).toContain('rendered')
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('finishes a server render that prefetches a disabled infinite query', async () => {
      const request: RouteRequest = { params: {} }
      const queryFn = vi.fn(() => Promise.resolve(['page']))
      const { createSSRApp, h, onServerPrefetch, renderToString } =
        await loadVue3ServerRenderer()

      const app = createSSRApp({
        setup: () => {
          const { suspense } = useInfiniteQuery(
            {
              queryKey: ['todos', request.params.id],
              queryFn,
              initialPageParam: 0,
              getNextPageParam: () => undefined,
              enabled: false,
            },
            client,
          )
          onServerPrefetch(suspense)
          return () => h('p', 'rendered')
        },
      })

      const outcome = await settleWithin(renderToString(app))

      expect(outcome.error).toBeUndefined()
      expect(outcome.settled).toBe(true)
      expect(outcome.value).toContain('rendered')
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('finishes a server render that awaits suspense when the route id is present', async () => {
      const request: RouteRequest = { params: { id: '7' } }
      const queryFn = vi.fn(() => Promise.resolve({ id: request.params.id }))
      const { createSSRApp, h, renderToString } = await loadVue3ServerRenderer()

      const app = createSSRApp({
        setup: async () => {
          const { suspense } = useQuery(
            {
              queryKey: ['todo', request.params.id],
              queryFn,
              enabled: () => routeEnablesQuery(request),
            },
            client,
          )
          await suspense()
          return () => h('p', 'rendered')
        },
      })

      const outcome = await settleWithin(renderToString(app))

      expect(outcome.settled).toBe(true)
      expect(outcome.error).toBeUndefined()
      expect(outcome.value).toContain('rendered')
      expect(queryFn).toHaveBeenCalledTimes(1)
    })
  })
})
