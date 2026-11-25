import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createRenderEffect, createSignal } from 'solid-js'
import { queryKey } from '@tanstack/query-test-utils'
import { QueryClient, QueryClientProvider, useMutation, useQueries } from '..'
import type { QueryClient as QueryClientType } from '..'

/**
 * useQueries and useMutation keep the observer created for the first client.
 * These tests fail until that observer is replaced when the client changes.
 * useQuery in this package already rebuilds its observer and is not covered here.
 */

type Account = 'a' | 'b'

type Seen = {
  account: Account
  values: Array<unknown>
}

type Clients = Record<Account, QueryClientType>

function createAccountClient(): QueryClientType {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnMount: true,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })
}

function cached(account: Account, name: string): string {
  return `${account}:cached:${name}`
}

function fetched(account: Account, name: string): string {
  return `${account}:fetched:${name}`
}

function clientLabel(
  client: QueryClientType,
  clients: Clients,
): Account | 'other' {
  if (client === clients.a) {
    return 'a'
  }
  if (client === clients.b) {
    return 'b'
  }
  return 'other'
}

function expectCurrentAccount(
  seen: Array<Seen>,
  account: Account,
  values: Array<unknown>,
) {
  const reads = seen
    .filter((entry) => entry.account === account)
    .map((entry) => entry.values)
  expect(reads.length).toBeGreaterThan(0)
  for (const read of reads) {
    expect(read).toEqual(values)
  }
}

describe('solid query client switch while a primitive stays mounted', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders every useQueries result from the client that is current for that update', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients: Clients = {
      a: createAccountClient(),
      b: createAccountClient(),
    }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List(props: { account: Account }) {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: messagesKey,
            queryFn: () => Promise.resolve(fetched(props.account, 'messages')),
          },
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve(fetched(props.account, 'profile')),
          },
        ],
      }))

      createRenderEffect(() => {
        seen.push({
          account: props.account,
          values: [results[0].data, results[1].data],
        })
      })

      return (
        <div>
          {String(results[0].data)}|{String(results[1].data)}
        </div>
      )
    }

    function Page() {
      const [account, setAccount] = createSignal<Account>('a')
      return (
        <QueryClientProvider client={clients[account()]}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <List account={account()} />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Page />)
    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
    expect(
      rendered.getByText(
        `${cached('b', 'messages')}|${cached('b', 'profile')}`,
      ),
    ).toBeInTheDocument()
  })

  it('renders useQueries from the client accessor passed to the primitive', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients: Clients = {
      a: createAccountClient(),
      b: createAccountClient(),
    }
    const holder = createAccountClient()
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List(props: { account: Account; client: QueryClientType }) {
      const results = useQueries(
        () => ({
          queries: [
            {
              queryKey: messagesKey,
              queryFn: () =>
                Promise.resolve(fetched(props.account, 'messages')),
            },
            {
              queryKey: profileKey,
              queryFn: () => Promise.resolve(fetched(props.account, 'profile')),
            },
          ],
        }),
        () => props.client,
      )

      createRenderEffect(() => {
        seen.push({
          account: props.account,
          values: [results[0].data, results[1].data],
        })
      })

      return (
        <div>
          {String(results[0].data)}|{String(results[1].data)}
        </div>
      )
    }

    function Page() {
      const [account, setAccount] = createSignal<Account>('a')
      return (
        <QueryClientProvider client={holder}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <List account={account()} client={clients[account()]} />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Page />)
    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
    expect(holder.getQueryData(messagesKey)).toBeUndefined()
    expect(holder.getQueryData(profileKey)).toBeUndefined()
  })

  it('stores a useQueries refetch on the client that is current when the refetch starts', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients: Clients = {
      a: createAccountClient(),
      b: createAccountClient(),
    }
    const seenClients: Array<QueryClientType> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List(props: { account: Account }) {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: messagesKey,
            queryFn: ({ client }: { client: QueryClientType }) => {
              seenClients.push(client)
              return Promise.resolve(fetched(props.account, 'messages'))
            },
          },
          {
            queryKey: profileKey,
            queryFn: ({ client }: { client: QueryClientType }) => {
              seenClients.push(client)
              return Promise.resolve(fetched(props.account, 'profile'))
            },
          },
        ],
      }))

      return (
        <div>
          <div>
            {String(results[0].data)}|{String(results[1].data)}
          </div>
          <button
            type="button"
            onClick={() => {
              void results[0].refetch()
              void results[1].refetch()
            }}
          >
            refetch
          </button>
        </div>
      )
    }

    function Page() {
      const [account, setAccount] = createSignal<Account>('a')
      return (
        <QueryClientProvider client={clients[account()]}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <List account={account()} />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Page />)
    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    seenClients.length = 0
    fireEvent.click(rendered.getByRole('button', { name: 'refetch' }))
    await vi.advanceTimersByTimeAsync(0)

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toBe(fetched('b', 'messages'))
    expect(clients.b.getQueryData(profileKey)).toBe(fetched('b', 'profile'))
    expect(clients.a.getQueryData(messagesKey)).toBe(cached('a', 'messages'))
    expect(clients.a.getQueryData(profileKey)).toBe(cached('a', 'profile'))
  })

  it('stores a useMutation started after a client switch on the current client', async () => {
    vi.useFakeTimers()
    const clients: Clients = {
      a: createAccountClient(),
      b: createAccountClient(),
    }

    function Saver(props: { account: Account }) {
      const mutation = useMutation(() => ({
        mutationFn: () => Promise.resolve(fetched(props.account, 'mutation')),
      }))

      return (
        <button type="button" onClick={() => void mutation.mutateAsync()}>
          save
        </button>
      )
    }

    function Page() {
      const [account, setAccount] = createSignal<Account>('a')
      return (
        <QueryClientProvider client={clients[account()]}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <Saver account={account()} />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Page />)
    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    fireEvent.click(rendered.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)

    expect({
      current: clients.b
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
      previous: clients.a
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
    }).toEqual({
      current: [fetched('b', 'mutation')],
      previous: [],
    })
  })
})
