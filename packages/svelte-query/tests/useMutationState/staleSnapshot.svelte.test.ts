import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import { QueryClient } from '@tanstack/query-core'
import StaleSnapshot from './StaleSnapshot.svelte'

/**
 * Svelte `useMutationState` keeps the array created on first run and writes it
 * only from the cache subscriber. Updating the options object the hook already
 * holds must change the rendered selection before any cache event.
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
  it('renders the new mutationKey when the held options filters change', async () => {
    const client = new QueryClient()
    seedPending(client, ['profile', 'account-a'], accountAVariables)
    seedPending(client, ['profile', 'account-b'], accountBVariables)

    const rendered = render(StaleSnapshot, {
      client,
      accountId: 'account-a',
      field: 'submittedValue',
      status: 'pending',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a-placeholder']),
    )

    await rendered.rerender({
      client,
      accountId: 'account-b',
      field: 'submittedValue',
      status: 'pending',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-b-placeholder']),
    )
  })

  it('renders the new select field when the held options select changes', async () => {
    const client = new QueryClient()
    seedPending(client, ['profile', 'account-a'], accountAVariables)

    const rendered = render(StaleSnapshot, {
      client,
      accountId: 'account-a',
      field: 'accountId',
      status: 'pending',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a']),
    )

    await rendered.rerender({
      client,
      accountId: 'account-a',
      field: 'submittedValue',
      status: 'pending',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a-placeholder']),
    )
  })

  it('renders the new success data when the held options filters change', async () => {
    const client = new QueryClient()
    await seedSuccess(
      client,
      ['profile', 'account-a'],
      accountAVariables,
      'account-a-result',
    )
    await seedSuccess(
      client,
      ['profile', 'account-b'],
      accountBVariables,
      'account-b-result',
    )

    const rendered = render(StaleSnapshot, {
      client,
      accountId: 'account-a',
      field: 'data',
      status: 'success',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-a-result']),
    )

    await rendered.rerender({
      client,
      accountId: 'account-b',
      field: 'data',
      status: 'success',
    })

    expect(rendered.getByTestId('selected').textContent).toBe(
      JSON.stringify(['account-b-result']),
    )
  })
})
