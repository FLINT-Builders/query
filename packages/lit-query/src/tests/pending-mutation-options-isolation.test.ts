import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { createMutationController } from '../createMutationController.js'
import { TestControllerHost } from './testHost.js'

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

describe('createMutationController keeps a pending call bound to the account that started it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not run the next account success handler for an in-flight mutation', async () => {
    const calls: Calls = { fn: [], success: [] }
    const request = createDeferred<string>()
    const queryClient = new QueryClient()
    const host = new TestControllerHost()
    let account: AccountName = 'previous'

    const mutation = createMutationController(
      host,
      () => {
        const current = account
        return {
          mutationFn: (variables: Variables) => {
            calls.fn.push({ account: current, variables })
            return request.promise.then((echoed) => ({ echoed }))
          },
          onSuccess: (data: Payload, variables: Variables) => {
            calls.success.push({ account: current, data, variables })
            queryClient.setQueryData(['profile', current], {
              data,
              variables,
            })
          },
        }
      },
      queryClient,
    )

    host.connect()
    await vi.advanceTimersByTimeAsync(0)

    mutation.mutate(previousVariables)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    account = 'next'
    host.update()
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()

    mutation.destroy()
  })
})
