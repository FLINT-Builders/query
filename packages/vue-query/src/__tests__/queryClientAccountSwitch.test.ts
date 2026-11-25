import { isVue3 } from 'vue-demi'
import * as VueDemi from 'vue-demi'
import { MutationObserver } from '@tanstack/query-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '../queryClient'
import { VUE_QUERY_CLIENT } from '../utils'
import { VueQueryPlugin } from '../vueQueryPlugin'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { useIsFetching } from '../useIsFetching'
import { useIsMutating, useMutationState } from '../useMutationState'
import { useMutation } from '../useMutation'
import { usePrefetchInfiniteQuery } from '../usePrefetchInfiniteQuery'
import { usePrefetchQuery } from '../usePrefetchQuery'
import { useQueries } from '../useQueries'
import { useQuery } from '../useQuery'
import type { MutationFunctionContext } from '@tanstack/query-core'

/**
 * Vue 3.5 `app.provide` overwrites the same plain provides object `inject`
 * reads. The read is not reactive, so a mounted composable keeps the previous
 * client unless it resolves the client again when it acts.
 */
type VueRuntime = typeof import('vue')

let vue: VueRuntime

function installRealInject() {
  vi.mocked(VueDemi.inject).mockImplementation(((key: string) =>
    vue.inject(key)) as typeof VueDemi.inject)
}

const accountNames = new WeakMap<QueryClient, string>()

function accountName(client: QueryClient | undefined) {
  return client ? accountNames.get(client) : undefined
}

function createAccountClients() {
  const config = {
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  }
  const previous = new QueryClient(config)
  const current = new QueryClient(config)
  const later = new QueryClient(config)
  accountNames.set(previous, 'previous')
  accountNames.set(current, 'current')
  accountNames.set(later, 'later')
  previous.setMutationDefaults(['save'], { meta: { account: 'previous' } })
  current.setMutationDefaults(['save'], { meta: { account: 'current' } })
  later.setMutationDefaults(['save'], { meta: { account: 'later' } })
  return { previous, current, later }
}

