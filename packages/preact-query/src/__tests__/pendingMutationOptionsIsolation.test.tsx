import { fireEvent } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueryClient, onlineManager, useMutation, useQueryClient } from '..'
import { renderWithClient } from './utils'

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

function Page({
  account,
  calls,
  request,
}: {
  account: AccountName
  calls: Calls
  request: Promise<string>
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (variables: Variables) => {
      calls.fn.push({ account, variables })
      return request.then((echoed) => ({ echoed }))
    },
    onSuccess: (data: Payload, variables: Variables) => {
      calls.success.push({ account, data, variables })
      queryClient.setQueryData(['profile', account], { data, variables })
    },
  })

  return (
    <button
      onClick={() => {
        mutation.mutate(previousVariables)
      }}
    >
      save
    </button>
  )
}

describe('useMutation keeps a pending call bound to the account that started it', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
  })

  afterEach(() => {
    onlineManager.setOnline(true)
    queryClient.clear()
    vi.useRealTimers()
  })

  it('does not run the next account success handler for an in-flight mutation', async () => {
    const calls: Calls = { fn: [], success: [] }
    const request = createDeferred<string>()
    const view = renderWithClient(
      queryClient,
      <Page account="previous" calls={calls} request={request.promise} />,
    )

    fireEvent.click(view.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    view.rerender(
      <Page account="next" calls={calls} request={request.promise} />,
    )
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  })

  it('does not resume a paused mutation with the next account mutation function', async () => {
    const calls: Calls = { fn: [], success: [] }
    const request = createDeferred<string>()
    const view = renderWithClient(
      queryClient,
      <Page account="previous" calls={calls} request={request.promise} />,
    )
    onlineManager.setOnline(false)

    fireEvent.click(view.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([])

    view.rerender(
      <Page account="next" calls={calls} request={request.promise} />,
    )
    onlineManager.setOnline(true)
    await vi.advanceTimersByTimeAsync(0)
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  })
})
