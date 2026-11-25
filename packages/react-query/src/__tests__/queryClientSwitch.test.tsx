import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQueries,
  useSuspenseQuery,
} from '..'
import type { QueryClient as QueryClientType } from '..'

/**
 * Spec for observers that outlive the QueryClient they were created with.
 *
 * These tests fail while a mounted query or mutation observer keeps reading
 * and writing the client from its first render after QueryClientProvider
 * publishes a different client. They pass once that observer follows the
 * client useQueryClient resolves on the render that sees the new identity.
 */

const clients: Array<QueryClient> = []

function createClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        queryFn: () => {
          throw new Error('queryFn should not run unless a test overrides it')
        },
      },
      mutations: { retry: false, gcTime: Infinity },
    },
  })
  clients.push(client)
  return client
}

afterEach(() => {
  clients.forEach((client) => {
    client.clear()
    client.unmount()
  })
  clients.length = 0
  vi.useRealTimers()
})

function mountWithClient(client: QueryClient, ui: React.ReactElement) {
  const rendered = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  )

  return {
    ...rendered,
    replaceClient(nextClient: QueryClient, nextUi: React.ReactElement = ui) {
      rendered.rerender(
        <QueryClientProvider client={nextClient}>{nextUi}</QueryClientProvider>,
      )
    },
  }
}

function rendersAfter<T>(seen: Array<T>, index: number): Array<T> {
  return seen.slice(index)
}

