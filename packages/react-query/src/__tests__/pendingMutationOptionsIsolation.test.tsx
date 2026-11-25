import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { QueryClient, onlineManager, useMutation, useQueryClient } from '..'
import { renderWithClient } from './utils'

type AccountName = 'previous' | 'next'
type Variables = { accountId: string; body: string }
type Payload = { echoed: string }

type Calls = {
  fn: Array<{ account: AccountName; variables: Variables }>
  success: Array<{ account: AccountName; data: Payload; variables: Variables }>
  error: Array<{ account: AccountName; error: Error; variables: Variables }>
}

const previousVariables: Variables = {
  accountId: 'previous-user',
  body: 'previous-draft',
}

function createCalls(): Calls {
  return { fn: [], success: [], error: [] }
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function Page({
  account,
  calls,
  request,
  mutationKey,
  fail,
}: {
  account: AccountName
  calls: Calls
  request: Promise<string>
  mutationKey?: ReadonlyArray<unknown>
  fail?: boolean
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationKey,
    retry: fail ? 1 : 0,
    retryDelay: fail ? 5 : undefined,
    mutationFn: (variables: Variables) => {
      calls.fn.push({ account, variables })
      if (fail) {
        return Promise.reject(new Error(`temporary-${account}`))
      }
      return request.then((echoed) => ({ echoed }))
    },
    onSuccess: (data: Payload, variables: Variables) => {
      calls.success.push({ account, data, variables })
      queryClient.setQueryData(['profile', account], { data, variables })
    },
    onError: (error: Error, variables: Variables) => {
      calls.error.push({ account, error, variables })
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

  function expectNextAccountIsolated(calls: Calls) {
    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.error.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  }

  it('does not run the next account success handler for an in-flight mutation without a key', async () => {
    const calls = createCalls()
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

    expectNextAccountIsolated(calls)
  })

  it('does not run the next account success handler when the mutation key stays the same', async () => {
    const calls = createCalls()
    const request = createDeferred<string>()
    const mutationKey = ['profile', 'save']
    const view = renderWithClient(
      queryClient,
      <Page
        account="previous"
        calls={calls}
        request={request.promise}
        mutationKey={mutationKey}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    view.rerender(
      <Page
        account="next"
        calls={calls}
        request={request.promise}
        mutationKey={mutationKey}
      />,
    )
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expectNextAccountIsolated(calls)
  })

  it('does not retry an in-flight failure with the next account mutation function', async () => {
    const calls = createCalls()
    const request = createDeferred<string>()
    const view = renderWithClient(
      queryClient,
      <Page account="previous" calls={calls} request={request.promise} fail />,
    )

    fireEvent.click(view.getByRole('button', { name: 'save' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    view.rerender(
      <Page account="next" calls={calls} request={request.promise} fail />,
    )
    await vi.advanceTimersByTimeAsync(5)

    expectNextAccountIsolated(calls)
  })

  it('does not resume a paused mutation with the next account mutation function', async () => {
    const calls = createCalls()
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

    expectNextAccountIsolated(calls)
  })
})
