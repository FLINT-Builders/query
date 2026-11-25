import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueryClient,
  focusManager,
  onlineManager,
} from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createSyncStoragePersister } from '../index'

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const VICTIM_SCOPE = 'todo'
const PLANTED_VARIABLES = { title: 'planted' }
const USER_VARIABLES = { title: 'milk' }
const PLANTED_GC_TIME = 60 * 60 * 1000

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

async function flushTurn() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('sync storage restore of a paused scoped mutation', () => {
  const clients: Array<QueryClient> = []

  afterEach(() => {
    for (const client of clients) {
      client.clear()
      client.unmount()
    }
    clients.length = 0
    onlineManager.setOnline(true)
    focusManager.setFocused(undefined)
  })

  it('does not leave a forged paused mutation occupying its scope while the client is already online', async () => {
    onlineManager.setOnline(true)
    const storage = memoryStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        buster: '',
        clientState: {
          mutations: [
            {
              mutationKey: ['addTodo'],
              scope: { id: VICTIM_SCOPE },
              gcTime: PLANTED_GC_TIME,
              state: {
                context: null,
                data: null,
                error: null,
                failureCount: 0,
                failureReason: null,
                isPaused: true,
                status: 'pending',
                variables: PLANTED_VARIABLES,
                submittedAt: 1,
              },
            },
          ],
          queries: [],
        },
      }),
    )
    const persister = createSyncStoragePersister({ storage })
    const client = new QueryClient()
    clients.push(client)
    client.mount()
    await persistQueryClientRestore({ queryClient: client, persister })

    expect(onlineManager.isOnline()).toBe(true)
    expect(focusManager.isFocused()).toBe(true)

    const userMutationFn = vi.fn((variables: { title: string }) => {
      return Promise.resolve(variables.title)
    })
    const unrelatedFn = vi.fn(() => Promise.resolve('ok'))
    const scoped = new MutationObserver(client, {
      mutationKey: ['addTodo'],
      scope: { id: VICTIM_SCOPE },
      mutationFn: userMutationFn,
    })
    const unrelated = new MutationObserver(client, {
      mutationKey: ['other'],
      scope: { id: 'not-the-planted-scope' },
      mutationFn: unrelatedFn,
    })

    const scopedPromise = scoped.mutate(USER_VARIABLES).catch(() => undefined)
    await unrelated.mutate(undefined)
    expect(unrelatedFn).toHaveBeenCalledTimes(1)

    for (let turn = 0; turn < 10; turn++) {
      await flushTurn()
    }

    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    expect(userMutationFn).not.toHaveBeenCalledWith(
      PLANTED_VARIABLES,
      expect.anything(),
    )
    await scopedPromise
  })
})
