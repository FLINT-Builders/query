import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationCache } from '../mutationCache'
import { MutationObserver } from '../mutationObserver'
import { QueryClient } from '../queryClient'
import { focusManager } from '../focusManager'
import { hydrate } from '../hydration'
import { onlineManager } from '../onlineManager'
import type { DehydratedState } from '../hydration'
import type { MutationKey } from '../types'

/**
 * A paused mutation snapshot is the JSON shape `dehydrate` writes and
 * `hydrate` reads. Building it through `JSON.parse(JSON.stringify(...))`
 * drops functions and `undefined`, which is the same constraint a storage
 * persister's default `JSON.parse` applies.
 */
function forgedPausedState(
  mutations: Array<{
    mutationKey?: MutationKey
    scope?: { id: string }
    variables: unknown
  }>,
): DehydratedState {
  return JSON.parse(
    JSON.stringify({
      mutations: mutations.map((mutation) => ({
        ...(mutation.mutationKey ? { mutationKey: mutation.mutationKey } : {}),
        ...(mutation.scope ? { scope: mutation.scope } : {}),
        state: {
          error: null,
          failureCount: 0,
          failureReason: null,
          isPaused: true,
          status: 'pending',
          variables: mutation.variables,
          submittedAt: 1,
        },
      })),
      queries: [],
    }),
  )
}

const updateVariables = { id: 'record-9', title: 'forged-title' }
const deleteVariables = { id: 'record-9' }

