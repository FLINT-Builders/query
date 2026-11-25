import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import type { AsyncStorage } from '@tanstack/query-persist-client-core'

/**
 * An edited origin storage snapshot is restored by the async persister and
 * resumed with the app's mutation defaults. The stored mutation context must
 * not be written into the query cache as an optimistic rollback.
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

function memoryStorage(): AsyncStorage<string> {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

function plantedSnapshot(variables: Variables): string {
  const context: RollbackContext = {
    previousTodos: FORGED_TODOS.map((todo) => ({ ...todo })),
    optimisticTodo: { id: 'forged', title: 'from-storage' },
  }
  return JSON.stringify({
    timestamp: Date.now(),
    buster: BUSTER,
    clientState: {
      mutations: [
        {
          mutationKey: [...MUTATION_KEY],
          state: {
            context,
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
  })
}

describe('async persister restored mutation context', () => {
  it('does not roll back to a paused mutation inserted in storage', async () => {
    const storage = memoryStorage()
    const variables = { title: 'attacker', fail: true }
    storage.setItem(STORAGE_KEY, plantedSnapshot(variables))
    const persister = createAsyncStoragePersister({
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
        // Matches the documented offline example, which retries a resumed mutation.
        retry: 3,
        retryDelay: 0,
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

    expect(calls).toEqual([variables, variables, variables, variables])
    expect(rollbackContext).not.toEqual({
      previousTodos: FORGED_TODOS,
      optimisticTodo: { id: 'forged', title: 'from-storage' },
    })
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
