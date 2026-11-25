import { queryKey, sleep } from '@tanstack/query-test-utils'
import { fireEvent, render } from '@testing-library/preact'
import { Suspense } from 'preact/compat'
import { useState } from 'preact/hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQueries,
  useSuspenseQuery,
} from '..'
import type { ComponentChildren } from 'preact'

/**
 * These tests are the spec for rebinding Preact observers when the QueryClient
 * changes. They fail while an observer created on the first client keeps
 * reading and writing that client's cache after the mounted hook is given
 * another client.
 */

const PROFILE_A = 'from-account-a'
const PROFILE_B = 'from-account-b'
const INBOX_A = 'inbox-account-a'
const INBOX_B = 'inbox-account-b'
const UPDATED_PAYLOAD = 'updated-payload'
const NEXT_PAGE = 'next-page-payload'
const MUTATION = 'written-after-switch'

type AccountName = 'A' | 'B'

type Paint = {
  account: AccountName
  mountId: number
  text: string
}

function createAccountClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

function accountOf(
  client: QueryClient,
  accountA: QueryClient,
  accountB: QueryClient,
): AccountName {
  if (client === accountB) return 'B'
  if (client === accountA) return 'A'
  throw new Error('QueryClient was neither account')
}

function mutationData(client: QueryClient) {
  return client
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.data)
}

function ProviderSwitch({
  accountA,
  accountB,
  children,
}: {
  accountA: QueryClient
  accountB: QueryClient
  children: ComponentChildren
}) {
  const [client, setClient] = useState(accountA)
  return (
    <QueryClientProvider client={client}>
      <button type="button" onClick={() => setClient(accountB)}>
        switch-account
      </button>
      {children}
    </QueryClientProvider>
  )
}

function expectCurrentAccountPaints(paints: Array<Paint>, text: string) {
  const current = paints.filter((paint) => paint.account === 'B')
  expect(current.length).toBeGreaterThan(0)
  expect(current.every((paint) => paint.mountId === 1)).toBe(true)
  expect(current.every((paint) => paint.text === text)).toBe(true)
}

