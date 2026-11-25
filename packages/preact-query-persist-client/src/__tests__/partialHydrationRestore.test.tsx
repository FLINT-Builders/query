/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/preact'
import { QueryClient, useQuery } from '@tanstack/preact-query'
import { sleep } from '@tanstack/query-test-utils'
import { createAsyncStoragePersister } from '../../../query-async-storage-persister/src/index'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import {
  FORGED_MUTATION,
  FORGED_PROFILE,
  FORGED_SESSION,
  PERSIST_STORAGE_KEY,
  createMemoryStorage,
  forgedValuesStillCached,
  plantPoisonedQueryCache,
} from '../../../query-persist-client-core/src/__tests__/poisonedPersistCache'

describe('PersistQueryClientProvider partial hydration', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not show or republish queries hydrated before a stateless persisted entry', async () => {
    vi.useFakeTimers()
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    const storage = createMemoryStorage()
    plantPoisonedQueryCache(storage)
    const persister = createAsyncStoragePersister({
      storage,
      throttleTime: 0,
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    queryClient.setQueryData(['profile'], 'real-profile')
    const seen: Array<string | undefined> = []

    function Page() {
      const state = useQuery({
        queryKey: ['session'],
        queryFn: () => sleep(10).then(() => 'fetched-session'),
      })
      seen.push(state.data)
      return <h1>{state.data}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )

    await act(() => vi.advanceTimersByTimeAsync(0))

    expect(forgedValuesStillCached(queryClient)).toEqual([])
    expect([undefined, 'real-profile']).toContain(
      queryClient.getQueryData(['profile']),
    )
    expect(queryClient.getQueryData(['session'])).not.toBe(FORGED_SESSION)
    expect(seen).not.toContain(FORGED_SESSION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    queryClient.setQueryData(['unrelated'], 'unrelated-value')
    await act(() => vi.advanceTimersByTimeAsync(20))

    const saved = storage.getItem(PERSIST_STORAGE_KEY) ?? ''
    expect(saved).not.toContain(FORGED_PROFILE)
    expect(saved).not.toContain(FORGED_SESSION)
    expect(saved).not.toContain(FORGED_MUTATION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
