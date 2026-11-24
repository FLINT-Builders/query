import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { queryKey } from '@tanstack/query-test-utils'
import { broadcastQueryClient } from '..'

/**
 * A broadcast payload is another writer of `dataUpdatedAt`. A timestamp in
 * the future must not keep the receiving tab from refetching at the default
 * stale time.
 */

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
const FORGED_PROFILE = { name: 'forged', role: 'admin' }
const SERVER_PROFILE = { name: 'real', role: 'member' }

const mockPostMessage = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn()
let lastCreatedChannel: { onmessage: ((action: unknown) => void) | null }

vi.mock('broadcast-channel', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    BroadcastChannel: class MockBroadcastChannel {
      onmessage: ((action: unknown) => void) | null = null
      postMessage = mockPostMessage
      close = mockClose
      constructor() {
        lastCreatedChannel = this
      }
    },
  }
})

describe('future dataUpdatedAt broadcast', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refetches after another tab writes a future dataUpdatedAt', async () => {
    vi.useFakeTimers()
    const client = new QueryClient()
    const key = queryKey()
    client.setQueryData(key, SERVER_PROFILE)
    const query = client.getQueryCache().find({ queryKey: key })
    if (!query) {
      throw new Error('expected query')
    }

    broadcastQueryClient({ queryClient: client })
    lastCreatedChannel.onmessage?.({
      type: 'updated',
      queryHash: query.queryHash,
      queryKey: key,
      state: {
        ...query.state,
        data: FORGED_PROFILE,
        dataUpdatedAt: Date.now() + ONE_YEAR_MS,
        status: 'success',
        isInvalidated: false,
      },
    })

    expect(client.getQueryData(key)).toEqual(FORGED_PROFILE)

    const queryFn = vi.fn(() => SERVER_PROFILE)
    const observer = new QueryObserver(client, { queryKey: key, queryFn })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(SERVER_PROFILE)
    expect(query.isStale()).toBe(true)

    unsubscribe()
    client.clear()
  })
})