describe('QueryClient switch while a Preact observer stays mounted', () => {
  let accountA: QueryClient
  let accountB: QueryClient
  let mountCount: number

  beforeEach(() => {
    vi.useFakeTimers()
    accountA = createAccountClient()
    accountB = createAccountClient()
    mountCount = 0
  })

  afterEach(() => {
    accountA.clear()
    accountB.clear()
    vi.useRealTimers()
  })

  it('returns every fresh useQueries result from the client the provider now holds', () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const paints: Array<Paint> = []
    const queryFn = vi.fn(() => Promise.resolve('network-payload'))
    accountA.setQueryData(profileKey, PROFILE_A)
    accountA.setQueryData(inboxKey, INBOX_A)
    accountB.setQueryData(profileKey, PROFILE_B)
    accountB.setQueryData(inboxKey, INBOX_B)

    function Batch() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const results = useQueries({
        queries: [
          { queryKey: profileKey, queryFn, staleTime: Infinity },
          { queryKey: inboxKey, queryFn, staleTime: Infinity },
        ],
      })
      const text = `${String(results[0].data)}|${String(results[1].data)}`
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Batch />
      </ProviderSwitch>,
    )

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_A}|${INBOX_A}`,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B}|${INBOX_B}`,
    )
    expectCurrentAccountPaints(paints, `${PROFILE_B}|${INBOX_B}`)
    expect(queryFn).not.toHaveBeenCalled()
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
    expect(accountA.getQueryData(inboxKey)).toBe(INBOX_A)
    expect(accountB.getQueryData(profileKey)).toBe(PROFILE_B)
    expect(accountB.getQueryData(inboxKey)).toBe(INBOX_B)
  })

  it('combines useQueries results from the client the provider now holds', () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const paints: Array<Paint> = []
    accountA.setQueryData(profileKey, PROFILE_A)
    accountA.setQueryData(inboxKey, INBOX_A)
    accountB.setQueryData(profileKey, PROFILE_B)
    accountB.setQueryData(inboxKey, INBOX_B)

    function Batch() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const text = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('network-payload'),
            staleTime: Infinity,
          },
          {
            queryKey: inboxKey,
            queryFn: () => Promise.resolve('network-payload'),
            staleTime: Infinity,
          },
        ],
        combine: (results) =>
          `${String(results[0].data)}|${String(results[1].data)}`,
      })
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Batch />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B}|${INBOX_B}`,
    )
    expectCurrentAccountPaints(paints, `${PROFILE_B}|${INBOX_B}`)
  })

  it('returns useQueries results from an explicit queryClient argument that changes', () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const paints: Array<Paint> = []
    const providerClient = createAccountClient()
    accountA.setQueryData(profileKey, PROFILE_A)
    accountA.setQueryData(inboxKey, INBOX_A)
    accountB.setQueryData(profileKey, PROFILE_B)
    accountB.setQueryData(inboxKey, INBOX_B)

    function Batch({ client }: { client: QueryClient }) {
      const [mountId] = useState(() => ++mountCount)
      const results = useQueries(
        {
          queries: [
            {
              queryKey: profileKey,
              queryFn: () => Promise.resolve('network-payload'),
              staleTime: Infinity,
            },
            {
              queryKey: inboxKey,
              queryFn: () => Promise.resolve('network-payload'),
              staleTime: Infinity,
            },
          ],
        },
        client,
      )
      const text = `${String(results[0].data)}|${String(results[1].data)}`
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    function App() {
      const [client, setClient] = useState(accountA)
      return (
        <QueryClientProvider client={providerClient}>
          <button type="button" onClick={() => setClient(accountB)}>
            switch-account
          </button>
          <Batch client={client} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App />)

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_A}|${INBOX_A}`,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B}|${INBOX_B}`,
    )
    expectCurrentAccountPaints(paints, `${PROFILE_B}|${INBOX_B}`)
    expect(providerClient.getQueryData(profileKey)).toBeUndefined()
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
    expect(accountB.getQueryData(profileKey)).toBe(PROFILE_B)
  })

  it('stores a useQueries refetch on the client the provider now holds', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    accountA.setQueryData(profileKey, PROFILE_A)
    accountB.setQueryData(profileKey, PROFILE_B)

    function Batch() {
      const [mountId] = useState(() => ++mountCount)
      const [result] = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: async ({ client }) => {
              observedClients.push(client)
              await sleep(10)
              return UPDATED_PAYLOAD
            },
            staleTime: Infinity,
          },
        ],
      })
      return (
        <div>
          <div data-testid="mount">{mountId}</div>
          <div data-testid="list">{String(result.data)}</div>
          <button type="button" onClick={() => void result.refetch()}>
            refetch
          </button>
        </div>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Batch />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    fireEvent.click(rendered.getByRole('button', { name: 'refetch' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.getByTestId('mount')).toHaveTextContent('1')
    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(rendered.getByTestId('list')).toHaveTextContent(UPDATED_PAYLOAD)
    expect(accountB.getQueryData(profileKey)).toBe(UPDATED_PAYLOAD)
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
  })

  it('builds a query added to useQueries after a client switch on the new client', () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const paints: Array<Paint> = []
    const inboxFn = vi.fn(() => Promise.resolve('network-inbox'))
    accountA.setQueryData(profileKey, PROFILE_A)
    accountB.setQueryData(profileKey, PROFILE_B)
    accountB.setQueryData(inboxKey, INBOX_B)

    function Batch() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const [includeInbox, setIncludeInbox] = useState(false)
      const results = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('network-profile'),
            staleTime: Infinity,
          },
          ...(includeInbox
            ? [
                {
                  queryKey: inboxKey,
                  queryFn: inboxFn,
                  staleTime: Infinity,
                },
              ]
            : []),
        ],
      })
      const text = results.map((result) => String(result.data)).join('|')
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return (
        <div>
          <div data-testid="list">{text}</div>
          <button type="button" onClick={() => setIncludeInbox(true)}>
            add-query
          </button>
        </div>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Batch />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    fireEvent.click(rendered.getByRole('button', { name: 'add-query' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B}|${INBOX_B}`,
    )
    expect(inboxFn).not.toHaveBeenCalled()
    expect(accountA.getQueryData(inboxKey)).toBeUndefined()
    expect(accountB.getQueryData(inboxKey)).toBe(INBOX_B)
    expect(
      paints
        .filter((paint) => paint.account === 'B' && paint.text.includes('|'))
        .every((paint) => paint.text === `${PROFILE_B}|${INBOX_B}`),
    ).toBe(true)
  })

  it('returns fresh useSuspenseQueries results from the client the provider now holds', () => {
    const profileKey = queryKey()
    const inboxKey = queryKey()
    const paints: Array<Paint> = []
    accountA.setQueryData(profileKey, PROFILE_A)
    accountA.setQueryData(inboxKey, INBOX_A)
    accountB.setQueryData(profileKey, PROFILE_B)
    accountB.setQueryData(inboxKey, INBOX_B)

    function Batch() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const results = useSuspenseQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('network-payload'),
            staleTime: Infinity,
          },
          {
            queryKey: inboxKey,
            queryFn: () => Promise.resolve('network-payload'),
            staleTime: Infinity,
          },
        ],
      })
      const text = `${String(results[0].data)}|${String(results[1].data)}`
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Suspense fallback={<div>loading</div>}>
          <Batch />
        </Suspense>
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B}|${INBOX_B}`,
    )
    expect(rendered.queryByText('loading')).not.toBeInTheDocument()
    expectCurrentAccountPaints(paints, `${PROFILE_B}|${INBOX_B}`)
  })

  it('fetches useSuspenseQueries into the current client when that client has no cached data', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    accountA.setQueryData(profileKey, PROFILE_A)

    function Batch() {
      const results = useSuspenseQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: async ({ client }) => {
              observedClients.push(client)
              await sleep(10)
              return 'fetched-into-current-client'
            },
            staleTime: Infinity,
          },
        ],
      })
      return <div data-testid="list">{String(results[0].data)}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Suspense fallback={<div>loading</div>}>
          <Batch />
        </Suspense>
      </ProviderSwitch>,
    )

    expect(rendered.getByTestId('list')).toHaveTextContent(PROFILE_A)

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.queryByText(PROFILE_A)).not.toBeInTheDocument()
    expect(rendered.getByTestId('list')).toHaveTextContent(
      'fetched-into-current-client',
    )
    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(accountB.getQueryData(profileKey)).toBe(
      'fetched-into-current-client',
    )
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
  })

  it('returns a fresh useQuery result from the client the provider now holds', () => {
    const profileKey = queryKey()
    const paints: Array<Paint> = []
    const queryFn = vi.fn(() => Promise.resolve('network-payload'))
    accountA.setQueryData(profileKey, PROFILE_A)
    accountB.setQueryData(profileKey, PROFILE_B)

    function Profile() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const result = useQuery({
        queryKey: profileKey,
        queryFn,
        staleTime: Infinity,
      })
      const text = String(result.data)
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Profile />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(PROFILE_B)
    expectCurrentAccountPaints(paints, PROFILE_B)
    expect(queryFn).not.toHaveBeenCalled()
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
    expect(accountB.getQueryData(profileKey)).toBe(PROFILE_B)
  })

  it('stores a useQuery refetch on the client the provider now holds', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    accountA.setQueryData(profileKey, PROFILE_A)
    accountB.setQueryData(profileKey, PROFILE_B)

    function Profile() {
      const result = useQuery({
        queryKey: profileKey,
        queryFn: async ({ client }) => {
          observedClients.push(client)
          await sleep(10)
          return UPDATED_PAYLOAD
        },
        staleTime: Infinity,
      })
      return (
        <div>
          <div data-testid="list">{String(result.data)}</div>
          <button type="button" onClick={() => void result.refetch()}>
            refetch
          </button>
        </div>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Profile />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    fireEvent.click(rendered.getByRole('button', { name: 'refetch' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(rendered.getByTestId('list')).toHaveTextContent(UPDATED_PAYLOAD)
    expect(accountB.getQueryData(profileKey)).toBe(UPDATED_PAYLOAD)
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
  })

  it('reads useInfiniteQuery from the current client and appends the next page there', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    const paints: Array<Paint> = []
    accountA.setQueryData(profileKey, {
      pages: [PROFILE_A],
      pageParams: [0],
    })
    accountB.setQueryData(profileKey, {
      pages: [PROFILE_B],
      pageParams: [0],
    })

    function Pages() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const result = useInfiniteQuery({
        queryKey: profileKey,
        queryFn: async ({ client: queryClient, pageParam }) => {
          observedClients.push(queryClient)
          await sleep(10)
          return pageParam === 0 ? 'first-page' : NEXT_PAGE
        },
        initialPageParam: 0,
        getNextPageParam: () => 1,
        staleTime: Infinity,
      })
      const text = (result.data?.pages ?? []).join(',')
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return (
        <div>
          <div data-testid="list">{text}</div>
          <button type="button" onClick={() => void result.fetchNextPage()}>
            next-page
          </button>
        </div>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Pages />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(PROFILE_B)
    expectCurrentAccountPaints(paints, PROFILE_B)

    fireEvent.click(rendered.getByRole('button', { name: 'next-page' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B},${NEXT_PAGE}`,
    )
    expect(accountB.getQueryData(profileKey)).toEqual({
      pages: [PROFILE_B, NEXT_PAGE],
      pageParams: [0, 1],
    })
    expect(accountA.getQueryData(profileKey)).toEqual({
      pages: [PROFILE_A],
      pageParams: [0],
    })
  })

  it('returns a fresh useSuspenseQuery result from the client the provider now holds', () => {
    const profileKey = queryKey()
    const paints: Array<Paint> = []
    accountA.setQueryData(profileKey, PROFILE_A)
    accountB.setQueryData(profileKey, PROFILE_B)

    function Profile() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const result = useSuspenseQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('network-payload'),
        staleTime: Infinity,
      })
      const text = String(result.data)
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return <div data-testid="list">{text}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Suspense fallback={<div>loading</div>}>
          <Profile />
        </Suspense>
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(PROFILE_B)
    expectCurrentAccountPaints(paints, PROFILE_B)
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
    expect(accountB.getQueryData(profileKey)).toBe(PROFILE_B)
  })

  it('fetches useSuspenseQuery into the current client when that client has no cached data', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    accountA.setQueryData(profileKey, PROFILE_A)

    function Profile() {
      const result = useSuspenseQuery({
        queryKey: profileKey,
        queryFn: async ({ client }) => {
          observedClients.push(client)
          await sleep(10)
          return 'fetched-into-current-client'
        },
        staleTime: Infinity,
      })
      return <div data-testid="list">{String(result.data)}</div>
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Suspense fallback={<div>loading</div>}>
          <Profile />
        </Suspense>
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.queryByText(PROFILE_A)).not.toBeInTheDocument()
    expect(rendered.getByTestId('list')).toHaveTextContent(
      'fetched-into-current-client',
    )
    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(accountB.getQueryData(profileKey)).toBe(
      'fetched-into-current-client',
    )
    expect(accountA.getQueryData(profileKey)).toBe(PROFILE_A)
  })

  it('reads useSuspenseInfiniteQuery from the current client and appends the next page there', async () => {
    const profileKey = queryKey()
    const observedClients: Array<QueryClient> = []
    const paints: Array<Paint> = []
    accountA.setQueryData(profileKey, {
      pages: [PROFILE_A],
      pageParams: [0],
    })
    accountB.setQueryData(profileKey, {
      pages: [PROFILE_B],
      pageParams: [0],
    })

    function Pages() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const result = useSuspenseInfiniteQuery({
        queryKey: profileKey,
        queryFn: async ({ client: queryClient, pageParam }) => {
          observedClients.push(queryClient)
          await sleep(10)
          return pageParam === 0 ? 'first-page' : NEXT_PAGE
        },
        initialPageParam: 0,
        getNextPageParam: () => 1,
        staleTime: Infinity,
      })
      const text = result.data.pages.join(',')
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text,
      })
      return (
        <div>
          <div data-testid="list">{text}</div>
          <button type="button" onClick={() => void result.fetchNextPage()}>
            next-page
          </button>
        </div>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Suspense fallback={<div>loading</div>}>
          <Pages />
        </Suspense>
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))

    expect(rendered.getByTestId('list')).toHaveTextContent(PROFILE_B)
    expectCurrentAccountPaints(paints, PROFILE_B)

    fireEvent.click(rendered.getByRole('button', { name: 'next-page' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(observedClients).toHaveLength(1)
    expect(observedClients[0]).toBe(accountB)
    expect(rendered.getByTestId('list')).toHaveTextContent(
      `${PROFILE_B},${NEXT_PAGE}`,
    )
    expect(accountB.getQueryData(profileKey)).toEqual({
      pages: [PROFILE_B, NEXT_PAGE],
      pageParams: [0, 1],
    })
    expect(accountA.getQueryData(profileKey)).toEqual({
      pages: [PROFILE_A],
      pageParams: [0],
    })
  })

  it('records useMutation on the client the provider now holds', async () => {
    const paints: Array<Paint> = []

    function Save() {
      const client = useQueryClient()
      const [mountId] = useState(() => ++mountCount)
      const mutation = useMutation({
        mutationKey: ['save-profile'],
        mutationFn: async (value: string) => {
          await sleep(10)
          return value
        },
      })
      paints.push({
        account: accountOf(client, accountA, accountB),
        mountId,
        text: String(mutation.data ?? ''),
      })
      return (
        <button type="button" onClick={() => mutation.mutate(MUTATION)}>
          save
        </button>
      )
    }

    const rendered = render(
      <ProviderSwitch accountA={accountA} accountB={accountB}>
        <Save />
      </ProviderSwitch>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-account' }))
    expect(
      paints.filter((paint) => paint.account === 'B').length,
    ).toBeGreaterThan(0)
    expect(
      paints
        .filter((paint) => paint.account === 'B')
        .every((paint) => paint.mountId === 1),
    ).toBe(true)

    fireEvent.click(rendered.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(mutationData(accountA)).not.toContain(MUTATION)
    expect(mutationData(accountB)).toContain(MUTATION)
  })
})
