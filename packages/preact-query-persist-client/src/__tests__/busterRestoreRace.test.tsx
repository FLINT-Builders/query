/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/preact'
import {
  QueryClient,
  focusManager,
  onlineManager,
} from '@tanstack/preact-query'
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

function Provider(props: {
  client: QueryClient
  persister: ReturnType<typeof createGatedPersister>['persister']
  buster: string
}) {
  return (
    <PersistQueryClientProvider
      client={props.client}
      persistOptions={{ persister: props.persister, buster: props.buster }}
    >
      <div>persist</div>
    </PersistQueryClientProvider>
  )
}

describe('PersistQueryClientProvider account buster changes during restore', () => {
  afterEach(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it('clears the in-memory client when the buster changes', async () => {
    const gate = createGatedPersister(await previousAccountSnapshot())
    const queryClient = new QueryClient()
    const view = render(
      <Provider
        client={queryClient}
        persister={gate.persister}
        buster={previousBuster}
      />,
    )
    expect(gate.pending()).toBe(1)
    queryClient.setQueryData(profileKey, previousProfile)

    view.rerender(
      <Provider
        client={queryClient}
        persister={gate.persister}
        buster={nextBuster}
      />,
    )

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
    const view = render(
      <Provider
        client={queryClient}
        persister={gate.persister}
        buster={previousBuster}
      />,
    )
    expect(gate.pending()).toBe(1)

    view.rerender(
      <Provider
        client={queryClient}
        persister={gate.persister}
        buster={nextBuster}
      />,
    )
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

    await act(async () => {
      queryClient.mount()
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await Promise.resolve()
      queryClient.unmount()
    })
    expect(nextMutation).not.toHaveBeenCalled()
  })
})
