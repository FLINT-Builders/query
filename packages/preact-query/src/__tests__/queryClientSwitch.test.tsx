import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/preact'
import { Suspense } from 'preact/compat'
import { useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { queryKey } from '@tanstack/query-test-utils'
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
 * A mounted hook must read and write the QueryClient from the current render.
 * These tests fail while the hook keeps the observer it created for the first client.
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

function AccountSwitch({
  clients,
  children,
}: {
  clients: Clients
  children: (account: Account) => ComponentChildren
}) {
  const [account, setAccount] = useState<Account>('a')
  return (
    <QueryClientProvider client={clients[account]}>
      <button type="button" onClick={() => setAccount('b')}>
        switch-account
      </button>
      {children(account)}
    </QueryClientProvider>
  )
}

function switchAccount(rendered: ReturnType<typeof render>) {
  fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
}

describe('query client switch while a hook stays mounted', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders every useQueries result from the client that is current for that render', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const calls = { messages: 0, profile: 0 }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List({ account }: { account: Account }) {
      const results = useQueries({
        queries: [
          {
            queryKey: messagesKey,
            queryFn: () => {
              calls.messages += 1
              return Promise.resolve(fetched(account, 'messages'))
            },
          },
          {
            queryKey: profileKey,
            queryFn: () => {
              calls.profile += 1
              return Promise.resolve(fetched(account, 'profile'))
            },
          },
        ],
      })
      const values = results.map((result) => result.data)
      seen.push({ account, values })
      return <div data-testid="list">{values.join('|')}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )

    expectCurrentAccount(seen, 'a', [
      cached('a', 'messages'),
      cached('a', 'profile'),
    ])

    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
    expect(rendered.getByTestId('list').textContent).toBe(
      `${cached('b', 'messages')}|${cached('b', 'profile')}`,
    )
    expect(calls).toEqual({ messages: 0, profile: 0 })

    clients.a.setQueryData(messagesKey, 'a:pushed')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('list').textContent).toBe(
      `${cached('b', 'messages')}|${cached('b', 'profile')}`,
    )

    clients.b.setQueryData(messagesKey, 'b:pushed')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('list').textContent).toBe(
      `b:pushed|${cached('b', 'profile')}`,
    )
    expect(clients.a.getQueryData(messagesKey)).toBe('a:pushed')
    expect(clients.b.getQueryData(profileKey)).toBe(cached('b', 'profile'))
  })

  it('renders useQueries from the client passed as the hook argument', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const holder = createAccountClient()
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List({
      account,
      client,
    }: {
      account: Account
      client: QueryClientType
    }) {
      const results = useQueries(
        {
          queries: [
            {
              queryKey: messagesKey,
              queryFn: () => Promise.resolve(fetched(account, 'messages')),
            },
            {
              queryKey: profileKey,
              queryFn: () => Promise.resolve(fetched(account, 'profile')),
            },
          ],
        },
        client,
      )
      const values = results.map((result) => result.data)
      seen.push({ account, values })
      return <div data-testid="list">{values.join('|')}</div>
    }

    function Page() {
      const [account, setAccount] = useState<Account>('a')
      return (
        <QueryClientProvider client={holder}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <List account={account} client={clients[account]} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<Page />)
    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
    expect(rendered.getByTestId('list').textContent).toBe(
      `${cached('b', 'messages')}|${cached('b', 'profile')}`,
    )
    expect(holder.getQueryData(messagesKey)).toBeUndefined()
    expect(holder.getQueryData(profileKey)).toBeUndefined()
  })

  it('combines useQueries results from the client that is current for that render', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List({ account }: { account: Account }) {
      const combined = useQueries({
        queries: [
          {
            queryKey: messagesKey,
            queryFn: () => Promise.resolve(fetched(account, 'messages')),
          },
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve(fetched(account, 'profile')),
          },
        ],
        combine: (results) => results.map((result) => result.data),
      })
      seen.push({ account, values: combined })
      return <div data-testid="list">{combined.join('|')}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
    expect(rendered.getByTestId('list').textContent).toBe(
      `${cached('b', 'messages')}|${cached('b', 'profile')}`,
    )
  })

  it('stores a useQueries refetch on the client that is current when the refetch starts', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seenClients: Array<QueryClientType> = []
    let record = false
    const pending: { current: Promise<unknown> } = {
      current: Promise.resolve(),
    }

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List({ account }: { account: Account }) {
      const results = useQueries({
        queries: [messagesKey, profileKey].map((key) => ({
          queryKey: key,
          queryFn: ({ client }: { client: QueryClientType }) => {
            if (record) {
              seenClients.push(client)
            }
            const name = key === messagesKey ? 'messages' : 'profile'
            return Promise.resolve(fetched(account, name))
          },
        })),
      })
      const values = results.map((result) => result.data)
      return (
        <div>
          <div data-testid="list">{values.join('|')}</div>
          <button
            type="button"
            onClick={() => {
              pending.current = Promise.all(
                results.map((result) => result.refetch()),
              )
            }}
          >
            refetch
          </button>
        </div>
      )
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)
    record = true

    fireEvent.click(rendered.getByRole('button', { name: 'refetch' }))

    await act(async () => {
      await pending.current
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toBe(fetched('b', 'messages'))
    expect(clients.b.getQueryData(profileKey)).toBe(fetched('b', 'profile'))
    expect(clients.a.getQueryData(messagesKey)).toBe(cached('a', 'messages'))
    expect(clients.a.getQueryData(profileKey)).toBe(cached('a', 'profile'))
    expect(rendered.getByTestId('list').textContent).toBe(
      `${fetched('b', 'messages')}|${fetched('b', 'profile')}`,
    )
  })

  it('stores a useQueries interval refetch on the client that is current when the interval fires', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seenClients: Array<QueryClientType> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))

    function List({ account }: { account: Account }) {
      const [result] = useQueries({
        queries: [
          {
            queryKey: messagesKey,
            refetchInterval: 1000,
            refetchIntervalInBackground: true,
            queryFn: ({ client }: { client: QueryClientType }) => {
              seenClients.push(client)
              return Promise.resolve(fetched(account, 'messages'))
            },
          },
        ],
      })
      return <div data-testid="list">{String(result.data)}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)
    seenClients.length = 0

    await vi.advanceTimersByTimeAsync(1000)

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toBe(fetched('b', 'messages'))
    expect(clients.a.getQueryData(messagesKey)).toBe(cached('a', 'messages'))
    expect(rendered.getByTestId('list').textContent).toBe(
      fetched('b', 'messages'),
    )
  })

  it('renders useQuery from the client that is current for that render', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))

    function List({ account }: { account: Account }) {
      const result = useQuery({
        queryKey: messagesKey,
        queryFn: () => Promise.resolve(fetched(account, 'messages')),
      })
      seen.push({ account, values: [result.data] })
      return <div data-testid="list">{String(result.data)}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [cached('b', 'messages')])
    expect(rendered.getByTestId('list').textContent).toBe(
      cached('b', 'messages'),
    )

    clients.a.setQueryData(messagesKey, 'a:pushed')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('list').textContent).toBe(
      cached('b', 'messages'),
    )

    clients.b.setQueryData(messagesKey, 'b:pushed')
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('list').textContent).toBe('b:pushed')
  })

  it('renders useQuery from the client passed as the hook argument', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const holder = createAccountClient()
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))

    function List({
      account,
      client,
    }: {
      account: Account
      client: QueryClientType
    }) {
      const result = useQuery(
        {
          queryKey: messagesKey,
          queryFn: () => Promise.resolve(fetched(account, 'messages')),
        },
        client,
      )
      seen.push({ account, values: [result.data] })
      return <div data-testid="list">{String(result.data)}</div>
    }

    function Page() {
      const [account, setAccount] = useState<Account>('a')
      return (
        <QueryClientProvider client={holder}>
          <button type="button" onClick={() => setAccount('b')}>
            switch-account
          </button>
          <List account={account} client={clients[account]} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<Page />)
    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [cached('b', 'messages')])
    expect(holder.getQueryData(messagesKey)).toBeUndefined()
  })

  it('stores a useQuery refetch on the client that is current when the refetch starts', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seenClients: Array<QueryClientType> = []
    const pending: { current: Promise<unknown> } = {
      current: Promise.resolve(),
    }

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))

    function List({ account }: { account: Account }) {
      const result = useQuery({
        queryKey: messagesKey,
        queryFn: ({ client }) => {
          seenClients.push(client)
          return Promise.resolve(fetched(account, 'messages'))
        },
      })
      return (
        <div>
          <div data-testid="list">{String(result.data)}</div>
          <button
            type="button"
            onClick={() => {
              pending.current = result.refetch()
            }}
          >
            refetch
          </button>
        </div>
      )
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)
    seenClients.length = 0
    fireEvent.click(rendered.getByRole('button', { name: 'refetch' }))

    await act(async () => {
      await pending.current
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toBe(fetched('b', 'messages'))
    expect(clients.a.getQueryData(messagesKey)).toBe(cached('a', 'messages'))
    expect(rendered.getByTestId('list').textContent).toBe(
      fetched('b', 'messages'),
    )
  })

  it('renders useInfiniteQuery from the current client and stores fetchNextPage there', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []
    const seenClients: Array<QueryClientType> = []
    const pending: { current: Promise<unknown> } = {
      current: Promise.resolve(),
    }

    for (const account of ['a', 'b'] as const) {
      clients[account].setQueryData(messagesKey, {
        pages: [cached(account, 'page')],
        pageParams: [0],
      })
    }

    function List({ account }: { account: Account }) {
      const result = useInfiniteQuery({
        queryKey: messagesKey,
        initialPageParam: 0,
        queryFn: ({ pageParam, client }) => {
          seenClients.push(client)
          return Promise.resolve(`${account}:page:${String(pageParam)}`)
        },
        getNextPageParam: (_lastPage, _pages, lastPageParam) =>
          Number(lastPageParam) + 1,
      })
      const values = result.data?.pages ?? []
      seen.push({ account, values })
      return (
        <div>
          <div data-testid="list">{values.join('|')}</div>
          <button
            type="button"
            onClick={() => {
              pending.current = result.fetchNextPage()
            }}
          >
            next-page
          </button>
        </div>
      )
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <List account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expectCurrentAccount(seen, 'b', [cached('b', 'page')])
    expect(rendered.getByTestId('list').textContent).toBe(cached('b', 'page'))
    seenClients.length = 0
    fireEvent.click(rendered.getByRole('button', { name: 'next-page' }))

    await act(async () => {
      await pending.current
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toEqual({
      pages: [cached('b', 'page'), 'b:page:1'],
      pageParams: [0, 1],
    })
    expect(clients.a.getQueryData(messagesKey)).toEqual({
      pages: [cached('a', 'page')],
      pageParams: [0],
    })
    expect(rendered.getByTestId('list').textContent).toBe(
      `${cached('b', 'page')}|b:page:1`,
    )
  })

  it('renders useSuspenseQueries from the client that is current for that render', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const profileKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.a.setQueryData(profileKey, cached('a', 'profile'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))
    clients.b.setQueryData(profileKey, cached('b', 'profile'))

    function List({ account }: { account: Account }) {
      const results = useSuspenseQueries({
        queries: [
          {
            queryKey: messagesKey,
            queryFn: () => Promise.resolve(fetched(account, 'messages')),
          },
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve(fetched(account, 'profile')),
          },
        ],
      })
      const values = results.map((result) => result.data)
      seen.push({ account, values })
      return <div data-testid="list">{values.join('|')}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => (
          <Suspense fallback={<div>suspended</div>}>
            <List account={account} />
          </Suspense>
        )}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expect(rendered.queryByText('suspended')).not.toBeInTheDocument()
    expectCurrentAccount(seen, 'b', [
      cached('b', 'messages'),
      cached('b', 'profile'),
    ])
  })

  it('renders useSuspenseQuery from the client that is current for that render', () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []

    clients.a.setQueryData(messagesKey, cached('a', 'messages'))
    clients.b.setQueryData(messagesKey, cached('b', 'messages'))

    function List({ account }: { account: Account }) {
      const result = useSuspenseQuery({
        queryKey: messagesKey,
        queryFn: () => Promise.resolve(fetched(account, 'messages')),
      })
      seen.push({ account, values: [result.data] })
      return <div data-testid="list">{String(result.data)}</div>
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => (
          <Suspense fallback={<div>suspended</div>}>
            <List account={account} />
          </Suspense>
        )}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expect(rendered.queryByText('suspended')).not.toBeInTheDocument()
    expectCurrentAccount(seen, 'b', [cached('b', 'messages')])
  })

  it('renders useSuspenseInfiniteQuery from the current client and stores fetchNextPage there', async () => {
    vi.useFakeTimers()
    const messagesKey = queryKey()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const seen: Array<Seen> = []
    const seenClients: Array<QueryClientType> = []
    const pending: { current: Promise<unknown> } = {
      current: Promise.resolve(),
    }

    for (const account of ['a', 'b'] as const) {
      clients[account].setQueryData(messagesKey, {
        pages: [cached(account, 'page')],
        pageParams: [0],
      })
    }

    function List({ account }: { account: Account }) {
      const result = useSuspenseInfiniteQuery({
        queryKey: messagesKey,
        initialPageParam: 0,
        queryFn: ({ pageParam, client }) => {
          seenClients.push(client)
          return Promise.resolve(`${account}:page:${String(pageParam)}`)
        },
        getNextPageParam: (_lastPage, _pages, lastPageParam) =>
          Number(lastPageParam) + 1,
      })
      seen.push({ account, values: result.data.pages })
      return (
        <div>
          <div data-testid="list">{result.data.pages.join('|')}</div>
          <button
            type="button"
            onClick={() => {
              pending.current = result.fetchNextPage()
            }}
          >
            next-page
          </button>
        </div>
      )
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => (
          <Suspense fallback={<div>suspended</div>}>
            <List account={account} />
          </Suspense>
        )}
      </AccountSwitch>,
    )
    switchAccount(rendered)

    expect(rendered.queryByText('suspended')).not.toBeInTheDocument()
    expectCurrentAccount(seen, 'b', [cached('b', 'page')])
    seenClients.length = 0
    fireEvent.click(rendered.getByRole('button', { name: 'next-page' }))

    await act(async () => {
      await pending.current
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(seenClients.map((client) => clientLabel(client, clients))).toEqual([
      'b',
    ])
    expect(clients.b.getQueryData(messagesKey)).toEqual({
      pages: [cached('b', 'page'), 'b:page:1'],
      pageParams: [0, 1],
    })
    expect(clients.a.getQueryData(messagesKey)).toEqual({
      pages: [cached('a', 'page')],
      pageParams: [0],
    })
  })

  it('stores a useMutation started after a client switch on the current client', async () => {
    vi.useFakeTimers()
    const clients = { a: createAccountClient(), b: createAccountClient() }
    const pending: { current: Promise<unknown> } = {
      current: Promise.resolve(),
    }

    function Saver({ account }: { account: Account }) {
      const mutation = useMutation({
        mutationFn: () => Promise.resolve(fetched(account, 'mutation')),
      })
      return (
        <div>
          <div data-testid="mutation">{String(mutation.data ?? '')}</div>
          <button
            type="button"
            onClick={() => {
              pending.current = mutation.mutateAsync()
            }}
          >
            save
          </button>
        </div>
      )
    }

    const rendered = render(
      <AccountSwitch clients={clients}>
        {(account) => <Saver account={account} />}
      </AccountSwitch>,
    )
    switchAccount(rendered)
    fireEvent.click(rendered.getByRole('button', { name: 'save' }))

    await act(async () => {
      await pending.current
      await vi.advanceTimersByTimeAsync(0)
    })

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
    expect(rendered.getByTestId('mutation').textContent).toBe(
      fetched('b', 'mutation'),
    )
  })
})
