import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueryClient,
  focusManager,
  onlineManager,
} from '@tanstack/query-core'
import {
  persistQueryClient,
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'

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

function forgedPersistedClient(isPaused: boolean) {
  return {
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
            isPaused,
            status: 'pending' as const,
            variables: PLANTED_VARIABLES,
            submittedAt: 1,
          },
        },
      ],
      queries: [],
    },
  }
}

async function flushTurn() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function runUserScope(client: QueryClient) {
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

  expect(onlineManager.isOnline()).toBe(true)
  expect(focusManager.isFocused()).toBe(true)
  return { userMutationFn, scopedPromise }
}

describe('async storage restore of a paused scoped mutation', () => {
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

  it('an edited paused mutation saved by the default persister keeps the scope from running while the tab stays online', async () => {
    onlineManager.setOnline(false)
    const source = new QueryClient()
    clients.push(source)
    const sourceFn = vi.fn(() => Promise.resolve('offline'))
    const observer = new MutationObserver(source, {
      mutationKey: ['addTodo'],
      scope: { id: 'draft' },
      mutationFn: sourceFn,
    })
    void observer.mutate(PLANTED_VARIABLES).catch(() => undefined)
    expect(sourceFn).not.toHaveBeenCalled()

    const storage = memoryStorage()
    const persister = createAsyncStoragePersister({
      storage,
      throttleTime: 0,
    })
    await persistQueryClientSave({ queryClient: source, persister })
    source.clear()

    const saved = JSON.parse((await storage.getItem(STORAGE_KEY)) ?? 'null')
    expect(saved.clientState.mutations).toHaveLength(1)
    expect(saved.clientState.mutations[0].scope).toEqual({ id: 'draft' })
    expect(saved.clientState.mutations[0].state).toMatchObject({
      isPaused: true,
      status: 'pending',
      variables: PLANTED_VARIABLES,
    })
    saved.clientState.mutations[0].scope = { id: VICTIM_SCOPE }
    saved.clientState.mutations[0].gcTime = PLANTED_GC_TIME
    await storage.setItem(STORAGE_KEY, JSON.stringify(saved))

    onlineManager.setOnline(true)
    const client = new QueryClient()
    clients.push(client)
    client.mount()
    await persistQueryClientRestore({ queryClient: client, persister })

    const { userMutationFn, scopedPromise } = await runUserScope(client)
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })

  it('restore of a forged pending mutation through persistQueryClient does not keep the scope paused', async () => {
    onlineManager.setOnline(true)
    const storage = memoryStorage()
    await storage.setItem(
      STORAGE_KEY,
      JSON.stringify(forgedPersistedClient(true)),
    )
    const persister = createAsyncStoragePersister({
      storage,
      throttleTime: 0,
    })
    const client = new QueryClient()
    clients.push(client)
    client.mount()
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: client,
      persister,
    })
    await restored

    const { userMutationFn, scopedPromise } = await runUserScope(client)
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
    unsubscribe()
  })

  it('a forged pending mutation that is not marked paused still must not occupy the scope', async () => {
    onlineManager.setOnline(true)
    const storage = memoryStorage()
    await storage.setItem(
      STORAGE_KEY,
      JSON.stringify(forgedPersistedClient(false)),
    )
    const persister = createAsyncStoragePersister({ storage, throttleTime: 0 })
    const client = new QueryClient()
    clients.push(client)
    client.mount()
    await persistQueryClientRestore({ queryClient: client, persister })

    const { userMutationFn, scopedPromise } = await runUserScope(client)
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })
})
