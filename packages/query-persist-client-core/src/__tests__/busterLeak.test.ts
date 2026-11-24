import { describe, expect, it } from 'vitest'
import { QueryClient, dehydrate } from '@tanstack/query-core'
import { persistQueryClient, persistQueryClientSave } from '../persist'
import type { PersistedClient, Persister } from '../persist'

const ACCOUNT_A = 'account-a-private'
const ACCOUNT_B = 'account-b-private'
const PROFILE_KEY = ['account', 'profile']

type RecordedWrite = {
  buster: string
  payload: string
}

type RecordingPersister = Persister & {
  writes: Array<RecordedWrite>
  release: (index: number) => void
  pending: () => number
}

/**
 * restoreClient copies the cache when it is called, then waits.
 * createAsyncStoragePersister reads storage before persistQueryClientRestore
 * compares busters, so a restore already in flight still sees the snapshot
 * from the buster it started with.
 */
function createRecordingPersister(): RecordingPersister {
  let stored: PersistedClient | undefined
  const writes: Array<RecordedWrite> = []
  const pending: Array<() => void> = []

  return {
    writes,
    persistClient(persistClient: PersistedClient) {
      stored = persistClient
      writes.push({
        buster: persistClient.buster,
        payload: JSON.stringify(persistClient),
      })
    },
    restoreClient() {
      const snapshot = stored
      return new Promise((resolve) => {
        pending.push(() => resolve(snapshot))
      })
    },
    removeClient() {
      stored = undefined
    },
    release(index: number) {
      const resume = pending[index]
      if (!resume) {
        throw new Error(`no restore pending at ${index}`)
      }
      delete pending[index]
      resume()
    },
    pending() {
      return pending.filter(Boolean).length
    },
  }
}

function clientWith(data: string): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, staleTime: Infinity, retry: false },
    },
  })
  queryClient.setQueryData(PROFILE_KEY, data)
  return queryClient
}

function leakedWrites(
  writes: Array<RecordedWrite>,
  buster: string,
): Array<RecordedWrite> {
  return writes.filter(
    (write) => write.buster === buster && write.payload.includes(ACCOUNT_A),
  )
}

describe('persistQueryClient buster and persister changes', () => {
  it('does not save the previous account under the new buster when a query updates', async () => {
    const queryClient = clientWith(ACCOUNT_A)
    const persister = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister,
      buster: 'account-a',
    })

    const [unsubscribeA, restoredA] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-a',
    })
    persister.release(0)
    await restoredA
    unsubscribeA()

    const [unsubscribeB, restoredB] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-b',
    })
    persister.release(1)
    await restoredB

    queryClient.setQueryData(['session'], 'account-b-session')

    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)
    expect(persister.writes.some((write) => write.buster === 'account-b')).toBe(
      true,
    )

    const nextSession = new QueryClient()
    const [unsubscribeNext, restoredNext] = persistQueryClient({
      queryClient: nextSession,
      persister,
      buster: 'account-b',
    })
    persister.release(2)
    await restoredNext
    expect(nextSession.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    unsubscribeB()
    unsubscribeNext()
    nextSession.clear()
    queryClient.clear()
  })

  it('does not save the previous account under the new buster when a mutation updates', async () => {
    const queryClient = clientWith(ACCOUNT_A)
    const persister = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister,
      buster: 'account-a',
    })

    const [unsubscribeA, restoredA] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-a',
    })
    persister.release(0)
    await restoredA
    unsubscribeA()

    const [unsubscribeB, restoredB] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-b',
    })
    persister.release(1)
    await restoredB

    queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => Promise.resolve('account-b-mutation'),
    })

    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)
    expect(persister.writes.some((write) => write.buster === 'account-b')).toBe(
      true,
    )

    unsubscribeB()
    queryClient.clear()
  })

  it('does not let a restore started for the previous buster hydrate after the new buster subscribed', async () => {
    const seeded = clientWith(ACCOUNT_A)
    const persister = createRecordingPersister()
    await persistQueryClientSave({
      queryClient: seeded,
      persister,
      buster: 'account-a',
    })
    seeded.clear()

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, staleTime: Infinity, retry: false },
      },
    })
    const [unsubscribeA, restoredA] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-a',
    })
    unsubscribeA()
    const [unsubscribeB, restoredB] = persistQueryClient({
      queryClient,
      persister,
      buster: 'account-b',
    })
    expect(persister.pending()).toBe(2)

    persister.release(1)
    await restoredB
    persister.release(0)
    await restoredA

    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])

    unsubscribeB()
    queryClient.clear()
  })

  it('does not copy the previous persister memory into the next persister', async () => {
    const queryClient = clientWith(ACCOUNT_A)
    queryClient.setQueryData(['notes'], 'account-a-notes')
    const previous = createRecordingPersister()
    const next = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister: previous,
      buster: 'app',
    })

    const older = clientWith(ACCOUNT_B)
    const olderState = dehydrate(older)
    const olderProfile = olderState.queries[0]
    if (!olderProfile) {
      throw new Error('expected a dehydrated profile query')
    }
    olderProfile.state.dataUpdatedAt = 1
    await persistQueryClientSave({
      queryClient: older,
      persister: next,
      buster: 'app',
    })
    const seeded = next.writes[0]
    if (!seeded) {
      throw new Error('expected the next persister to be seeded')
    }
    const seededClient = JSON.parse(seeded.payload) as PersistedClient
    seededClient.clientState.queries[0]!.state.dataUpdatedAt = 1
    next.writes.length = 0
    await next.persistClient(seededClient)

    const [unsubscribeA, restoredA] = persistQueryClient({
      queryClient,
      persister: previous,
      buster: 'app',
    })
    previous.release(0)
    await restoredA
    unsubscribeA()

    const [unsubscribeB, restoredB] = persistQueryClient({
      queryClient,
      persister: next,
      buster: 'app',
    })
    next.release(0)
    await restoredB

    expect(queryClient.getQueryData(PROFILE_KEY)).toBe(ACCOUNT_B)
    expect(queryClient.getQueryData(['notes'])).toBeUndefined()

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(next.writes, 'app')).toEqual([])

    unsubscribeB()
    older.clear()
    queryClient.clear()
  })
})
