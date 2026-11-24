import { BroadcastChannel } from 'broadcast-channel'
import type { BroadcastChannelOptions } from 'broadcast-channel'
import type { QueryClient, QueryKey } from '@tanstack/query-core'

/**
 * Metadata describing a broadcast that failed to be delivered to other tabs.
 * Passed to {@link BroadcastQueryClientOptions.onBroadcastError} so callers
 * can correlate failures with the originating query.
 */
export interface BroadcastErrorEvent {
  type: 'updated' | 'removed'
  queryHash: string
  queryKey: QueryKey
}

/**
 * Any page on the same origin can join the channel (or read the
 * localStorage fallback), so messages must never carry query data, errors,
 * failure reasons, or keys. They only name a query by a one-way digest of its
 * hash; receiving tabs refetch through their own `queryFn`.
 */
interface BroadcastMessage {
  type: BroadcastErrorEvent['type']
  digest: string
}

function digestQueryHash(queryHash: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < queryHash.length; i++) {
    const code = queryHash.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  )
}

function isBroadcastMessage(value: unknown): value is BroadcastMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { type, digest } = value as Record<string, unknown>
  return (
    (type === 'updated' || type === 'removed') && typeof digest === 'string'
  )
}

interface BroadcastQueryClientOptions {
  /** The QueryClient to sync. */
  queryClient: QueryClient
  /**
   * Unique channel name used to communicate between tabs and windows.
   * @default 'tanstack-query'
   */
  broadcastChannel?: string
  /** Options forwarded to the underlying `BroadcastChannel`. */
  options?: BroadcastChannelOptions
  /**
   * Called when a query event fails to broadcast to other tabs, for example
   * because the underlying channel was closed.
   *
   * Provide this to route failures to an error tracker. If omitted, a
   * `console.warn` is emitted in development so failures are never silent.
   *
   * May return a `Promise`; any rejection is caught internally so it cannot
   * cause a secondary unhandled rejection.
   */
  onBroadcastError?: (
    error: unknown,
    event: BroadcastErrorEvent,
  ) => void | Promise<void>
}

export function broadcastQueryClient({
  queryClient,
  broadcastChannel = 'tanstack-query',
  options,
  onBroadcastError,
}: BroadcastQueryClientOptions): () => void {
  let transaction = false
  const tx = (cb: () => void) => {
    transaction = true
    try {
      cb()
    } finally {
      // Guard against `cb` throwing (e.g. `queryCache.remove`/`invalidateQueries`
      // triggering a listener that throws while applying an incoming
      // cross-tab message). Without this, `transaction` would stay `true`
      // forever, silently disabling this tab's own broadcasts to other tabs
      // for the rest of the session.
      transaction = false
    }
  }

  const channel = new BroadcastChannel(broadcastChannel, {
    webWorkerSupport: false,
    ...options,
  })

  const queryCache = queryClient.getQueryCache()

  // Hashes of queries refetching because another tab announced an update.
  // Their success must not be announced back, or two tabs would refetch each
  // other forever.
  const remoteRefetches = new Set<string>()

  const safePost = (event: BroadcastErrorEvent): void => {
    const message: BroadcastMessage = {
      type: event.type,
      digest: digestQueryHash(event.queryHash),
    }
    channel.postMessage(message).catch((error: unknown) => {
      if (onBroadcastError) {
        const warnCallbackError = (callbackError: unknown) => {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `[broadcastQueryClient] onBroadcastError threw while handling "${event.type}" for query ${event.queryHash}.`,
              callbackError,
            )
          }
        }
        let result: void | Promise<void>
        try {
          result = onBroadcastError(error, event)
        } catch (callbackError) {
          warnCallbackError(callbackError)
          return
        }
        result?.catch(warnCallbackError)
      } else if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[broadcastQueryClient] Failed to broadcast "${event.type}" event for query ${event.queryHash}; ` +
            'cross-tab sync for this query was skipped.',
          error,
        )
      }
    })
  }

  const unsubscribe = queryCache.subscribe((queryEvent) => {
    if (transaction) {
      return
    }

    const {
      query: { queryHash, queryKey, observers },
    } = queryEvent

    if (queryEvent.type === 'updated' && queryEvent.action.type === 'success') {
      if (!queryEvent.action.manual && remoteRefetches.has(queryHash)) {
        return
      }
      safePost({
        type: 'updated',
        queryHash,
        queryKey,
      })
    }

    if (queryEvent.type === 'removed' && observers.length > 0) {
      safePost({
        type: 'removed',
        queryHash,
        queryKey,
      })
    }
  })

  channel.onmessage = (message: unknown) => {
    if (!isBroadcastMessage(message)) {
      return
    }

    const matches = queryCache
      .getAll()
      .filter((query) => digestQueryHash(query.queryHash) === message.digest)

    if (matches.length === 0) {
      return
    }

    tx(() => {
      if (message.type === 'removed') {
        matches.forEach((query) => {
          queryCache.remove(query)
        })
        return
      }

      const hashes = matches
        .map((query) => query.queryHash)
        .filter((queryHash) => !remoteRefetches.has(queryHash))
      hashes.forEach((queryHash) => remoteRefetches.add(queryHash))
      const release = () => {
        hashes.forEach((queryHash) => remoteRefetches.delete(queryHash))
      }

      try {
        queryClient
          .invalidateQueries({ predicate: (query) => matches.includes(query) })
          .then(release, release)
      } catch (error) {
        release()
        throw error
      }
    })
  }
  return () => {
    unsubscribe()
    channel.close()
  }
}
