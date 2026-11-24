import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/svelte'
import { QueryClient, dehydrate } from '@tanstack/query-core'
import AccountView from './AccountView.svelte'
import type { DehydratedState, HydrateOptions } from '@tanstack/query-core'

const CURRENT_USER = ['currentUser'] as const
const SESSION = ['session'] as const

const T0 = 10_000_000
const ACCOUNT_A_AT = T0
const OLDER_THAN_B_AT = T0 + 500
const ACCOUNT_B_AT = T0 + 1_000
const STALE_TIME = 60_000

describe('Svelte hydration snapshot updates', () => {
  let queryClient: QueryClient
  let stateA: DehydratedState
  let stateB: DehydratedState
  let olderState: DehydratedState
  let queryFnCalls: number

  beforeEach(() => {
    vi.useFakeTimers()
    queryFnCalls = 0
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    })
    stateA = snapshot([
      {
        queryKey: CURRENT_USER,
        data: 'profile-a-private',
        updatedAt: ACCOUNT_A_AT,
      },
      {
        queryKey: ['billing'],
        data: 'billing-a-private',
        updatedAt: ACCOUNT_A_AT,
      },
    ])
    stateB = snapshot([
      {
        queryKey: CURRENT_USER,
        data: 'profile-b-private',
        updatedAt: ACCOUNT_B_AT,
      },
      {
        queryKey: SESSION,
        data: 'session-b-private',
        updatedAt: ACCOUNT_B_AT,
      },
    ])
    olderState = snapshot([
      {
        queryKey: CURRENT_USER,
        data: 'profile-old-private',
        updatedAt: OLDER_THAN_B_AT,
      },
    ])
    vi.setSystemTime(ACCOUNT_B_AT)
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  function queryFn() {
    queryFnCalls += 1
    return new Promise<string>(() => {})
  }

  it('replaces a mounted HydrationBoundary snapshot, then ignores an older one', async () => {
    let inits = 0
    const rendered = render(AccountView, {
      props: {
        queryClient,
        state: stateA,
        staleTime: STALE_TIME,
        queryFn,
        onInit: () => {
          inits += 1
        },
      },
    })

    expect(inits).toBe(1)
    expect(rendered.getByText('user:profile-a-private')).toBeInTheDocument()
    expect(queryFnCalls).toBe(0)

    await rendered.rerender({ state: stateB })
    await vi.advanceTimersByTimeAsync(STALE_TIME - 1)

    expect(inits).toBe(1)
    expect(queryFnCalls).toBe(0)
    expect(rendered.getByText('user:profile-b-private')).toBeInTheDocument()
    expect(queryClient.getQueryData(CURRENT_USER)).toBe('profile-b-private')
    expect(queryClient.getQueryData(SESSION)).toBe('session-b-private')

    await rendered.rerender({ state: olderState })

    expect(rendered.getByText('user:profile-b-private')).toBeInTheDocument()
    expect(queryClient.getQueryData(CURRENT_USER)).toBe('profile-b-private')
    expect(queryFnCalls).toBe(0)
  })

  it('keeps showing the previous account when the mounted query is already stale', async () => {
    const rendered = render(AccountView, {
      props: {
        queryClient,
        state: stateA,
        staleTime: 0,
        queryFn,
      },
    })

    expect(rendered.getByText('user:profile-a-private')).toBeInTheDocument()

    await rendered.rerender({ state: stateB })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(rendered.getByText('user:profile-b-private')).toBeInTheDocument()
    expect(queryClient.getQueryData(CURRENT_USER)).toBe('profile-b-private')
    expect(queryClient.getQueryData(SESSION)).toBe('session-b-private')
  })

  it('hydrates a query client passed to HydrationBoundary after the first render', async () => {
    const nextClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    })
    const rendered = render(AccountView, {
      props: {
        queryClient,
        boundaryClient: queryClient,
        state: stateA,
        staleTime: STALE_TIME,
        queryFn,
      },
    })

    expect(queryClient.getQueryData(CURRENT_USER)).toBe('profile-a-private')
    expect(nextClient.getQueryData(CURRENT_USER)).toBeUndefined()

    await rendered.rerender({ boundaryClient: nextClient })

    expect(nextClient.getQueryData(CURRENT_USER)).toBe('profile-a-private')
    expect(nextClient.getQueryData(['billing'])).toBe('billing-a-private')
    nextClient.clear()
  })

  it('applies hydrate options from a later HydrationBoundary update', async () => {
    const rendered = render(AccountView, {
      props: {
        queryClient,
        state: stateA,
        options: prefixOptions('first:'),
        staleTime: STALE_TIME,
        queryFn,
      },
    })

    expect(
      rendered.getByText('user:first:profile-a-private'),
    ).toBeInTheDocument()

    await rendered.rerender({
      state: stateB,
      options: prefixOptions('second:'),
    })

    expect(
      rendered.getByText('user:second:profile-b-private'),
    ).toBeInTheDocument()
    expect(queryClient.getQueryData(CURRENT_USER)).toBe(
      'second:profile-b-private',
    )
    expect(queryClient.getQueryData(SESSION)).toBe('second:session-b-private')
  })
})

function prefixOptions(prefix: string): HydrateOptions {
  return {
    defaultOptions: {
      deserializeData: (data) => `${prefix}${String(data)}`,
    },
  }
}

function snapshot(
  entries: Array<{
    queryKey: ReadonlyArray<unknown>
    data: string
    updatedAt: number
  }>,
): DehydratedState {
  const client = new QueryClient()
  for (const entry of entries) {
    vi.setSystemTime(entry.updatedAt)
    client.setQueryData(entry.queryKey, entry.data)
  }
  const state = JSON.parse(JSON.stringify(dehydrate(client))) as DehydratedState
  client.clear()
  return state
}
