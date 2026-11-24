import { QueryClient, QueryObserver, hashKey } from '@tanstack/query-core'
import {
  BroadcastChannel as LibraryBroadcastChannel,
  OPEN_BROADCAST_CHANNELS,
} from 'broadcast-channel'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import { broadcastQueryClient } from '..'
import type { QueryClient as QueryClientType } from '@tanstack/query-core'

/**
 * Wire format of broadcast-channel 7.3.0. postMessage wraps the payload as
 * `{ time, type: 'message', data }` and the native method forwards
 * `MessageEvent.data` unchanged. A document that never imports this plugin
 * can post that object with the platform BroadcastChannel.
 */
const FOREIGN_ENVELOPE_TIME = Number.MAX_SAFE_INTEGER
const DEFAULT_CHANNEL = 'tanstack-query'

interface ForeignChannel {
  close: () => void
}

const foreignChannels: Array<ForeignChannel> = []

function postFromForeignDocument(channelName: string, payload: unknown): void {
  const foreign = new BroadcastChannel(channelName)
  foreignChannels.push(foreign)
  foreign.postMessage({
    time: FOREIGN_ENVELOPE_TIME,
    type: 'message',
    data: payload,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Broadcast delivery and observer notification are both queued. Poll long
 * enough that a message which is going to be applied has been applied,
 * and record every cached value seen along the way.
 */
async function settle(): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 100) {
    await delay(10)
  }
}

function forgedState(data: unknown) {
  return {
    data,
    dataUpdatedAt: Date.now(),
    error: null,
    status: 'success' as const,
    fetchStatus: 'idle' as const,
    isInvalidated: false,
  }
}

function startSync(
  queryClient: QueryClientType,
  broadcastChannel?: string,
): () => void {
  try {
    return broadcastQueryClient(
      broadcastChannel === undefined
        ? { queryClient }
        : { queryClient, broadcastChannel },
    )
  } catch {
    // Refusing to start without an explicit channel name closes the
    // default-channel attack. Integrity tests pass a channel name.
    return () => {}
  }
}

describe('unauthenticated broadcast cache writes', () => {
  const cleanups: Array<() => void> = []

  beforeAll(async () => {
    const channelName = 'transport-probe'
    const received: Array<unknown> = []
    const libraryChannel = new LibraryBroadcastChannel(channelName, {
      webWorkerSupport: false,
    })
    if (libraryChannel.type !== 'native') {
      await libraryChannel.close()
      throw new Error(
        `expected the native BroadcastChannel method, got ${libraryChannel.type}`,
      )
    }
    libraryChannel.onmessage = (data) => {
      received.push(data)
    }
    postFromForeignDocument(channelName, { type: 'updated', probe: true })
    const startedAt = Date.now()
    while (received.length === 0 && Date.now() - startedAt < 500) {
      await delay(10)
    }
    await libraryChannel.close()
    if (received.length !== 1) {
      throw new Error(
        `a platform BroadcastChannel message was not delivered: ${JSON.stringify(received)}`,
      )
    }
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    await Promise.all(
      [...OPEN_BROADCAST_CHANNELS].map((channel) => channel.close()),
    )
    for (const foreign of foreignChannels.splice(0)) {
      foreign.close()
    }
  })

  function track(queryClient: QueryClientType): Array<unknown> {
    const seen: Array<unknown> = []
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      seen.push(event.query.state.data)
    })
    cleanups.push(unsubscribe)
    return seen
  }

  it('does not let a foreign updated message replace a cached query on the default channel', async () => {
    const key = queryKey()
    const real = { name: 'real-profile' }
    const forged = { name: 'forged-profile' }
    const queryClient = new QueryClient()
    const seen = track(queryClient)
    queryClient.setQueryData(key, real)

    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => Promise.resolve(real),
      staleTime: Infinity,
    })
    const rendered: Array<unknown> = []
    cleanups.push(
      observer.subscribe((result) => {
        rendered.push(result.data)
      }),
    )

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.getObserversCount()).toBeGreaterThan(0)

    cleanups.push(startSync(queryClient))
    postFromForeignDocument(DEFAULT_CHANNEL, {
      type: 'updated',
      queryHash: hashKey(key),
      queryKey: key,
      state: forgedState(forged),
    })
    await settle()

    expect(rendered).not.toContainEqual(forged)
    expect(observer.getCurrentResult().data).toEqual(real)
    expect(queryClient.getQueryData(key)).toEqual(real)
    expect(seen).not.toContainEqual(forged)
  })

  it('does not let a foreign updated message create a query on the default channel', async () => {
    const key = queryKey()
    const forged = { name: 'forged-new-query' }
    const queryClient = new QueryClient()
    const seen = track(queryClient)
    cleanups.push(startSync(queryClient))

    postFromForeignDocument(DEFAULT_CHANNEL, {
      type: 'updated',
      queryHash: hashKey(key),
      queryKey: key,
      state: forgedState(forged),
    })
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(seen).not.toContainEqual(forged)
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some(
          (query) => query.state.data && typeof query.state.data === 'object',
        ),
    ).toBe(false)
  })

  it('does not let a foreign added message create a query on the default channel', async () => {
    const key = queryKey()
    const forged = { name: 'forged-added-query' }
    const queryClient = new QueryClient()
    const seen = track(queryClient)
    cleanups.push(startSync(queryClient))

    postFromForeignDocument(DEFAULT_CHANNEL, {
      type: 'added',
      queryHash: hashKey(key),
      queryKey: key,
      state: forgedState(forged),
    })
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(seen).not.toContainEqual(forged)
  })

  it('does not let a foreign added message fill a mounted query that has no data yet', async () => {
    const key = queryKey()
    const forged = { name: 'forged-before-fetch' }
    const queryClient = new QueryClient()
    const seen = track(queryClient)
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => Promise.resolve({ name: 'real' }),
      enabled: false,
    })
    cleanups.push(observer.subscribe(() => {}))
    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(
      queryClient.getQueryCache().find({ queryKey: key })!.getObserversCount(),
    ).toBeGreaterThan(0)

    cleanups.push(startSync(queryClient))
    postFromForeignDocument(DEFAULT_CHANNEL, {
      type: 'added',
      queryHash: hashKey(key),
      queryKey: key,
      state: forgedState(forged),
    })
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(observer.getCurrentResult().data).toBeUndefined()
    expect(seen).not.toContainEqual(forged)
  })

  it('does not let a foreign removed message delete a query on the default channel', async () => {
    const key = queryKey()
    const real = { name: 'real-document' }
    const queryClient = new QueryClient()
    queryClient.setQueryData(key, real)
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => Promise.resolve(real),
      staleTime: Infinity,
    })
    cleanups.push(observer.subscribe(() => {}))
    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.getObserversCount()).toBeGreaterThan(0)

    cleanups.push(startSync(queryClient))
    postFromForeignDocument(DEFAULT_CHANNEL, {
      type: 'removed',
      queryHash: hashKey(key),
      queryKey: key,
    })
    await settle()

    expect(queryClient.getQueryCache().get(hashKey(key))).toBe(query)
    expect(queryClient.getQueryData(key)).toEqual(real)
    expect(observer.getCurrentResult().data).toEqual(real)
  })

  describe('messages on an explicit channel', () => {
    const channelName = 'app-specific-channel'

    it('drops an updated message whose query hash does not match its query key', async () => {
      const cachedKey = queryKey()
      const claimedKey = queryKey()
      const real = { name: 'cached-profile' }
      const forged = { name: 'forged-via-mismatched-hash' }
      const queryClient = new QueryClient()
      const seen = track(queryClient)
      queryClient.setQueryData(cachedKey, real)
      const observer = new QueryObserver(queryClient, {
        queryKey: cachedKey,
        queryFn: () => Promise.resolve(real),
        staleTime: Infinity,
      })
      const rendered: Array<unknown> = []
      cleanups.push(
        observer.subscribe((result) => {
          rendered.push(result.data)
        }),
      )

      cleanups.push(startSync(queryClient, channelName))
      // Hash selects the cached query. Key names a different query.
      // Applying either one accepts a message that failed the hash check.
      postFromForeignDocument(channelName, {
        type: 'updated',
        queryHash: hashKey(cachedKey),
        queryKey: claimedKey,
        state: forgedState(forged),
      })
      await settle()

      expect(rendered).not.toContainEqual(forged)
      expect(observer.getCurrentResult().data).toEqual(real)
      expect(queryClient.getQueryData(cachedKey)).toEqual(real)
      expect(queryClient.getQueryData(claimedKey)).toBeUndefined()
      expect(seen).not.toContainEqual(forged)
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ).toEqual([real])
    })

    it('drops an updated message that would create a query under a hash its key does not produce', async () => {
      const cachedKey = queryKey()
      const real = { name: 'cached-profile' }
      const forged = { name: 'forged-under-other-hash' }
      const queryClient = new QueryClient()
      const seen = track(queryClient)
      queryClient.setQueryData(cachedKey, real)

      cleanups.push(startSync(queryClient, channelName))
      postFromForeignDocument(channelName, {
        type: 'updated',
        queryHash: hashKey(['not-the-cached-key']),
        queryKey: cachedKey,
        state: forgedState(forged),
      })
      await settle()

      expect(queryClient.getQueryData(cachedKey)).toEqual(real)
      expect(queryClient.getQueryCache().getAll()).toHaveLength(1)
      expect(seen).not.toContainEqual(forged)
    })

    it('drops an added message whose query hash does not match its query key', async () => {
      const cachedKey = queryKey()
      const claimedKey = queryKey()
      const forged = { name: 'forged-added-mismatch' }
      const queryClient = new QueryClient()
      const seen = track(queryClient)
      const observer = new QueryObserver(queryClient, {
        queryKey: cachedKey,
        queryFn: () => Promise.resolve({ name: 'real' }),
        enabled: false,
      })
      cleanups.push(observer.subscribe(() => {}))
      expect(queryClient.getQueryData(cachedKey)).toBeUndefined()

      cleanups.push(startSync(queryClient, channelName))
      // The cached query has no data yet, so `added` would call setState.
      // The hash selects that query while the key names a different one.
      postFromForeignDocument(channelName, {
        type: 'added',
        queryHash: hashKey(cachedKey),
        queryKey: claimedKey,
        state: forgedState(forged),
      })
      await settle()

      expect(queryClient.getQueryData(cachedKey)).toBeUndefined()
      expect(queryClient.getQueryData(claimedKey)).toBeUndefined()
      expect(observer.getCurrentResult().data).toBeUndefined()
      expect(seen).not.toContainEqual(forged)
    })

    it('drops an added message that would create a query under a hash its key does not produce', async () => {
      const cachedKey = queryKey()
      const real = { name: 'cached-profile' }
      const forged = { name: 'forged-added-other-hash' }
      const queryClient = new QueryClient()
      queryClient.setQueryData(cachedKey, real)

      cleanups.push(startSync(queryClient, channelName))
      postFromForeignDocument(channelName, {
        type: 'added',
        queryHash: hashKey(['added-not-the-cached-key']),
        queryKey: cachedKey,
        state: forgedState(forged),
      })
      await settle()

      expect(queryClient.getQueryData(cachedKey)).toEqual(real)
      expect(queryClient.getQueryCache().getAll()).toHaveLength(1)
    })

    it('does not remove a query when the removed message hash does not match its key', async () => {
      const cachedKey = queryKey()
      const claimedKey = queryKey()
      const real = { name: 'cached-document' }
      const queryClient = new QueryClient()
      queryClient.setQueryData(cachedKey, real)
      const observer = new QueryObserver(queryClient, {
        queryKey: cachedKey,
        queryFn: () => Promise.resolve(real),
        staleTime: Infinity,
      })
      cleanups.push(observer.subscribe(() => {}))

      cleanups.push(startSync(queryClient, channelName))
      postFromForeignDocument(channelName, {
        type: 'removed',
        queryHash: hashKey(cachedKey),
        queryKey: claimedKey,
      })
      await settle()

      expect(queryClient.getQueryData(cachedKey)).toEqual(real)
      expect(queryClient.getQueryCache().get(hashKey(cachedKey))).toBeDefined()
      expect(observer.getCurrentResult().data).toEqual(real)
    })

    it('does not remove a query that still has a mounted observer', async () => {
      const key = queryKey()
      const real = { name: 'mounted-document' }
      const queryClient = new QueryClient()
      queryClient.setQueryData(key, real)
      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        queryFn: () => Promise.resolve(real),
        staleTime: Infinity,
      })
      cleanups.push(observer.subscribe(() => {}))
      const query = queryClient.getQueryCache().find({ queryKey: key })!
      expect(query.getObserversCount()).toBeGreaterThan(0)

      cleanups.push(startSync(queryClient, channelName))
      postFromForeignDocument(channelName, {
        type: 'removed',
        queryHash: hashKey(key),
        queryKey: key,
      })
      await settle()

      expect(queryClient.getQueryCache().get(hashKey(key))).toBe(query)
      expect(queryClient.getQueryData(key)).toEqual(real)
      expect(observer.getCurrentResult().data).toEqual(real)
      expect(query.getObserversCount()).toBeGreaterThan(0)
    })
  })
})
