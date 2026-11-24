import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusManager } from '../focusManager'
import { dehydrate, hydrate } from '../hydration'
import { onlineManager } from '../onlineManager'
import { QueryClient } from '../queryClient'
import { executeMutation, mockOnlineManagerIsOnline } from './utils'
import type { DehydratedState } from '../hydration'
import type { MutationState } from '../mutation'

const MUTATION_KEY = ['todos'] as const

/**
 * Stops a restored mutation from spinning on real timers after a failed
 * assertion. `retry: true` with `retryDelay: 0` schedules the next attempt
 * immediately, and an unfocused page pauses that loop.
 */
async function stopRestoredRetries(): Promise<void> {
  focusManager.setFocused(false)
  for (let turn = 0; turn < 5; turn++) {
    await vi.advanceTimersToNextTimerAsync()
  }
}

function pausedMutationState(
  id: string,
): MutationState<unknown, Error, { id: string }> {
  return {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: true,
    status: 'pending',
    submittedAt: 1,
    variables: { id },
  }
}

function tamperedMutation(id: string, extras: Record<string, unknown> = {}) {
  return {
    mutationKey: [...MUTATION_KEY],
    meta: { from: 'snapshot' },
    scope: { id: 'offline-todos' },
    retry: true,
    retryDelay: 0,
    networkMode: 'always',
    gcTime: 1,
    throwOnError: true,
    attackerControlled: true,
    state: pausedMutationState(id),
    ...extras,
  }
}

function asDehydratedState(
  mutations: Array<Record<string, unknown>>,
): DehydratedState {
  return {
    mutations,
    queries: [],
  } as unknown as DehydratedState
}

function createRejectingMutation() {
  const mutationFn = vi.fn((_variables: { id: string }) => {
    throw new Error('rejected')
  })
  const onError = vi.fn()
  const onSuccess = vi.fn()
  return { mutationFn, onError, onSuccess }
}

async function drainUntilStable(read: () => number): Promise<void> {
  let previous = -1
  for (let turn = 0; turn < 80 && read() !== previous; turn++) {
    previous = read()
    await vi.advanceTimersToNextTimerAsync()
  }
}

