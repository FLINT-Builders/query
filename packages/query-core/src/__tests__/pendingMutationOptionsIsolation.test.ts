import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient, onlineManager } from '..'
import type { MutationObserverOptions } from '..'

type AccountName = 'previous' | 'next'
type Variables = { accountId: string; body: string }
type Payload = { echoed: string }

type FnCall = { account: AccountName; variables: Variables }
type SuccessCall = {
  account: AccountName
  data: Payload
  variables: Variables
}
type ErrorCall = { account: AccountName; error: Error; variables: Variables }
type SettledCall = {
  account: AccountName
  data: Payload | undefined
  error: Error | null
  variables: Variables
}

type Calls = {
  fn: Array<FnCall>
  success: Array<SuccessCall>
  error: Array<ErrorCall>
  settled: Array<SettledCall>
}

type KeyCase = {
  label: string
  previousKey: ReadonlyArray<unknown> | undefined
  nextKey: ReadonlyArray<unknown> | undefined
}

const previousVariables: Variables = {
  accountId: 'previous-user',
  body: 'previous-draft',
}

const keyCases: Array<KeyCase> = [
  {
    label: 'an omitted mutation key',
    previousKey: undefined,
    nextKey: undefined,
  },
  {
    label: 'an unchanged mutation key',
    previousKey: ['profile', 'save'],
    nextKey: ['profile', 'save'],
  },
  {
    label: 'a mutation key removed while the call is pending',
    previousKey: ['profile', 'save'],
    nextKey: undefined,
  },
  {
    label: 'a mutation key added while the call is pending',
    previousKey: undefined,
    nextKey: ['profile', 'save'],
  },
]

