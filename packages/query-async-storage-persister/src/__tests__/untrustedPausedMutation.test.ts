/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'

const updateVariables = { id: 'record-9', title: 'forged-title' }
const deleteVariables = { id: 'record-9' }

function forgedClientJson(options: {
  buster?: string
  mutations: Array<{
    mutationKey: Array<string>
    variables: unknown
  }>
}) {
  return JSON.stringify({
    timestamp: Date.now(),
    buster: options.buster ?? '',
    clientState: {
      mutations: options.mutations.map((mutation) => ({
        mutationKey: mutation.mutationKey,
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
    },
  })
}

describe('async storage restore of an untrusted paused mutation', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('does not run paused mutations planted in the default storage key', async () => {
    localStorage.setItem(
      'REACT_QUERY_OFFLINE_CACHE',
      forgedClientJson({
        mutations: [
          { mutationKey: ['todos', 'update'], variables: updateVariables },
          { mutationKey: ['todos', 'delete'], variables: deleteVariables },
        ],
      }),
    )

    const calls: Array<{ kind: 'update' | 'delete'; variables: unknown }> = []
    const queryClient = new QueryClient()
    queryClient.setMutationDefaults(['todos', 'update'], {
      mutationFn: (variables: { id: string; title: string }) => {
        calls.push({ kind: 'update', variables })
        return Promise.resolve(variables)
      },
      onMutate: (variables: { id: string; title: string }) => ({
        optimisticId: variables.id,
      }),
    })
    queryClient.setMutationDefaults(['todos', 'delete'], {
      mutationFn: (variables: { id: string }) => {
        calls.push({ kind: 'delete', variables })
        return Promise.resolve(variables)
      },
      onMutate: (variables: { id: string }) => ({
        optimisticId: variables.id,
      }),
    })

    const persister = createAsyncStoragePersister({
      storage: window.localStorage,
    })

    await persistQueryClientRestore({ queryClient, persister })
    await queryClient.resumePausedMutations()

    expect(calls).toEqual([])
    queryClient.clear()
  })

  it('does not run paused mutations when a public buster matches the planted snapshot', async () => {
    const key = 'app-query-cache'
    const buster = 'release-5'
    localStorage.setItem(
      key,
      forgedClientJson({
        buster,
        mutations: [
          { mutationKey: ['todos', 'update'], variables: updateVariables },
        ],
      }),
    )

    const calls: Array<unknown> = []
    const queryClient = new QueryClient()
    queryClient.setMutationDefaults(['todos', 'update'], {
      mutationFn: (variables: { id: string; title: string }) => {
        calls.push(variables)
        return Promise.resolve(variables)
      },
      onMutate: () => ({ optimistic: true }),
    })

    const persister = createAsyncStoragePersister({
      storage: window.localStorage,
      key,
    })

    await persistQueryClientRestore({ queryClient, persister, buster })
    await queryClient.resumePausedMutations()

    expect(calls).toEqual([])
    queryClient.clear()
  })

  it('does not run a paused mutation that appears only on a later read of the same storage key', async () => {
    const safe = JSON.stringify({
      timestamp: Date.now(),
      buster: '',
      clientState: { mutations: [], queries: [] },
    })
    const planted = forgedClientJson({
      mutations: [
        { mutationKey: ['todos', 'delete'], variables: deleteVariables },
      ],
    })
    let reads = 0
    const storage = {
      getItem: (key: string) => {
        reads += 1
        if (key !== 'REACT_QUERY_OFFLINE_CACHE') {
          return null
        }
        return reads === 1 ? safe : planted
      },
      setItem: (key: string, value: string) => {
        localStorage.setItem(key, value)
      },
      removeItem: (key: string) => {
        localStorage.removeItem(key)
      },
    }

    const calls: Array<unknown> = []
    const queryClient = new QueryClient()
    queryClient.setMutationDefaults(['todos', 'delete'], {
      mutationFn: (variables: { id: string }) => {
        calls.push(variables)
        return Promise.resolve(variables)
      },
      onMutate: () => ({ optimistic: true }),
    })
    const persister = createAsyncStoragePersister({ storage })

    await persistQueryClientRestore({ queryClient, persister })
    await queryClient.resumePausedMutations()

    expect(calls).toEqual([])
    expect(reads).toBeGreaterThan(0)
    queryClient.clear()
  })
})
