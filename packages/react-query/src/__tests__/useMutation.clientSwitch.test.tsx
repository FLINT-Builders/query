import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import * as React from 'react'
import { sleep } from '@tanstack/query-test-utils'
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQueries,
  useQuery,
} from '..'
import type { QueryClient as Client, MutationFunctionContext } from '..'

/**
 * Spec for switching the QueryClient under a mounted mutation.
 * A mutation started after the switch must run on the client the provider
 * (or the explicit argument) currently resolves, and its callbacks must
 * receive that same client. The previous client's query and mutation caches
 * stay unchanged. The still-mounted query must render the current client's
 * cache, which is the cache those callbacks update.
 */

const profileKey = ['profile']

type Profile = {
  account: string
  items: Array<string>
}

type CallbackClients = {
  mutationFn: Array<Client>
  onMutate: Array<Client>
  onSuccess: Array<Client>
  onError: Array<Client>
  onSettled: Array<Client>
  callOnSuccess: Array<Client>
  callOnError: Array<Client>
  callOnSettled: Array<Client>
  cacheOnMutate: Array<Client>
  cacheOnSuccess: Array<Client>
  cacheOnError: Array<Client>
  cacheOnSettled: Array<Client>
  meta: Array<string | undefined>
}

function emptyCallbacks(): CallbackClients {
  return {
    mutationFn: [],
    onMutate: [],
    onSuccess: [],
    onError: [],
    onSettled: [],
    callOnSuccess: [],
    callOnError: [],
    callOnSettled: [],
    cacheOnMutate: [],
    cacheOnSuccess: [],
    cacheOnError: [],
    cacheOnSettled: [],
    meta: [],
  }
}

function createAccount(account: string, source: string, seen: CallbackClients) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
    mutationCache: new MutationCache({
      onMutate: (_variables, _mutation, context) => {
        seen.cacheOnMutate.push(context.client)
      },
      onSuccess: (_data, _variables, _onMutateResult, _mutation, context) => {
        seen.cacheOnSuccess.push(context.client)
      },
      onError: (_error, _variables, _onMutateResult, _mutation, context) => {
        seen.cacheOnError.push(context.client)
      },
      onSettled: (
        _data,
        _error,
        _variables,
        _onMutateResult,
        _mutation,
        context,
      ) => {
        seen.cacheOnSettled.push(context.client)
      },
    }),
  })
  client.setQueryData<Profile>(profileKey, { account, items: [account] })
  client.setMutationDefaults(profileKey, {
    meta: { source },
  })
  return client
}

function label(profile: Profile | undefined) {
  if (!profile) return 'missing'
  return `${profile.account}:${profile.items.join(',')}`
}

function mutationOptions(seen: CallbackClients, fail: boolean) {
  return {
    mutationKey: profileKey,
    mutationFn: async (item: string, context: MutationFunctionContext) => {
      seen.mutationFn.push(context.client)
      seen.meta.push(context.meta?.source as string | undefined)
      await sleep(10)
      if (fail) {
        throw new Error(`failed:${item}`)
      }
      return item
    },
    onMutate: (item: string, context: MutationFunctionContext) => {
      seen.onMutate.push(context.client)
      context.client.setQueryData<Profile>(profileKey, (current) => ({
        account: current?.account ?? 'missing',
        items: [...(current?.items ?? []), item],
      }))
      return { item }
    },
    onSuccess: (
      _data: string,
      _item: string,
      _onMutateResult: { item: string },
      context: MutationFunctionContext,
    ) => {
      seen.onSuccess.push(context.client)
      return context.client.invalidateQueries({
        queryKey: profileKey,
        refetchType: 'none',
      })
    },
    onError: (
      _error: Error,
      _item: string,
      _onMutateResult: { item: string } | undefined,
      context: MutationFunctionContext,
    ) => {
      seen.onError.push(context.client)
    },
    onSettled: (
      _data: string | undefined,
      _error: Error | null,
      _item: string,
      _onMutateResult: { item: string } | undefined,
      context: MutationFunctionContext,
    ) => {
      seen.onSettled.push(context.client)
    },
  }
}

