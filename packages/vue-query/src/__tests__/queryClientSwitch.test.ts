import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import type { App } from 'vue'
import type { QueryClient } from '../queryClient'

vi.unmock('vue-demi')

const FIRST_EMAIL = 'first-account@example.test'
const SECOND_EMAIL = 'second-account@example.test'
const PROFILE_ERROR = 'profile rejected'

async function loadVueQuery() {
  const [
    queryClient,
    plugin,
    utils,
    mutationState,
    isFetching,
    query,
    queries,
    infiniteQuery,
    mutation,
    prefetchQuery,
    prefetchInfiniteQuery,
  ] = await Promise.all([
    import('../queryClient'),
    import('../vueQueryPlugin'),
    import('../utils'),
    import('../useMutationState'),
    import('../useIsFetching'),
    import('../useQuery'),
    import('../useQueries'),
    import('../useInfiniteQuery'),
    import('../useMutation'),
    import('../usePrefetchQuery'),
    import('../usePrefetchInfiniteQuery'),
  ])

  return {
    QueryClient: queryClient.QueryClient,
    VueQueryPlugin: plugin.VueQueryPlugin,
    VUE_QUERY_CLIENT: utils.VUE_QUERY_CLIENT,
    useMutationState: mutationState.useMutationState,
    useIsMutating: mutationState.useIsMutating,
    useIsFetching: isFetching.useIsFetching,
    useQuery: query.useQuery,
    useQueries: queries.useQueries,
    useInfiniteQuery: infiniteQuery.useInfiniteQuery,
    useMutation: mutation.useMutation,
    usePrefetchQuery: prefetchQuery.usePrefetchQuery,
    usePrefetchInfiniteQuery: prefetchInfiniteQuery.usePrefetchInfiniteQuery,
  }
}

function createClient(
  VueQueryClient: new (
    config?: ConstructorParameters<typeof QueryClient>[0],
  ) => QueryClient,
): QueryClient {
  return new VueQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  })
}

function mount(
  root: Parameters<typeof createApp>[0],
  plugin: { install: (app: App, ...options: Array<any>) => void },
  client: QueryClient,
): { app: App; el: HTMLElement } {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(root)
  app.use(plugin, { queryClient: client })
  app.mount(el)
  return { app, el }
}

async function seedSuccess(client: QueryClient, email: string): Promise<void> {
  await client
    .getMutationCache()
    .build(client, {
      mutationKey: ['profile'],
      mutationFn: (variables: { email: string }) => Promise.resolve(variables),
    })
    .execute({ email })
}

async function seedFailure(client: QueryClient, email: string): Promise<void> {
  await client
    .getMutationCache()
    .build(client, {
      mutationKey: ['profile-error'],
      mutationFn: () => Promise.reject(new Error(PROFILE_ERROR)),
    })
    .execute({ email })
    .catch(() => undefined)
}

function displayedMutation(mutation: {
  state: { variables: unknown; data: unknown; error: unknown }
}) {
  const error = mutation.state.error
  return {
    variables: mutation.state.variables,
    data: mutation.state.data,
    error: error instanceof Error ? error.message : error,
  }
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await nextTick()
}

