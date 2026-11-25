import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { QueryClient } from '@tanstack/query-core'
import { sleep } from '@tanstack/query-test-utils'
import AccountLayout from './AccountLayout.svelte'
import ProviderLayout from './ProviderLayout.svelte'

const previousAccountId = 'account-previous'
const currentAccountId = 'account-current'

function startMutation(client: QueryClient, accountId: string) {
  const mutation = client.getMutationCache().build(client, {
    mutationKey: ['account', accountId, 'save'],
    mutationFn: () => sleep(10_000).then(() => 'saved'),
  })
  // The promise stays pending on purpose. Do not await it: an async test
  // would wait out the mutation, and fake timers are not advanced that far.
  const pending = mutation.execute({ field: 'profile' })
  pending.catch(() => {})
}

function startFetch(client: QueryClient, accountId: string) {
  const pending = client.query({
    queryKey: ['account', accountId, 'profile'],
    queryFn: () => sleep(10_000).then(() => 'profile'),
  })
  pending.catch(() => {})
}

/**
 * Counts subscribe/unsubscribe calls made after the spy is installed, so the
 * assertion is that the helpers drop every subscription they created.
 */
function spyOnCache(cache: {
  subscribe: (listener: () => void) => () => void
}) {
  const original = cache.subscribe
  let subscribed = 0
  let unsubscribed = 0
  vi.spyOn(cache, 'subscribe').mockImplementation((listener: () => void) => {
    subscribed += 1
    const unsubscribe = original.call(cache, listener)
    return () => {
      unsubscribed += 1
      unsubscribe()
    }
  })
  return {
    subscribed: () => subscribed,
    unsubscribed: () => unsubscribed,
  }
}

describe('account switch while the mutation indicators stay mounted', () => {
  let previousClient: QueryClient
  let currentClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    previousClient = new QueryClient()
    currentClient = new QueryClient()
  })

  afterEach(() => {
    previousClient.clear()
    currentClient.clear()
    vi.useRealTimers()
  })

  async function mountWithPreviousActivity(Component: typeof AccountLayout) {
    startMutation(previousClient, previousAccountId)
    startFetch(previousClient, previousAccountId)
    await vi.advanceTimersByTimeAsync(0)

    const mutationSubs = spyOnCache(previousClient.getMutationCache())
    const querySubs = spyOnCache(previousClient.getQueryCache())

    const rendered = render(Component, {
      props: {
        accountId: previousAccountId,
        queryClient: previousClient,
      },
    })

    expect(rendered.getByText('account: account-previous')).toBeInTheDocument()
    expect(rendered.getByText('isMutating: 1')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 1')).toBeInTheDocument()
    expect(
      rendered.getByText(
        'pendingMutations: [["account","account-previous","save"]]',
      ),
    ).toBeInTheDocument()
    expect(mutationSubs.subscribed()).toBeGreaterThan(0)
    expect(querySubs.subscribed()).toBeGreaterThan(0)

    return { rendered, mutationSubs, querySubs }
  }

  async function expectCurrentAccount(
    rendered: ReturnType<typeof render>,
    mutationSubs: ReturnType<typeof spyOnCache>,
    querySubs: ReturnType<typeof spyOnCache>,
  ) {
    await rendered.rerender({
      accountId: currentAccountId,
      queryClient: currentClient,
    })
    await vi.advanceTimersByTimeAsync(0)

    // Another in-flight mutation on the account that was just signed out.
    // The mounted page must not follow it.
    startMutation(previousClient, previousAccountId)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('account: account-current')).toBeInTheDocument()
    expect(rendered.getByText('isMutating: 0')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 0')).toBeInTheDocument()
    expect(rendered.getByText('pendingMutations: []')).toBeInTheDocument()
    expect(mutationSubs.unsubscribed()).toBe(mutationSubs.subscribed())
    expect(querySubs.unsubscribed()).toBe(querySubs.subscribed())

    startMutation(currentClient, currentAccountId)
    startFetch(currentClient, currentAccountId)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('isMutating: 1')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 1')).toBeInTheDocument()
    expect(
      rendered.getByText(
        'pendingMutations: [["account","account-current","save"]]',
      ),
    ).toBeInTheDocument()

    startMutation(previousClient, previousAccountId)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('isMutating: 1')).toBeInTheDocument()
    expect(
      rendered.getByText(
        'pendingMutations: [["account","account-current","save"]]',
      ),
    ).toBeInTheDocument()
  }

  it('keeps reporting the client and account passed into the helpers', async () => {
    const mounted = await mountWithPreviousActivity(AccountLayout)
    await expectCurrentAccount(
      mounted.rendered,
      mounted.mutationSubs,
      mounted.querySubs,
    )
    expect(mounted.rendered.getByText('isMutating: 1')).toBeInTheDocument()
  })

  it('keeps reporting the client from QueryClientProvider and the account passed to the helpers', async () => {
    const mounted = await mountWithPreviousActivity(ProviderLayout)
    await expectCurrentAccount(
      mounted.rendered,
      mounted.mutationSubs,
      mounted.querySubs,
    )
    expect(mounted.rendered.getByText('isMutating: 1')).toBeInTheDocument()
  })

  it('keeps reporting the account id passed in the filters when the client is unchanged', async () => {
    startMutation(previousClient, previousAccountId)
    startFetch(previousClient, previousAccountId)
    await vi.advanceTimersByTimeAsync(0)

    const rendered = render(AccountLayout, {
      props: {
        accountId: previousAccountId,
        queryClient: previousClient,
      },
    })

    expect(rendered.getByText('isMutating: 1')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 1')).toBeInTheDocument()

    await rendered.rerender({
      accountId: currentAccountId,
      queryClient: previousClient,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('account: account-current')).toBeInTheDocument()
    expect(rendered.getByText('isMutating: 0')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 0')).toBeInTheDocument()
    expect(rendered.getByText('pendingMutations: []')).toBeInTheDocument()

    startMutation(previousClient, currentAccountId)
    startFetch(previousClient, currentAccountId)
    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('isMutating: 1')).toBeInTheDocument()
    expect(rendered.getByText('isFetching: 1')).toBeInTheDocument()
    expect(
      rendered.getByText(
        'pendingMutations: [["account","account-current","save"]]',
      ),
    ).toBeInTheDocument()
  })
})
