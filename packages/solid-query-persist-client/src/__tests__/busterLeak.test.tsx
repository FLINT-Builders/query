import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@solidjs/testing-library'
import { QueryClient, dehydrate, useQuery } from '@tanstack/solid-query'
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from '@tanstack/query-persist-client-core'
import { createSignal } from 'solid-js'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

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

function createRecordingPersister(options?: {
  gate: boolean
}): RecordingPersister {
  let stored: PersistedClient | undefined
  const writes: Array<RecordedWrite> = []
  const pending: Array<() => void> = []
  const gate = options?.gate ?? false

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
      if (!gate) {
        return Promise.resolve(snapshot)
      }
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

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, staleTime: Infinity, retry: false },
    },
  })
}

function leakedWrites(writes: Array<RecordedWrite>, buster: string) {
  return writes.filter(
    (write) => write.buster === buster && write.payload.includes(ACCOUNT_A),
  )
}

function Profile(props: { fetches: { count: number } }) {
  const state = useQuery(() => ({
    queryKey: PROFILE_KEY,
    queryFn: () => {
      props.fetches.count += 1
      return 'account-b-from-network'
    },
    staleTime: Infinity,
  }))

  return <h1>data: {String(state.data ?? 'empty')}</h1>
}

async function settle() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('PersistQueryClientProvider buster changes', () => {
  it('stops showing the previous account and does not persist it under the new buster', async () => {
    const queryClient = createClient()
    queryClient.setQueryData(PROFILE_KEY, ACCOUNT_A)
    const persister = createRecordingPersister()
    const fetches = { count: 0 }
    await persistQueryClientSave({
      queryClient,
      persister,
      buster: 'account-a',
    })

    const [buster, setBuster] = createSignal('account-a')
    let restores = 0

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: buster() }}
        onSuccess={() => {
          restores += 1
        }}
      >
        <Profile fetches={fetches} />
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(restores).toBe(1)
    })
    expect(screen.getByText(`data: ${ACCOUNT_A}`)).toBeInTheDocument()
    expect(fetches.count).toBe(0)

    const writesBeforeSwitch = persister.writes.length
    setBuster('account-b')

    await vi.waitFor(() => {
      expect(restores).toBe(2)
    })

    expect(screen.queryByText(`data: ${ACCOUNT_A}`)).not.toBeInTheDocument()
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.setQueryData(['session'], 'account-b-session')

    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])
    expect(persister.writes.length).toBeGreaterThan(writesBeforeSwitch)

    const laterVisit = createClient()
    await persistQueryClientRestore({
      queryClient: laterVisit,
      persister,
      buster: 'account-b',
    })
    expect(laterVisit.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.clear()
    laterVisit.clear()
  })

  it('does not persist the previous account when only the mutation cache updates', async () => {
    const queryClient = createClient()
    queryClient.setQueryData(PROFILE_KEY, ACCOUNT_A)
    const persister = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister,
      buster: 'account-a',
    })

    const [buster, setBuster] = createSignal('account-a')
    let restores = 0

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: buster() }}
        onSuccess={() => {
          restores += 1
        }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(restores).toBe(1)
    })

    setBuster('account-b')
    await vi.waitFor(() => {
      expect(restores).toBe(2)
    })

    queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => Promise.resolve('account-b-mutation'),
    })

    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])
    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)
    expect(persister.writes.some((write) => write.buster === 'account-b')).toBe(
      true,
    )

    queryClient.clear()
  })

  it('restores the new buster cache instead of keeping newer in-memory data from the previous buster', async () => {
    const queryClient = createClient()
    queryClient.setQueryData(PROFILE_KEY, ACCOUNT_A)
    queryClient.setQueryData(['notes'], 'account-a-notes')
    const persister = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister,
      buster: 'account-a',
    })

    const [buster, setBuster] = createSignal('account-a')
    let restores = 0

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: buster() }}
        onSuccess={() => {
          restores += 1
        }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(restores).toBe(1)
    })

    const seeded = createClient()
    seeded.setQueryData(PROFILE_KEY, ACCOUNT_B)
    const seededState = dehydrate(seeded)
    const profile = seededState.queries[0]
    if (!profile) {
      throw new Error('expected a dehydrated profile query')
    }
    profile.state.dataUpdatedAt = 1
    await persister.persistClient({
      buster: 'account-b',
      timestamp: Date.now(),
      clientState: seededState,
    })

    setBuster('account-b')
    await vi.waitFor(() => {
      expect(restores).toBe(2)
    })

    expect(queryClient.getQueryData(PROFILE_KEY)).toBe(ACCOUNT_B)
    expect(queryClient.getQueryData(['notes'])).toBeUndefined()

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])

    queryClient.clear()
    seeded.clear()
  })

  it('drops the previous account when the new persister is empty', async () => {
    const queryClient = createClient()
    queryClient.setQueryData(PROFILE_KEY, ACCOUNT_A)
    const current = createRecordingPersister()
    const next = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister: current,
      buster: 'app',
    })

    const [persister, setPersister] = createSignal(current)
    let restores = 0

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: persister(), buster: 'app' }}
        onSuccess={() => {
          restores += 1
        }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(restores).toBe(1)
    })

    setPersister(next)
    await vi.waitFor(() => {
      expect(restores).toBe(2)
    })

    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(next.writes, 'app')).toEqual([])

    queryClient.clear()
  })

  it('restores the next persister when its snapshot is older than the in-memory account', async () => {
    const queryClient = createClient()
    queryClient.setQueryData(PROFILE_KEY, ACCOUNT_A)
    queryClient.setQueryData(['notes'], 'account-a-notes')
    const current = createRecordingPersister()
    const next = createRecordingPersister()
    await persistQueryClientSave({
      queryClient,
      persister: current,
      buster: 'app',
    })

    const seeded = createClient()
    seeded.setQueryData(PROFILE_KEY, ACCOUNT_B)
    const seededState = dehydrate(seeded)
    const profile = seededState.queries[0]
    if (!profile) {
      throw new Error('expected a dehydrated profile query')
    }
    profile.state.dataUpdatedAt = 1
    await next.persistClient({
      buster: 'app',
      timestamp: Date.now(),
      clientState: seededState,
    })

    const [persister, setPersister] = createSignal(current)
    let restores = 0

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: persister(), buster: 'app' }}
        onSuccess={() => {
          restores += 1
        }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(restores).toBe(1)
    })

    setPersister(next)
    await vi.waitFor(() => {
      expect(restores).toBe(2)
    })

    expect(queryClient.getQueryData(PROFILE_KEY)).toBe(ACCOUNT_B)
    expect(queryClient.getQueryData(['notes'])).toBeUndefined()

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(next.writes, 'app')).toEqual([])

    queryClient.clear()
    seeded.clear()
  })

  it('ignores an in-flight restore for the previous buster when it finishes last', async () => {
    const seeded = createClient()
    seeded.setQueryData(PROFILE_KEY, ACCOUNT_A)
    const persister = createRecordingPersister({ gate: true })
    await persistQueryClientSave({
      queryClient: seeded,
      persister,
      buster: 'account-a',
    })
    seeded.clear()

    const queryClient = createClient()
    const [buster, setBuster] = createSignal('account-a')

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: buster() }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(persister.pending()).toBe(1)
    })
    setBuster('account-b')
    await vi.waitFor(() => {
      expect(persister.pending()).toBe(2)
    })

    persister.release(1)
    await settle()
    persister.release(0)
    await settle()

    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])

    queryClient.clear()
  })

  it('ignores an in-flight restore for the previous buster when it finishes first', async () => {
    const seeded = createClient()
    seeded.setQueryData(PROFILE_KEY, ACCOUNT_A)
    const persister = createRecordingPersister({ gate: true })
    await persistQueryClientSave({
      queryClient: seeded,
      persister,
      buster: 'account-a',
    })
    seeded.clear()

    const queryClient = createClient()
    const [buster, setBuster] = createSignal('account-a')

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: buster() }}
      >
        <div>mounted</div>
      </PersistQueryClientProvider>
    ))

    await vi.waitFor(() => {
      expect(persister.pending()).toBe(1)
    })
    setBuster('account-b')
    await vi.waitFor(() => {
      expect(persister.pending()).toBe(2)
    })

    persister.release(0)
    await settle()
    persister.release(1)
    await settle()

    expect(queryClient.getQueryData(PROFILE_KEY)).not.toBe(ACCOUNT_A)

    queryClient.setQueryData(['session'], 'account-b-session')
    expect(leakedWrites(persister.writes, 'account-b')).toEqual([])

    queryClient.clear()
  })
})
