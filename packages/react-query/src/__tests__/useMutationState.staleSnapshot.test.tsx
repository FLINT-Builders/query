import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import * as React from 'react'
import {
  QueryClient,
  QueryClientProvider,
  useIsMutating,
  useMutationState,
} from '..'

/**
 * These tests fail while `useMutationState` keeps its first snapshot until a
 * mutation-cache event. Switching the client or the options must change the
 * value returned on that render, before any later cache event.
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

function expectRendersSince<T>(seen: Array<T>, start: number, expected: T) {
  const afterSwitch = seen.slice(start)
  expect(afterSwitch.length).toBeGreaterThan(0)
  for (const entry of afterSwitch) {
    expect(entry).toEqual(expected)
  }
}

describe('useMutationState stale snapshot', () => {
  it('returns the new client variables on the render that changes the queryClient argument', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)

    const seen: Array<Array<AccountVariables>> = []

    function Observer(props: { client: QueryClient }) {
      const variables = useMutationState(
        {
          filters: { mutationKey: ['profile'], status: 'pending', exact: true },
          select: (mutation) => mutation.state.variables as AccountVariables,
        },
        props.client,
      )
      seen.push(variables)
      return (
        <output data-testid="variables">{JSON.stringify(variables)}</output>
      )
    }

    const rendered = render(<Observer client={clientA} />)
    expect(seen).toEqual([[accountAVariables]])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountAVariables]),
      { normalizeWhitespace: false },
    )

    const start = seen.length
    rendered.rerender(<Observer client={clientB} />)

    expectRendersSince(seen, start, [accountBVariables])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountBVariables]),
      { normalizeWhitespace: false },
    )
  })

  it('returns the new client variables on the render that changes QueryClientProvider', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)

    const seen: Array<Array<AccountVariables>> = []

    function Observer() {
      const variables = useMutationState({
        filters: { mutationKey: ['profile'], status: 'pending', exact: true },
        select: (mutation) => mutation.state.variables as AccountVariables,
      })
      seen.push(variables)
      return (
        <output data-testid="variables">{JSON.stringify(variables)}</output>
      )
    }

    function Page(props: { client: QueryClient }) {
      return (
        <QueryClientProvider client={props.client}>
          <Observer />
        </QueryClientProvider>
      )
    }

    const rendered = render(<Page client={clientA} />)
    expect(seen[seen.length - 1]).toEqual([accountAVariables])

    const start = seen.length
    rendered.rerender(<Page client={clientB} />)

    expectRendersSince(seen, start, [accountBVariables])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountBVariables]),
      { normalizeWhitespace: false },
    )
  })

  it('returns only the new mutationKey on the render that changes the filter', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const seen: Array<Array<AccountVariables>> = []

    function Observer(props: { accountId: string }) {
      const variables = useMutationState({
        filters: {
          mutationKey: [props.accountId],
          status: 'pending',
          exact: true,
        },
        select: (mutation) => mutation.state.variables as AccountVariables,
      })
      seen.push(variables)
      return (
        <output data-testid="variables">{JSON.stringify(variables)}</output>
      )
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toEqual([accountAVariables])

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, [accountBVariables])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountBVariables]),
      { normalizeWhitespace: false },
    )
  })

  it('returns only the new predicate match on the render that changes the predicate', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const seen: Array<Array<AccountVariables>> = []

    function Observer(props: { accountId: string }) {
      const variables = useMutationState({
        filters: {
          status: 'pending',
          predicate: (mutation) =>
            mutation.options.mutationKey?.[0] === props.accountId,
        },
        select: (mutation) => mutation.state.variables as AccountVariables,
      })
      seen.push(variables)
      return (
        <output data-testid="variables">{JSON.stringify(variables)}</output>
      )
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toEqual([accountAVariables])

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, [accountBVariables])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountBVariables]),
      { normalizeWhitespace: false },
    )
  })

  it('returns the new select result on the render that changes select', () => {
    const client = new QueryClient()
    seedPending(client, ['profile'], accountAVariables)

    const seen: Array<Array<string>> = []

    function Observer(props: { field: keyof AccountVariables }) {
      const selected = useMutationState({
        filters: { mutationKey: ['profile'], status: 'pending', exact: true },
        select: (mutation) =>
          (mutation.state.variables as AccountVariables)[props.field],
      })
      seen.push(selected)
      return <output data-testid="selected">{JSON.stringify(selected)}</output>
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer field="accountId" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toEqual(['account-a'])

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer field="submittedValue" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, ['account-a-placeholder'])
    expect(rendered.getByTestId('selected')).toHaveTextContent(
      JSON.stringify(['account-a-placeholder']),
      { normalizeWhitespace: false },
    )
  })

  it('returns the new mutation data on the render that changes the success filter', async () => {
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

    const seen: Array<Array<string>> = []

    function Observer(props: { accountId: string }) {
      const data = useMutationState({
        filters: {
          mutationKey: [props.accountId],
          status: 'success',
          exact: true,
        },
        select: (mutation) => mutation.state.data as string,
      })
      seen.push(data)
      return <output data-testid="data">{JSON.stringify(data)}</output>
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toEqual(['account-a-result'])

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, ['account-b-result'])
    expect(rendered.getByTestId('data')).toHaveTextContent(
      JSON.stringify(['account-b-result']),
      { normalizeWhitespace: false },
    )
  })

  it('returns the default mutation state for the new filter on that render', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)

    const seen: Array<Array<AccountVariables | undefined>> = []

    function Observer(props: { accountId: string }) {
      const states = useMutationState({
        filters: {
          mutationKey: [props.accountId],
          status: 'pending',
          exact: true,
        },
      })
      const variables = states.map(
        (state) => state.variables as AccountVariables | undefined,
      )
      seen.push(variables)
      return (
        <output data-testid="variables">{JSON.stringify(variables)}</output>
      )
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toEqual([accountAVariables])

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, [accountBVariables])
    expect(rendered.getByTestId('variables')).toHaveTextContent(
      JSON.stringify([accountBVariables]),
      { normalizeWhitespace: false },
    )
  })
})

describe('useIsMutating stale snapshot', () => {
  it('returns the new client pending count on the render that changes the queryClient argument', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)
    seedPending(clientB, ['profile'], {
      ...accountBVariables,
      submittedValue: 'account-b-second-placeholder',
    })

    const seen: Array<number> = []

    function Observer(props: { client: QueryClient }) {
      const count = useIsMutating(
        { mutationKey: ['profile'], exact: true },
        props.client,
      )
      seen.push(count)
      return <output data-testid="count">{count}</output>
    }

    const rendered = render(<Observer client={clientA} />)
    expect(seen[seen.length - 1]).toBe(1)

    const start = seen.length
    rendered.rerender(<Observer client={clientB} />)

    expectRendersSince(seen, start, 2)
    expect(rendered.getByTestId('count')).toHaveTextContent('2')
  })

  it('returns the new client pending count on the render that changes QueryClientProvider', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    seedPending(clientA, ['profile'], accountAVariables)
    seedPending(clientB, ['profile'], accountBVariables)
    seedPending(clientB, ['profile'], {
      ...accountBVariables,
      submittedValue: 'account-b-second-placeholder',
    })

    const seen: Array<number> = []

    function Observer() {
      const count = useIsMutating({ mutationKey: ['profile'], exact: true })
      seen.push(count)
      return <output data-testid="count">{count}</output>
    }

    function Page(props: { client: QueryClient }) {
      return (
        <QueryClientProvider client={props.client}>
          <Observer />
        </QueryClientProvider>
      )
    }

    const rendered = render(<Page client={clientA} />)
    expect(seen[seen.length - 1]).toBe(1)

    const start = seen.length
    rendered.rerender(<Page client={clientB} />)

    expectRendersSince(seen, start, 2)
    expect(rendered.getByTestId('count')).toHaveTextContent('2')
  })

  it('returns the new mutationKey pending count on the render that changes the filter', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)
    seedPending(client, ['account-b'], {
      ...accountBVariables,
      submittedValue: 'account-b-second-placeholder',
    })

    const seen: Array<number> = []

    function Observer(props: { accountId: string }) {
      const count = useIsMutating({
        mutationKey: [props.accountId],
        exact: true,
      })
      seen.push(count)
      return <output data-testid="count">{count}</output>
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toBe(1)

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, 2)
    expect(rendered.getByTestId('count')).toHaveTextContent('2')
  })

  it('returns the new predicate pending count on the render that changes the predicate', () => {
    const client = new QueryClient()
    seedPending(client, ['account-a'], accountAVariables)
    seedPending(client, ['account-b'], accountBVariables)
    seedPending(client, ['account-b'], {
      ...accountBVariables,
      submittedValue: 'account-b-second-placeholder',
    })

    const seen: Array<number> = []

    function Observer(props: { accountId: string }) {
      const count = useIsMutating({
        predicate: (mutation) =>
          mutation.options.mutationKey?.[0] === props.accountId,
      })
      seen.push(count)
      return <output data-testid="count">{count}</output>
    }

    const rendered = render(
      <QueryClientProvider client={client}>
        <Observer accountId="account-a" />
      </QueryClientProvider>,
    )
    expect(seen[seen.length - 1]).toBe(1)

    const start = seen.length
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Observer accountId="account-b" />
      </QueryClientProvider>,
    )

    expectRendersSince(seen, start, 2)
    expect(rendered.getByTestId('count')).toHaveTextContent('2')
  })
})
