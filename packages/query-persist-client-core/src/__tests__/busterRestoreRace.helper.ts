import { QueryClient, dehydrate, onlineManager } from '@tanstack/query-core'
import type { PersistedClient, Persister } from '../persist'

export const profileKey = ['account', 'profile'] as const
export const mutationKey = ['profile', 'save'] as const

export const previousProfile = { accountId: 'previous', name: 'Ada' }
export const nextProfile = { accountId: 'next', name: 'Bea' }
export const previousVariables = { accountId: 'previous', city: 'queued' }

export const previousBuster = 'account-previous'
export const nextBuster = 'account-next'

interface PendingRead {
  captured: PersistedClient | undefined
  resolve: (value: PersistedClient | undefined) => void
  reject: (error: Error) => void
}

/**
 * Storage whose in-flight reads return the value sampled when the read
 * started, matching an async adapter that resolves getItem with a snapshot
 * taken before a later setItem.
 */
export function createGatedPersister(initial?: PersistedClient) {
  let stored = initial
  const reads: Array<PendingRead> = []

  const persister: Persister = {
    persistClient(client) {
      stored = client
      return Promise.resolve()
    },
    restoreClient() {
      const captured = stored
      return new Promise((resolve, reject) => {
        reads.push({ captured, resolve, reject })
      })
    },
    removeClient() {
      stored = undefined
      return Promise.resolve()
    },
  }

  return {
    persister,
    pending: () => reads.length,
    current: () => stored,
    releaseAll() {
      const batch = reads.splice(0, reads.length)
      for (const read of batch) {
        read.resolve(read.captured)
      }
    },
    failOldest(error: Error) {
      const read = reads.shift()
      if (!read) {
        throw new Error('no in-flight restore read')
      }
      read.reject(error)
    },
  }
}

export type GatedPersister = ReturnType<typeof createGatedPersister>

export async function settleGate(gate: GatedPersister) {
  for (let attempt = 0; attempt < 8; attempt++) {
    gate.releaseAll()
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    if (gate.pending() === 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
      if (gate.pending() === 0) return
    }
  }
  throw new Error('restore did not settle')
}

export async function settleRestores(
  gate: GatedPersister,
  work: Promise<unknown>,
) {
  const done = work.then(
    () => undefined,
    () => undefined,
  )
  for (let attempt = 0; attempt < 8; attempt++) {
    gate.releaseAll()
    const status = await Promise.race([
      done.then(() => 'done' as const),
      new Promise<'wait'>((resolve) => {
        setTimeout(() => resolve('wait'), 0)
      }),
    ])
    if (status === 'done') {
      await done
      return
    }
  }
  throw new Error('restore did not settle')
}

export async function previousAccountSnapshot(): Promise<PersistedClient> {
  const wasOnline = onlineManager.isOnline()
  onlineManager.setOnline(false)
  try {
    const client = new QueryClient()
    client.setQueryData(profileKey, previousProfile)
    client.setMutationDefaults(mutationKey, {
      mutationFn: () => Promise.resolve('previous-session'),
      networkMode: 'online',
    })
    const execution = client
      .getMutationCache()
      .build(client, { mutationKey })
      .execute(previousVariables)
    execution.catch(() => undefined)
    await Promise.resolve()

    const paused = client
      .getMutationCache()
      .getAll()
      .some((mutation) => mutation.state.isPaused)
    if (!paused) {
      throw new Error('expected the previous account mutation to be paused')
    }

    return {
      buster: previousBuster,
      timestamp: Date.now(),
      clientState: dehydrate(client),
    }
  } finally {
    onlineManager.setOnline(wasOnline)
  }
}

export function nextAccountSnapshot(): PersistedClient {
  const client = new QueryClient()
  client.setQueryData(profileKey, nextProfile)
  return {
    buster: nextBuster,
    timestamp: Date.now(),
    clientState: dehydrate(client),
  }
}

export function storedProfileAccount(
  client: PersistedClient | undefined,
): string | undefined {
  const query = client?.clientState.queries.find(
    (entry) => JSON.stringify(entry.queryKey) === JSON.stringify(profileKey),
  )
  const data = query?.state.data as { accountId?: string } | undefined
  return data?.accountId
}

export function clientHasPreviousMutation(client: QueryClient) {
  return client
    .getMutationCache()
    .getAll()
    .some((mutation) => {
      const variables = mutation.state.variables as
        | { city?: string }
        | undefined
      return variables?.city === previousVariables.city
    })
}
