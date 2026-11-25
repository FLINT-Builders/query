import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import { MutationObserver, QueryClient } from '@tanstack/query-core'
import FrozenMutatingFilters from '../useIsMutating/FrozenFilters.svelte'
import FrozenFetchingFilters from '../useIsFetching/FrozenFilters.svelte'
import FrozenFilters from './FrozenFilters.svelte'
import FrozenClientArgument from './FrozenClientArgument.svelte'
import FrozenClientProvider from './FrozenClientProvider.svelte'

type AccountPayload = {
  account: string
  form: string
}

async function submit(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: AccountPayload,
) {
  const observer = new MutationObserver(client, {
    mutationKey,
    gcTime: Infinity,
    mutationFn: (vars: AccountPayload) =>
      Promise.resolve({
        savedFor: vars.account,
        receipt: `receipt-for-${vars.form}`,
      }),
  })
  await observer.mutate(variables)
  flushSync()
}

function payloadsOf(rendered: ReturnType<typeof render>): string {
  return rendered.getByTestId('payloads').textContent ?? ''
}

describe('frozen mutation snapshot', () => {
  it('replaces the previous account mutation variables and results when the filter changes', async () => {
    const client = new QueryClient()
    const rendered = render(FrozenFilters, {
      props: {
        queryClient: client,
        filters: { mutationKey: ['profile', 'account-a'] },
      },
    })

    await submit(client, ['profile', 'account-a'], {
      account: 'account-a',
      form: 'form-from-a',
    })
    await submit(client, ['profile', 'account-b'], {
      account: 'account-b',
      form: 'form-from-b',
    })

    expect(payloadsOf(rendered)).toContain('form-from-a')
    expect(payloadsOf(rendered)).toContain('receipt-for-form-from-a')
    expect(payloadsOf(rendered)).not.toContain('form-from-b')

    await rendered.rerender({
      queryClient: client,
      filters: { mutationKey: ['profile', 'account-b'] },
    })

    const after = payloadsOf(rendered)
    expect(after).toContain('form-from-b')
    expect(after).toContain('receipt-for-form-from-b')
    expect(after).not.toContain('form-from-a')
    expect(after).not.toContain('receipt-for-form-from-a')
  })

  it('drops the previous account mutation payloads when the queryClient argument changes', async () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    const rendered = render(FrozenClientArgument, {
      props: { queryClient: clientA },
    })

    await submit(clientA, ['profile'], {
      account: 'account-a',
      form: 'form-from-a',
    })
    expect(payloadsOf(rendered)).toContain('form-from-a')
    expect(payloadsOf(rendered)).toContain('receipt-for-form-from-a')

    await rendered.rerender({ queryClient: clientB })

    expect(payloadsOf(rendered)).not.toContain('form-from-a')
    expect(payloadsOf(rendered)).not.toContain('receipt-for-form-from-a')

    await submit(clientB, ['profile'], {
      account: 'account-b',
      form: 'form-from-b',
    })
    const afterB = payloadsOf(rendered)
    expect(afterB).toContain('form-from-b')
    expect(afterB).toContain('receipt-for-form-from-b')
    expect(afterB).not.toContain('form-from-a')

    await submit(clientA, ['profile'], {
      account: 'account-a',
      form: 'form-from-a-again',
    })
    const afterA = payloadsOf(rendered)
    expect(afterA).not.toContain('form-from-a')
    expect(afterA).not.toContain('form-from-a-again')
    expect(afterA).toContain('form-from-b')
  })

  it('drops the previous account mutation payloads when the provider client changes', async () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    const rendered = render(FrozenClientProvider, {
      props: { client: clientA },
    })

    await submit(clientA, ['profile'], {
      account: 'account-a',
      form: 'form-from-a',
    })
    expect(payloadsOf(rendered)).toContain('form-from-a')
    expect(payloadsOf(rendered)).toContain('receipt-for-form-from-a')

    let releasePending: (value: string) => void = () => {}
    const pending = new MutationObserver(clientA, {
      mutationKey: ['profile'],
      gcTime: Infinity,
      mutationFn: () =>
        new Promise<string>((resolve) => {
          releasePending = resolve
        }),
    })
    void pending.mutate({ account: 'account-a', form: 'pending-form-from-a' })
    flushSync()
    expect(rendered.getByTestId('pending').textContent).toBe('1')

    let releaseFetch: (value: string) => void = () => {}
    const fetching = clientA.query({
      queryKey: ['profile'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          releaseFetch = resolve
        }),
    })
    flushSync()
    expect(rendered.getByTestId('fetching').textContent).toBe('1')

    await rendered.rerender({ client: clientB })

    expect(payloadsOf(rendered)).not.toContain('form-from-a')
    expect(payloadsOf(rendered)).not.toContain('receipt-for-form-from-a')
    expect(payloadsOf(rendered)).not.toContain('pending-form-from-a')
    expect(rendered.getByTestId('pending').textContent).toBe('0')
    expect(rendered.getByTestId('fetching').textContent).toBe('0')

    await submit(clientB, ['profile'], {
      account: 'account-b',
      form: 'form-from-b',
    })
    const afterB = payloadsOf(rendered)
    expect(afterB).toContain('form-from-b')
    expect(afterB).toContain('receipt-for-form-from-b')
    expect(afterB).not.toContain('form-from-a')

    await submit(clientA, ['profile'], {
      account: 'account-a',
      form: 'form-from-a-again',
    })
    expect(payloadsOf(rendered)).not.toContain('form-from-a')
    expect(payloadsOf(rendered)).not.toContain('form-from-a-again')
    expect(payloadsOf(rendered)).toContain('form-from-b')

    let releaseLateFetch: (value: string) => void = () => {}
    const lateFetch = clientA.query({
      queryKey: ['profile', 'late'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          releaseLateFetch = resolve
        }),
    })
    flushSync()
    expect(rendered.getByTestId('fetching').textContent).toBe('0')
    expect(rendered.getByTestId('pending').textContent).toBe('0')

    releasePending('done')
    releaseFetch('done')
    releaseLateFetch('done')
    await Promise.allSettled([fetching, lateFetch])
    flushSync()
    expect(payloadsOf(rendered)).not.toContain('form-from-a')
    expect(rendered.getByTestId('pending').textContent).toBe('0')
    expect(rendered.getByTestId('fetching').textContent).toBe('0')
  })

  it('stops counting the previous account pending mutations when the mutation filter changes', async () => {
    const client = new QueryClient()
    const rendered = render(FrozenMutatingFilters, {
      props: {
        queryClient: client,
        filters: { mutationKey: ['profile', 'account-a'] },
      },
    })

    let release: (value: string) => void = () => {}
    const pending = new MutationObserver(client, {
      mutationKey: ['profile', 'account-a'],
      gcTime: Infinity,
      mutationFn: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    })
    void pending.mutate({ account: 'account-a', form: 'pending-form-from-a' })
    flushSync()
    expect(rendered.getByTestId('pending').textContent).toBe('1')

    await rendered.rerender({
      queryClient: client,
      filters: { mutationKey: ['profile', 'account-b'] },
    })

    expect(rendered.getByTestId('pending').textContent).toBe('0')
    release('done')
  })

  it('stops counting the previous account fetches when the query filter changes', async () => {
    const client = new QueryClient()
    const rendered = render(FrozenFetchingFilters, {
      props: {
        queryClient: client,
        filters: { queryKey: ['profile', 'account-a'] },
      },
    })

    let release: (value: string) => void = () => {}
    const fetching = client.query({
      queryKey: ['profile', 'account-a'],
      queryFn: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    })
    flushSync()
    expect(rendered.getByTestId('fetching').textContent).toBe('1')

    await rendered.rerender({
      queryClient: client,
      filters: { queryKey: ['profile', 'account-b'] },
    })

    expect(rendered.getByTestId('fetching').textContent).toBe('0')
    release('done')
    await fetching.catch(() => undefined)
  })
})
