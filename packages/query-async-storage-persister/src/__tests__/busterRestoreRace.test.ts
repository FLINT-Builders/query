import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, focusManager, onlineManager } from '@tanstack/query-core'
import { persistQueryClientRestore } from '@tanstack/query-persist-client-core'
import { createAsyncStoragePersister } from '../index'
import {
  clientHasPreviousMutation,
  mutationKey,
  nextAccountSnapshot,
  nextBuster,
  nextProfile,
  previousAccountSnapshot,
  previousBuster,
  previousProfile,
  profileKey,
  storedProfileAccount,
} from '../../../query-persist-client-core/src/__tests__/busterRestoreRace.helper'
import type { PersistedClient } from '@tanstack/query-persist-client-core'

function createSnapshotStorage(initial: string) {
  let value: string | null = initial
  const pending: Array<() => void> = []
  return {
    storage: {
      getItem: async () => {
        const snapshot = value
        await new Promise<void>((resolve) => {
          pending.push(resolve)
        })
        return snapshot
      },
      setItem: (_key: string, next: string) => {
        value = next
        return Promise.resolve()
      },
      removeItem: () => {
        value = null
        return Promise.resolve()
      },
    },
    pending: () => pending.length,
    current: () => value,
    releaseAll() {
      const batch = pending.splice(0, pending.length)
      for (const resolve of batch) resolve()
    },
  }
}

async function settle(
  storage: { releaseAll: () => void },
  work: Promise<unknown>,
) {
  const done = work.then(
    () => undefined,
    () => undefined,
  )
  for (let attempt = 0; attempt < 8; attempt++) {
    storage.releaseAll()
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

describe('createAsyncStoragePersister account buster changes during restore', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('does not hydrate the previous snapshot or delete the cache written during the read', async () => {
    const storage = createSnapshotStorage(
      JSON.stringify(await previousAccountSnapshot()),
    )
    const persister = createAsyncStoragePersister({
      storage: storage.storage,
      throttleTime: 0,
    })
    const queryClient = new QueryClient()
    const nextMutation = vi.fn(() => Promise.resolve('next-session'))
    queryClient.setMutationDefaults(mutationKey, {
      mutationFn: nextMutation,
      networkMode: 'online',
    })

    const first = persistQueryClientRestore({
      queryClient,
      persister,
      buster: previousBuster,
    })
    expect(storage.pending()).toBe(1)
    queryClient.clear()
    const second = persistQueryClientRestore({
      queryClient,
      persister,
      buster: nextBuster,
    })
    await persister.persistClient(nextAccountSnapshot())
    await settle(storage, Promise.allSettled([first, second]))

    const stored = storage.current()
    const parsed = stored ? (JSON.parse(stored) as PersistedClient) : undefined
    expect(queryClient.getQueryData(profileKey)).toEqual(nextProfile)
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(storedProfileAccount(parsed)).toBe(nextProfile.accountId)
    expect(parsed?.buster).toBe(nextBuster)

    queryClient.mount()
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await Promise.resolve()
    queryClient.unmount()
    expect(nextMutation).not.toHaveBeenCalled()
  })
})
