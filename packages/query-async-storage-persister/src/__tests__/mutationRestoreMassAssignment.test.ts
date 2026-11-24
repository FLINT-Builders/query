// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, focusManager, onlineManager } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'

const STORAGE_KEY = 'tanstack-query-offline-cache'
const MUTATION_KEY = ['todos']

/**
 * Pauses any restored retry loop before real timers are restored. A snapshot
 * with `retry: true` and `retryDelay: 0` otherwise keeps scheduling attempts.
 */
async function stopRestoredRetries(): Promise<void> {
  focusManager.setFocused(false)
  for (let turn = 0; turn < 5; turn++) {
    await vi.advanceTimersToNextTimerAsync()
  }
}

function tamperedMutation(id: string, extras: Record<string, unknown> = {}) {
  return {
    mutationKey: MUTATION_KEY,
    meta: { from: 'snapshot' },
    scope: { id: 'offline-todos' },
    retry: true,
    retryDelay: 0,
    networkMode: 'always',
    gcTime: 1,
    throwOnError: true,
    attackerControlled: true,
    state: {
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: 'pending',
      variables: { id },
      submittedAt: 1,
    },
    ...extras,
  }
}

function attackerStorage(mutations: Array<Record<string, unknown>>) {
  const serialized = JSON.stringify({
    timestamp: Date.now(),
    buster: '',
    clientState: {
      mutations,
      queries: [],
    },
  })
  const items = new Map<string, string>([[STORAGE_KEY, serialized]])
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

function createRejectingMutation() {
  const mutationFn = vi.fn((_variables: { id: string }) => {
    throw new Error('rejected')
  })
  return mutationFn
}

async function drainUntilStable(read: () => number): Promise<void> {
  let previous = -1
  for (let turn = 0; turn < 80 && read() !== previous; turn++) {
    previous = read()
    await vi.advanceTimersToNextTimerAsync()
  }
}

describe('async storage persister mutation restore', () => {
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

  it('does not resume a storage snapshot into an unbounded mutation retry loop', async () => {
    const mutationFn = createRejectingMutation()
    const onError = vi.fn()
    const queryClient = new QueryClient()
    queryClient.setMutationDefaults(MUTATION_KEY, {
      mutationFn,
      onError,
    })

    const persister = createAsyncStoragePersister({
      storage: attackerStorage([tamperedMutation('a'), tamperedMutation('b')]),
      key: STORAGE_KEY,
    })

    await persistQueryClientRestore({
      queryClient,
      persister,
      buster: '',
    })

    const restored = queryClient.getMutationCache().getAll()
    expect.soft(restored).toHaveLength(2)
    for (const mutation of restored) {
      expect.soft(mutation.options.mutationFn).toBe(mutationFn)
      expect.soft(mutation.options.retry).toBeUndefined()
      expect.soft(mutation.options.retryDelay).toBeUndefined()
      expect.soft(mutation.options.networkMode).toBeUndefined()
      expect.soft(mutation.gcTime).toBe(5 * 60 * 1000)
      expect.soft(mutation.options.meta).toEqual({ from: 'snapshot' })
      expect.soft(mutation.options.scope).toEqual({ id: 'offline-todos' })
      expect
        .soft(
          (mutation.options as { attackerControlled?: boolean })
            .attackerControlled,
        )
        .toBeUndefined()
    }

    void queryClient.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    const callsFor = (id: string) =>
      mutationFn.mock.calls.filter((call) => call[0].id === id)
    expect.soft(callsFor('a')).toHaveLength(1)
    expect.soft(callsFor('b')).toHaveLength(1)
    expect.soft(onError).toHaveBeenCalledTimes(2)

    queryClient.clear()
  })

  it('does not let a null mutationFn in storage replace the registered function', async () => {
    const mutationFn = createRejectingMutation()
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          retryDelay: 250,
          networkMode: 'online',
          gcTime: 60_000,
        },
      },
    })
    queryClient.setMutationDefaults(MUTATION_KEY, { mutationFn })

    const persister = createAsyncStoragePersister({
      storage: attackerStorage([
        tamperedMutation('a', { mutationFn: null, _defaulted: true }),
      ]),
      key: STORAGE_KEY,
    })

    await persistQueryClientRestore({
      queryClient,
      persister,
      buster: '',
      hydrateOptions: {
        defaultOptions: {
          mutations: {
            retry: false,
            retryDelay: 500,
            networkMode: 'online',
            gcTime: 120_000,
          },
        },
      },
    })

    const mutation = queryClient.getMutationCache().getAll()[0]
    expect.soft(mutation?.options.mutationFn).toBe(mutationFn)
    expect.soft(mutation?.options.retry).toBe(false)
    expect.soft(mutation?.options.retryDelay).toBe(500)
    expect.soft(mutation?.options.networkMode).toBe('online')
    expect.soft(mutation?.gcTime).toBe(120_000)

    void queryClient.resumePausedMutations()
    await drainUntilStable(() => mutationFn.mock.calls.length)

    expect.soft(mutationFn).toHaveBeenCalledTimes(1)
    expect
      .soft(mutationFn)
      .toHaveBeenCalledWith(
        { id: 'a' },
        expect.objectContaining({ mutationKey: MUTATION_KEY }),
      )

    queryClient.clear()
  })
})