function createCalls(): Calls {
  return { fn: [], success: [], error: [], settled: [] }
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

describe('pending mutation options stay bound to the call that started them', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
    queryClient.mount()
  })

  afterEach(() => {
    onlineManager.setOnline(true)
    queryClient.clear()
    vi.useRealTimers()
  })

  function accountOptions(
    account: AccountName,
    calls: Calls,
    request: Promise<string>,
    mutationKey: ReadonlyArray<unknown> | undefined,
  ): MutationObserverOptions<Payload, Error, Variables, unknown> {
    return {
      mutationKey,
      mutationFn: (variables) => {
        calls.fn.push({ account, variables })
        return request.then((echoed) => ({ echoed }))
      },
      onSuccess: (data, variables) => {
        calls.success.push({ account, data, variables })
        queryClient.setQueryData(['profile', account], { data, variables })
      },
      onError: (error, variables) => {
        calls.error.push({ account, error, variables })
      },
      onSettled: (data, error, variables) => {
        calls.settled.push({ account, data, error, variables })
      },
    }
  }

  function expectNextAccountIsolated(calls: Calls) {
    expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.success.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.error.filter((call) => call.account === 'next')).toEqual([])
    expect(calls.settled.filter((call) => call.account === 'next')).toEqual([])
    expect(queryClient.getQueryData(['profile', 'next'])).toBeUndefined()
  }

  describe.each(keyCases)('with $label', ({ previousKey, nextKey }) => {
    it('does not give the replacement success handler the in-flight response', async () => {
      const calls = createCalls()
      const request = createDeferred<string>()
      const observer = new MutationObserver(
        queryClient,
        accountOptions('previous', calls, request.promise, previousKey),
      )

      const pending = observer.mutate(previousVariables)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.fn).toEqual([
        { account: 'previous', variables: previousVariables },
      ])

      observer.setOptions(
        accountOptions('next', calls, request.promise, nextKey),
      )
      request.resolve('server-body')
      await pending.catch(() => undefined)

      expectNextAccountIsolated(calls)
    })

    it('does not run the replacement mutation function for a call that has not started', async () => {
      const calls = createCalls()
      const request = createDeferred<string>()
      const observer = new MutationObserver(
        queryClient,
        accountOptions('previous', calls, request.promise, previousKey),
      )

      const pending = observer.mutate(previousVariables)
      observer.setOptions(
        accountOptions('next', calls, request.promise, nextKey),
      )
      await vi.advanceTimersByTimeAsync(0)
      request.resolve('server-body')
      await pending.catch(() => undefined)

      expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
      expectNextAccountIsolated(calls)
    })

    it('does not give the replacement error handler the in-flight failure', async () => {
      const calls = createCalls()
      const request = createDeferred<string>()
      const observer = new MutationObserver(
        queryClient,
        accountOptions('previous', calls, request.promise, previousKey),
      )

      const pending = observer.mutate(previousVariables)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.fn).toEqual([
        { account: 'previous', variables: previousVariables },
      ])

      observer.setOptions(
        accountOptions('next', calls, request.promise, nextKey),
      )
      request.reject(new Error('server rejected'))
      await pending.catch(() => undefined)

      expectNextAccountIsolated(calls)
    })
  })

  describe.each(keyCases.filter((keyCase) => keyCase.label.startsWith('an ')))(
    'retry with $label',
    ({ previousKey, nextKey }) => {
      it('retries with the mutation function from the call that started', async () => {
        const calls = createCalls()
        const observer = new MutationObserver<Payload, Error, Variables>(
          queryClient,
          {
            mutationKey: previousKey,
            retry: 1,
            retryDelay: 5,
          mutationFn: (variables) => {
            calls.fn.push({ account: 'previous', variables })
            return Promise.reject(new Error('temporary'))
          },
            onError: (error, variables) => {
              calls.error.push({ account: 'previous', error, variables })
            },
          },
        )

        const pending = observer.mutate(previousVariables)
        void pending.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(calls.fn).toEqual([
          { account: 'previous', variables: previousVariables },
        ])

        observer.setOptions({
          mutationKey: nextKey,
          retry: 1,
          retryDelay: 5,
        mutationFn: (variables) => {
          calls.fn.push({ account: 'next', variables })
          return Promise.reject(new Error('temporary-next'))
        },
          onError: (error, variables) => {
            calls.error.push({ account: 'next', error, variables })
          },
        })
        await vi.advanceTimersByTimeAsync(5)
        await pending.catch(() => undefined)

        expect(calls.fn.filter((call) => call.account === 'next')).toEqual([])
        expect(calls.error.filter((call) => call.account === 'next')).toEqual(
          [],
        )
      })
    },
  )

  it('does not run the replacement mutation function when a scoped call was queued', async () => {
    const calls = createCalls()
    const blockerRequest = createDeferred<string>()
    const queuedRequest = createDeferred<string>()
    const scope = { id: 'profile-save' }
    const blocker = new MutationObserver(queryClient, {
      scope,
      mutationFn: () => blockerRequest.promise.then(() => 'blocked'),
    })
    const observer = new MutationObserver(queryClient, {
      scope,
      ...accountOptions('previous', calls, queuedRequest.promise, undefined),
    })

    const blocking = blocker.mutate(undefined)
    const pending = observer.mutate(previousVariables)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([])

    observer.setOptions({
      scope,
      ...accountOptions('next', calls, queuedRequest.promise, undefined),
    })
    blockerRequest.resolve('release')
    await blocking
    queuedRequest.resolve('server-body')
    await pending.catch(() => undefined)

    expectNextAccountIsolated(calls)
  })

  it('does not run the replacement mutation function when a paused call resumes', async () => {
    onlineManager.setOnline(false)
    const calls = createCalls()
    const request = createDeferred<string>()
    const observer = new MutationObserver(
      queryClient,
      accountOptions('previous', calls, request.promise, undefined),
    )

    const pending = observer.mutate(previousVariables)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.fn).toEqual([])
    expect(observer.getCurrentResult().isPaused).toBe(true)

    observer.setOptions(
      accountOptions('next', calls, request.promise, undefined),
    )
    onlineManager.setOnline(true)
    await vi.advanceTimersByTimeAsync(0)
    request.resolve('server-body')
    await pending.catch(() => undefined)

    expectNextAccountIsolated(calls)
  })
})
