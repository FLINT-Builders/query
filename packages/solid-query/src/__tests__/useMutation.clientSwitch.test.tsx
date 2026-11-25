import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { fireEvent, render } from '@solidjs/testing-library'
import { sleep } from '@tanstack/query-test-utils'
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from '..'
import type { QueryClient as Client, MutationFunctionContext } from '..'

/**
 * Spec for switching the QueryClient under a mounted Solid mutation.
 * useMutation's observer is constructed once. After the provider client
 * or the explicit accessor changes, mutate and mutateAsync must build the
 * mutation on the new client and pass that client to callbacks.
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
  client.setMutationDefaults(profileKey, { meta: { source } })
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
    },
    onSuccess: (
      _data: string,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.onSuccess.push(context.client)
    },
    onError: (
      _error: Error,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.onError.push(context.client)
    },
    onSettled: (
      _data: string | undefined,
      _error: Error | null,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.onSettled.push(context.client)
    },
  }
}

function expectOnly(actual: Array<Client>, expected: Client) {
  expect(actual).toHaveLength(1)
  expect(actual[0]).toBe(expected)
}

function callOptions(seen: CallbackClients) {
  return {
    onSuccess: (
      _data: string,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.callOnSuccess.push(context.client)
    },
    onError: (
      _error: Error,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.callOnError.push(context.client)
    },
    onSettled: (
      _data: string | undefined,
      _error: Error | null,
      _item: string,
      _onMutateResult: unknown,
      context: MutationFunctionContext,
    ) => {
      seen.callOnSettled.push(context.client)
    },
  }
}

describe('useMutation client switch', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs mutate and mutateAsync on the provider client after it changes', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)
    const [client, setClient] = createSignal(accountA)
    const [optionsTick, setOptionsTick] = createSignal(0)

    function Page() {
      const profile = useQuery(() => ({
        queryKey: profileKey,
        queryFn: ({ client: queryClient }) => {
          const cached = queryClient.getQueryData<Profile>(profileKey)
          if (!cached) {
            throw new Error('missing profile')
          }
          return cached
        },
      }))
      const mutation = useMutation(() => {
        optionsTick()
        return mutationOptions(seen, false)
      })

      return (
        <div>
          <span data-testid="profile">{label(profile.data)}</span>
          <button
            onClick={() => mutation.mutate('from-mutate', callOptions(seen))}
          >
            mutate
          </button>
          <button
            onClick={() => {
              void mutation.mutateAsync('from-mutate-async', callOptions(seen))
            }}
          >
            mutateAsync
          </button>
        </div>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <Page />
      </QueryClientProvider>
    ))

    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(accountA.getQueryData<Profile>(profileKey)?.items).toEqual([
      'A',
      'from-mutate',
    ])
    for (const key of Object.keys(seen) as Array<keyof CallbackClients>) {
      seen[key] = [] as never
    }

    setClient(accountB)
    setOptionsTick(1)
    expect(rendered.getByTestId('profile')).toHaveTextContent('B:B')

    fireEvent.click(rendered.getByRole('button', { name: 'mutateAsync' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectOnly(seen.mutationFn, accountB)
    expectOnly(seen.onMutate, accountB)
    expectOnly(seen.onSuccess, accountB)
    expectOnly(seen.onSettled, accountB)
    expectOnly(seen.callOnSuccess, accountB)
    expectOnly(seen.callOnSettled, accountB)
    expectOnly(seen.cacheOnMutate, accountB)
    expectOnly(seen.cacheOnSettled, accountB)
    expect(accountA.getQueryData<Profile>(profileKey)?.items).toEqual([
      'A',
      'from-mutate',
    ])
    expect(accountB.getQueryData<Profile>(profileKey)?.items).toEqual([
      'B',
      'from-mutate-async',
    ])
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
  })

  it('delivers the current client to error callbacks after the provider changes', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)
    const [client, setClient] = createSignal(accountA)
    const [optionsTick, setOptionsTick] = createSignal(0)

    function Page() {
      const mutation = useMutation(() => {
        optionsTick()
        return mutationOptions(seen, true)
      })
      return (
        <button onClick={() => mutation.mutate('from-b', callOptions(seen))}>
          mutate
        </button>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <Page />
      </QueryClientProvider>
    ))

    setClient(accountB)
    setOptionsTick(1)
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expect(seen.meta).toEqual(['account-b'])
    expectOnly(seen.mutationFn, accountB)
    expectOnly(seen.onMutate, accountB)
    expectOnly(seen.onError, accountB)
    expectOnly(seen.onSettled, accountB)
    expectOnly(seen.callOnError, accountB)
    expectOnly(seen.callOnSettled, accountB)
    expectOnly(seen.cacheOnMutate, accountB)
    expectOnly(seen.cacheOnSettled, accountB)
    expect(accountA.getQueryData<Profile>(profileKey)?.items).toEqual(['A'])
    expect(accountB.getQueryData<Profile>(profileKey)?.items).toEqual([
      'B',
      'from-b',
    ])
    expect(accountA.getMutationCache().getAll()).toEqual([])
    expect(accountB.getMutationCache().getAll()[0]?.state.status).toBe('error')
  })

  it('uses a replaced explicit query client accessor rather than the provider client', async () => {
    vi.useFakeTimers()
    const seen = emptyCallbacks()
    const accountA = createAccount('A', 'account-a', seen)
    const accountB = createAccount('B', 'account-b', seen)
    const providerClient = createAccount('provider', 'provider', seen)
    const [explicit, setExplicit] = createSignal(accountA)
    const [optionsTick, setOptionsTick] = createSignal(0)

    function Page() {
      const mutation = useMutation(
        () => {
          optionsTick()
          return mutationOptions(seen, false)
        },
        () => explicit(),
      )
      return (
        <button onClick={() => mutation.mutate('from-b', callOptions(seen))}>
          mutate
        </button>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={providerClient}>
        <Page />
      </QueryClientProvider>
    ))

    setExplicit(accountB)
    setOptionsTick(1)
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await vi.advanceTimersByTimeAsync(10)

    expectOnly(seen.mutationFn, accountB)
    expectOnly(seen.onSuccess, accountB)
    expectOnly(seen.callOnSuccess, accountB)
    expect(accountA.getQueryData<Profile>(profileKey)?.items).toEqual(['A'])
    expect(providerClient.getQueryData<Profile>(profileKey)?.items).toEqual([
      'provider',
    ])
    expect(accountB.getQueryData<Profile>(profileKey)?.items).toEqual([
      'B',
      'from-b',
    ])
    expect(accountA.getMutationCache().getAll()).toEqual([])
    expect(providerClient.getMutationCache().getAll()).toEqual([])
    expect(
      accountB
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual(['from-b'])
  })
})