describe('QueryClient identity change with a mounted observer', () => {
  it('useQuery shows the replacement client cache and does not render the previous account', () => {
    const key = ['profile']
    const seen: Array<unknown> = []
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    clientB.setQueryData(key, 'profile-b')

    function StableProfile() {
      const { data } = useQuery({
        queryKey: key,
        staleTime: Infinity,
      })
      seen.push(data)
      return <span>stable: {String(data)}</span>
    }

    function ProfileMountedAfterSwitch() {
      const { data } = useQuery({
        queryKey: key,
        staleTime: Infinity,
      })
      return <span>mounted-after: {String(data)}</span>
    }

    function Page({ showLate }: { showLate: boolean }) {
      return (
        <>
          <StableProfile />
          {showLate ? <ProfileMountedAfterSwitch /> : null}
        </>
      )
    }

    const view = mountWithClient(clientA, <Page showLate={false} />)
    expect(view.getByText('stable: profile-a')).toBeInTheDocument()
    const switchIndex = seen.length

    view.replaceClient(clientB, <Page showLate />)

    expect(view.getByText('stable: profile-b')).toBeInTheDocument()
    expect(view.getByText('mounted-after: profile-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a')
    expect(clientA.getQueryData(key)).toBe('profile-a')
    expect(clientB.getQueryData(key)).toBe('profile-b')
  })

  it('useQuery stores a refetch after the switch on the replacement client', async () => {
    const key = ['profile']
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    clientB.setQueryData(key, 'profile-b')
    const refetch = React.createRef<() => Promise<unknown>>()

    function Page() {
      const result = useQuery({
        queryKey: key,
        queryFn: () => 'profile-b-refetched',
        staleTime: Infinity,
      })
      refetch.current = result.refetch
      return <span>data: {String(result.data)}</span>
    }

    const view = mountWithClient(clientA, <Page />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    view.replaceClient(clientB)
    expect(view.getByText('data: profile-b')).toBeInTheDocument()

    await act(async () => {
      await refetch.current?.()
    })

    expect(
      await view.findByText('data: profile-b-refetched'),
    ).toBeInTheDocument()
    expect(clientB.getQueryData(key)).toBe('profile-b-refetched')
    expect(clientA.getQueryData(key)).toBe('profile-a')
  })

  it('useQuery stores a query key change after the switch on the replacement client', async () => {
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(['profile', 'a'], 'profile-a')
    clientB.setQueryData(['profile', 'a'], 'profile-b')

    function Page({ id }: { id: string }) {
      const { data } = useQuery({
        queryKey: ['profile', id],
        queryFn: () => `profile-${id}-fetched`,
        staleTime: Infinity,
      })
      return <span>data: {String(data)}</span>
    }

    const view = mountWithClient(clientA, <Page id="a" />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    view.replaceClient(clientB, <Page id="a" />)
    expect(view.getByText('data: profile-b')).toBeInTheDocument()

    view.replaceClient(clientB, <Page id="c" />)

    expect(await view.findByText('data: profile-c-fetched')).toBeInTheDocument()
    expect(clientB.getQueryData(['profile', 'c'])).toBe('profile-c-fetched')
    expect(clientA.getQueryData(['profile', 'c'])).toBeUndefined()
    expect(clientA.getQueryData(['profile', 'a'])).toBe('profile-a')
  })

  it('useQuery follows an explicit QueryClient argument when that identity changes', async () => {
    const key = ['profile']
    const providerClient = createClient()
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    clientB.setQueryData(key, 'profile-b')
    const seen: Array<unknown> = []
    const refetch = React.createRef<() => Promise<unknown>>()

    function Page({ client }: { client: QueryClientType }) {
      const result = useQuery(
        {
          queryKey: key,
          queryFn: () => 'profile-b-refetched',
          staleTime: Infinity,
        },
        client,
      )
      seen.push(result.data)
      refetch.current = result.refetch
      return <span>data: {String(result.data)}</span>
    }

    const view = mountWithClient(providerClient, <Page client={clientA} />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(providerClient, <Page client={clientB} />)

    expect(view.getByText('data: profile-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a')

    await act(async () => {
      await refetch.current?.()
    })

    expect(clientB.getQueryData(key)).toBe('profile-b-refetched')
    expect(clientA.getQueryData(key)).toBe('profile-a')
    expect(providerClient.getQueryData(key)).toBeUndefined()
  })

  it('useQuery fetches an empty replacement client instead of keeping the previous account', async () => {
    const key = ['profile']
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    let account = 'a'

    function Page() {
      const { data } = useQuery({
        queryKey: key,
        queryFn: () => `profile-${account}`,
        staleTime: Infinity,
      })
      return <span>data: {String(data)}</span>
    }

    const view = mountWithClient(clientA, <Page />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()

    account = 'b'
    view.replaceClient(clientB)

    expect(view.queryByText('data: profile-a')).not.toBeInTheDocument()
    expect(await view.findByText('data: profile-b')).toBeInTheDocument()
    expect(clientB.getQueryData(key)).toBe('profile-b')
    expect(clientA.getQueryData(key)).toBe('profile-a')
  })

  it('useQuery stores refetchInterval results on the replacement client', async () => {
    vi.useFakeTimers()
    const key = ['profile']
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    let fetches = 0

    function Page() {
      const { data } = useQuery({
        queryKey: key,
        queryFn: () => {
          fetches++
          return `fetch-${fetches}`
        },
        staleTime: Infinity,
        refetchInterval: 1000,
        refetchIntervalInBackground: true,
      })
      return <span>data: {String(data)}</span>
    }

    const view = mountWithClient(clientA, <Page />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    expect(fetches).toBe(0)

    view.replaceClient(clientB)
    await act(() => vi.advanceTimersByTimeAsync(1000))

    expect(clientA.getQueryData(key)).toBe('profile-a')
    expect(clientB.getQueryData(key)).toMatch(/^fetch-/)
    expect(fetches).toBeGreaterThan(0)
    expect(view.queryByText('data: profile-a')).not.toBeInTheDocument()
  })

  it('useInfiniteQuery shows the replacement cache and stores fetchNextPage there', async () => {
    const key = ['feed']
    const clientA = createClient()
    const clientB = createClient()
    const pageA = { pages: ['cached-a'], pageParams: [0] }
    const pageB = { pages: ['cached-b'], pageParams: [0] }
    clientA.setQueryData(key, pageA)
    clientB.setQueryData(key, pageB)
    const seen: Array<unknown> = []
    const fetchNext = React.createRef<() => Promise<unknown>>()

    function Page() {
      const result = useInfiniteQuery({
        queryKey: key,
        queryFn: ({ pageParam }) => `page-${pageParam}`,
        initialPageParam: 0,
        getNextPageParam: (_lastPage, allPages) => allPages.length,
        staleTime: Infinity,
      })
      seen.push(result.data?.pages[0])
      fetchNext.current = result.fetchNextPage
      return <span>page: {String(result.data?.pages.join(','))}</span>
    }

    const view = mountWithClient(clientA, <Page />)
    expect(view.getByText('page: cached-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(clientB)

    expect(view.getByText('page: cached-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('cached-a')

    await act(async () => {
      await fetchNext.current?.()
    })

    expect(view.getByText('page: cached-b,page-1')).toBeInTheDocument()
    expect(clientB.getQueryData(key)).toEqual({
      pages: ['cached-b', 'page-1'],
      pageParams: [0, 1],
    })
    expect(clientA.getQueryData(key)).toEqual(pageA)
  })

  it('useSuspenseQuery shows the replacement cache and fetches an empty replacement client', async () => {
    const key = ['profile']
    const clientA = createClient()
    const clientB = createClient()
    const clientC = createClient()
    clientA.setQueryData(key, 'profile-a')
    clientB.setQueryData(key, 'profile-b')
    const seen: Array<unknown> = []
    let account = 'b'

    function Page() {
      const { data } = useSuspenseQuery({
        queryKey: key,
        queryFn: () => `profile-${account}`,
        staleTime: Infinity,
      })
      seen.push(data)
      return <span>data: {String(data)}</span>
    }

    function App() {
      return (
        <React.Suspense fallback={<span>loading</span>}>
          <Page />
        </React.Suspense>
      )
    }

    const view = mountWithClient(clientA, <App />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(clientB)

    expect(view.getByText('data: profile-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a')
    expect(clientA.getQueryData(key)).toBe('profile-a')

    account = 'c'
    view.replaceClient(clientC)
    expect(view.queryByText('data: profile-b')).not.toBeInTheDocument()
    expect(view.queryByText('data: profile-a')).not.toBeInTheDocument()
    expect(await view.findByText('data: profile-c')).toBeInTheDocument()
    expect(clientC.getQueryData(key)).toBe('profile-c')
    expect(clientB.getQueryData(key)).toBe('profile-b')
    expect(clientA.getQueryData(key)).toBe('profile-a')
  })

  it('useSuspenseInfiniteQuery shows the replacement cache and stores fetchNextPage there', async () => {
    const key = ['feed']
    const clientA = createClient()
    const clientB = createClient()
    const pageA = { pages: ['cached-a'], pageParams: [0] }
    const pageB = { pages: ['cached-b'], pageParams: [0] }
    clientA.setQueryData(key, pageA)
    clientB.setQueryData(key, pageB)
    const seen: Array<unknown> = []
    const fetchNext = React.createRef<() => Promise<unknown>>()

    function Page() {
      const result = useSuspenseInfiniteQuery({
        queryKey: key,
        queryFn: ({ pageParam }) => `page-${pageParam}`,
        initialPageParam: 0,
        getNextPageParam: (_lastPage, allPages) => allPages.length,
        staleTime: Infinity,
      })
      seen.push(result.data.pages[0])
      fetchNext.current = result.fetchNextPage
      return <span>page: {result.data.pages.join(',')}</span>
    }

    const view = mountWithClient(
      clientA,
      <React.Suspense fallback={<span>loading</span>}>
        <Page />
      </React.Suspense>,
    )
    expect(view.getByText('page: cached-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(clientB)

    expect(view.getByText('page: cached-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('cached-a')

    await act(async () => {
      await fetchNext.current?.()
    })

    expect(view.getByText('page: cached-b,page-1')).toBeInTheDocument()
    expect(clientB.getQueryData(key)).toEqual({
      pages: ['cached-b', 'page-1'],
      pageParams: [0, 1],
    })
    expect(clientA.getQueryData(key)).toEqual(pageA)
  })

  it('useQueries shows the replacement cache and stores a refetch there', async () => {
    const key1 = ['profile']
    const key2 = ['session']
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key1, 'profile-a')
    clientA.setQueryData(key2, 'session-a')
    clientB.setQueryData(key1, 'profile-b')
    clientB.setQueryData(key2, 'session-b')
    const seen: Array<string> = []
    const refetch = React.createRef<() => Promise<unknown>>()

    function Page() {
      const results = useQueries({
        queries: [
          {
            queryKey: key1,
            queryFn: () => 'profile-b-refetched',
            staleTime: Infinity,
          },
          {
            queryKey: key2,
            queryFn: () => 'session-b-refetched',
            staleTime: Infinity,
          },
        ],
      })
      seen.push(`${String(results[0]?.data)}|${String(results[1]?.data)}`)
      refetch.current = results[0]?.refetch
      return (
        <span>
          data: {String(results[0]?.data)}|{String(results[1]?.data)}
        </span>
      )
    }

    const view = mountWithClient(clientA, <Page />)
    expect(view.getByText('data: profile-a|session-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(clientB)

    expect(view.getByText('data: profile-b|session-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a|session-a')

    await act(async () => {
      await refetch.current?.()
    })

    expect(
      view.getByText('data: profile-b-refetched|session-b'),
    ).toBeInTheDocument()
    expect(clientB.getQueryData(key1)).toBe('profile-b-refetched')
    expect(clientB.getQueryData(key2)).toBe('session-b')
    expect(clientA.getQueryData(key1)).toBe('profile-a')
    expect(clientA.getQueryData(key2)).toBe('session-a')
  })

  it('useSuspenseQueries shows the replacement cache and fetches an empty replacement client', async () => {
    const key1 = ['profile']
    const key2 = ['session']
    const clientA = createClient()
    const clientB = createClient()
    const clientC = createClient()
    clientA.setQueryData(key1, 'profile-a')
    clientA.setQueryData(key2, 'session-a')
    clientB.setQueryData(key1, 'profile-b')
    clientB.setQueryData(key2, 'session-b')
    const seen: Array<string> = []
    let account = 'b'

    function Page() {
      const results = useSuspenseQueries({
        queries: [
          {
            queryKey: key1,
            queryFn: () => `profile-${account}`,
            staleTime: Infinity,
          },
          {
            queryKey: key2,
            queryFn: () => `session-${account}`,
            staleTime: Infinity,
          },
        ],
      })
      seen.push(`${results[0].data}|${results[1].data}`)
      return (
        <span>
          data: {results[0].data}|{results[1].data}
        </span>
      )
    }

    function App() {
      return (
        <React.Suspense fallback={<span>loading</span>}>
          <Page />
        </React.Suspense>
      )
    }

    const view = mountWithClient(clientA, <App />)
    expect(view.getByText('data: profile-a|session-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(clientB)

    expect(view.getByText('data: profile-b|session-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a|session-a')

    account = 'c'
    view.replaceClient(clientC)
    expect(
      view.queryByText('data: profile-b|session-b'),
    ).not.toBeInTheDocument()
    expect(
      view.queryByText('data: profile-a|session-a'),
    ).not.toBeInTheDocument()
    expect(
      await view.findByText('data: profile-c|session-c'),
    ).toBeInTheDocument()
    expect(clientC.getQueryData(key1)).toBe('profile-c')
    expect(clientC.getQueryData(key2)).toBe('session-c')
    expect(clientA.getQueryData(key1)).toBe('profile-a')
    expect(clientB.getQueryData(key1)).toBe('profile-b')
  })

  it('useMutation stores a mutation after the switch on the replacement client', async () => {
    const clientA = createClient()
    const clientB = createClient()

    function Page() {
      const mutation = useMutation({
        mutationKey: ['save-profile'],
        mutationFn: async (value: string) => value,
      })
      return (
        <button type="button" onClick={() => mutation.mutate('saved-b')}>
          status: {mutation.status} data: {String(mutation.data ?? '')}
        </button>
      )
    }

    const view = mountWithClient(clientA, <Page />)
    expect(view.getByText('status: idle data:')).toBeInTheDocument()
    view.replaceClient(clientB)
    fireEvent.click(view.getByRole('button'))

    expect(
      await view.findByText('status: success data: saved-b'),
    ).toBeInTheDocument()
    expect(mutationData(clientA, clientB)).toEqual({
      previousClient: [],
      nextClient: ['saved-b'],
    })
  })

  it('useQueries follows an explicit QueryClient argument when that identity changes', async () => {
    const key = ['profile']
    const providerClient = createClient()
    const clientA = createClient()
    const clientB = createClient()
    clientA.setQueryData(key, 'profile-a')
    clientB.setQueryData(key, 'profile-b')
    const seen: Array<unknown> = []
    const refetch = React.createRef<() => Promise<unknown>>()

    function Page({ client }: { client: QueryClientType }) {
      const results = useQueries(
        {
          queries: [
            {
              queryKey: key,
              queryFn: () => 'profile-b-refetched',
              staleTime: Infinity,
            },
          ],
        },
        client,
      )
      seen.push(results[0]?.data)
      refetch.current = results[0]?.refetch
      return <span>data: {String(results[0]?.data)}</span>
    }

    const view = mountWithClient(providerClient, <Page client={clientA} />)
    expect(view.getByText('data: profile-a')).toBeInTheDocument()
    const switchIndex = seen.length
    view.replaceClient(providerClient, <Page client={clientB} />)

    expect(view.getByText('data: profile-b')).toBeInTheDocument()
    expect(rendersAfter(seen, switchIndex)).not.toContain('profile-a')

    await act(async () => {
      await refetch.current?.()
    })

    expect(clientB.getQueryData(key)).toBe('profile-b-refetched')
    expect(clientA.getQueryData(key)).toBe('profile-a')
    expect(providerClient.getQueryData(key)).toBeUndefined()
  })

  it('useMutation follows an explicit QueryClient argument when that identity changes', async () => {
    const providerClient = createClient()
    const clientA = createClient()
    const clientB = createClient()

    function Page({ client }: { client: QueryClientType }) {
      const mutation = useMutation(
        {
          mutationKey: ['save-profile'],
          mutationFn: async (value: string) => value,
        },
        client,
      )
      return (
        <button type="button" onClick={() => mutation.mutate('saved-b')}>
          status: {mutation.status} data: {String(mutation.data ?? '')}
        </button>
      )
    }

    const view = mountWithClient(providerClient, <Page client={clientA} />)
    view.replaceClient(providerClient, <Page client={clientB} />)
    fireEvent.click(view.getByRole('button'))

    expect(
      await view.findByText('status: success data: saved-b'),
    ).toBeInTheDocument()
    expect(mutationData(clientA, clientB)).toEqual({
      previousClient: [],
      nextClient: ['saved-b'],
    })
    expect(providerClient.getMutationCache().getAll()).toHaveLength(0)
  })
})

function mutationData(previousClient: QueryClient, nextClient: QueryClient) {
  const dataOf = (client: QueryClient) =>
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data)

  return {
    previousClient: dataOf(previousClient),
    nextClient: dataOf(nextClient),
  }
}