describe('query client switch drops the previous account mutation state', () => {
  it('replaces useMutationState variables, data, and errors when a new client is provided', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    await seedSuccess(first, FIRST_EMAIL)
    await seedFailure(first, FIRST_EMAIL)
    await seedSuccess(second, SECOND_EMAIL)

    const Root = defineComponent({
      setup() {
        const state = api.useMutationState({
          select: displayedMutation,
        })
        return () => h('pre', JSON.stringify(state.value))
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    expect(el.textContent).toContain(FIRST_EMAIL)
    expect(el.textContent).toContain(PROFILE_ERROR)

    app.provide(api.VUE_QUERY_CLIENT, second)
    await flush()

    expect(el.textContent).toContain(SECOND_EMAIL)
    expect(el.textContent).not.toContain(FIRST_EMAIL)
    expect(el.textContent).not.toContain(PROFILE_ERROR)
    app.unmount()
    el.remove()
  })

  it('replaces useIsMutating when a new client is provided', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    void first
      .getMutationCache()
      .build(first, {
        mutationFn: () => new Promise(() => undefined),
      })
      .execute({ email: FIRST_EMAIL })

    const Root = defineComponent({
      setup() {
        const pending = api.useIsMutating()
        return () => h('pre', String(pending.value))
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    expect(el.textContent).toBe('1')

    app.provide(api.VUE_QUERY_CLIENT, second)
    await flush()

    expect(el.textContent).toBe('0')
    app.unmount()
    el.remove()
  })

  it('rereads filters from the client that is current after the switch', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    await seedSuccess(first, FIRST_EMAIL)
    await second
      .getMutationCache()
      .build(second, {
        mutationKey: ['other'],
        mutationFn: (variables: { email: string }) => Promise.resolve(variables),
      })
      .execute({ email: SECOND_EMAIL })
    const activeKey = ref('profile')

    const Root = defineComponent({
      setup() {
        const state = api.useMutationState(() => ({
          filters: { mutationKey: [activeKey.value] },
          select: (mutation) => mutation.state.variables,
        }))
        return () => h('pre', JSON.stringify(state.value))
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    expect(el.textContent).toContain(FIRST_EMAIL)

    app.provide(api.VUE_QUERY_CLIENT, second)
    activeKey.value = 'other'
    await flush()

    expect(el.textContent).toContain(SECOND_EMAIL)
    expect(el.textContent).not.toContain(FIRST_EMAIL)
    app.unmount()
    el.remove()
  })

  it('drops displayed mutation variables, data, and errors when the bound cache is cleared', async () => {
    const api = await loadVueQuery()
    const client = createClient(api.QueryClient)
    await seedSuccess(client, FIRST_EMAIL)
    await seedFailure(client, FIRST_EMAIL)

    const Root = defineComponent({
      setup() {
        const state = api.useMutationState(
          { select: displayedMutation },
          client,
        )
        return () => h('pre', JSON.stringify(state.value))
      },
    })

    const el = document.createElement('div')
    const app = createApp(Root)
    app.mount(el)
    await flush()
    expect(el.textContent).toContain(FIRST_EMAIL)
    expect(el.textContent).toContain(PROFILE_ERROR)

    client.clear()
    await flush()

    expect(client.getMutationCache().getAll()).toEqual([])
    expect(el.textContent).toBe('[]')
    app.unmount()
    el.remove()
  })

  it('shows the new client query data from useQuery, useInfiniteQuery, and useQueries', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    const infinite = (email: string) => ({
      pages: [{ email }],
      pageParams: [0],
    })
    first.setQueryData(['profile'], { email: FIRST_EMAIL })
    second.setQueryData(['profile'], { email: SECOND_EMAIL })
    first.setQueryData(['pages'], infinite(FIRST_EMAIL))
    second.setQueryData(['pages'], infinite(SECOND_EMAIL))

    const Root = defineComponent({
      setup() {
        const query = api.useQuery({
          queryKey: ['profile'],
          queryFn: () => Promise.resolve({ email: 'fetched' }),
        })
        const infiniteQuery = api.useInfiniteQuery({
          queryKey: ['pages'],
          queryFn: () => Promise.resolve({ email: 'fetched' }),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        })
        const queries = api.useQueries({
          queries: [
            {
              queryKey: ['profile'],
              queryFn: () => Promise.resolve({ email: 'fetched' }),
            },
          ],
        })
        return () =>
          h(
            'pre',
            JSON.stringify({
              query: query.data.value,
              infinite: infiniteQuery.data.value,
              queries: queries.value.map((result) => result.data),
            }),
          )
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    expect(el.textContent).toContain(FIRST_EMAIL)

    app.provide(api.VUE_QUERY_CLIENT, second)
    await flush()

    expect(el.textContent).toContain(SECOND_EMAIL)
    expect(el.textContent).not.toContain(FIRST_EMAIL)
    app.unmount()
    el.remove()
  })

  it('reports useIsFetching from the client provided after the switch', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)

    const Root = defineComponent({
      setup() {
        const fetching = api.useIsFetching()
        return () => h('pre', String(fetching.value))
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    void first
      .query({
        queryKey: ['profile'],
        queryFn: () => new Promise(() => undefined),
      })
      .catch(() => undefined)
    await flush()
    expect(el.textContent).toBe('1')

    app.provide(api.VUE_QUERY_CLIENT, second)
    await flush()

    expect(el.textContent).toBe('0')
    app.unmount()
    el.remove()
  })

  it('sends useMutation to the client provided after the switch and clears the previous result', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    let mutate: (email: string) => void = () => undefined

    const Root = defineComponent({
      setup() {
        const mutation = api.useMutation({
          mutationFn: (email: string) => Promise.resolve({ email }),
        })
        mutate = (email: string) => {
          mutation.mutate(email)
        }
        return () =>
          h(
            'pre',
            JSON.stringify({
              variables: mutation.variables.value,
              data: mutation.data.value,
            }),
          )
      },
    })

    const { app, el } = mount(Root, api.VueQueryPlugin, first)
    await flush()
    mutate(FIRST_EMAIL)
    await flush()
    expect(el.textContent).toContain(FIRST_EMAIL)

    app.provide(api.VUE_QUERY_CLIENT, second)
    await flush()
    expect(el.textContent).not.toContain(FIRST_EMAIL)

    mutate(SECOND_EMAIL)
    await flush()

    expect(
      second.getMutationCache().getAll().map((mutation) => mutation.state.variables),
    ).toContain(SECOND_EMAIL)
    expect(first.getMutationCache().getAll()).toHaveLength(0)
    expect(el.textContent).toContain(SECOND_EMAIL)
    expect(el.textContent).not.toContain(FIRST_EMAIL)
    app.unmount()
    el.remove()
  })

  it('prefetches into the client provided after the switch', async () => {
    const api = await loadVueQuery()
    const first = createClient(api.QueryClient)
    const second = createClient(api.QueryClient)
    const version = ref('one')

    const Root = defineComponent({
      setup() {
        api.usePrefetchQuery(() => ({
          queryKey: ['profile', version.value],
          queryFn: () => Promise.resolve({ email: 'prefetched@example.test' }),
        }))
        api.usePrefetchInfiniteQuery(() => ({
          queryKey: ['pages', version.value],
          queryFn: () =>
            Promise.resolve({ email: 'prefetched-pages@example.test' }),
          initialPageParam: 0,
          getNextPageParam: () => undefined,
        }))
        return () => h('span')
      },
    })

    const { app } = mount(Root, api.VueQueryPlugin, first)
    await flush()

    app.provide(api.VUE_QUERY_CLIENT, second)
    version.value = 'two'
    await flush()

    expect({
      first: first.getQueryData(['profile', 'two']),
      second: second.getQueryData(['profile', 'two']),
    }).toEqual({
      first: undefined,
      second: { email: 'prefetched@example.test' },
    })
    expect({
      first: first.getQueryData(['pages', 'two']),
      second: second.getQueryData(['pages', 'two']),
    }).toEqual({
      first: undefined,
      second: {
        pages: [{ email: 'prefetched-pages@example.test' }],
        pageParams: [0],
      },
    })
    app.unmount()
  })
})