function callOptions(seen: CallbackClients) {
  return {
    onSuccess: (
      _data: string,
      _item: string,
      _onMutateResult: { item: string },
      context: MutationFunctionContext,
    ) => {
      seen.callOnSuccess.push(context.client)
    },
    onError: (
      _error: Error,
      _item: string,
      _onMutateResult: { item: string } | undefined,
      context: MutationFunctionContext,
    ) => {
      seen.callOnError.push(context.client)
    },
    onSettled: (
      _data: string | undefined,
      _error: Error | null,
      _item: string,
      _onMutateResult: { item: string } | undefined,
      context: MutationFunctionContext,
    ) => {
      seen.callOnSettled.push(context.client)
    },
  }
}

function expectOnly(actual: Array<Client>, expected: Client) {
  expect(actual).toHaveLength(1)
  expect(actual[0]).toBe(expected)
}

function expectCurrentClient(
  seen: CallbackClients,
  current: Client,
  outcome: 'success' | 'error',
) {
  expectOnly(seen.mutationFn, current)
  expectOnly(seen.onMutate, current)
  expectOnly(seen.cacheOnMutate, current)
  expectOnly(seen.cacheOnSettled, current)
  if (outcome === 'success') {
    expectOnly(seen.onSuccess, current)
    expect(seen.onError).toEqual([])
    expectOnly(seen.onSettled, current)
    expectOnly(seen.callOnSuccess, current)
    expect(seen.callOnError).toEqual([])
    expectOnly(seen.callOnSettled, current)
    expectOnly(seen.cacheOnSuccess, current)
    expect(seen.cacheOnError).toEqual([])
  } else {
    expect(seen.onSuccess).toEqual([])
    expectOnly(seen.onError, current)
    expectOnly(seen.onSettled, current)
    expect(seen.callOnSuccess).toEqual([])
    expectOnly(seen.callOnError, current)
    expectOnly(seen.callOnSettled, current)
    expect(seen.cacheOnSuccess).toEqual([])
    expectOnly(seen.cacheOnError, current)
  }
}