function mountWithClient(
  client: QueryClient,
  setup: (switchAccount: (next: QueryClient) => void) => void,
) {
  let switchAccount: (next: QueryClient) => void = () => {
    throw new Error('app was not mounted')
  }
  const Root = vue.defineComponent({
    name: 'SignedInForm',
    setup() {
      setup(switchAccount)
      return () => vue.h('form')
    },
  })
  const app = vue.createApp(Root)
  app.use(VueQueryPlugin, { queryClient: client })
  switchAccount = (next) => {
    app.provide(VUE_QUERY_CLIENT, next)
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  app.mount(el)
  return {
    switchAccount,
    /** What `useQueryClient()` reads after `switchAccount`, from a fresh inject. */
    readProvided() {
      return app.runWithContext(
        () => vue.inject(VUE_QUERY_CLIENT) as QueryClient,
      )
    },
    unmount() {
      app.unmount()
      el.remove()
    },
  }
}

async function flushWork() {
  await vue.nextTick()
  await Promise.resolve()
  await vue.nextTick()
}

describe.skipIf(!isVue3)(
  'account switch while a composable stays mounted',
  () => {
  beforeEach(async () => {
    vue = await import('vue')
    installRealInject()
  })

  it('records a mutation started after the switch on the new client', async () => {
    const { previous, current, later } = createAccountClients()
    const label = vue.ref('previous')
    let mutate!: ReturnType<typeof useMutation>['mutate']
    let mutateAsync!: ReturnType<typeof useMutation>['mutateAsync']
    let seenOnMutate: QueryClient | undefined
    let seenFn: QueryClient | undefined
    let seenMeta: string | undefined
    let perCall: QueryClient | undefined
    let releaseFirst!: (value: string) => void
    const firstResult = new Promise<string>((resolve) => {
      releaseFirst = resolve
    })

    const mounted = mountWithClient(previous, (switchAccount) => {
      const mutation = useMutation(() => ({
        mutationKey: ['save', label.value] as const,
        mutationFn: async (
          vars: string,
          context: MutationFunctionContext,
        ) => {
          seenFn = context.client as QueryClient
          seenMeta = context.meta?.account as string | undefined
          if (vars === 'first') {
            return firstResult
          }
          return 'second-result'
        },
        onMutate: async (vars: string, context: MutationFunctionContext) => {
          seenOnMutate = context.client as QueryClient
          context.client.setQueryData(['optimistic', vars], true)
          if (vars === 'second') {
            switchAccount(later)
          }
        },
        onSuccess: (
          _data: string,
          vars: string,
          _onMutateResult: unknown,
          context: MutationFunctionContext,
        ) => {
          context.client.setQueryData(['settled', vars], true)
        },
      }))
      mutate = mutation.mutate
      mutateAsync = mutation.mutateAsync
    })

    mutate('first')
    expect(previous.getQueryData(['optimistic', 'first'])).toBe(true)
    expect(previous.getMutationCache().findAll()).toHaveLength(1)

    mounted.switchAccount(current)
    expect(mounted.readProvided()).toBe(current)
    label.value = 'current'
    await vue.nextTick()

    const second = mutateAsync('second', {
      onSuccess: (_data, _vars, _onMutateResult, context) => {
        perCall = context.client as QueryClient
      },
    })
    releaseFirst('first-result')
    await firstResult
    await second

    expect(accountName(seenOnMutate)).toBe('current')
    expect(accountName(seenFn)).toBe('current')
    expect(seenMeta).toBe('current')
    expect(accountName(perCall)).toBe('current')
    expect(current.getQueryData(['optimistic', 'second'])).toBe(true)
    expect(current.getQueryData(['settled', 'second'])).toBe(true)
    expect(
      current
        .getMutationCache()
        .findAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['second'])
    expect(
      previous
        .getMutationCache()
        .findAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['first'])
    expect(previous.getQueryData(['optimistic', 'first'])).toBe(true)
    expect(previous.getQueryData(['optimistic', 'second'])).toBeUndefined()
    expect(previous.getQueryData(['settled', 'first'])).toBe(true)
    expect(previous.getQueryData(['settled', 'second'])).toBeUndefined()
    expect(later.getMutationCache().findAll()).toHaveLength(0)
    expect(later.getQueryData(['optimistic', 'second'])).toBeUndefined()
    expect(later.getQueryData(['settled', 'second'])).toBeUndefined()

    mounted.unmount()
  })

  it('lists mutations and the pending count from the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    const status = vue.ref<'idle' | 'pending' | 'success'>('idle')
    const mutationKey = vue.ref('previous')
    let variables!: ReturnType<typeof useMutationState<string>>
    let pending!: ReturnType<typeof useIsMutating>

    const mounted = mountWithClient(previous, () => {
      variables = useMutationState(() => ({
        filters: { status: status.value },
        select: (mutation) => mutation.state.variables as string,
      }))
      pending = useIsMutating(() => ({ mutationKey: [mutationKey.value] }))
    })

    mounted.switchAccount(current)
    status.value = 'pending'
    mutationKey.value = 'current'
    await vue.nextTick()

    let release!: (value: string) => void
    const gate = new Promise<string>((resolve) => {
      release = resolve
    })
    const observer = new MutationObserver(current, {
      mutationKey: ['current'],
      mutationFn: () => gate,
    })
    const inFlight = observer.mutate('from-current')
    await flushWork()

    expect(variables.value).toEqual(['from-current'])
    expect(pending.value).toBe(1)
    expect(previous.getMutationCache().findAll()).toHaveLength(0)

    release('done')
    await inFlight
    mounted.unmount()
  })

  it('refetches useQuery against the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    const id = vue.ref(1)
    let query!: ReturnType<typeof useQuery>
    const seen: Array<QueryClient> = []

    const mounted = mountWithClient(previous, () => {
      query = useQuery(() => ({
        queryKey: ['profile', id.value],
        queryFn: async ({ client }: { client: QueryClient }) => {
          seen.push(client)
          return client === current ? 'current' : 'previous'
        },
      }))
    })

    await vi.waitFor(() => {
      expect(query.data.value).toBe('previous')
    })

    mounted.switchAccount(current)
    const refetched = await query.refetch()
    expect(refetched.data).toBe('current')
    expect(accountName(seen.at(-1))).toBe('current')
    expect(current.getQueryData(['profile', 1])).toBe('current')
    expect(previous.getQueryData(['profile', 1])).toBe('previous')

    id.value = 2
    await vi.waitFor(() => {
      expect(query.data.value).toBe('current')
    })
    expect(current.getQueryData(['profile', 2])).toBe('current')
    expect(previous.getQueryData(['profile', 2])).toBeUndefined()

    const suspended = await query.suspense()
    expect(suspended.data).toBe('current')
    expect(seen.some((client) => accountName(client) === 'previous')).toBe(
      true,
    )
    expect(accountName(seen.at(-1))).toBe('current')

    mounted.unmount()
  })

  it('fetches the next infinite page on the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    let infinite!: ReturnType<typeof useInfiniteQuery>
    const seen: Array<QueryClient> = []

    const mounted = mountWithClient(previous, () => {
      infinite = useInfiniteQuery({
        queryKey: ['pages'],
        initialPageParam: 0,
        queryFn: async ({
          client,
          pageParam,
        }: {
          client: QueryClient
          pageParam: number
        }) => {
          seen.push(client)
          return { pageParam, account: client === current ? 'current' : 'previous' }
        },
        getNextPageParam: (last: { pageParam: number }) => last.pageParam + 1,
      })
    })

    await vi.waitFor(() => {
      expect(infinite.isSuccess.value).toBe(true)
    })

    mounted.switchAccount(current)
    const next = await infinite.fetchNextPage()
    expect(accountName(seen.at(-1))).toBe('current')
    expect(
      next.data?.pages.some((page) => page.account === 'current'),
    ).toBe(true)
    const currentPages = current.getQueryData<{
      pages: Array<{ account: string }>
    }>(['pages'])
    expect(currentPages?.pages.some((page) => page.account === 'current')).toBe(
      true,
    )
    expect(previous.getQueryData(['pages'])).toMatchObject({
      pages: [{ account: 'previous' }],
    })

    mounted.unmount()
  })

  it('runs useQueries on the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    const id = vue.ref(1)
    let queries!: ReturnType<typeof useQueries>
    const seen: Array<QueryClient> = []

    const mounted = mountWithClient(previous, () => {
      queries = useQueries({
        queries: () => [
          {
            queryKey: ['item', id.value],
            queryFn: async ({ client }: { client: QueryClient }) => {
              seen.push(client)
              return client === current ? 'current' : 'previous'
            },
          },
        ],
      })
    })

    await vi.waitFor(() => {
      expect(queries.value[0]?.data).toBe('previous')
    })

    mounted.switchAccount(current)
    id.value = 2
    await vi.waitFor(() => {
      expect(queries.value[0]?.data).toBe('current')
    })
    expect(accountName(seen.at(-1))).toBe('current')
    expect(current.getQueryData(['item', 2])).toBe('current')
    expect(previous.getQueryData(['item', 2])).toBeUndefined()

    mounted.unmount()
  })

  it('counts fetches on the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    const label = vue.ref('previous')
    let fetching!: ReturnType<typeof useIsFetching>

    const mounted = mountWithClient(previous, () => {
      fetching = useIsFetching(() => ({ queryKey: ['box', label.value] }))
    })

    mounted.switchAccount(current)
    label.value = 'current'
    await vue.nextTick()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = current.fetchQuery({
      queryKey: ['box', 'current'],
      queryFn: () => gate.then(() => 'ok'),
    })
    await flushWork()

    expect(fetching.value).toBe(1)
    expect(previous.isFetching()).toBe(0)

    release()
    await pending
    mounted.unmount()
  })

  it('prefetches on the client provided after setup', async () => {
    const { previous, current } = createAccountClients()
    const id = vue.ref('previous')
    const page = vue.ref(0)
    const seen: Array<QueryClient> = []

    const mounted = mountWithClient(previous, () => {
      usePrefetchQuery(() => ({
        queryKey: ['post', id.value],
        queryFn: async ({ client }: { client: QueryClient }) => {
          seen.push(client)
          return client === current ? 'current' : 'previous'
        },
      }))
      usePrefetchInfiniteQuery(() => ({
        queryKey: ['feed', page.value],
        initialPageParam: 0,
        queryFn: async ({ client }: { client: QueryClient }) => {
          seen.push(client)
          return client === current ? 'current' : 'previous'
        },
        getNextPageParam: () => undefined,
      }))
    })

    await vi.waitFor(() => {
      expect(previous.getQueryData(['post', 'previous'])).toBe('previous')
      expect(previous.getQueryData(['feed', 0])).toMatchObject({
        pages: ['previous'],
      })
    })

    mounted.switchAccount(current)
    id.value = 'current'
    page.value = 1
    await vi.waitFor(() => {
      expect(current.getQueryData(['post', 'current'])).toBe('current')
      expect(current.getQueryData(['feed', 1])).toMatchObject({
        pages: ['current'],
      })
    })
    expect(previous.getQueryData(['post', 'current'])).toBeUndefined()
    expect(previous.getQueryData(['feed', 1])).toBeUndefined()
    expect(seen.some((client) => accountName(client) === 'current')).toBe(true)

    mounted.unmount()
  })
  },
)
