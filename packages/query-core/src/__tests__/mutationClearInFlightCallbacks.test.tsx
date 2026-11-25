import { afterEach, describe, expect, it } from 'vitest'
import { MutationCache, MutationObserver, QueryClient } from '..'
import { executeMutation } from './utils'

/**
 * Spec for in-flight mutations that outlive MutationCache.clear / remove.
 * These tests fail while a cleared mutation still runs its success, error,
 * and settled callbacks and writes the previous account's query data back.
 */

const todosKey = ['todos'] as const
const previousAccountTodos = ['account-a private todo']

interface CallbackCalls {
  cacheOnSuccess: number
  cacheOnError: number
  cacheOnSettled: number
  optionsOnSuccess: number
  optionsOnError: number
  optionsOnSettled: number
  perCallOnSuccess: number
  perCallOnError: number
  perCallOnSettled: number
}

function emptyCalls(): CallbackCalls {
  return {
    cacheOnSuccess: 0,
    cacheOnError: 0,
    cacheOnSettled: 0,
    optionsOnSuccess: 0,
    optionsOnError: 0,
    optionsOnSettled: 0,
    perCallOnSuccess: 0,
    perCallOnError: 0,
    perCallOnSettled: 0,
  }
}

function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function createClient(mutationCache?: MutationCache) {
  return new QueryClient({
    mutationCache,
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  })
}