describe('useMutation client switch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a mutation started after the provider client changes on that client', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)
    const invalidateA = vi.spyOn(accountA, 'invalidateQueries')
    const invalidateB = vi.spyOn(accountB, 'invalidateQueries')

    function Page() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: ({ client }) => {
          const cached = client.getQueryData<Profile>(profileKey)
          if (!cached) {
            throw new Error('missing profile')
          }
          return cached
        },
      })
      const { mutate, mutateAsync } = useMutation(mutationOptions(seen, false))

      return (
        <div>
          <span data-testid="profile">{label(profile.data)}</span>
          <button onClick={() => mutate('from-mutate', callOptions(seen))}>
            mutate
          </button>
          <button
            onClick={() => {
              void mutateAsync('from-mutate-async', callOptions(seen))
            }}
          >
            mutateAsync
          </button>
        </div>
      )
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={accountA} />)
    expect(rendered.getByTestId('profile')).toHaveTextContent('A:A')

    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(accountA.getQueryData<Profile>(profileKey)).toEqual({
      account: 'A',
      items: ['A', 'from-mutate'],
    })
    expect(accountB.getQueryData<Profile>(profileKey)).toEqual({
      account: 'B',
      items: ['B'],
    })
    expect(
      accountA
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-mutate'])
    expect(accountB.getMutationCache().getAll()).toEqual([])

    const seenAfterFirst = emptyCallbacks()
    for (const key of Object.keys(seen) as Array<keyof CallbackClients>) {
      seenAfterFirst[key] = [...seen[key]] as never
      seen[key] = [] as never
    }
    expectCurrentClient(seenAfterFirst, accountA, 'success')
    expect(seenAfterFirst.meta).toEqual(['account-a'])
    invalidateA.mockClear()
    invalidateB.mockClear()

    rendered.rerender(<App client={accountB} />)

    expect(rendered.getByTestId('profile')).toHaveTextContent('B:B')

    fireEvent.click(rendered.getByRole('button', { name: 'mutateAsync' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectCurrentClient(seen, accountB, 'success')
    expect(accountA.getQueryData<Profile>(profileKey)).toEqual({
      account: 'A',
      items: ['A', 'from-mutate'],
    })
    expect(accountB.getQueryData<Profile>(profileKey)).toEqual({
      account: 'B',
      items: ['B', 'from-mutate-async'],
    })
    expect(rendered.getByTestId('profile')).toHaveTextContent(
      'B:B,from-mutate-async',
    )
    expect(
      accountA
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-mutate'])
    expect(
      accountB
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-mutate-async'])
    expect(invalidateA).not.toHaveBeenCalled()
    expect(invalidateB).toHaveBeenCalled()
  })

  it('uses the current client when mutation options stay referentially stable', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)

    function Page() {
      const options = React.useMemo(() => mutationOptions(seen, false), [])
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: ({ client }) => {
          const cached = client.getQueryData<Profile>(profileKey)
          if (!cached) {
            throw new Error('missing profile')
          }
          return cached
        },
      })
      const { mutate } = useMutation(options)

      return (
        <div>
          <span data-testid="profile">{label(profile.data)}</span>
          <button onClick={() => mutate('from-b', callOptions(seen))}>
            mutate
          </button>
        </div>
      )
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={accountA} />)
    rendered.rerender(<App client={accountB} />)
    expect(rendered.getByTestId('profile')).toHaveTextContent('B:B')

    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectOnly(seen.mutationFn, accountB)
    expectOnly(seen.onMutate, accountB)
    expectOnly(seen.onSuccess, accountB)
    expectOnly(seen.callOnSuccess, accountB)
    expect(accountA.getQueryData<Profile>(profileKey)).toEqual({
      account: 'A',
      items: ['A'],
    })
    expect(accountB.getQueryData<Profile>(profileKey)).toEqual({
      account: 'B',
      items: ['B', 'from-b'],
    })
    expect(rendered.getByTestId('profile')).toHaveTextContent('B:B,from-b')
    expect(accountA.getMutationCache().getAll()).toEqual([])
    expect(
      accountB
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-b'])
  })

  it('delivers the current client to error callbacks after the provider changes', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)

    function Page() {
      const { mutate } = useMutation(mutationOptions(seen, true))
      return (
        <button onClick={() => mutate('from-b', callOptions(seen))}>
          mutate
        </button>
      )
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={accountA} />)
    rendered.rerender(<App client={accountB} />)
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectCurrentClient(seen, accountB, 'error')
    expect(accountA.getQueryData<Profile>(profileKey)).toEqual({
      account: 'A',
      items: ['A'],
    })
    expect(accountB.getQueryData<Profile>(profileKey)).toEqual({
      account: 'B',
      items: ['B', 'from-b'],
    })
    expect(accountA.getMutationCache().getAll()).toEqual([])
    expect(
      accountB
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.status),
    ).toEqual(['error'])
  })

  it('uses a replaced explicit queryClient argument rather than the provider client', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)
    const providerClient = createAccount('provider', 'provider', seen)

    function Page({ client }: { client: QueryClient }) {
      const { mutateAsync } = useMutation(mutationOptions(seen, false), client)
      return (
        <button
          onClick={() => {
            void mutateAsync('from-b', callOptions(seen))
          }}
        >
          mutateAsync
        </button>
      )
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={providerClient}>
          <Page client={client} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={accountA} />)
    rendered.rerender(<App client={accountB} />)
    fireEvent.click(rendered.getByRole('button', { name: 'mutateAsync' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectCurrentClient(seen, accountB, 'success')
    expect(accountA.getQueryData<Profile>(profileKey)).toEqual({
      account: 'A',
      items: ['A'],
    })
    expect(accountB.getQueryData<Profile>(profileKey)).toEqual({
      account: 'B',
      items: ['B', 'from-b'],
    })
    expect(providerClient.getQueryData<Profile>(profileKey)).toEqual({
      account: 'provider',
      items: ['provider'],
    })
    expect(accountA.getMutationCache().getAll()).toEqual([])
    expect(providerClient.getMutationCache().getAll()).toEqual([])
    expect(
      accountB
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-b'])
  })

  it('renders useQueries from the provider client after that client is replaced', () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)

    function Page() {
      const [profile] = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: ({ client }: { client: Client }) => {
              const cached = client.getQueryData<Profile>(profileKey)
              if (!cached) {
                throw new Error('missing profile')
              }
              return cached
            },
          },
        ],
      })

      return <span data-testid="profile">{label(profile.data)}</span>
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Page />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={accountA} />)
    expect(rendered.getByTestId('profile')).toHaveTextContent('A:A')
    rendered.rerender(<App client={accountB} />)
    expect(rendered.getByTestId('profile')).toHaveTextContent('B:B')
  })
})
