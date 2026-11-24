import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import { flushSync } from 'svelte'
import {
  MutationObserver,
  QueryClient,
  focusManager,
  onlineManager,
} from '@tanstack/query-core'
import AccountSwitch from './AccountSwitch.svelte'

type AccountAction = {
  accountId: string
  operation: string
}

function seedAccount(client: QueryClient, label: string) {
  client.setQueryData(['current-user'], label)
  client.setQueryData(['feed'], {
    pages: [`${label}-feed`],
    pageParams: [0],
  })
  client.setQueryData(['inbox'], `${label}-inbox`)
}

describe('QueryClientProvider account switch', () => {
  let clientA: QueryClient
  let clientB: QueryClient
  let calls: Array<AccountAction>

  beforeEach(() => {
    vi.useFakeTimers()
    onlineManager.setOnline(true)
    focusManager.setFocused(true)
    calls = []
    clientA = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    clientB = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    seedAccount(clientA, 'account-a-profile')
    seedAccount(clientB, 'account-b-profile')
  })

  afterEach(() => {
    clientA.clear()
    clientB.clear()
    clientA.unmount()
    clientB.unmount()
    onlineManager.setOnline(true)
    focusManager.setFocused(undefined)
    vi.useRealTimers()
  })

  async function switchClient(
    rendered: ReturnType<typeof render>,
    next: QueryClient,
    showFreshPage = false,
  ) {
    await rendered.rerender({
      client: next,
      showFreshPage,
      mutationFn: (variables: AccountAction) => {
        calls.push(variables)
        return Promise.resolve(variables.operation)
      },
    })
    flushSync()
  }

  it('keeps showing the previous account until the provider adopts the next client', async () => {
    const rendered = render(AccountSwitch, {
      props: {
        client: clientA,
        mutationFn: (variables: AccountAction) => {
          calls.push(variables)
          return Promise.resolve(variables.operation)
        },
      },
    })

    expect(rendered.getByTestId('mounted-user')).toHaveTextContent(
      'account-a-profile',
    )
    expect(rendered.getByTestId('mounted-feed')).toHaveTextContent(
      'account-a-profile-feed',
    )
    expect(rendered.getByTestId('mounted-inbox')).toHaveTextContent(
      'account-a-profile-inbox',
    )

    await switchClient(rendered, clientB, true)

    expect(rendered.getByTestId('mounted-user')).toHaveTextContent(
      'account-b-profile',
    )
    expect(rendered.getByTestId('mounted-user')).not.toHaveTextContent(
      'account-a-profile',
    )
    expect(rendered.getByTestId('mounted-feed')).toHaveTextContent(
      'account-b-profile-feed',
    )
    expect(rendered.getByTestId('mounted-inbox')).toHaveTextContent(
      'account-b-profile-inbox',
    )
    expect(rendered.getByTestId('mounted-client-user')).toHaveTextContent(
      'account-b-profile',
    )
    expect(rendered.getByTestId('fresh-user')).toHaveTextContent(
      'account-b-profile',
    )
    expect(rendered.getByTestId('fresh-client-user')).toHaveTextContent(
      'account-b-profile',
    )
    expect(rendered.container.textContent).not.toContain('account-a-profile')
  })

  it('counts fetches and mutations on the client that is current after the switch', async () => {
    let releaseInflight: (value: string) => void = () => undefined
    const inflight = new Promise<string>((resolve) => {
      releaseInflight = resolve
    })
    void clientA.prefetchQuery({
      queryKey: ['account-a-only'],
      queryFn: () => inflight,
      staleTime: 0,
    })

    const rendered = render(AccountSwitch, {
      props: {
        client: clientA,
        mutationFn: (variables: AccountAction) => {
          calls.push(variables)
          return Promise.resolve(variables.operation)
        },
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByTestId('mounted-fetching')).toHaveTextContent('1')

    await switchClient(rendered, clientB)

    expect(rendered.getByTestId('mounted-fetching')).toHaveTextContent('0')
    expect(rendered.getByTestId('mounted-mutating')).toHaveTextContent('0')

    releaseInflight('done')
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not resume the previous account paused mutation when the network returns', async () => {
    onlineManager.setOnline(false)

    const rendered = render(AccountSwitch, {
      props: {
        client: clientA,
        mutationFn: (variables: AccountAction) => {
          calls.push(variables)
          return Promise.resolve(variables.operation)
        },
      },
    })

    fireEvent.click(rendered.getByRole('button', { name: 'Run paused action' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    expect(rendered.getByTestId('mounted-pending')).toHaveTextContent(
      'account-a',
    )
    expect(rendered.getByTestId('mounted-mutating')).toHaveTextContent('1')

    const nextCalls: Array<AccountAction> = []
    const nextOptions = {
      mutationKey: ['account-action'],
      mutationFn: (variables: AccountAction) => {
        nextCalls.push(variables)
        return Promise.resolve(variables.operation)
      },
      retry: false,
      networkMode: 'online' as const,
    }
    const nextObserver = new MutationObserver<string, Error, AccountAction>(
      clientB,
      nextOptions,
    )
    const extraObserver = new MutationObserver<string, Error, AccountAction>(
      clientB,
      nextOptions,
    )
    void nextObserver.mutate({
      accountId: 'account-b',
      operation: 'save-draft',
    })
    void extraObserver.mutate({
      accountId: 'account-b',
      operation: 'second-draft',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(nextObserver.getCurrentResult().isPaused).toBe(true)

    await switchClient(rendered, clientB)

    // The previous account has one paused mutation and the next has two, so a
    // hook that is still bound to the previous client cannot report this count
    // or these variables.
    expect(rendered.getByTestId('mounted-pending')).toHaveTextContent(
      'account-b',
    )
    expect(rendered.getByTestId('mounted-pending')).not.toHaveTextContent(
      'account-a',
    )
    expect(rendered.getByTestId('mounted-mutating')).toHaveTextContent('2')

    onlineManager.setOnline(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toEqual([])
    expect(nextCalls).toEqual([
      { accountId: 'account-b', operation: 'save-draft' },
      { accountId: 'account-b', operation: 'second-draft' },
    ])
  })

  it('does not resume the previous account paused mutation when the window focuses', async () => {
    focusManager.setFocused(false)
    onlineManager.setOnline(false)

    const rendered = render(AccountSwitch, {
      props: {
        client: clientA,
        mutationFn: (variables: AccountAction) => {
          calls.push(variables)
          return Promise.resolve(variables.operation)
        },
      },
    })

    fireEvent.click(rendered.getByRole('button', { name: 'Run paused action' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])

    const nextCalls: Array<AccountAction> = []
    const nextObserver = new MutationObserver<string, Error, AccountAction>(
      clientB,
      {
        mutationKey: ['account-action'],
        mutationFn: (variables) => {
          nextCalls.push(variables)
          return Promise.resolve(variables.operation)
        },
        retry: false,
        networkMode: 'online',
      },
    )
    void nextObserver.mutate({
      accountId: 'account-b',
      operation: 'save-draft',
    })
    await vi.advanceTimersByTimeAsync(0)

    // Network returns while the window is still unfocused. Resume is a no-op
    // until focus, which is the event that then replays a paused mutation.
    onlineManager.setOnline(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    expect(nextCalls).toEqual([])

    await switchClient(rendered, clientB)

    focusManager.setFocused(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toEqual([])
    expect(nextCalls).toEqual([
      { accountId: 'account-b', operation: 'save-draft' },
    ])
  })

  it('moves focus and online subscriptions from the previous client to the next one', async () => {
    const rendered = render(AccountSwitch, {
      props: {
        client: clientA,
        mutationFn: (variables: AccountAction) => {
          calls.push(variables)
          return Promise.resolve(variables.operation)
        },
      },
    })

    const focusA = vi.spyOn(clientA.getQueryCache(), 'onFocus')
    const focusB = vi.spyOn(clientB.getQueryCache(), 'onFocus')
    const onlineA = vi.spyOn(clientA.getQueryCache(), 'onOnline')
    const onlineB = vi.spyOn(clientB.getQueryCache(), 'onOnline')

    await switchClient(rendered, clientB)

    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(focusA).not.toHaveBeenCalled()
    expect(focusB).toHaveBeenCalled()

    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onlineA).not.toHaveBeenCalled()
    expect(onlineB).toHaveBeenCalled()
  })
})
