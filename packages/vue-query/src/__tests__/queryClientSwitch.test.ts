import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, inject, nextTick, shallowRef } from 'vue-demi'
import { MutationObserver } from '@tanstack/query-core'
import { queryKey } from '@tanstack/query-test-utils'
import { QueryClient } from '../queryClient'
import { useQuery } from '../useQuery'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { useQueries } from '../useQueries'
import { useMutation } from '../useMutation'
import { usePrefetchQuery } from '../usePrefetchQuery'
import { usePrefetchInfiniteQuery } from '../usePrefetchInfiniteQuery'
import { useIsFetching } from '../useIsFetching'
import { useIsMutating, useMutationState } from '../useMutationState'
import { VUE_QUERY_CLIENT } from '../utils'

/**
 * A still-mounted composable must follow the query client it was given when
 * that client is a ref, a computed, a getter, or a provided ref. Reading it
 * once at setup and then calling setOptions on the original observer keeps
 * the previous account's result on screen and writes later fetches into that
 * account's cache.
 */
function createClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  })
  client.mount()
  return client
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('switching the query client on a mounted composable', () => {
  const scopes: Array<ReturnType<typeof effectScope>> = []

  afterEach(() => {
    for (const scope of scopes.splice(0)) {
      scope.stop()
    }
    vi.mocked(inject).mockReset()
  })

  function run<T>(setup: () => T): T {
    const scope = effectScope()
    scopes.push(scope)
    return scope.run(setup) as T
  }

  it('useQuery drops the previous account result when a shallowRef client changes and stores the next fetch on the new client', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, 'alice-secret')
    let releaseBob: (value: string) => void = () => {}
    const bobResult = new Promise<string>((resolve) => {
      releaseBob = resolve
    })
    const active = shallowRef(alice)

    const query = run(() =>
      useQuery(
        {
          queryKey: key,
          queryFn: () => bobResult,
        },
        active as unknown as QueryClient,
      ),
    )

    await settle()
    expect(query.data.value).toBe('alice-secret')

    active.value = bob
    await settle()

    expect(query.data.value).not.toBe('alice-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
    expect(bob.getQueryData(key)).toBeUndefined()

    releaseBob('bob-secret')
    await bobResult
    await settle()

    expect(query.data.value).toBe('bob-secret')
    expect(bob.getQueryData(key)).toBe('bob-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
  })

  it('useQuery follows a getter client without rerunning setup', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, 'alice-secret')
    bob.setQueryData(key, 'bob-secret')
    const active = shallowRef(alice)

    const query = run(() =>
      useQuery(
        {
          queryKey: key,
          queryFn: () => Promise.resolve('fetched'),
        },
        (() => active.value) as unknown as QueryClient,
      ),
    )

    await settle()
    expect(query.data.value).toBe('alice-secret')

    active.value = bob
    await settle()

    expect(query.data.value).toBe('bob-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
    expect(bob.getQueryData(key)).toBe('bob-secret')
  })

  it('useQuery follows a computed client when only the client identity changes', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, 'alice-secret')
    bob.setQueryData(key, 'bob-secret')
    const active = shallowRef(alice)
    const client = computed(() => active.value)

    const query = run(() =>
      useQuery(
        {
          queryKey: key,
          queryFn: () => Promise.resolve('fetched'),
        },
        client as unknown as QueryClient,
      ),
    )

    await settle()
    expect(query.data.value).toBe('alice-secret')

    active.value = bob
    await settle()

    expect(query.data.value).toBe('bob-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
  })

  it('useQuery follows a provided client ref when the composable did not receive its own client', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, 'alice-secret')
    bob.setQueryData(key, 'bob-secret')
    const active = shallowRef(alice)
    vi.mocked(inject).mockImplementation((injectedKey) => {
      if (injectedKey === VUE_QUERY_CLIENT) {
        return active
      }
      return undefined
    })

    const query = run(() =>
      useQuery({
        queryKey: key,
        queryFn: () => Promise.resolve('fetched'),
      }),
    )

    await settle()
    expect(query.data.value).toBe('alice-secret')

    active.value = bob
    await settle()

    expect(query.data.value).toBe('bob-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
    expect(bob.getQueryData(key)).toBe('bob-secret')
  })

  it('useInfiniteQuery rebinds to the next client and does not append that account onto the previous cache', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, { pages: ['alice-page'], pageParams: [0] })
    bob.setQueryData(key, { pages: ['bob-page'], pageParams: [0] })
    const active = shallowRef(alice)

    const query = run(() =>
      useInfiniteQuery(
        {
          queryKey: key,
          queryFn: ({ pageParam }) => Promise.resolve(`page-${pageParam}`),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        },
        (() => active.value) as unknown as QueryClient,
      ),
    )

    await settle()
    expect(query.data.value?.pages).toEqual(['alice-page'])

    active.value = bob
    await settle()

    expect(query.data.value?.pages).toEqual(['bob-page'])
    expect(alice.getQueryData(key)).toEqual({
      pages: ['alice-page'],
      pageParams: [0],
    })
    expect(bob.getQueryData(key)).toEqual({
      pages: ['bob-page'],
      pageParams: [0],
    })
  })

  it('useQueries rebinds every observer to the next client', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData(key, 'alice-secret')
    bob.setQueryData(key, 'bob-secret')
    const active = shallowRef(alice)

    const queries = run(() =>
      useQueries(
        {
          queries: [
            {
              queryKey: key,
              queryFn: () => Promise.resolve('fetched'),
            },
          ],
        },
        (() => active.value) as unknown as QueryClient,
      ),
    )

    await settle()
    expect(queries.value[0].data).toBe('alice-secret')

    active.value = bob
    await settle()

    expect(queries.value[0].data).toBe('bob-secret')
    expect(alice.getQueryData(key)).toBe('alice-secret')
    expect(bob.getQueryData(key)).toBe('bob-secret')
  })

  it('useMutation stores a later mutation on the client that is current when mutate runs', async () => {
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    const mutation = run(() =>
      useMutation(
        {
          mutationKey: ['save-profile'],
          mutationFn: (value: string) => Promise.resolve(value),
        },
        (() => active.value) as unknown as QueryClient,
      ),
    )

    active.value = bob
    await settle()
    mutation.mutate('bob-secret')
    await settle()
    await vi.waitFor(() => {
      expect(bob.getMutationCache().findAll()).toHaveLength(1)
    })

    expect(bob.getMutationCache().findAll()[0]?.state.data).toBe('bob-secret')
    expect(alice.getMutationCache().findAll()).toHaveLength(0)
  })

  it('usePrefetchQuery writes a later prefetch to the current client only', async () => {
    const account = shallowRef('alice')
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    run(() => {
      usePrefetchQuery(
        () => ({
          queryKey: ['profile', account.value],
          queryFn: () => Promise.resolve(`secret-${account.value}`),
        }),
        (() => active.value) as unknown as QueryClient,
      )
    })

    await settle()
    expect(alice.getQueryData(['profile', 'alice'])).toBe('secret-alice')

    active.value = bob
    account.value = 'bob'
    await settle()

    expect(bob.getQueryData(['profile', 'bob'])).toBe('secret-bob')
    expect(alice.getQueryData(['profile', 'bob'])).toBeUndefined()
    expect(alice.getQueryData(['profile', 'alice'])).toBe('secret-alice')
  })

  it('usePrefetchInfiniteQuery writes a later prefetch to the current client only', async () => {
    const account = shallowRef('alice')
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    run(() => {
      usePrefetchInfiniteQuery(
        () => ({
          queryKey: ['pages', account.value],
          queryFn: () => Promise.resolve(`page-${account.value}`),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        }),
        (() => active.value) as unknown as QueryClient,
      )
    })

    await settle()
    expect(alice.getQueryData(['pages', 'alice'])).toEqual({
      pages: ['page-alice'],
      pageParams: [0],
    })

    active.value = bob
    account.value = 'bob'
    await settle()

    expect(bob.getQueryData(['pages', 'bob'])).toEqual({
      pages: ['page-bob'],
      pageParams: [0],
    })
    expect(alice.getQueryData(['pages', 'bob'])).toBeUndefined()
  })

  it('useIsFetching counts fetches on the client that is current after a switch', async () => {
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    const fetching = run(() =>
      useIsFetching({}, active as unknown as QueryClient),
    )

    await settle()
    expect(fetching.value).toBe(0)

    active.value = bob
    await settle()
    void bob.query({
      queryKey: queryKey(),
      queryFn: () => new Promise(() => {}),
    })
    await settle()

    expect(fetching.value).toBe(1)
    expect(alice.isFetching()).toBe(0)
  })

  it('useIsMutating counts mutations on the client that is current after a switch', async () => {
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    const mutating = run(() =>
      useIsMutating({}, active as unknown as QueryClient),
    )

    await settle()
    expect(mutating.value).toBe(0)

    active.value = bob
    await settle()
    const observer = new MutationObserver(bob, {
      mutationFn: () => new Promise(() => {}),
    })
    void observer.mutate(undefined)
    await settle()

    expect(mutating.value).toBe(1)
    expect(alice.isMutating()).toBe(0)
  })

  it('useMutationState lists mutations from the client that is current after a switch', async () => {
    const alice = createClient()
    const bob = createClient()
    const active = shallowRef(alice)

    const state = run(() =>
      useMutationState(
        {
          select: (mutation) => mutation.state.data,
        },
        active as unknown as QueryClient,
      ),
    )

    await settle()
    expect(state.value).toEqual([])

    active.value = bob
    await settle()
    const observer = new MutationObserver(bob, {
      mutationFn: () => Promise.resolve('bob-saved'),
    })
    await observer.mutate(undefined).catch(() => {})
    await settle()

    expect(state.value).toEqual(['bob-saved'])
    expect(alice.getMutationCache().findAll()).toHaveLength(0)
  })

  it('keeps watching the client after the first read, including across an options update', async () => {
    const key = queryKey()
    const alice = createClient()
    const bob = createClient()
    alice.setQueryData([...key, 0], 'alice-secret')
    const version = shallowRef(0)
    const active = shallowRef(alice)

    const query = run(() =>
      useQuery(
        () => ({
          queryKey: [...key, version.value],
          queryFn: () =>
            Promise.resolve(
              `fetched-${active.value === bob ? 'bob' : 'alice'}`,
            ),
        }),
        active as unknown as QueryClient,
      ),
    )

    await settle()
    expect(query.data.value).toBe('alice-secret')

    active.value = bob
    version.value = 1
    await settle()
    await vi.waitFor(() => {
      expect(bob.getQueryData([...key, 1])).toBe('fetched-bob')
    })

    expect(query.data.value).toBe('fetched-bob')
    expect(alice.getQueryData([...key, 1])).toBeUndefined()
    expect(alice.getQueryData([...key, 0])).toBe('alice-secret')
  })
})
