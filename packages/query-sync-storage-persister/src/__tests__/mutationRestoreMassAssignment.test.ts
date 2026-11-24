// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, focusManager, onlineManager } from '@tanstack/query-core'
import { persistQueryClient } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'

const STORAGE_KEY = 'tanstack-query-offline-cache'
const MUTATION_KEY = ['todos']

async function stopRestoredRetries(): Promise<void> {
  focusManager.setFocused(false)
  for (let turn = 0; turn < 5; turn++) {
    await vi.advanceTimersToNextTimerAsync()
  }
}

function tamperedMutation(id: string) {
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

describe('sync storage persister mutation restore', () => {
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
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
          retryDelay: 1_000,
          networkMode: 'online',
          gcTime: 60_000,
        },
      },
    })
    queryClient.setMutationDefaults(MUTATION_KEY, { mutationFn })

    const persister = createSyncStoragePersister({
      storage: attackerStorage([tamperedMutation('a')]),
      key: STORAGE_KEY,
      throttleTime: 0,
    })

    const [unsubscribe, restored] = persistQueryClient({
      queryClient,
      persister,
      buster: '',
    })
    await restored
    unsubscribe()

    const mutation = queryClient.getMutationCache().getAll()[0]
    expect.soft(mutation?.options.mutationFn).toBe(mutationFn)
    expect.soft(mutation?.options.retry).toBe(false)
    expect.soft(mutation?.options.retryDelay).toBe(1_000)
    expect.soft(mutation?.options.networkMode).toBe('online')
    expect.soft(mutation?.gcTime).toBe(60_000)
    expect.soft(mutation?.options.meta).toEqual({ from: 'snapshot' })
    expect.soft(mutation?.options.scope).toEqual({ id: 'offline-todos' })

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
