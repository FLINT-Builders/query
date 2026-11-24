import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { QueryClient, focusManager, onlineManager } from '@tanstack/solid-query'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import {
  clientHasPreviousMutation,
  createGatedPersister,
  mutationKey,
  nextAccountSnapshot,
  nextBuster,
  nextProfile,
  previousAccountSnapshot,
  previousBuster,
  previousProfile,
  profileKey,
  settleGate,
  storedProfileAccount,
} from '../../../query-persist-client-core/src/__tests__/busterRestoreRace.helper'
import type { Persister } from '@tanstack/query-persist-client-core'

describe('PersistQueryClientProvider account buster changes during restore', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('clears the in-memory client when the buster changes', async () => {
    const gate = createGatedPersister(await previousAccountSnapshot())
    const queryClient = new QueryClient()
    const [buster, setBuster] = createSignal(previousBuster)

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: gate.persister, buster: buster() }}
      >
        <div>persist</div>
      </PersistQueryClientProvider>
    ))
    expect(gate.pending()).toBe(1)
    queryClient.setQueryData(profileKey, previousProfile)
    setBuster(nextBuster)

    expect(queryClient.getQueryData(profileKey)).toBeUndefined()
    await settleGate(gate)
  })

  it('does not hydrate the previous account or resume its mutation for the new buster', async () => {
    const gate = createGatedPersister(await previousAccountSnapshot())
    const queryClient = new QueryClient()
    const nextMutation = vi.fn(() => Promise.resolve('next-session'))
    queryClient.setMutationDefaults(mutationKey, {
      mutationFn: nextMutation,
      networkMode: 'online',
    })
    const [buster, setBuster] = createSignal(previousBuster)

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: gate.persister satisfies Persister,
          buster: buster(),
        }}
      >
        <div>persist</div>
      </PersistQueryClientProvider>
    ))
    expect(gate.pending()).toBe(1)
    setBuster(nextBuster)
    expect(gate.pending()).toBe(2)
    queryClient.clear()
    queryClient.setMutationDefaults(mutationKey, {
      mutationFn: nextMutation,
      networkMode: 'online',
    })
    await gate.persister.persistClient(nextAccountSnapshot())
    await settleGate(gate)

    expect(queryClient.getQueryData(profileKey)).toEqual(nextProfile)
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(storedProfileAccount(gate.current())).toBe(nextProfile.accountId)
    expect(gate.current()?.buster).toBe(nextBuster)

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
