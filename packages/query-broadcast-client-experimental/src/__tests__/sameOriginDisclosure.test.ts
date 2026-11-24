import { BroadcastChannel as LibraryBroadcastChannel } from 'broadcast-channel'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient, hashKey, hydrate } from '@tanstack/query-core'
import { broadcastQueryClient } from '..'
import type { QueryState } from '@tanstack/query-core'

/**
 * These tests are the spec for the cross-tab sync disclosure.
 * They fail while a same-origin page that never loads this library can
 * read cached query data, errors, or failure reasons from the channel.
 */

const DEFAULT_CHANNEL = 'tanstack-query'
const LOCAL_STORAGE_PREFIX = 'pubkey.broadcastChannel-'

const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  const pending = closers.splice(0, closers.length)
  await Promise.all(pending.map((close) => close()))
})

function createClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  closers.push(() => {
    queryClient.clear()
  })
  return queryClient
}

function textOf(value: unknown): string {
  if (value === undefined) {
    return ''
  }
  return JSON.stringify(value)
}

async function settle(read: () => unknown): Promise<void> {
  const deadline = Date.now() + 1000
  let last = textOf(read())
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 15)
    })
    const next = textOf(read())
    if (next !== last) {
      last = next
      stableSince = Date.now()
      continue
    }
    if (next.length > 2 && Date.now() - stableSince >= 45) {
      return
    }
  }
}

/**
 * A page on the same origin that does not import this package.
 * It uses the platform BroadcastChannel, which is what
 * broadcast-channel's native method posts to.
 */
function openOutsider(name: string): { messages: Array<unknown> } {
  expect(typeof BroadcastChannel).toBe('function')
  const channel = new BroadcastChannel(name)
  expect('postInternal' in channel).toBe(false)
  const messages: Array<unknown> = []
  channel.onmessage = (event: MessageEvent) => {
    messages.push(event.data)
  }
  closers.push(() => {
    channel.close()
  })
  return { messages }
}

function openNativeProbe(): void {
  const probe = new LibraryBroadcastChannel(
    `transport-probe-${Math.random()}`,
    { webWorkerSupport: false },
  )
  closers.push(() => probe.close())
  expect(probe.type).toBe('native')
}

describe('same-origin broadcast disclosure', () => {
  it('posts fetched query data on the default channel to a page that does not load this library', async () => {
    openNativeProbe()
    const outsider = openOutsider(DEFAULT_CHANNEL)
    const queryClient = createClient()
    const stop = broadcastQueryClient({ queryClient })
    closers.push(stop)

    const fetched = 'placeholder-fetched-cache-payload'
    const seeded = 'placeholder-initial-cache-payload'
    await queryClient.query({
      queryKey: ['account'],
      initialData: { note: seeded },
      queryFn: () => ({ note: fetched }),
    })

    await settle(() => outsider.messages)
    expect(textOf(outsider.messages)).not.toContain(fetched)
    expect(textOf(outsider.messages)).not.toContain(seeded)
  })

  it('posts cache data on a caller-chosen channel name with no listener check', async () => {
    openNativeProbe()
    const channelName = 'app-sync-channel'
    const outsider = openOutsider(channelName)
    const queryClient = createClient()
    const stop = broadcastQueryClient({
      queryClient,
      broadcastChannel: channelName,
    })
    closers.push(stop)

    const marker = 'placeholder-manual-cache-payload'
    queryClient.setQueryData(['ledger'], { note: marker })

    await settle(() => outsider.messages)
    expect(textOf(outsider.messages)).not.toContain(marker)
  })

  it('posts hydrated data, errors, and failure reasons when a query is added', async () => {
    openNativeProbe()
    const outsider = openOutsider(DEFAULT_CHANNEL)
    const queryClient = createClient()
    const stop = broadcastQueryClient({ queryClient })
    closers.push(stop)

    const dataMarker = 'placeholder-hydrated-cache-payload'
    const errorMarker = 'placeholder-hydrated-error-detail'
    const reasonMarker = 'placeholder-hydrated-failure-reason'
    const queryKey = ['account', 'snapshot']
    const state: QueryState = {
      data: { note: dataMarker },
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      error: { detail: errorMarker },
      errorUpdateCount: 1,
      errorUpdatedAt: 1,
      fetchFailureCount: 1,
      fetchFailureReason: { detail: reasonMarker },
      fetchMeta: null,
      isInvalidated: true,
      status: 'error',
      fetchStatus: 'idle',
    }

    hydrate(queryClient, {
      queries: [
        {
          queryHash: hashKey(queryKey),
          queryKey,
          state,
          dehydratedAt: 1,
        },
      ],
    })

    await settle(() => outsider.messages)
    const received = textOf(outsider.messages)
    expect(received).not.toContain(dataMarker)
    expect(received).not.toContain(errorMarker)
    expect(received).not.toContain(reasonMarker)
  })

  it('posts the failure reason on a later manual update after a fetch fails', async () => {
    openNativeProbe()
    const channelName = 'app-sync-after-failure'
    const outsider = openOutsider(channelName)
    const queryClient = createClient()
    const stop = broadcastQueryClient({
      queryClient,
      broadcastChannel: channelName,
    })
    closers.push(stop)

    const reasonMarker = 'placeholder-fetch-failure-reason'
    const failure = { detail: reasonMarker }
    await expect(
      queryClient.query({
        queryKey: ['account', 'invoice'],
        queryFn: () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)

    queryClient.setQueryData(['account', 'invoice'], { note: 'replacement' })

    await settle(() => outsider.messages)
    expect(textOf(outsider.messages)).not.toContain(reasonMarker)
  })

  it('writes the same query state to localStorage when BroadcastChannel is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'BroadcastChannel',
    )
    expect(descriptor).toBeDefined()
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    const channelName = 'fallback-sync-channel'
    const storageKey = `${LOCAL_STORAGE_PREFIX}${channelName}`
    const stored: Array<string> = []
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey && event.newValue) {
        stored.push(event.newValue)
      }
    }
    window.addEventListener('storage', onStorage)

    try {
      const probe = new LibraryBroadcastChannel(channelName, {
        webWorkerSupport: false,
      })
      expect(probe.type).toBe('localstorage')
      await probe.close()

      const queryClient = createClient()
      const stop = broadcastQueryClient({
        queryClient,
        broadcastChannel: channelName,
      })
      closers.push(stop)

      const marker = 'placeholder-fallback-cache-payload'
      await queryClient.query({
        queryKey: ['account', 'fallback'],
        queryFn: () => ({ note: marker }),
      })

      const readVisible = () => [
        stored,
        window.localStorage.getItem(storageKey),
      ]
      await settle(readVisible)
      expect(textOf(readVisible())).not.toContain(marker)
    } finally {
      window.removeEventListener('storage', onStorage)
      window.localStorage.removeItem(storageKey)
      if (descriptor) {
        Object.defineProperty(globalThis, 'BroadcastChannel', descriptor)
      }
    }
  })
})
