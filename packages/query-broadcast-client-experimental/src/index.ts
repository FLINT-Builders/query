import { BroadcastChannel } from 'broadcast-channel'
import { hashKey } from '@tanstack/query-core'
import type { BroadcastChannelOptions } from 'broadcast-channel'
import type { QueryClient, QueryKey, QueryState } from '@tanstack/query-core'

/**
 * Metadata describing a broadcast that failed to be delivered to other tabs.
 * Passed to {@link BroadcastQueryClientOptions.onBroadcastError} so callers
 * can correlate failures with the originating query.
 */
export interface BroadcastErrorEvent {
  type: 'updated' | 'removed' | 'added'
  queryHash: string
  queryKey: QueryKey
}

type BroadcastMessage =
  | { type: 'updated'; queryHash: string; queryKey: QueryKey; state: unknown }
  | { type: 'removed'; queryHash: string; queryKey: QueryKey }
  | { type: 'added'; queryHash: string; queryKey: QueryKey; state: unknown }

interface BroadcastQueryClientOptions {
  /** The QueryClient to sync. */
  queryClient: QueryClient
  /**
   * Unique channel name used to communicate between tabs and windows.
   * Choose a name specific to your app: any document on the same origin can
   * post to a channel whose name it knows, and messages on this channel are
   * written into the cache.
   */
  broadcastChannel: string
  /** Options forwarded to the underlying `BroadcastChannel`. */
  options?: BroadcastChannelOptions
  /**
   * Called when a query event fails to broadcast to other tabs — most
   * commonly because the query's `state.data`, `state.error`, or `queryKey`
   * contains a value the structured-clone algorithm cannot serialize
   * (e.g. `ReadableStream`, `File`, functions, Vue `reactive` proxies).
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

type SyncedState = Partial<QueryState>

const queryStatuses: ReadonlyArray<unknown> = ['pending', 'success', 'error']

const numericStateFields = [
  'dataUpdateCount',
  'dataUpdatedAt',
  'errorUpdateCount',
  'errorUpdatedAt',
  'fetchFailureCount',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/**
 * Copies only the fields another tab may sync. `fetchStatus` and `fetchMeta`
 * describe this tab's own in-flight fetch and are never taken from a message.
 * Returns `undefined` when a field has the wrong type.
 */
function toSyncedState(state: unknown): SyncedState | undefined {
  if (!isRecord(state)) {
    return undefined
  }

  const synced: SyncedState = {}

  if ('data' in state) {
    synced.data = state.data
  }
  if ('error' in state) {
    synced.error = state.error as QueryState['error']
  }
  if ('fetchFailureReason' in state) {
    synced.fetchFailureReason =
      state.fetchFailureReason as QueryState['fetchFailureReason']
  }
  for (const field of numericStateFields) {
    if (field in state) {
      const value = state[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined
      }
      synced[field] = value
    }
  }
  if ('isInvalidated' in state) {
    if (typeof state.isInvalidated !== 'boolean') {
      return undefined
    }
    synced.isInvalidated = state.isInvalidated
  }
  if ('status' in state) {
    if (!queryStatuses.includes(state.status)) {
      return undefined
    }
    synced.status = state.status as QueryState['status']
  }

  return synced
}

export function broadcastQueryClient({
  queryClient,
  broadcastChannel,
  options,
  onBroadcastError,
}: BroadcastQueryClientOptions): () => void {
  if (typeof broadcastChannel !== 'string' || broadcastChannel === '') {
    throw new Error(
      '[broadcastQueryClient] A `broadcastChannel` name is required. Choose a name specific to your app.',
    )
  }

  let transaction = false
  const tx = (cb: () => void) => {
    transaction = true
    try {
      cb()
    } finally {
      // Guard against `cb` throwing (e.g. `query.setState`/`queryCache.build`
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

  const safePost = (message: BroadcastMessage): void => {
    channel.postMessage(message).catch((error: unknown) => {
      const event: BroadcastErrorEvent = {
        type: message.type,
        queryHash: message.queryHash,
        queryKey: message.queryKey,
      }

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
          `[broadcastQueryClient] Failed to broadcast "${event.type}" event for query ${event.queryHash}. ` +
            'The query value could not be structured-cloned; cross-tab sync for this query was skipped.',
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
      query: { queryHash, queryKey, state, observers },
    } = queryEvent

    if (queryEvent.type === 'updated' && queryEvent.action.type === 'success') {
      safePost({
        type: 'updated',
        queryHash,
        queryKey,
        state,
      })
    }

    if (queryEvent.type === 'removed' && observers.length > 0) {
      safePost({
        type: 'removed',
        queryHash,
        queryKey,
      })
    }

    if (queryEvent.type === 'added') {
      safePost({
        type: 'added',
        queryHash,
        queryKey,
        state,
      })
    }
  })

  channel.onmessage = (message: unknown) => {
    if (!isRecord(message)) {
      return
    }

    const { type, queryHash, queryKey } = message

    if (
      (type !== 'updated' && type !== 'removed' && type !== 'added') ||
      typeof queryHash !== 'string' ||
      !Array.isArray(queryKey)
    ) {
      return
    }

    const query = queryCache.get(queryHash)

    let expectedHash: string
    try {
      expectedHash = query
        ? (query.options.queryKeyHashFn ?? hashKey)(queryKey)
        : queryClient.defaultQueryOptions({ queryKey }).queryHash
    } catch {
      return
    }
    if (expectedHash !== queryHash) {
      return
    }

    if (type === 'removed') {
      if (query && query.getObserversCount() === 0) {
        tx(() => {
          queryCache.remove(query)
        })
      }
      return
    }

    const state = toSyncedState(message.state)
    if (!state) {
      return
    }

    tx(() => {
      if (query) {
        if (type === 'updated' || query.state.data === undefined) {
          query.setState(state)
        }
        return
      }

      queryCache.build(queryClient, { queryKey, queryHash }).setState(state)
    })
  }
  return () => {
    unsubscribe()
    channel.close()
  }
}
