import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, focusManager, onlineManager } from '@tanstack/query-core'
import { persistQueryClient, persistQueryClientRestore } from '../persist'
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
  settleRestores,
  storedProfileAccount,
} from './busterRestoreRace.helper'

async function resumeThroughFocus(queryClient: QueryClient) {
  queryClient.mount()
  focusManager.setFocused(false)
  focusManager.setFocused(true)
  await Promise.resolve()
  queryClient.unmount()
}

async function resumeThroughOnline(queryClient: QueryClient) {
  queryClient.mount()
  onlineManager.setOnline(false)
  onlineManager.setOnline(true)
  await Promise.resolve()
  queryClient.unmount()
}

describe('account buster changes during persist restore', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('keeps a single matching restore', async () => {
    const snapshot = await previousAccountSnapshot()
    const gate = createGatedPersister(snapshot)
    const queryClient = new QueryClient()

    const restore = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: previousBuster,
    })
    await settleRestores(gate, restore)

    expect(queryClient.getQueryData(profileKey)).toEqual(previousProfile)
    expect(clientHasPreviousMutation(queryClient)).toBe(true)
    expect(gate.current()?.buster).toBe(previousBuster)
  })

  it('still discards a mismatched snapshot when storage is unchanged', async () => {
    const snapshot = await previousAccountSnapshot()
    const gate = createGatedPersister(snapshot)
    const queryClient = new QueryClient()

    const restore = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: nextBuster,
    })
    await settleRestores(gate, restore)

    expect(queryClient.getQueryData(profileKey)).toBeUndefined()
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(gate.current()).toBeUndefined()
  })

  it('does not copy the previous account into the client that a newer restore is using', async () => {
    const snapshot = await previousAccountSnapshot()
    const gate = createGatedPersister(snapshot)
    const queryClient = new QueryClient()
    const nextMutation = vi.fn(() => Promise.resolve('next-session'))
    queryClient.setMutationDefaults(mutationKey, {
      mutationFn: nextMutation,
      networkMode: 'online',
    })

    const first = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: previousBuster,
    })
    queryClient.clear()
    const second = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: nextBuster,
    })
    const saved = nextAccountSnapshot()
    await gate.persister.persistClient(saved)

    await settleRestores(gate, Promise.allSettled([first, second]))

    expect(queryClient.getQueryData(profileKey)).toEqual(nextProfile)
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(storedProfileAccount(gate.current())).toBe(nextProfile.accountId)
    expect(gate.current()?.buster).toBe(nextBuster)

    await resumeThroughFocus(queryClient)
    expect(nextMutation).not.toHaveBeenCalled()
    await resumeThroughOnline(queryClient)
    expect(nextMutation).not.toHaveBeenCalled()
  })

  it('does not let an unsubscribed persistQueryClient apply or delete after the read', async () => {
    const snapshot = await previousAccountSnapshot()
    const gate = createGatedPersister(snapshot)
    const queryClient = new QueryClient()
    const nextMutation = vi.fn(() => Promise.resolve('next-session'))
    queryClient.setMutationDefaults(mutationKey, {
      mutationFn: nextMutation,
      networkMode: 'online',
    })

    const [unsubscribe, restored] = persistQueryClient({
      queryClient,
      persister: gate.persister,
      buster: previousBuster,
    })
    expect(gate.pending()).toBe(1)
    unsubscribe()
    queryClient.clear()
    const saved = nextAccountSnapshot()
    await gate.persister.persistClient(saved)

    await settleRestores(gate, restored)

    expect(queryClient.getQueryData(profileKey)).toBeUndefined()
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(storedProfileAccount(gate.current())).toBe(nextProfile.accountId)
    expect(gate.current()?.buster).toBe(nextBuster)

    await resumeThroughFocus(queryClient)
    expect(nextMutation).not.toHaveBeenCalled()
  })

  it('does not let a superseded restore delete storage when its read fails', async () => {
    const snapshot = await previousAccountSnapshot()
    const gate = createGatedPersister(snapshot)
    const queryClient = new QueryClient()
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    const first = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: previousBuster,
    })
    const second = persistQueryClientRestore({
      queryClient,
      persister: gate.persister,
      buster: nextBuster,
    })
    const saved = nextAccountSnapshot()
    await gate.persister.persistClient(saved)
    gate.failOldest(new Error('storage failed'))

    await settleRestores(gate, Promise.allSettled([first, second]))

    expect(queryClient.getQueryData(profileKey)).toEqual(nextProfile)
    expect(clientHasPreviousMutation(queryClient)).toBe(false)
    expect(storedProfileAccount(gate.current())).toBe(nextProfile.accountId)
    expect(gate.current()?.buster).toBe(nextBuster)

    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
