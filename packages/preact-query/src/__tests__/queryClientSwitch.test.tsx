import { act, fireEvent, render, waitFor } from '@testing-library/preact'
import { Suspense } from 'preact/compat'
import { useEffect, useState } from 'preact/hooks'
import { describe, expect, it } from 'vitest'

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
import type { InfiniteData } from '..'
import type { ComponentChildren } from 'preact'

/**
 * Spec for the Preact observer lifetime bug: a mounted query hook keeps the
 * QueryObserver (or QueriesObserver / MutationObserver) it created on the
 * first render. That observer reads and writes only the QueryClient it was
 * constructed with. Replacing the provider client, or the explicit client
 * argument, without remounting the component must follow the new client.
 *
 * These tests fail while that observer is reused across a client change.
 */

const profileKey = ['profile'] as const

function createAccountClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  })
}

function infiniteData(page: string): InfiniteData<string, number> {
  return { pages: [page], pageParams: [0] }
}

function SwitchAccounts({
  first,
  second,
  children,
}: {
  first: QueryClient
  second: QueryClient
  children: ComponentChildren
}) {
  const [client, setClient] = useState(first)

  return (
    <>
      <button type="button" onClick={() => setClient(second)}>
        switch-account
      </button>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </>
  )
}

async function clickButton(label: string): Promise<void> {
  await act(() => {
    fireEvent.click(
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === label,
      ) as HTMLButtonElement,
    )
  })
}

async function expectData(value: string): Promise<void> {
  await waitFor(() => {
    expect(dataText()).toBe(value)
  })
}

function dataText(): string {
  return document.querySelector('[data-testid="data"]')?.textContent ?? ''
}

