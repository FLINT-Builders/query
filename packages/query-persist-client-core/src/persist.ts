import { dehydrate, hydrate } from '@tanstack/query-core'
import { trackWrite, watchWrites } from './writes'
import type {
  DehydrateOptions,
  DehydratedState,
  HydrateOptions,
  NotifyEventType,
  QueryClient,
} from '@tanstack/query-core'

export type Promisable<T> = T | PromiseLike<T>

export interface Persister {
  persistClient: (persistClient: PersistedClient) => Promisable<void>
  restoreClient: () => Promisable<PersistedClient | undefined>
  removeClient: () => Promisable<void>
}

export interface PersistedClient {
  timestamp: number
  buster: string
  clientState: DehydratedState
}

export interface PersistQueryClientRootOptions {
  /** The QueryClient to persist */
  queryClient: QueryClient
  /** The Persister interface for storing and restoring the cache
   * to/from a persisted location */
  persister: Persister
  /** A unique string that can be used to forcefully
   * invalidate existing caches if they do not share the same buster string */
  buster?: string
}

export interface PersistedQueryClientRestoreOptions extends PersistQueryClientRootOptions {
  /** The max-allowed age of the cache in milliseconds.
   * If a persisted cache is found that is older than this
   * time, it will be discarded */
  maxAge?: number
  /** The options passed to the hydrate function */
  hydrateOptions?: HydrateOptions
}

export interface PersistedQueryClientSaveOptions extends PersistQueryClientRootOptions {
  /** The options passed to the dehydrate function */
  dehydrateOptions?: DehydrateOptions
}

export interface PersistQueryClientOptions
  extends
    PersistedQueryClientRestoreOptions,
    PersistedQueryClientSaveOptions,
    PersistQueryClientRootOptions {}

/**
 * Checks if emitted event is about cache change and not about observers.
 * Useful for persist, where we only want to trigger save when cache is changed.
 */
const cacheEventTypes: Array<NotifyEventType> = ['added', 'removed', 'updated']

function isCacheEventType(eventType: NotifyEventType) {
  return cacheEventTypes.includes(eventType)
}

interface RestoreToken {}

/**
 * The restore that currently owns each QueryClient. Starting a new restore
 * supersedes any earlier one that is still waiting on storage, so a snapshot
 * read for a previous buster can never be hydrated or discarded later.
 */
const activeRestores = new WeakMap<QueryClient, RestoreToken>()

const MAX_DISCARD_ATTEMPTS = 3

function isSameSnapshot(a: PersistedClient, b: PersistedClient) {
  return a.timestamp === b.timestamp && a.buster === b.buster
}

async function restoreWithToken(
  {
    queryClient,
    persister,
    maxAge = 1000 * 60 * 60 * 24,
    buster = '',
    hydrateOptions,
  }: PersistedQueryClientRestoreOptions,
  token: RestoreToken,
) {
  const isCurrent = () => activeRestores.get(queryClient) === token

  try {
    let persistedClient = await persister.restoreClient()

    for (
      let attempt = 0;
      persistedClient && attempt < MAX_DISCARD_ATTEMPTS;
      attempt++
    ) {
      if (!isCurrent()) return

      if (persistedClient.timestamp) {
        const expired = Date.now() - persistedClient.timestamp > maxAge
        const busted = persistedClient.buster !== buster
        if (!expired && !busted) {
          hydrate(queryClient, persistedClient.clientState, hydrateOptions)
          return
        }
      }

      // The snapshot may have been replaced while it was being read, so only
      // discard storage that still holds the snapshot that was rejected.
      const rejected = persistedClient
      const isUnwritten = watchWrites(persister)
      persistedClient = await persister.restoreClient()
      if (!isCurrent()) return
      if (
        persistedClient &&
        isUnwritten() &&
        isSameSnapshot(persistedClient, rejected)
      ) {
        return persister.removeClient()
      }
    }
  } catch (err) {
    if (!isCurrent()) throw err

    if (process.env.NODE_ENV !== 'production') {
      console.error(err)
      console.warn(
        'Encountered an error attempting to restore client cache from persisted location. As a precaution, the persisted cache will be discarded.',
      )
    }

    await persister.removeClient()

    throw err
  }
}

function startRestore(options: PersistedQueryClientRestoreOptions) {
  const token: RestoreToken = {}
  activeRestores.set(options.queryClient, token)
  return {
    promise: restoreWithToken(options, token),
    cancel: () => {
      if (activeRestores.get(options.queryClient) === token) {
        activeRestores.delete(options.queryClient)
      }
    },
  }
}

/**
 * Restores persisted data to the QueryCache
 *  - data obtained from persister.restoreClient
 *  - data is hydrated using hydrateOptions
 * If data is expired, busted, empty, or throws, it runs persister.removeClient
 * A later restore for the same QueryClient supersedes this one: once
 * superseded, it neither hydrates nor removes the persisted client.
 */
export async function persistQueryClientRestore(
  options: PersistedQueryClientRestoreOptions,
) {
  return startRestore(options).promise
}

/**
 * Persists data from the QueryCache
 *  - data dehydrated using dehydrateOptions
 *  - data is persisted using persister.persistClient
 */
export async function persistQueryClientSave({
  queryClient,
  persister,
  buster = '',
  dehydrateOptions,
}: PersistedQueryClientSaveOptions) {
  const persistClient: PersistedClient = {
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(queryClient, dehydrateOptions),
  }

  const settleWrite = trackWrite(persister)
  try {
    await persister.persistClient(persistClient)
  } finally {
    settleWrite()
  }
}

/**
 * Subscribe to QueryCache and MutationCache updates (for persisting)
 * @returns an unsubscribe function (to discontinue monitoring)
 */
export function persistQueryClientSubscribe(
  props: PersistedQueryClientSaveOptions,
) {
  const unsubscribeQueryCache = props.queryClient
    .getQueryCache()
    .subscribe((event) => {
      if (isCacheEventType(event.type)) {
        persistQueryClientSave(props)
      }
    })

  const unsubscribeMutationCache = props.queryClient
    .getMutationCache()
    .subscribe((event) => {
      if (isCacheEventType(event.type)) {
        persistQueryClientSave(props)
      }
    })

  return () => {
    unsubscribeQueryCache()
    unsubscribeMutationCache()
  }
}

/**
 * Restores persisted data to QueryCache and persists further changes.
 */
export function persistQueryClient(
  props: PersistQueryClientOptions,
): [() => void, Promise<void>] {
  let hasUnsubscribed = false
  let persistQueryClientUnsubscribe: (() => void) | undefined
  const restore = startRestore(props)
  const unsubscribe = () => {
    hasUnsubscribed = true
    restore.cancel()
    persistQueryClientUnsubscribe?.()
  }

  // Attempt restore
  const restorePromise = restore.promise.then(() => {
    if (!hasUnsubscribed) {
      // Subscribe to changes in the query cache to trigger the save
      persistQueryClientUnsubscribe = persistQueryClientSubscribe(props)
    }
  })

  return [unsubscribe, restorePromise]
}