describe('restored paused mutations from an untrusted snapshot', () => {
  afterEach(() => {
    onlineManager.setOnline(true)
    focusManager.setFocused(undefined)
  })

  function clientWithTodoMutations() {
    const updateTodo = vi.fn((variables: { id: string; title: string }) =>
      Promise.resolve(variables),
    )
    const deleteTodo = vi.fn((variables: { id: string }) =>
      Promise.resolve(variables),
    )
    const cacheOnMutate = vi.fn(() => undefined)
    const updateOnMutate = vi.fn(
      (variables: { id: string; title: string }) => ({
        optimisticId: variables.id,
      }),
    )
    const deleteOnMutate = vi.fn((variables: { id: string }) => ({
      optimisticId: variables.id,
    }))

    const queryClient = new QueryClient({
      mutationCache: new MutationCache({
        onMutate: cacheOnMutate,
      }),
    })
    queryClient.setMutationDefaults(['todos', 'update'], {
      mutationFn: updateTodo,
      onMutate: updateOnMutate,
    })
    queryClient.setMutationDefaults(['todos', 'delete'], {
      mutationFn: deleteTodo,
      onMutate: deleteOnMutate,
    })

    return {
      queryClient,
      updateTodo,
      deleteTodo,
      cacheOnMutate,
      updateOnMutate,
      deleteOnMutate,
    }
  }

  function plantForgedMutations(queryClient: QueryClient) {
    hydrate(
      queryClient,
      forgedPausedState([
        { mutationKey: ['todos', 'update'], variables: updateVariables },
        { mutationKey: ['todos', 'delete'], variables: deleteVariables },
      ]),
    )
  }

  async function forgedCallCounts(
    updateTodo: ReturnType<typeof vi.fn>,
    deleteTodo: ReturnType<typeof vi.fn>,
  ) {
    await Promise.resolve()
    return {
      update: updateTodo.mock.calls.length,
      delete: deleteTodo.mock.calls.length,
    }
  }

  it('does not execute forged variables when the restored mutation is continued', async () => {
    const { queryClient, updateTodo, deleteTodo } = clientWithTodoMutations()
    plantForgedMutations(queryClient)

    const restored = queryClient.getMutationCache().getAll()
    await Promise.all(restored.map((mutation) => mutation.continue()))

    expect(await forgedCallCounts(updateTodo, deleteTodo)).toEqual({
      update: 0,
      delete: 0,
    })
    queryClient.clear()
  })

  it('does not execute forged variables from queryClient.resumePausedMutations', async () => {
    const { queryClient, updateTodo, deleteTodo } = clientWithTodoMutations()
    plantForgedMutations(queryClient)

    await queryClient.resumePausedMutations()

    expect(await forgedCallCounts(updateTodo, deleteTodo)).toEqual({
      update: 0,
      delete: 0,
    })
    queryClient.clear()
  })

  it('does not execute forged variables from mutationCache.resumePausedMutations', async () => {
    const { queryClient, updateTodo, deleteTodo } = clientWithTodoMutations()
    plantForgedMutations(queryClient)

    await queryClient.getMutationCache().resumePausedMutations()

    expect(await forgedCallCounts(updateTodo, deleteTodo)).toEqual({
      update: 0,
      delete: 0,
    })
    queryClient.clear()
  })

  it('does not execute forged variables when the mounted client comes online', async () => {
    onlineManager.setOnline(false)
    const { queryClient, updateTodo, deleteTodo } = clientWithTodoMutations()
    queryClient.mount()
    plantForgedMutations(queryClient)

    onlineManager.setOnline(true)

    expect(await forgedCallCounts(updateTodo, deleteTodo)).toEqual({
      update: 0,
      delete: 0,
    })
    queryClient.unmount()
    queryClient.clear()
  })

  it('does not execute forged variables when the mounted client regains focus', async () => {
    focusManager.setFocused(false)
    const { queryClient, updateTodo, deleteTodo } = clientWithTodoMutations()
    queryClient.mount()
    plantForgedMutations(queryClient)

    focusManager.setFocused(true)

    expect(await forgedCallCounts(updateTodo, deleteTodo)).toEqual({
      update: 0,
      delete: 0,
    })
    queryClient.unmount()
    queryClient.clear()
  })

  it('does not bind a shorter registered key to a longer forged mutation key', async () => {
    const updateTodo = vi.fn((variables: { id: string; title: string }) =>
      Promise.resolve(variables),
    )
    const queryClient = new QueryClient()
    queryClient.setMutationDefaults(['todos'], {
      mutationFn: updateTodo,
      onMutate: () => ({ optimistic: true }),
    })

    hydrate(
      queryClient,
      forgedPausedState([
        {
          mutationKey: ['todos', 'update'],
          variables: updateVariables,
        },
      ]),
    )

    await queryClient.resumePausedMutations()

    expect(updateTodo).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('does not run the client-wide default mutation function for a forged paused mutation', async () => {
    const updateTodo = vi.fn((variables: unknown) => Promise.resolve(variables))
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          mutationFn: updateTodo,
          onMutate: () => ({ optimistic: true }),
        },
      },
    })

    hydrate(
      queryClient,
      forgedPausedState([
        { variables: updateVariables },
        { mutationKey: ['unregistered'], variables: deleteVariables },
      ]),
    )

    await queryClient.resumePausedMutations()

    expect(updateTodo).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('does not continue a forged paused mutation when an earlier scoped mutation settles', async () => {
    const forgedUpdate = vi.fn((variables: { id: string; title: string }) =>
      Promise.resolve(variables),
    )
    let releaseSession = () => {}
    let markSessionStarted = () => {}
    const sessionStarted = new Promise<void>((resolve) => {
      markSessionStarted = resolve
    })
    const sessionMutation = vi.fn(
      (_variables: { id: string }) =>
        new Promise<string>((resolve) => {
          releaseSession = () => resolve('session-ok')
          markSessionStarted()
        }),
    )

    const queryClient = new QueryClient()
    queryClient.setMutationDefaults<
      { id: string; title: string },
      Error,
      { id: string; title: string }
    >(['todos', 'update'], {
      mutationFn: forgedUpdate,
      onMutate: (variables) => ({ optimisticId: variables.id }),
    })

    const observer = new MutationObserver(queryClient, {
      mutationKey: ['session'],
      scope: { id: 'todo' },
      mutationFn: sessionMutation,
    })
    const inFlight = observer.mutate({ id: 'session-record' })

    hydrate(
      queryClient,
      forgedPausedState([
        {
          mutationKey: ['todos', 'update'],
          scope: { id: 'todo' },
          variables: updateVariables,
        },
      ]),
    )

    await sessionStarted
    releaseSession()
    await inFlight

    expect(sessionMutation).toHaveBeenCalledTimes(1)
    expect(forgedUpdate).not.toHaveBeenCalled()
    queryClient.clear()
  })
})
