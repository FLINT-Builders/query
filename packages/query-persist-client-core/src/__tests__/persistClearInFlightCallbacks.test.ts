import { afterEach, describe, expect, it } from 'vitest'
import {
  MutationCache,
  MutationObserver,
  QueryClient,
} from '@tanstack/query-core'
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from '../persist'
import type { PersistedClient, Persister } from '../persist'

/**
 * Spec for the persistence subscriber saving query data that an in-flight
 * mutation writes back after QueryClient.clear / MutationCache.remove.
 * These tests fail while that write is persisted and can be restored.
 */

const todosKey = ['todos'] as const
const previousAccountTodos = ['account-a private todo']

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

function createRecordingPersister() {
  let stored: PersistedClient | undefined
  const snapshots: Array<PersistedClient> = []
  let record = false

  const persister: Persister = {
    persistClient(persistClient) {
      stored = persistClient
      if (record) {
        snapshots.push(structuredClone(persistClient))
      }
    },
    restoreClient() {
      return stored
    },
    removeClient() {
      stored = undefined
    },
  }

  return {
    persister,
    snapshots,
    startRecording() {
      record = true
    },
  }
}

function queryData(client: PersistedClient | undefined) {
  return client?.clientState.queries.map((query) => query.state.data)
}

describe('persistence of in-flight mutation callbacks after cache clear', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => {
      cleanup()
    })
  })

  async function runLogoutDuringMutation(
    outcome: 'success' | 'error',
    drop: 'clear' | 'remove',
  ) {
    const calls = {
      cacheOnError: 0,
      cacheOnSuccess: 0,
      cacheOnSettled: 0,
    }
    const queryClient = createClient(
      new MutationCache({
        onError: () => {
          calls.cacheOnError++
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
        onSuccess: (data) => {
          calls.cacheOnSuccess++
          queryClient.setQueryData(todosKey, [data])
        },
        onSettled: () => {
          calls.cacheOnSettled++
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
      }),
    )
    queryClient.mount()
    const recorder = createRecordingPersister()
    const unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister: recorder.persister,
    })
    cleanups.push(() => {
      unsubscribe()
      queryClient.clear()
      queryClient.unmount()
    })

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
      onError: (_error, _variables, onMutateResult) => {
        queryClient.setQueryData(todosKey, onMutateResult?.previousTodos)
      },
      onSuccess: (data) => {
        queryClient.setQueryData(todosKey, [data])
      },
      onSettled: () => {
        queryClient.setQueryData(todosKey, previousAccountTodos)
        return queryClient.invalidateQueries({ queryKey: todosKey })
      },
    })
    const unsubscribeObserver = observer.subscribe(() => undefined)
    const execution = observer
      .mutate('account-a item', {
        onError: (_error, _variables, onMutateResult) => {
          queryClient.setQueryData(todosKey, onMutateResult?.previousTodos)
        },
        onSuccess: (data) => {
          queryClient.setQueryData(todosKey, [data])
        },
        onSettled: () => {
          queryClient.setQueryData(todosKey, previousAccountTodos)
        },
      })
      .then(
        () => undefined,
        () => undefined,
      )

    await started.promise
    if (drop === 'clear') {
      queryClient.clear()
    } else {
      const inFlight = queryClient.getMutationCache().getAll()[0]
      if (!inFlight) {
        throw new Error('expected an in-flight mutation')
      }
      queryClient.getQueryCache().clear()
      queryClient.getMutationCache().remove(inFlight)
    }
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    recorder.startRecording()

    if (outcome === 'success') {
      finish('account-a server todo')
    } else {
      fail(new Error('mutation failed'))
    }
    await execution
    unsubscribeObserver()

    return { queryClient, recorder, calls }
  }

  async function restoredTodos(
    persister: ReturnType<typeof createRecordingPersister>['persister'],
  ) {
    const nextAccount = createClient()
    nextAccount.mount()
    cleanups.push(() => {
      nextAccount.clear()
      nextAccount.unmount()
    })
    await persistQueryClientRestore({
      queryClient: nextAccount,
      persister,
      maxAge: 1000 * 60 * 60,
    })
    return nextAccount.getQueryData(todosKey)
  }

  it('does not persist or restore the previous account snapshot when an in-flight error callback follows QueryClient.clear', async () => {
    const { queryClient, recorder, calls } = await runLogoutDuringMutation(
      'error',
      'clear',
    )

    for (const snapshot of recorder.snapshots) {
      expect(queryData(snapshot)).not.toContainEqual(previousAccountTodos)
      expect(queryData(snapshot)).not.toContainEqual([
        ...previousAccountTodos,
        'optimistic',
      ])
    }
    expect(await restoredTodos(recorder.persister)).toBeUndefined()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
    expect(calls).toEqual({
      cacheOnError: 0,
      cacheOnSuccess: 0,
      cacheOnSettled: 0,
    })
  })

  it('does not persist or restore the previous account result when an in-flight success callback follows QueryClient.clear', async () => {
    const { queryClient, recorder } = await runLogoutDuringMutation(
      'success',
      'clear',
    )

    for (const snapshot of recorder.snapshots) {
      expect(queryData(snapshot)).not.toContainEqual(previousAccountTodos)
      expect(queryData(snapshot)).not.toContainEqual(['account-a server todo'])
    }
    expect(await restoredTodos(recorder.persister)).toBeUndefined()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
  })

  it('does not persist or restore the previous account snapshot when an in-flight error callback follows MutationCache.remove', async () => {
    const { queryClient, recorder } = await runLogoutDuringMutation(
      'error',
      'remove',
    )

    for (const snapshot of recorder.snapshots) {
      expect(queryData(snapshot)).not.toContainEqual(previousAccountTodos)
    }
    expect(await restoredTodos(recorder.persister)).toBeUndefined()
    expect(queryClient.getQueryData(todosKey)).toBeUndefined()
  })
})
