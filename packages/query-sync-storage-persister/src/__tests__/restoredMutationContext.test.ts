import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'

/**
 * The sync storage persister used by the documented offline-mutation example
 * restores whatever string is in storage. A paused mutation inserted there
 * must not supply `onError` with its stored context.
 */

type Todo = { id: string; title: string }
type Variables = { title: string; fail: boolean }
type RollbackContext = {
  previousTodos: Array<Todo>
  optimisticTodo: Todo
}

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const BUSTER = 'build-1'
const TODOS_KEY = ['todos'] as const
const MUTATION_KEY = ['addTodo'] as const
const REAL_TODOS: Array<Todo> = [{ id: 'real', title: 'Buy milk' }]
const FORGED_TODOS: Array<Todo> = [{ id: 'forged', title: 'Injected todo' }]

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
  }
}

describe('sync persister restored mutation context', () => {
  it('does not roll back to a paused mutation inserted in storage', async () => {
    const storage = memoryStorage()
    const variables = { title: 'attacker', fail: true }
    const planted: RollbackContext = {
      previousTodos: FORGED_TODOS.map((todo) => ({ ...todo })),
      optimisticTodo: { id: 'forged', title: 'from-storage' },
    }
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        buster: BUSTER,
        clientState: {
          mutations: [
            {
              mutationKey: [...MUTATION_KEY],
              state: {
                context: planted,
                data: undefined,
                error: null,
                failureCount: 0,
                failureReason: null,
                isPaused: true,
                status: 'pending',
                variables,
                submittedAt: 1,
              },
            },
          ],
          queries: [],
        },
      }),
    )
    const persister = createSyncStoragePersister({
      storage,
      key: STORAGE_KEY,
      throttleTime: 0,
    })

    const calls: Array<Variables> = []
    const produced: Array<RollbackContext> = []
    let rollbackContext: unknown
    const client = new QueryClient()
    client.setMutationDefaults<Todo, Error, Variables, RollbackContext>(
      [...MUTATION_KEY],
      {
        retry: 0,
        mutationFn: (next) => {
          calls.push(next)
          if (next.fail) {
            return Promise.reject(new Error('mutation failed'))
          }
          return Promise.resolve({ id: 'server-id', title: next.title })
        },
        onMutate: () => {
          const context: RollbackContext = {
            previousTodos: REAL_TODOS.map((todo) => ({ ...todo })),
            optimisticTodo: {
              id: 'session-optimistic',
              title: 'from-this-session',
            },
          }
          produced.push(context)
          return context
        },
        onError: (_error, _variables, onMutateResult, mutationContext) => {
          rollbackContext = onMutateResult
          mutationContext.client.setQueryData(
            TODOS_KEY,
            onMutateResult?.previousTodos,
          )
        },
        onSuccess: (result, _variables, onMutateResult, mutationContext) => {
          mutationContext.client.setQueryData<Array<Todo>>(TODOS_KEY, (old) =>
            (old ?? []).map((todo) =>
              todo.id === onMutateResult.optimisticTodo.id ? result : todo,
            ),
          )
        },
        onSettled: (_data, _error, _variables, onMutateResult) => {
          if (rollbackContext === undefined) {
            rollbackContext = onMutateResult
          }
        },
      },
    )

    await persistQueryClientRestore({
      queryClient: client,
      persister,
      buster: BUSTER,
    })
    client.setQueryData(
      TODOS_KEY,
      REAL_TODOS.map((todo) => ({ ...todo })),
    )
    await client.resumePausedMutations().catch(() => undefined)

    expect(calls).toEqual([variables])
    expect(rollbackContext).not.toEqual(planted)
    const fromThisSession =
      rollbackContext === undefined ||
      produced.some(
        (value) => JSON.stringify(value) === JSON.stringify(rollbackContext),
      )
    expect(fromThisSession).toBe(true)
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)

    client.clear()
  })
})
