import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueryClient,
  dehydrate,
  focusManager,
  hydrate,
  onlineManager,
} from '..'
import type { DehydratedState } from '..'

const VICTIM_SCOPE = 'todo'
const PLANTED_VARIABLES = { title: 'planted' }
const USER_VARIABLES = { title: 'milk' }
// Long enough that garbage collection cannot explain a prompt unblock.
const PLANTED_GC_TIME = 60 * 60 * 1000

interface PlantedMutationRecord {
  mutationKey?: ReadonlyArray<unknown>
  scope?: { id: string }
  gcTime?: number
  state: {
    context: null
    data: null
    error: null
    failureCount: number
    failureReason: null
    isPaused: boolean
    status: 'pending'
    variables: { title: string }
    submittedAt: number
  }
}

/**
 * Storage snapshot an attacker can write. Shape matches `dehydrateMutation`
 * plus the extra option fields `hydrate` copies onto the restored mutation.
 */
function plantedDehydratedState(
  mutation: Partial<PlantedMutationRecord> &
    Pick<PlantedMutationRecord, 'state'>,
): DehydratedState {
  const serialized = JSON.stringify({
    mutations: [
      {
        gcTime: PLANTED_GC_TIME,
        ...mutation,
      },
    ],
    queries: [],
  })
  return JSON.parse(serialized) as DehydratedState
}

function pausedPendingState(isPaused: boolean): PlantedMutationRecord['state'] {
  return {
    context: null,
    data: null,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused,
    status: 'pending',
    variables: PLANTED_VARIABLES,
    submittedAt: 1,
  }
}

async function flushTurn() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Runs a scoped mutation while the client is already online and focused.
 * Does not fire a focus or online transition. The caller asserts that the
 * scoped mutation function ran.
 */
async function runScopedMutation(
  client: QueryClient,
  options: {
    scopeId: string
    passScopeOnObserver: boolean
    networkMode?: 'online' | 'always'
  },
) {
  expect(onlineManager.isOnline()).toBe(true)
  expect(focusManager.isFocused()).toBe(true)

  const userMutationFn = vi.fn((variables: { title: string }) => {
    return Promise.resolve(variables.title)
  })
  const unrelatedFn = vi.fn(() => Promise.resolve('ok'))

  const scoped = new MutationObserver(client, {
    mutationKey: ['addTodo'],
    ...(options.passScopeOnObserver ? { scope: { id: options.scopeId } } : {}),
    mutationFn: userMutationFn,
    networkMode: options.networkMode ?? 'online',
  })
  const unrelated = new MutationObserver(client, {
    mutationKey: ['other'],
    scope: { id: `${options.scopeId}-other` },
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

describe('restored pending mutations must not keep a scope paused', () => {
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

  function track(client: QueryClient) {
    clients.push(client)
    return client
  }

  it('default dehydrate keeps a paused mutation and its scope id', () => {
    onlineManager.setOnline(false)
    const client = track(new QueryClient())
    const mutationFn = vi.fn(() => Promise.resolve('should-not-run'))
    const observer = new MutationObserver(client, {
      mutationKey: ['addTodo'],
      scope: { id: 'draft' },
      mutationFn,
    })

    void observer.mutate(PLANTED_VARIABLES).catch(() => undefined)

    const dehydrated = dehydrate(client)
    expect(mutationFn).not.toHaveBeenCalled()
    expect(dehydrated.mutations).toHaveLength(1)
    expect(dehydrated.mutations[0]?.scope).toEqual({ id: 'draft' })
    expect(dehydrated.mutations[0]?.state).toMatchObject({
      isPaused: true,
      status: 'pending',
      variables: PLANTED_VARIABLES,
    })

    onlineManager.setOnline(true)
  })

  it.each(['online', 'always'] as const)(
    'hydrate of a paused pending scope does not block a later %s mutation while already online and focused',
    async (networkMode) => {
      onlineManager.setOnline(true)
      const client = track(new QueryClient())
      // Same order as QueryClientProvider then PersistQueryClientProvider:
      // mount subscribes first, restore happens after, with no focus/online edge.
      client.mount()
      hydrate(
        client,
        plantedDehydratedState({
          mutationKey: ['addTodo'],
          scope: { id: VICTIM_SCOPE },
          state: pausedPendingState(true),
        }),
      )

      const { userMutationFn, scopedPromise } = await runScopedMutation(
        client,
        {
          scopeId: VICTIM_SCOPE,
          passScopeOnObserver: true,
          networkMode,
        },
      )
      expect(userMutationFn).toHaveBeenCalledTimes(1)
      expect(userMutationFn).toHaveBeenCalledWith(
        USER_VARIABLES,
        expect.objectContaining({ mutationKey: ['addTodo'] }),
      )
      await scopedPromise
    },
  )

  it('hydrate of a pending mutation that is not paused still must not occupy the scope', async () => {
    onlineManager.setOnline(true)
    const client = track(new QueryClient())
    client.mount()
    hydrate(
      client,
      plantedDehydratedState({
        mutationKey: ['addTodo'],
        scope: { id: VICTIM_SCOPE },
        state: pausedPendingState(false),
      }),
    )

    const { userMutationFn, scopedPromise } = await runScopedMutation(client, {
      scopeId: VICTIM_SCOPE,
      passScopeOnObserver: true,
    })
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })

  it('a restored mutation inherits a scope from setMutationDefaults and must not block that scope', async () => {
    onlineManager.setOnline(true)
    const client = track(new QueryClient())
    client.setMutationDefaults(['addTodo'], {
      scope: { id: VICTIM_SCOPE },
      mutationFn: () => Promise.resolve('default-must-not-be-required'),
    })
    client.mount()
    hydrate(
      client,
      plantedDehydratedState({
        mutationKey: ['addTodo'],
        state: pausedPendingState(true),
      }),
    )

    const { userMutationFn, scopedPromise } = await runScopedMutation(client, {
      scopeId: VICTIM_SCOPE,
      passScopeOnObserver: false,
    })
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })

  it('a restored mutation inherits scope from defaultOptions.mutations and must not block that scope', async () => {
    onlineManager.setOnline(true)
    const client = track(
      new QueryClient({
        defaultOptions: {
          mutations: {
            scope: { id: VICTIM_SCOPE },
          },
        },
      }),
    )
    client.mount()
    hydrate(
      client,
      plantedDehydratedState({
        mutationKey: ['unrelated-key'],
        state: pausedPendingState(true),
      }),
    )

    const { userMutationFn, scopedPromise } = await runScopedMutation(client, {
      scopeId: VICTIM_SCOPE,
      passScopeOnObserver: true,
    })
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })

  it('a restored mutation inherits scope from hydrate default options and must not block that scope', async () => {
    onlineManager.setOnline(true)
    const client = track(
      new QueryClient({
        defaultOptions: {
          hydrate: {
            mutations: {
              scope: { id: VICTIM_SCOPE },
            },
          },
        },
      }),
    )
    client.mount()
    hydrate(
      client,
      plantedDehydratedState({
        state: pausedPendingState(true),
      }),
    )

    const { userMutationFn, scopedPromise } = await runScopedMutation(client, {
      scopeId: VICTIM_SCOPE,
      passScopeOnObserver: true,
    })
    expect(userMutationFn).toHaveBeenCalledTimes(1)
    expect(userMutationFn).toHaveBeenCalledWith(
      USER_VARIABLES,
      expect.objectContaining({ mutationKey: ['addTodo'] }),
    )
    await scopedPromise
  })
})