describe('in-flight mutation callbacks after the mutation is removed', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    clients.forEach((client) => {
      client.clear()
      client.unmount()
    })
    clients.length = 0
  })

  function track(client: QueryClient) {
    clients.push(client)
    client.mount()
    return client
  }

  async function startOptimisticMutation(
    queryClient: QueryClient,
    outcome: 'success' | 'error',
    calls: CallbackCalls,
  ) {
    const started = deferred()
    let finish: (value: string) => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const request = new Promise<string>((resolve, reject) => {
      finish = resolve
      fail = reject
    })

    queryClient.setQueryData(todosKey, previousAccountTodos)

    const observer = new MutationObserver(queryClient, {
      mutationKey: ['addTodo'],
      networkMode: 'always',
      retry: false,
      mutationFn: async (_variables: string) => {
        started.resolve()
        return request
      },
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: todosKey })
        const previousTodos = queryClient.getQueryData<Array<string>>(todosKey)
        queryClient.setQueryData<Array<string>>(todosKey, (old) => [
          ...(old ?? []),
          'optimistic',
        ])
        return { previousTodos }
      },
      onSuccess: (data) => {
        calls.optionsOnSuccess++
        queryClient.setQueryData(todosKey, [data])
      },
      onError: (_error, _variables, onMutateResult) => {
        calls.optionsOnError++
        queryClient.setQueryData(todosKey, onMutateResult?.previousTodos)
      },
      onSettled: () => {
        calls.optionsOnSettled++
        queryClient.setQueryData(todosKey, previousAccountTodos)
        return queryClient.invalidateQueries({ queryKey: todosKey })
      },
    })

    const unsubscribe = observer.subscribe(() => undefined)
    const execution = observer
      .mutate('account-a item', {
        onSuccess: (data) => {
          calls.perCallOnSuccess++
          queryClient.setQueryData(todosKey, [data])
        },
        onError: (_error, _variables, onMutateResult) => {
          calls.perCallOnError++
          queryClient.setQueryData(todosKey, onMutateResult?.previousTodos)
        },
        onSettled: () => {
          calls.perCallOnSettled++
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
      })
      .then(
        () => undefined,
        () => undefined,
      )

    await started.promise
    expect(queryClient.getQueryData(todosKey)).toEqual([
      ...previousAccountTodos,
      'optimistic',
    ])

    return {
      execution,
      unsubscribe,
      settle: () => {
        if (outcome === 'success') {
          finish('account-a server todo')
        } else {
          fail(new Error('mutation failed'))
        }
      },
    }
  }

  function expectNoRewrite(queryClient: QueryClient, calls: CallbackCalls) {
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(
      queryClient.getQueryCache().find({ queryKey: todosKey }),
    ).toBeUndefined()
    expect(calls).toEqual(emptyCalls())
  }

  it('does not restore the previous account snapshot from error callbacks after QueryClient.clear', async () => {
    const calls = emptyCalls()
    const queryClient = track(
      createClient(
        new MutationCache({
          onSuccess: () => {
            calls.cacheOnSuccess++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
          onError: () => {
            calls.cacheOnError++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
          onSettled: () => {
            calls.cacheOnSettled++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
        }),
      ),
    )
    const mutation = await startOptimisticMutation(queryClient, 'error', calls)

    queryClient.clear()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0)

    mutation.settle()
    await mutation.execution
    mutation.unsubscribe()

    expectNoRewrite(queryClient, calls)
  })

  it('does not write the previous account result from success callbacks after QueryClient.clear', async () => {
    const calls = emptyCalls()
    const queryClient = track(
      createClient(
        new MutationCache({
          onSuccess: () => {
            calls.cacheOnSuccess++
            queryClient.setQueryData(todosKey, ['account-a server todo'])
          },
          onError: () => {
            calls.cacheOnError++
          },
          onSettled: () => {
            calls.cacheOnSettled++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
        }),
      ),
    )
    const mutation = await startOptimisticMutation(
      queryClient,
      'success',
      calls,
    )

    queryClient.clear()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()

    mutation.settle()
    await mutation.execution
    mutation.unsubscribe()

    expectNoRewrite(queryClient, calls)
  })

  it('does not restore the previous account snapshot when MutationCache.clear drops the in-flight mutation', async () => {
    const calls = emptyCalls()
    const queryClient = track(createClient())
    const mutation = await startOptimisticMutation(queryClient, 'error', calls)

    queryClient.getQueryCache().clear()
    queryClient.getMutationCache().clear()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0)

    mutation.settle()
    await mutation.execution
    mutation.unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.optionsOnError).toBe(0)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.perCallOnError).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })

  it('does not restore the previous account snapshot when MutationCache.remove drops the in-flight mutation', async () => {
    const calls = emptyCalls()
    const queryClient = track(createClient())
    const mutation = await startOptimisticMutation(queryClient, 'error', calls)
    const inFlight = queryClient.getMutationCache().getAll()[0]

    if (!inFlight) {
      throw new Error('expected an in-flight mutation')
    }
    queryClient.getQueryCache().clear()
    queryClient.getMutationCache().remove(inFlight)
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0)
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()

    mutation.settle()
    await mutation.execution
    mutation.unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.optionsOnError).toBe(0)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.perCallOnError).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })

  it('does not write the previous account result when MutationCache.remove drops a successful in-flight mutation', async () => {
    const calls = emptyCalls()
    const queryClient = track(createClient())
    const mutation = await startOptimisticMutation(
      queryClient,
      'success',
      calls,
    )
    const inFlight = queryClient.getMutationCache().getAll()[0]
    if (!inFlight) {
      throw new Error('expected an in-flight mutation')
    }

    queryClient.getQueryCache().clear()
    queryClient.getMutationCache().remove(inFlight)

    mutation.settle()
    await mutation.execution
    mutation.unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.optionsOnSuccess).toBe(0)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.perCallOnSuccess).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })

  it('does not run later error callbacks when clear happens during an earlier awaited cache hook', async () => {
    const calls = emptyCalls()
    const entered = deferred()
    let releaseHook: () => void = () => undefined
    const queryClient = track(
      createClient(
        new MutationCache({
          onError: async () => {
            calls.cacheOnError++
            entered.resolve()
            await new Promise<void>((resolve) => {
              releaseHook = resolve
            })
          },
          onSettled: () => {
            calls.cacheOnSettled++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
        }),
      ),
    )
    const mutation = await startOptimisticMutation(queryClient, 'error', calls)

    mutation.settle()
    await entered.promise
    expect(calls.cacheOnError).toBe(1)

    queryClient.clear()
    releaseHook()
    await mutation.execution
    mutation.unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.cacheOnSettled).toBe(0)
    expect(calls.optionsOnError).toBe(0)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.perCallOnError).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })

  it('does not run later success callbacks when clear happens during an earlier awaited cache hook', async () => {
    const calls = emptyCalls()
    const entered = deferred()
    let releaseHook: () => void = () => undefined
    const queryClient = track(
      createClient(
        new MutationCache({
          onSuccess: async () => {
            calls.cacheOnSuccess++
            entered.resolve()
            await new Promise<void>((resolve) => {
              releaseHook = resolve
            })
          },
          onSettled: () => {
            calls.cacheOnSettled++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
        }),
      ),
    )
    const mutation = await startOptimisticMutation(
      queryClient,
      'success',
      calls,
    )

    mutation.settle()
    await entered.promise
    expect(calls.cacheOnSuccess).toBe(1)

    queryClient.clear()
    releaseHook()
    await mutation.execution
    mutation.unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.cacheOnSettled).toBe(0)
    expect(calls.optionsOnSuccess).toBe(0)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.perCallOnSuccess).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })

  it('does not run the mutation settled callback when clear happens during the awaited mutation error callback', async () => {
    const calls = emptyCalls()
    const entered = deferred()
    let releaseHook: () => void = () => undefined
    const queryClient = track(createClient())
    const started = deferred()
    let fail: (error: Error) => void = () => undefined
    const request = new Promise<string>((_resolve, reject) => {
      fail = reject
    })

    queryClient.setQueryData(todosKey, previousAccountTodos)

    const execution = executeMutation(
      queryClient,
      {
        networkMode: 'always',
        retry: false,
        mutationFn: async (_variables: string) => {
          started.resolve()
          return request
        },
        onError: async () => {
          calls.optionsOnError++
          entered.resolve()
          await new Promise<void>((resolve) => {
            releaseHook = resolve
          })
        },
        onSettled: () => {
          calls.optionsOnSettled++
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
      },
      'account-a item',
    ).then(
      () => undefined,
      () => undefined,
    )

    await started.promise
    fail(new Error('mutation failed'))
    await entered.promise

    queryClient.clear()
    releaseHook()
    await execution

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.optionsOnError).toBe(1)
    expect(calls.optionsOnSettled).toBe(0)
  })

  it('does not run cache or per-call settled hooks when remove happens during the awaited mutation success callback', async () => {
    const calls = emptyCalls()
    const entered = deferred()
    let releaseHook: () => void = () => undefined
    const queryClient = track(
      createClient(
        new MutationCache({
          onSettled: () => {
            calls.cacheOnSettled++
            queryClient.setQueryData(todosKey, previousAccountTodos)
          },
        }),
      ),
    )
    const started = deferred()
    let finish: (value: string) => void = () => undefined
    const request = new Promise<string>((resolve) => {
      finish = resolve
    })

    queryClient.setQueryData(todosKey, previousAccountTodos)

    const observer = new MutationObserver(queryClient, {
      networkMode: 'always',
      retry: false,
      mutationFn: async (_variables: string) => {
        started.resolve()
        return request
      },
      onSuccess: async () => {
        calls.optionsOnSuccess++
        entered.resolve()
        await new Promise<void>((resolve) => {
          releaseHook = resolve
        })
      },
      onSettled: () => {
        calls.optionsOnSettled++
        queryClient.setQueryData(todosKey, previousAccountTodos)
      },
    })
    const unsubscribe = observer.subscribe(() => undefined)
    const execution = observer
      .mutate('account-a item', {
        onSettled: () => {
          calls.perCallOnSettled++
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
      })
      .then(
        () => undefined,
        () => undefined,
      )

    await started.promise
    finish('account-a server todo')
    await entered.promise

    const inFlight = queryClient.getMutationCache().getAll()[0]
    if (!inFlight) {
      throw new Error('expected an in-flight mutation')
    }
    queryClient.getQueryCache().clear()
    queryClient.getMutationCache().remove(inFlight)
    releaseHook()
    await execution
    unsubscribe()

    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls.optionsOnSuccess).toBe(1)
    expect(calls.optionsOnSettled).toBe(0)
    expect(calls.cacheOnSettled).toBe(0)
    expect(calls.perCallOnSettled).toBe(0)
  })
})
