import { render } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/svelte-query'
import { createAsyncStoragePersister } from '../../query-async-storage-persister/src/index'
import {
  FORGED_MUTATION,
  FORGED_PROFILE,
  FORGED_SESSION,
  PERSIST_STORAGE_KEY,
  createMemoryStorage,
  forgedValuesStillCached,
  plantPoisonedQueryCache,
} from '../../query-persist-client-core/src/__tests__/poisonedPersistCache'
import PartialHydration from './PartialHydration/Provider.svelte'

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

    const rendered = render(PartialHydration, {
      props: { queryClient, persistOptions: { persister } },
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(forgedValuesStillCached(queryClient)).toEqual([])
    expect([undefined, 'real-profile']).toContain(
      queryClient.getQueryData(['profile']),
    )
    expect(queryClient.getQueryData(['session'])).not.toBe(FORGED_SESSION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    queryClient.setQueryData(['unrelated'], 'unrelated-value')
    await vi.advanceTimersByTimeAsync(20)

    const saved = storage.getItem(PERSIST_STORAGE_KEY) ?? ''
    expect(saved).not.toContain(FORGED_PROFILE)
    expect(saved).not.toContain(FORGED_SESSION)
    expect(saved).not.toContain(FORGED_MUTATION)
    expect(rendered.container.textContent).not.toContain(FORGED_SESSION)

    consoleError.mockRestore()
    consoleWarn.mockRestore()
  })
})
