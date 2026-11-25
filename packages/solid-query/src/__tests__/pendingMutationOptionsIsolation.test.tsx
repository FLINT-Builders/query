import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { QueryClient, useMutation } from '..'
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

describe('useMutation keeps a pending call bound to the account that started it', () => {
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
    const controls: { mutate?: () => void; switchAccount?: () => void } = {}

    function Page() {
      const [account, setAccount] = createSignal<AccountName>('previous')
      const mutation = useMutation(() => {
        const current = account()
        return {
          mutationFn: (variables: Variables) => {
            calls.fn.push({ account: current, variables })
            return request.promise.then((echoed) => ({ echoed }))
          },
          onSuccess: (data: Payload, variables: Variables) => {
            calls.success.push({ account: current, data, variables })
            queryClient.setQueryData(['profile', current], { data, variables })
          },
        }
      })
      controls.mutate = () => {
        mutation.mutate(previousVariables)
      }
      controls.switchAccount = () => {
        setAccount('next')
      }
      return <div>{account()}</div>
    }

    renderWithClient(queryClient, () => <Page />)
    controls.mutate?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([
      { account: 'previous', variables: previousVariables },
    ])

    controls.switchAccount?.()
    request.resolve('server-body')
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  })
})
