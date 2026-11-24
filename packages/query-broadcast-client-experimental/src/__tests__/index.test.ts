import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { broadcastQueryClient } from '..'
import type { BroadcastErrorEvent } from '..'
import type { QueryCache } from '@tanstack/query-core'

const mockPostMessage = vi.fn().mockResolvedValue(undefined)
const mockClose = vi.fn()
let lastCreatedChannel: { onmessage: ((action: any) => void) | null }

vi.mock('broadcast-channel', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    BroadcastChannel: class MockBroadcastChannel {
      onmessage = null
      postMessage = mockPostMessage
      close = mockClose
      constructor() {
        lastCreatedChannel = this
      }
    },
  }
})

describe('broadcastQueryClient', () => {
  let queryClient: QueryClient
  let queryCache: QueryCache

  beforeEach(() => {
    queryClient = new QueryClient()
    queryCache = queryClient.getQueryCache()
    mockPostMessage.mockResolvedValue(undefined)
    mockClose.mockReset()
  })

  it('should subscribe to the query cache', () => {
    broadcastQueryClient({
      queryClient,
      broadcastChannel: 'test_channel',
    })
    expect(queryCache.hasListeners()).toBe(true)
  })

  it('should not have any listeners after cleanup', () => {
    const unsubscribe = broadcastQueryClient({
      queryClient,
      broadcastChannel: 'test_channel',
    })
    unsubscribe()
    expect(queryCache.hasListeners()).toBe(false)
  })

  describe('incoming message handling', () => {
    // Connects a second tab's client to the first one: whatever the first
    // tab posts is delivered to the second tab's channel.
    function connectTab() {
      const otherClient = new QueryClient()
      broadcastQueryClient({
        queryClient: otherClient,
        broadcastChannel: 'test_channel',
      })
      const otherChannel = lastCreatedChannel
      const deliverLastPost = () => {
        otherChannel.onmessage?.(mockPostMessage.mock.lastCall?.[0])
      }
      return { otherClient, otherChannel, deliverLastPost }
    }

    it('should only post the event type and an opaque digest', () => {
      const key = queryKey()

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })

      queryClient.setQueryData(key, { secret: 'placeholder-cache-payload' })

      const message = mockPostMessage.mock.lastCall?.[0]
      expect(Object.keys(message).sort()).toEqual(['digest', 'type'])
      expect(message.type).toBe('updated')
      expect(JSON.stringify(message)).not.toContain(key[0])
      expect(JSON.stringify(message)).not.toContain('placeholder-cache-payload')
    })

    it('should refetch an active query through its own queryFn instead of adopting remote state', async () => {
      const key = queryKey()
      const queryFn = vi.fn().mockResolvedValue('from server')

      const { otherClient, deliverLastPost } = connectTab()
      const observer = new QueryObserver(otherClient, {
        queryKey: key,
        queryFn,
        staleTime: Infinity,
      })
      const unsubscribeObserver = observer.subscribe(() => {})
      await sleep(0)
      expect(queryFn).toHaveBeenCalledTimes(1)

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })
      queryClient.setQueryData(key, 'from this tab')
      deliverLastPost()
      await sleep(0)

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(otherClient.getQueryData(key)).toBe('from server')

      unsubscribeObserver()
    })

    it('should not announce a refetch that was triggered by another tab', async () => {
      const key = queryKey()
      const queryFn = vi.fn().mockResolvedValue('from server')

      const { otherClient, deliverLastPost } = connectTab()
      const observer = new QueryObserver(otherClient, {
        queryKey: key,
        queryFn,
        staleTime: Infinity,
      })
      const unsubscribeObserver = observer.subscribe(() => {})
      await sleep(0)

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })
      queryClient.setQueryData(key, 'from this tab')
      deliverLastPost()
      mockPostMessage.mockClear()
      await sleep(0)

      expect(queryFn).toHaveBeenCalledTimes(2)
      expect(mockPostMessage).not.toHaveBeenCalled()

      // A later fetch that this tab starts itself is announced again.
      await otherClient.refetchQueries({ queryKey: key })
      expect(mockPostMessage).toHaveBeenCalledTimes(1)

      unsubscribeObserver()
    })

    it('should ignore messages that carry query state or keys', () => {
      const existingKey = queryKey()
      const remoteKey = queryKey()

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })

      queryClient.setQueryData(existingKey, { value: 'resolved' })
      const existingQuery = queryCache.find({ queryKey: existingKey })!

      lastCreatedChannel.onmessage?.({
        type: 'updated',
        queryHash: existingQuery.queryHash,
        queryKey: existingKey,
        state: { status: 'success', data: { value: 'injected' } },
      })
      lastCreatedChannel.onmessage?.({
        type: 'added',
        queryHash: JSON.stringify(remoteKey),
        queryKey: remoteKey,
        state: { status: 'success', data: { value: 'injected' } },
      })

      expect(queryClient.getQueryData(existingKey)).toEqual({
        value: 'resolved',
      })
      expect(queryCache.find({ queryKey: remoteKey })).toBeUndefined()
    })

    it('should remove a query when another tab removes it', () => {
      const key = queryKey()

      const { otherClient, deliverLastPost } = connectTab()
      otherClient.setQueryData(key, 'cached')

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })
      queryClient.setQueryData(key, 'cached')
      const observer = new QueryObserver(queryClient, {
        queryKey: key,
        enabled: false,
      })
      const unsubscribeObserver = observer.subscribe(() => {})
      mockPostMessage.mockClear()

      queryClient.removeQueries({ queryKey: key })
      expect(mockPostMessage.mock.lastCall?.[0].type).toBe('removed')
      deliverLastPost()

      expect(
        otherClient.getQueryCache().find({ queryKey: key }),
      ).toBeUndefined()

      unsubscribeObserver()
    })

    it('should keep broadcasting local changes after applying an incoming message throws', () => {
      const key = queryKey()
      const localKey = queryKey()

      const { otherClient, deliverLastPost } = connectTab()
      otherClient.setQueryData(key, 'cached')

      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
      })
      queryClient.setQueryData(key, 'cached')

      // Simulate some other part of the app (e.g. another cache subscriber)
      // throwing synchronously while an incoming cross-tab message is being
      // applied locally.
      const explodingUnsubscribe = otherClient.getQueryCache().subscribe(() => {
        throw new Error('boom from an unrelated cache listener')
      })

      expect(() => deliverLastPost()).toThrow('boom')

      explodingUnsubscribe()
      mockPostMessage.mockClear()

      // A later local change must still be broadcast to other tabs, instead
      // of being silently swallowed because the transaction flag got stuck.
      otherClient.setQueryData(localKey, { value: 1 })
      expect(mockPostMessage).toHaveBeenCalled()

      // The query whose refetch failed to start is still announced later.
      mockPostMessage.mockClear()
      otherClient.setQueryData(key, 'changed locally')
      expect(mockPostMessage).toHaveBeenCalled()
    })
  })

  describe('postMessage error handling', () => {
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env['NODE_ENV']
    })

    afterEach(() => {
      process.env['NODE_ENV'] = originalEnv
    })

    it('should not cause an unhandled rejection when onBroadcastError itself throws', async () => {
      const key = queryKey()
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const unhandledRejections: Array<unknown> = []
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason)
      }
      process.on('unhandledRejection', onUnhandledRejection)

      try {
        const onBroadcastError = vi.fn().mockImplementation(() => {
          throw new Error('boom')
        })

        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
          onBroadcastError,
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(0)

        expect(onBroadcastError).toHaveBeenCalledWith(
          cloneError,
          expect.objectContaining<BroadcastErrorEvent>({
            type: 'updated',
            queryHash: expect.any(String) as string,
            queryKey: key,
          }),
        )
        expect(unhandledRejections).toHaveLength(0)
      } finally {
        process.off('unhandledRejection', onUnhandledRejection)
      }
    })

    it('should warn in dev when onBroadcastError itself throws', async () => {
      const key = queryKey()
      process.env['NODE_ENV'] = 'development'
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      const callbackError = new Error('boom')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
          onBroadcastError: () => {
            throw callbackError
          },
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(0)

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('onBroadcastError threw while handling'),
          callbackError,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('should not cause an unhandled rejection when async onBroadcastError rejects', async () => {
      const key = queryKey()
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const unhandledRejections: Array<unknown> = []
      const onUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason)
      }
      process.on('unhandledRejection', onUnhandledRejection)

      try {
        const onBroadcastError = vi
          .fn()
          .mockRejectedValueOnce(new Error('async boom'))

        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
          onBroadcastError,
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(10)

        expect(onBroadcastError).toHaveBeenCalledWith(
          cloneError,
          expect.objectContaining<BroadcastErrorEvent>({
            type: 'updated',
            queryHash: expect.any(String) as string,
            queryKey: key,
          }),
        )
        expect(unhandledRejections).toHaveLength(0)
      } finally {
        process.off('unhandledRejection', onUnhandledRejection)
      }
    })

    it('should warn in dev when async onBroadcastError rejects', async () => {
      const key = queryKey()
      process.env['NODE_ENV'] = 'development'
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      const asyncError = new Error('async boom')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
          onBroadcastError: () => Promise.reject(asyncError),
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(10)

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('onBroadcastError threw while handling'),
          asyncError,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('should call onBroadcastError when postMessage fails', async () => {
      const key = queryKey()
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const onBroadcastError = vi.fn()
      broadcastQueryClient({
        queryClient,
        broadcastChannel: 'test_channel',
        onBroadcastError,
      })

      queryClient.setQueryData(key, { value: 1 })

      await sleep(0)
      expect(onBroadcastError).toHaveBeenCalledWith(
        cloneError,
        expect.objectContaining<BroadcastErrorEvent>({
          type: 'updated',
          queryHash: expect.any(String) as string,
          queryKey: key,
        }),
      )
    })

    it('should warn in dev when postMessage fails and onBroadcastError is not provided', async () => {
      const key = queryKey()
      process.env['NODE_ENV'] = 'development'
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(0)
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('cross-tab sync for this query was skipped'),
          cloneError,
        )
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('should not warn in production when postMessage fails', async () => {
      const key = queryKey()
      process.env['NODE_ENV'] = 'production'
      const cloneError = new DOMException('DataCloneError', 'DataCloneError')
      mockPostMessage.mockRejectedValueOnce(cloneError)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        broadcastQueryClient({
          queryClient,
          broadcastChannel: 'test_channel',
        })

        queryClient.setQueryData(key, { value: 1 })

        await sleep(0)
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })
})
