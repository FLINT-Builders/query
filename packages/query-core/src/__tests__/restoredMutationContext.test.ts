import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusManager } from '../focusManager'
import { hydrate } from '../hydration'
import { MutationCache } from '../mutationCache'
import { onlineManager } from '../onlineManager'
import { QueryClient } from '../queryClient'
import { QueryObserver } from '../queryObserver'
import type { MutationFunctionContext } from '../types'
import type { DehydratedState } from '../hydration'

/**
 * Restored paused mutations must not treat context from the dehydrated
 * snapshot as the value `onMutate` returned in this session.
 *
 * A later fix should still resume the mutation function. Callbacks may then
 * receive `undefined`, or a context object produced by `onMutate` during this
 * execution. They must not receive the snapshot's context, even if that
 * field is read again immediately before the callback runs.
 */

type Todo = { id: string; title: string }
type Variables = { title: string; fail: boolean }
type RollbackContext = {
  previousTodos: Array<Todo>
  optimisticTodo: Todo
}

const TODOS_KEY = ['todos'] as const
const MUTATION_KEY = ['addTodo'] as const
const REAL_TODOS: Array<Todo> = [{ id: 'real', title: 'Buy milk' }]

function sessionContext(): RollbackContext {
  return {
    previousTodos: REAL_TODOS.map((todo) => ({ ...todo })),
    optimisticTodo: {
      id: 'session-optimistic',
      title: 'from-this-session',
    },
  }
}

function plantedRollback(
  todos: Array<Todo>,
  optimisticId: string,
): RollbackContext {
  return {
    previousTodos: todos.map((todo) => ({ ...todo })),
    optimisticTodo: { id: optimisticId, title: 'from-storage' },
  }
}

const FORGED_TODOS: Array<Todo> = [{ id: 'forged', title: 'Injected todo' }]

function pausedMutation(
  variables: Variables,
  context: RollbackContext,
  scope?: { id: string },
): DehydratedState['mutations'][number] {
  return {
    mutationKey: [...MUTATION_KEY],
    ...(scope ? { scope } : {}),
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
  }
}

function expectTrusted(
  context: unknown,
  planted: RollbackContext,
  produced: Array<RollbackContext>,
) {
  expect(context).not.toEqual(planted)
  const fromThisSession =
    context === undefined ||
    produced.some((value) => JSON.stringify(value) === JSON.stringify(context))
  expect(fromThisSession).toBe(true)
}

type SeenContext = { callback: string; context: unknown }

function createClient(
  produced: Array<RollbackContext>,
  seen: Array<SeenContext>,
) {
  const calls: Array<Variables> = []
  const mutationCache = new MutationCache({
    onError: (_error, _variables, context) => {
      seen.push({ callback: 'cache.onError', context })
    },
    onSuccess: (_data, _variables, context) => {
      seen.push({ callback: 'cache.onSuccess', context })
    },
    onSettled: (_data, _error, _variables, context) => {
      seen.push({ callback: 'cache.onSettled', context })
    },
  })
  const client = new QueryClient({ mutationCache })

  client.setMutationDefaults<Todo, Error, Variables, RollbackContext>(
    [...MUTATION_KEY],
    {
      retry: 0,
      mutationFn: (variables) => {
        calls.push(variables)
        if (variables.fail) {
          return Promise.reject(new Error('mutation failed'))
        }
        return Promise.resolve({ id: 'server-id', title: variables.title })
      },
      onMutate: () => {
        const context = sessionContext()
        produced.push(context)
        return context
      },
      onError: (
        _error,
        _variables,
        onMutateResult,
        mutationContext: MutationFunctionContext,
      ) => {
        seen.push({ callback: 'options.onError', context: onMutateResult })
        // Documented optimistic rollback: write the onMutate snapshot back.
        mutationContext.client.setQueryData(
          TODOS_KEY,
          onMutateResult?.previousTodos,
        )
      },
      onSuccess: (result, _variables, onMutateResult, mutationContext) => {
        seen.push({ callback: 'options.onSuccess', context: onMutateResult })
        // Documented persisted-mutation success path: replace the optimistic row.
        mutationContext.client.setQueryData<Array<Todo>>(TODOS_KEY, (old) =>
          (old ?? []).map((todo) =>
            todo.id === onMutateResult.optimisticTodo.id ? result : todo,
          ),
        )
      },
      onSettled: (_data, _error, _variables, onMutateResult) => {
        seen.push({ callback: 'options.onSettled', context: onMutateResult })
      },
    },
  )

  return { client, calls }
}

function restorePaused(
  client: QueryClient,
  mutations: DehydratedState['mutations'],
) {
  // Round-trip through JSON the way persisters serialize the snapshot.
  const snapshot = JSON.parse(
    JSON.stringify({ mutations, queries: [] }),
  ) as DehydratedState
  hydrate(client, snapshot)
  client.setQueryData(
    TODOS_KEY,
    REAL_TODOS.map((todo) => ({ ...todo })),
  )
}

async function settle(promise: Promise<unknown>) {
  await promise.catch(() => undefined)
}

const mounted: Array<QueryClient> = []

afterEach(() => {
  for (const client of mounted) {
    client.clear()
    client.unmount()
  }
  mounted.length = 0
  onlineManager.setOnline(true)
  focusManager.setFocused(undefined)
})

