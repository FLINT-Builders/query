import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { render } from '@solidjs/testing-library'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from '..'
import type { QueryClient as QueryClientType } from '..'
import type { QueryFunctionContext } from '@tanstack/query-core'

/**
 * Account-scoped clients. Each query function records the client that actually
 * executed it so a stale observer cannot pass by fetching the previous account.
 */
function accountClients() {
  const clientA = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const clientB = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const calls: Array<QueryClientType> = []

  const queryFn = (context: QueryFunctionContext): Promise<string> => {
    calls.push(context.client as QueryClientType)
    const label = context.client === clientA ? 'account-a' : 'account-b'
    return sleep(10).then(() => label)
  }

  return { clientA, clientB, calls, queryFn }
}

const freshOptions = {
  staleTime: Infinity,
  refetchOnMount: false as const,
  refetchOnReconnect: false as const,
  refetchOnWindowFocus: false as const,
}

describe('query client replacement', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear())
    vi.useRealTimers()
  })

  it('shows the new provider client cache and ignores later updates from the previous client', async () => {
    vi.useFakeTimers()
    const key = queryKey()
    const { clientA, clientB, calls, queryFn } = accountClients()
    clients.push(clientA, clientB)
    clientB.setQueryData(key, 'account-b-cached')

    const [client, setClient] = createSignal(clientA)

    function Page() {
      const query = useQuery(() => ({
        queryKey: key,
        queryFn,
        ...freshOptions,
      }))

      return <div data-testid="data">{String(query.data ?? 'none')}</div>
    }

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <Page />
      </QueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(10)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-a')
    expect(calls).toEqual([clientA])

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')
    expect(calls).toEqual([clientA])

    clientA.setQueryData(key, 'account-a-updated')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')
    expect(rendered.getByTestId('data')).not.toHaveTextContent(
      'account-a-updated',
    )

    clientB.setQueryData(key, 'account-b-updated')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-updated')
  })

  it('fetches the new provider client and keeps its result when the previous client updates', async () => {
    vi.useFakeTimers()
    const key = queryKey()
    const { clientA, clientB, calls, queryFn } = accountClients()
    clients.push(clientA, clientB)

    const [client, setClient] = createSignal(clientA)

    function Page() {
      const query = useQuery(() => ({
        queryKey: key,
        queryFn,
        ...freshOptions,
      }))

      return <div data-testid="data">{String(query.data ?? 'none')}</div>
    }

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <Page />
      </QueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(10)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-a')
    expect(calls).toEqual([clientA])

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(10)

    expect(calls).toEqual([clientA, clientB])
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b')
    expect(clientB.getQueryCache().find({ queryKey: key })?.state.data).toBe(
      'account-b',
    )

    clientA.setQueryData(key, 'account-a-updated')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b')
    expect(calls.filter((called) => called === clientA)).toHaveLength(1)
  })

  it('shows the new query client passed to useQuery and ignores the previous client', async () => {
    vi.useFakeTimers()
    const key = queryKey()
    const { clientA, clientB, calls, queryFn } = accountClients()
    clients.push(clientA, clientB)
    clientB.setQueryData(key, 'account-b-cached')

    const [client, setClient] = createSignal(clientA)

    function Page(props: { client: () => QueryClient }) {
      const query = useQuery(
        () => ({
          queryKey: key,
          queryFn,
          ...freshOptions,
        }),
        props.client,
      )

      return <div data-testid="data">{String(query.data ?? 'none')}</div>
    }

    const rendered = render(() => <Page client={client} />)

    await vi.advanceTimersByTimeAsync(10)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-a')

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')
    expect(calls).toEqual([clientA])

    clientA.setQueryData(key, 'account-a-updated')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')

    clientB.setQueryData(key, 'account-b-updated')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-updated')
  })

  it('shows the new provider client for an infinite query and ignores the previous client', async () => {
    vi.useFakeTimers()
    const key = queryKey()
    const { clientA, clientB, calls, queryFn } = accountClients()
    clients.push(clientA, clientB)
    clientB.setQueryData(key, {
      pages: ['account-b-cached'],
      pageParams: [0],
    })

    const [client, setClient] = createSignal(clientA)

    function Page() {
      const query = useInfiniteQuery(() => ({
        queryKey: key,
        queryFn,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        ...freshOptions,
      }))

      return (
        <div data-testid="data">{query.data?.pages.join(',') ?? 'none'}</div>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <Page />
      </QueryClientProvider>
    ))

    await vi.advanceTimersByTimeAsync(10)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-a')
    expect(calls).toEqual([clientA])

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')
    expect(calls).toEqual([clientA])

    clientA.setQueryData(key, {
      pages: ['account-a-updated'],
      pageParams: [0],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-cached')

    clientB.setQueryData(key, {
      pages: ['account-b-updated'],
      pageParams: [0],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('data')).toHaveTextContent('account-b-updated')
  })
})
