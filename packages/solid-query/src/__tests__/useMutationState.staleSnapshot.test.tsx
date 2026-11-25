import { describe, expect, it } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { QueryClient, QueryClientProvider, useMutationState } from '..'

/**
 * Solid `useMutationState` stores the first `getResult` and only calls
 * `setResult` from the cache subscriber. `useIsMutating` recomputes inside its
 * effect and is not covered here.
 */

type AccountVariables = {
  accountId: string
  submittedValue: string
}

const accountAVariables: AccountVariables = {
  accountId: 'account-a',
  submittedValue: 'account-a-placeholder',
}

const accountBVariables: AccountVariables = {
  accountId: 'account-b',
  submittedValue: 'account-b-placeholder',
}

function seedPending(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: AccountVariables,
): void {
  const mutation = client
    .getMutationCache()
    .build<string, Error, AccountVariables, unknown>(client, {
      gcTime: Infinity,
      mutationKey,
      mutationFn: () => new Promise<string>(() => {}),
    })
  void mutation.execute(variables)
}

async function seedSuccess(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: AccountVariables,
  data: string,
): Promise<void> {
  const mutation = client
    .getMutationCache()
    .build<string, Error, AccountVariables, unknown>(client, {
      gcTime: Infinity,
      mutationKey,
      mutationFn: () => Promise.resolve(data),
    })
  await mutation.execute(variables)
}

describe('useMutationState stale snapshot', () => {
  it('returns the new client variables when the queryClient accessor changes', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)

    const [client, setClient] = createSignal(clientA)

    function Observer() {
      const variables = useMutationState(
        () => ({
          filters: {
            mutationKey: ['profile'],
            status: 'pending' as const,
            exact: true,
          },
          select: (mutation) => mutation.state.variables as AccountVariables,
        }),
        client,
      )
      return (
        <output data-testid="variables">{JSON.stringify(variables())}</output>
      )
    }

    const rendered = render(() => <Observer />)
    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountAVariables]),
    )

    setClient(clientB)

    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountBVariables]),
    )
  })

  it('returns the new client variables when QueryClientProvider changes client', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)

    const [client, setClient] = createSignal(clientA)

    function Observer() {
      const variables = useMutationState(() => ({
        filters: {
          mutationKey: ['profile'],
          status: 'pending' as const,
          exact: true,
        },
        select: (mutation) => mutation.state.variables as AccountVariables,
      }))
      return (
        <output data-testid="variables">{JSON.stringify(variables())}</output>
      )
    }

    function Page() {
      return (
        <QueryClientProvider client={client()}>
          <Observer />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Page />)
    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountAVariables]),
    )

    setClient(clientB)

    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountBVariables]),
    )
  })

  it('returns only the new mutationKey when the options accessor changes', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const [accountId, setAccountId] = createSignal('account-a')

    function Observer() {
      const variables = useMutationState(() => ({
        filters: {
          mutationKey: [accountId()],
          status: 'pending' as const,
          exact: true,
        },
        select: (mutation) => mutation.state.variables as AccountVariables,
      }))
      return (
        <output data-testid="variables">{JSON.stringify(variables())}</output>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client}>
        <Observer />
      </QueryClientProvider>
    ))
    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountAVariables]),
    )

    setAccountId('account-b')

    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountBVariables]),
    )
  })

  it('returns only the new predicate match when the predicate accessor changes', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const [accountId, setAccountId] = createSignal('account-a')

    function Observer() {
      const variables = useMutationState(() => ({
        filters: {
          status: 'pending' as const,
          predicate: (mutation) =>
            mutation.options.mutationKey?.[0] === accountId(),
        },
        select: (mutation) => mutation.state.variables as AccountVariables,
      }))
      return (
        <output data-testid="variables">{JSON.stringify(variables())}</output>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client}>
        <Observer />
      </QueryClientProvider>
    ))
    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountAVariables]),
    )

    setAccountId('account-b')

    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountBVariables]),
    )
  })

  it('returns the new select result when select changes', () => {
    const client = new QueryClient()
    seedPending(client, ['profile'], accountAVariables)

    const [field, setField] = createSignal<keyof AccountVariables>('accountId')

    function Observer() {
      const selected = useMutationState(() => ({
        filters: {
          mutationKey: ['profile'],
          status: 'pending' as const,
          exact: true,
        },
        select: (mutation) =>
          (mutation.state.variables as AccountVariables)[field()],
      }))
      return (
        <output data-testid="selected">{JSON.stringify(selected())}</output>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client}>
        <Observer />
      </QueryClientProvider>
    ))
    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a']),
    )

    setField('submittedValue')

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a-placeholder']),
    )
  })

  it('returns the new mutation data when the success filter changes', async () => {
    const client = new QueryClient()
    await seedSuccess(
      client,
      ['account-a'],
      accountAVariables,
      'account-a-result',
    )
    await seedSuccess(
      client,
      ['account-b'],
      accountBVariables,
      'account-b-result',
    )

    const [accountId, setAccountId] = createSignal('account-a')

    function Observer() {
      const data = useMutationState(() => ({
        filters: {
          mutationKey: [accountId()],
          status: 'success' as const,
          exact: true,
        },
        select: (mutation) => mutation.state.data as string,
      }))
      return <output data-testid="data">{JSON.stringify(data())}</output>
    }

    const rendered = render(() => (
      <QueryClientProvider client={client}>
        <Observer />
      </QueryClientProvider>
    ))
    expect(rendered.getByTestId('data').textContent).toBe(
      JSON.stringify(['account-a-result']),
    )

    setAccountId('account-b')

    expect(rendered.getByTestId('data').textContent).toBe(
      JSON.stringify(['account-b-result']),
    )
  })

  it('returns the default mutation state for the new filter', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const [accountId, setAccountId] = createSignal('account-a')

    function Observer() {
      const states = useMutationState(() => ({
        filters: {
          mutationKey: [accountId()],
          status: 'pending' as const,
          exact: true,
        },
      }))
      const variables = () =>
        states().map((state) => state.variables as AccountVariables | undefined)
      return (
        <output data-testid="variables">{JSON.stringify(variables())}</output>
      )
    }

    const rendered = render(() => (
      <QueryClientProvider client={client}>
        <Observer />
      </QueryClientProvider>
    ))
    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountAVariables]),
    )

    setAccountId('account-b')

    expect(rendered.getByTestId('variables').textContent).toBe(
      JSON.stringify([accountBVariables]),
    )
  })
})