describe('restored mutation context', () => {
  it('does not write storage rollback data when a resumed mutation fails', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const planted = plantedRollback(FORGED_TODOS, 'forged')
    const { client, calls } = createClient(produced, seen)
    const observer = new QueryObserver<Array<Todo>>(client, {
      queryKey: [...TODOS_KEY],
      queryFn: () => Promise.resolve(REAL_TODOS.map((todo) => ({ ...todo }))),
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)

    restorePaused(client, [
      pausedMutation({ title: 'attacker', fail: true }, planted),
    ])

    await settle(client.resumePausedMutations())

    expect(calls).toEqual([{ title: 'attacker', fail: true }])
    expect(seen.map((entry) => entry.callback)).toEqual([
      'cache.onError',
      'options.onError',
      'cache.onSettled',
      'options.onSettled',
    ])
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    expect(observer.getCurrentResult().data).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, planted, produced)
    }

    unsubscribe()
    client.clear()
  })

  it('does not apply storage context when a resumed mutation succeeds', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const planted = plantedRollback(FORGED_TODOS, 'real')
    const { client, calls } = createClient(produced, seen)

    restorePaused(client, [
      pausedMutation({ title: 'attacker-title', fail: false }, planted),
    ])

    await settle(client.resumePausedMutations())

    expect(calls).toEqual([{ title: 'attacker-title', fail: false }])
    expect(seen.map((entry) => entry.callback)).toContain('options.onSuccess')
    expect(seen.map((entry) => entry.callback)).toContain('cache.onSuccess')
    expect(seen.map((entry) => entry.callback)).toContain('options.onSettled')
    expect(seen.map((entry) => entry.callback)).toContain('cache.onSettled')
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, planted, produced)
    }

    client.clear()
  })

  it('does not trust storage context when continue() resumes the mutation directly', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const planted = plantedRollback(FORGED_TODOS, 'forged')
    const { client, calls } = createClient(produced, seen)

    restorePaused(client, [
      pausedMutation({ title: 'direct', fail: true }, planted),
    ])
    const mutation = client.getMutationCache().getAll()[0]
    expect(mutation).toBeDefined()

    await settle(mutation!.continue())

    expect(calls).toEqual([{ title: 'direct', fail: true }])
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, planted, produced)
    }

    client.clear()
  })

  it('does not trust storage context when focus resumes a restored mutation', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const planted = plantedRollback(FORGED_TODOS, 'forged')
    const { client, calls } = createClient(produced, seen)
    mounted.push(client)

    focusManager.setFocused(false)
    client.mount()
    restorePaused(client, [
      pausedMutation({ title: 'focus', fail: true }, planted),
    ])

    expect(calls).toEqual([])

    focusManager.setFocused(true)
    await vi.waitFor(() => {
      expect(seen.map((entry) => entry.callback)).toEqual([
        'cache.onError',
        'options.onError',
        'cache.onSettled',
        'options.onSettled',
      ])
    })

    expect(calls).toEqual([{ title: 'focus', fail: true }])
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, planted, produced)
    }
  })

  it('does not trust storage context when reconnect resumes a restored mutation', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const planted = plantedRollback(FORGED_TODOS, 'forged')
    const { client, calls } = createClient(produced, seen)
    mounted.push(client)

    onlineManager.setOnline(false)
    client.mount()
    restorePaused(client, [
      pausedMutation({ title: 'reconnect', fail: true }, planted),
    ])
    await settle(client.resumePausedMutations())
    expect(calls).toEqual([])

    onlineManager.setOnline(true)
    await vi.waitFor(() => {
      expect(seen.map((entry) => entry.callback)).toEqual([
        'cache.onError',
        'options.onError',
        'cache.onSettled',
        'options.onSettled',
      ])
    })

    expect(calls).toEqual([{ title: 'reconnect', fail: true }])
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, planted, produced)
    }
  })

  it('does not trust storage context when a later scoped mutation is started by the scope queue', async () => {
    const produced: Array<RollbackContext> = []
    const seen: Array<SeenContext> = []
    const plantedFirst = plantedRollback(
      [{ id: 'forged-first', title: 'First injected' }],
      'forged-first',
    )
    const plantedSecond = plantedRollback(
      [{ id: 'forged-second', title: 'Second injected' }],
      'forged-second',
    )
    const { client, calls } = createClient(produced, seen)
    const scope = { id: 'todo' }

    restorePaused(client, [
      pausedMutation({ title: 'first', fail: true }, plantedFirst, scope),
      pausedMutation({ title: 'second', fail: true }, plantedSecond, scope),
    ])

    const [first, second] = client.getMutationCache().getAll()
    expect(first?.state.variables).toEqual({ title: 'first', fail: true })
    expect(second?.state.variables).toEqual({ title: 'second', fail: true })
    if (!first || !second) {
      throw new Error('expected two restored mutations')
    }

    // The scope queue starts the second mutation from MutationCache.runNext,
    // which calls continue() without the catch inside resumePausedMutations.
    const continueSecond = second.continue.bind(second)
    let secondDone: Promise<unknown> = Promise.resolve()
    second.continue = () => {
      secondDone = continueSecond().catch(() => undefined)
      return secondDone
    }

    await settle(first.continue())
    await secondDone

    expect(calls.map((variables) => variables.title)).toEqual([
      'first',
      'second',
    ])
    expect(
      seen.filter((entry) => entry.callback === 'options.onError'),
    ).toHaveLength(2)
    expect(client.getQueryData(TODOS_KEY)).toEqual(REAL_TODOS)
    for (const entry of seen) {
      expectTrusted(entry.context, plantedFirst, produced)
      expectTrusted(entry.context, plantedSecond, produced)
    }

    client.clear()
  })
})
