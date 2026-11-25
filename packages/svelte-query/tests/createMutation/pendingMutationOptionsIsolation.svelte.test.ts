import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/svelte'
import { QueryClient } from '@tanstack/query-core'
import PendingAccountSwitch from './PendingAccountSwitch.svelte'

type AccountName = 'previous' | 'next'
type Variables = { accountId: string; body: string }
type Payload = { echoed: string }

type Calls = {
  fn: Array<{ account: AccountName; variables: Variables }>
  success: Array<{ account: AccountName; data: Payload; variables: Variables }>
}

const previousVariables: Variables = {
  accountId: 'previous-user',
  body: 'previous-draft',
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createMutation keeps a pending call bound to the account that started it', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  it('does not run the next account success handler for an in-flight mutation', async () => {
    const calls: Calls = { fn: [], success: [] }
    const request = createDeferred<string>()
    const rendered = render(PendingAccountSwitch, {
      props: {
        queryClient,
        calls,
        request: request.promise,
        variables: previousVariables,
      },
    })

    fireEvent.click(rendered.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    fireEvent.click(rendered.getByRole('button', { name: 'switch' }))
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  })
})