describe('Preact query client identity', () => {
  it('useQuery renders the current client cache after the provider client changes', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')
    accountB.setQueryData(profileKey, 'account-b-profile')
    let mounts = 0

    function Profile() {
      const result = useQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched'),
      })
      useEffect(() => {
        mounts += 1
      }, [])

      return <span data-testid="data">{result.data ?? 'empty'}</span>
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-profile')

    await clickButton('switch-account')

    expect(mounts).toBe(1)
    expect(dataText()).toBe('account-b-profile')
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
    expect(accountB.getQueryData(profileKey)).toBe('account-b-profile')
  })

  it('useQuery stores a later refetch on the client that is current after the switch', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')

    function Profile() {
      const result = useQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched-after-switch'),
      })
      return (
        <>
          <span data-testid="data">{result.data ?? 'empty'}</span>
          <button type="button" onClick={() => void result.refetch()}>
            refetch
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    await clickButton('switch-account')
    await clickButton('refetch')
    await expectData('fetched-after-switch')
    expect(accountB.getQueryData(profileKey)).toBe('fetched-after-switch')
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
  })

  it('useQuery builds a query key changed after the switch on the current client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    const sessionKey = ['session'] as const
    accountA.setQueryData(profileKey, 'account-a-profile')

    function Profile() {
      const [key, setKey] = useState<ReadonlyArray<string>>(profileKey)
      const result = useQuery({
        queryKey: key,
        queryFn: () => Promise.resolve('fetched-session'),
      })
      return (
        <>
          <span data-testid="data">{result.data ?? 'empty'}</span>
          <button type="button" onClick={() => setKey(sessionKey)}>
            change-key
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    await clickButton('switch-account')
    await clickButton('change-key')
    await expectData('fetched-session')
    expect(accountB.getQueryData(sessionKey)).toBe('fetched-session')
    expect(accountA.getQueryData(sessionKey)).toBeUndefined()
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
  })

  it('useQuery follows an explicit queryClient argument instead of the provider', async () => {
    const providerClient = createAccountClient()
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')
    accountB.setQueryData(profileKey, 'account-b-profile')
    providerClient.setQueryData(profileKey, 'provider-profile')

    function Profile({ client }: { client: QueryClient }) {
      const result = useQuery(
        {
          queryKey: profileKey,
          queryFn: () => Promise.resolve('fetched'),
        },
        client,
      )
      return <span data-testid="data">{result.data ?? 'empty'}</span>
    }

    function App() {
      const [client, setClient] = useState(accountA)
      return (
        <>
          <button type="button" onClick={() => setClient(accountB)}>
            switch-account
          </button>
          <QueryClientProvider client={providerClient}>
            <Profile client={client} />
          </QueryClientProvider>
        </>
      )
    }

    render(<App />)

    expect(dataText()).toBe('account-a-profile')
    await clickButton('switch-account')
    expect(dataText()).toBe('account-b-profile')
    expect(providerClient.getQueryData(profileKey)).toBe('provider-profile')
  })

  it('useInfiniteQuery renders the current client pages and stores fetchNextPage there', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    const seen: Array<string> = []
    accountA.setQueryData(profileKey, infiniteData('account-a-page'))
    accountB.setQueryData(profileKey, infiniteData('account-b-page'))

    function Profile() {
      const result = useInfiniteQuery({
        queryKey: profileKey,
        queryFn: ({ pageParam }) => {
          const page = `page-${String(pageParam)}`
          seen.push(page)
          return Promise.resolve(page)
        },
        initialPageParam: 0,
        getNextPageParam: (_lastPage, _pages, lastPageParam) =>
          lastPageParam + 1,
      })
      const pages = result.data?.pages.join(',') ?? 'empty'
      return (
        <>
          <span data-testid="data">{pages}</span>
          <button type="button" onClick={() => void result.fetchNextPage()}>
            next-page
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-page')
    await clickButton('switch-account')
    expect(dataText()).toBe('account-b-page')

    await clickButton('next-page')
    await expectData('account-b-page,page-1')
    expect(
      accountB.getQueryData<InfiniteData<string, number>>(profileKey)?.pages,
    ).toEqual(['account-b-page', 'page-1'])
    expect(
      accountA.getQueryData<InfiniteData<string, number>>(profileKey)?.pages,
    ).toEqual(['account-a-page'])
    expect(seen).toEqual(['page-1'])
  })

  it('useSuspenseQuery renders the current client cache and suspends into that client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')

    function Profile() {
      const result = useSuspenseQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched-b'),
      })
      return <span data-testid="data">{result.data}</span>
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Suspense fallback={<span data-testid="data">loading</span>}>
          <Profile />
        </Suspense>
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-profile')
    await clickButton('switch-account')
    await expectData('fetched-b')
    expect(accountB.getQueryData(profileKey)).toBe('fetched-b')
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
  })

  it('useSuspenseInfiniteQuery does not keep the previous client page after a switch', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, infiniteData('account-a-page'))
    accountB.setQueryData(profileKey, infiniteData('account-b-page'))

    function Profile() {
      const result = useSuspenseInfiniteQuery({
        queryKey: profileKey,
        queryFn: ({ pageParam }) =>
          Promise.resolve(`page-${String(pageParam)}`),
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      })
      return <span data-testid="data">{result.data.pages[0]}</span>
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Suspense fallback={<span data-testid="data">loading</span>}>
          <Profile />
        </Suspense>
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-page')
    await clickButton('switch-account')
    expect(dataText()).toBe('account-b-page')
    expect(
      accountA.getQueryData<InfiniteData<string, number>>(profileKey)?.pages,
    ).toEqual(['account-a-page'])
  })

  it('useQueries reads and refetches through the current client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')
    accountB.setQueryData(profileKey, 'account-b-profile')

    function Profile() {
      const [result] = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('fetched-again'),
          },
        ],
      })
      return (
        <>
          <span data-testid="data">{result.data ?? 'empty'}</span>
          <button type="button" onClick={() => void result.refetch()}>
            refetch
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-profile')
    await clickButton('switch-account')
    expect(dataText()).toBe('account-b-profile')

    await clickButton('refetch')
    await expectData('fetched-again')
    expect(accountB.getQueryData(profileKey)).toBe('fetched-again')
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
  })

  it('useQueries creates a query added after the switch on the current client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    const sessionKey = ['session'] as const
    accountA.setQueryData(profileKey, 'account-a-profile')
    accountB.setQueryData(profileKey, 'account-b-profile')

    function Profile() {
      const [includeSession, setIncludeSession] = useState(false)
      const results = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('fetched-profile'),
          },
          ...(includeSession
            ? [
                {
                  queryKey: sessionKey,
                  queryFn: () => Promise.resolve('fetched-session'),
                },
              ]
            : []),
        ],
      })
      return (
        <>
          <span data-testid="data">
            {results.map((result) => result.data ?? 'empty').join(',')}
          </span>
          <button type="button" onClick={() => setIncludeSession(true)}>
            add-query
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    await clickButton('switch-account')
    await clickButton('add-query')
    await expectData('account-b-profile,fetched-session')
    expect(accountB.getQueryData(profileKey)).toBe('account-b-profile')
    expect(accountB.getQueryData(sessionKey)).toBe('fetched-session')
    expect(accountA.getQueryData(sessionKey)).toBeUndefined()
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
  })

  it('useSuspenseQueries suspends the missing query into the current client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()
    accountA.setQueryData(profileKey, 'account-a-profile')
    accountB.setQueryData(profileKey, 'account-b-profile')

    function Profile() {
      const [result] = useSuspenseQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('fetched-b'),
          },
        ],
      })
      return <span data-testid="data">{result.data}</span>
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Suspense fallback={<span data-testid="data">loading</span>}>
          <Profile />
        </Suspense>
      </SwitchAccounts>,
    )

    expect(dataText()).toBe('account-a-profile')
    await clickButton('switch-account')

    expect(dataText()).toBe('account-b-profile')
    expect(accountA.getQueryData(profileKey)).toBe('account-a-profile')
    expect(accountB.getQueryData(profileKey)).toBe('account-b-profile')
  })

  it('useMutation records a mutation started after the switch on the current client', async () => {
    const accountA = createAccountClient()
    const accountB = createAccountClient()

    function Profile() {
      const mutation = useMutation({
        mutationKey: profileKey,
        mutationFn: (variables: string) =>
          Promise.resolve(`saved-${variables}`),
      })
      return (
        <>
          <span data-testid="data">{mutation.data ?? 'idle'}</span>
          <button
            type="button"
            onClick={() => {
              mutation.mutate('account-b')
            }}
          >
            mutate
          </button>
        </>
      )
    }

    render(
      <SwitchAccounts first={accountA} second={accountB}>
        <Profile />
      </SwitchAccounts>,
    )

    await clickButton('switch-account')
    await clickButton('mutate')
    await expectData('saved-account-b')
    expect(accountB.getMutationCache().getAll()).toHaveLength(1)
    expect(accountB.getMutationCache().getAll()[0]?.state.data).toBe(
      'saved-account-b',
    )
    expect(accountA.getMutationCache().getAll()).toHaveLength(0)
  })
})