describe('hydrate mutation options from a snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
  })

  afterEach(async () => {
    await stopRestoredRetries()
    vi.useRealTimers()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('resumes a paused mutation once when the snapshot only contains fields dehydrate writes', async () => {
    const onlineMock = mockOnlineManagerIsOnline(false)
    const key = ['addTodo']
    const serverClient = new QueryClient()
    const serverMutationFn = vi.fn((variables: { id: string }) => variables)
    serverClient.setMutationDefaults(key, {
      mutationFn: serverMutationFn,
      retry: false,
    })

    void executeMutation(
      serverClient,
      { mutationKey: key },
      { id: 'kept' },
    ).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    const serialized = JSON.stringify(dehydrate(serverClient))
    serverClient.clear()
    onlineMock.mockRestore()
    onlineManager.setOnline(true)

    const client = new QueryClient()
    const mutationFn = vi.fn((variables: { id: string }) => ({
      id: variables.id,
    }))
    client.setMutationDefaults(key, {
      mutationFn,
      retry: false,
    })

    hydrate(client, JSON.parse(serialized) as DehydratedState)
    await client.resumePausedMutations()

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)
    expect
      .soft(mutationFn)
      .toHaveBeenCalledWith(
        { id: 'kept' },
        expect.objectContaining({ mutationKey: key }),
      )
    expect
      .soft(client.getMutationCache().getAll()[0]?.options.retry)
      .toBe(false)

    client.clear()
  })

  it('does not let snapshot retry options override the registered mutation and retry forever', async () => {
    const client = new QueryClient()
    const { mutationFn, onError, onSuccess } = createRejectingMutation()
    client.setMutationDefaults([...MUTATION_KEY], {
      mutationFn,
      onError,
      onSuccess,
      retry: 0,
      retryDelay: 1_000,
      networkMode: 'online',
      gcTime: 60_000,
      meta: { from: 'app' },
    })

    hydrate(
      client,
      asDehydratedState([tamperedMutation('a'), tamperedMutation('b')]),
    )

    const mutations = client.getMutationCache().getAll()
    expect.soft(mutations).toHaveLength(2)
    for (const mutation of mutations) {
      expect.soft(mutation.options.mutationFn).toBe(mutationFn)
      expect.soft(mutation.options.retry).toBe(0)
      expect.soft(mutation.options.retryDelay).toBe(1_000)
      expect.soft(mutation.options.networkMode).toBe('online')
      expect.soft(mutation.gcTime).toBe(60_000)
      expect.soft(mutation.options.meta).toEqual({ from: 'snapshot' })
      expect.soft(mutation.options.scope).toEqual({ id: 'offline-todos' })
      expect
        .soft((mutation.options as { throwOnError?: boolean }).throwOnError)
        .toBeUndefined()
      expect
        .soft(
          (mutation.options as { attackerControlled?: boolean })
            .attackerControlled,
        )
        .toBeUndefined()
    }

    void client.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    const callsFor = (id: string) =>
      mutationFn.mock.calls.filter((call) => call[0].id === id)

    expect.soft(callsFor('a')).toHaveLength(1)
    expect.soft(callsFor('b')).toHaveLength(1)
    expect.soft(onError).toHaveBeenCalledTimes(2)
    expect.soft(onSuccess).not.toHaveBeenCalled()

    client.clear()
  })

  it('does not let a snapshot replace the registered mutation function', async () => {
    const client = new QueryClient()
    const { mutationFn, onError } = createRejectingMutation()
    const injectedMutationFn = vi.fn(() => {
      throw new Error('injected')
    })
    const injectedOnError = vi.fn()
    client.setMutationDefaults([...MUTATION_KEY], {
      mutationFn,
      onError,
      retry: false,
    })

    hydrate(
      client,
      asDehydratedState([
        tamperedMutation('a', {
          mutationFn: injectedMutationFn,
          onError: injectedOnError,
          _defaulted: true,
        }),
      ]),
    )

    const mutation = client.getMutationCache().getAll()[0]
    expect.soft(mutation?.options.mutationFn).toBe(mutationFn)
    expect.soft(mutation?.options.retry).toBe(false)

    void client.resumePausedMutations()
    await drainUntilStable(
      () => mutationFn.mock.calls.length + injectedMutationFn.mock.calls.length,
    )

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)
    expect.soft(injectedMutationFn).not.toHaveBeenCalled()
    expect.soft(injectedOnError).not.toHaveBeenCalled()
    expect.soft(onError).toHaveBeenCalledTimes(1)

    client.clear()
  })

  it('keeps QueryClient mutation defaults ahead of snapshot retry fields', async () => {
    const client = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          retryDelay: 250,
          networkMode: 'online',
          gcTime: 60_000,
        },
      },
    })
    const { mutationFn } = createRejectingMutation()
    client.setMutationDefaults([...MUTATION_KEY], { mutationFn })

    hydrate(client, asDehydratedState([tamperedMutation('a')]))

    const mutation = client.getMutationCache().getAll()[0]
    expect.soft(mutation?.options.retry).toBe(false)
    expect.soft(mutation?.options.retryDelay).toBe(250)
    expect.soft(mutation?.options.networkMode).toBe('online')
    expect.soft(mutation?.gcTime).toBe(60_000)

    void client.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)

    client.clear()
  })

  it('keeps hydrate mutation defaults ahead of snapshot retry fields', async () => {
    const client = new QueryClient({
      defaultOptions: {
        hydrate: {
          mutations: {
            retry: false,
            retryDelay: 250,
            networkMode: 'online',
            gcTime: 60_000,
          },
        },
      },
    })
    const { mutationFn } = createRejectingMutation()
    client.setMutationDefaults([...MUTATION_KEY], { mutationFn })

    hydrate(client, asDehydratedState([tamperedMutation('a')]), {
      defaultOptions: {
        mutations: {
          retry: false,
          retryDelay: 500,
          networkMode: 'online',
          gcTime: 120_000,
        },
      },
    })

    const mutation = client.getMutationCache().getAll()[0]
    // Options passed to hydrate() are the per-restore defaults and win over
    // the client-level hydrate defaults. Neither loses to the snapshot.
    expect.soft(mutation?.options.retry).toBe(false)
    expect.soft(mutation?.options.retryDelay).toBe(500)
    expect.soft(mutation?.options.networkMode).toBe('online')
    expect.soft(mutation?.gcTime).toBe(120_000)

    void client.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)

    client.clear()
  })

  it('uses the client hydrate defaults when a restore does not pass its own', async () => {
    const client = new QueryClient({
      defaultOptions: {
        hydrate: {
          mutations: {
            retry: false,
            retryDelay: 250,
            networkMode: 'online',
            gcTime: 60_000,
          },
        },
      },
    })
    const { mutationFn } = createRejectingMutation()
    client.setMutationDefaults([...MUTATION_KEY], { mutationFn })

    hydrate(client, asDehydratedState([tamperedMutation('a')]))

    const mutation = client.getMutationCache().getAll()[0]
    expect.soft(mutation?.options.retry).toBe(false)
    expect.soft(mutation?.options.retryDelay).toBe(250)
    expect.soft(mutation?.options.networkMode).toBe('online')
    expect.soft(mutation?.gcTime).toBe(60_000)

    void client.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)

    client.clear()
  })
})
