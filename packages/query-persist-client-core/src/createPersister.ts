import {
  hashKey,
  matchQuery,
  notifyManager,
  partialMatchKey,
} from '@tanstack/query-core'
import type {
  Query,
  QueryClient,
  QueryFilters,
  QueryFunctionContext,
  QueryKey,
  QueryState,
} from '@tanstack/query-core'

export interface PersistedQuery {
  buster: string
  queryHash: string
  queryKey: QueryKey
  state: QueryState
}

export type MaybePromise<T> = T | Promise<T>

export interface AsyncStorage<TStorageValue = string> {
  getItem: (key: string) => MaybePromise<TStorageValue | undefined | null>
  setItem: (key: string, value: TStorageValue) => MaybePromise<unknown>
  removeItem: (key: string) => MaybePromise<void>
  entries?: () => MaybePromise<Array<[key: string, value: TStorageValue]>>
}

export interface StoragePersisterOptions<TStorageValue = string> {
  /** The storage client used for setting and retrieving items from cache.
   * For SSR pass in `undefined`.
   */
  storage: AsyncStorage<TStorageValue> | undefined | null
  /**
   * How to serialize the data to storage.
   * @default `JSON.stringify`
   */
  serialize?: (persistedQuery: PersistedQuery) => MaybePromise<TStorageValue>
  /**
   * How to deserialize the data from storage.
   * @default `JSON.parse`
   */
  deserialize?: (cachedString: TStorageValue) => MaybePromise<PersistedQuery>
  /**
   * A unique string that can be used to forcefully invalidate existing caches,
   * if they do not share the same buster string
   */
  buster?: string
  /**
   * The max-allowed age of the cache in milliseconds.
   * If a persisted cache is found that is older than this
   * time, it will be discarded
   * @default 24 hours
   */
  maxAge?: number
  /**
   * Prefix to be used for storage key.
   * Storage key is a combination of prefix and query hash in a form of `prefix-queryHash`.
   * @default 'tanstack-query'
   */
  prefix?: string
  /**
   * If set to `true`, the query will refetch on successful query restoration if the data is stale.
   * If set to `false`, the query will not refetch on successful query restoration.
   * If set to `'always'`, the query will always refetch on successful query restoration.
   *
   * @defaultValue true
   */
  refetchOnRestore?: boolean | 'always'
  /**
   * Filters to narrow down which Queries should be persisted.
   */
  filters?: QueryFilters
}

export const PERSISTER_KEY_PREFIX = 'tanstack-query'

interface StorageKeyState {
  /** Generation of the most recent save or removal requested for this key. */
  generation: number
  /** Generation of the most recent removal requested for this key. */
  removedAt: number
  /** Number of operations that still need this state to stay tracked. */
  holds: number
  /** Settles once every storage call issued for this key has settled. */
  tail: Promise<void>
  queryKey?: QueryKey
  queryHash?: string
}

const noop = () => {}

/**
 * Warning: experimental feature.
 * This utility function enables fine-grained query persistence.
 * Simple add it as a `persister` parameter to `useQuery` or `defaultOptions` on `queryClient`.
 *
 * ```
 * useQuery({
     queryKey: ['myKey'],
     queryFn: fetcher,
     persister: createPersister({
       storage: localStorage,
     }),
   })
   ```
 */
export function experimental_createQueryPersister<TStorageValue = string>({
  storage,
  buster = '',
  maxAge = 1000 * 60 * 60 * 24,
  serialize = JSON.stringify as Required<
    StoragePersisterOptions<TStorageValue>
  >['serialize'],
  deserialize = JSON.parse as Required<
    StoragePersisterOptions<TStorageValue>
  >['deserialize'],
  prefix = PERSISTER_KEY_PREFIX,
  refetchOnRestore = true,
  filters,
}: StoragePersisterOptions<TStorageValue>) {
  // Storage calls for one key are issued one at a time, in the order they were
  // requested, and each is skipped if a newer save or removal was requested
  // for that key in the meantime. AsyncStorage does not promise that
  // overlapping writes settle in order, so without this an older snapshot can
  // land after a newer save or a removal.
  const keyStates = new Map<string, StorageKeyState>()
  let lastGeneration = 0
  // While a read or scan of storage is running, idle key states are kept so
  // that a save which starts and finishes during it is still visible as newer.
  let activeReads = 0

  function holdKey(storageKey: string) {
    let state = keyStates.get(storageKey)
    if (!state) {
      state = { generation: 0, removedAt: 0, holds: 0, tail: Promise.resolve() }
      keyStates.set(storageKey, state)
    }
    state.holds++
    return state
  }

  function releaseKey(storageKey: string, state: StorageKeyState) {
    state.holds--
    if (
      state.holds === 0 &&
      activeReads === 0 &&
      keyStates.get(storageKey) === state
    ) {
      keyStates.delete(storageKey)
    }
  }

  function runInOrder(
    state: StorageKeyState,
    operation: () => MaybePromise<unknown>,
  ): Promise<void> {
    const run = state.tail.then(operation).then(noop)
    state.tail = run.catch(noop)
    return run
  }

  function startRead() {
    activeReads++
    const since = lastGeneration
    const busy = new Set<string>()
    keyStates.forEach((state, key) => {
      if (state.holds > 0) busy.add(key)
    })
    return {
      since,
      /** Whether no save or removal for the key was pending at, or requested since, the start of the read. */
      isCurrent: (storageKey: string) =>
        !busy.has(storageKey) &&
        (keyStates.get(storageKey)?.generation ?? 0) <= since,
    }
  }

  function endRead() {
    activeReads--
    if (activeReads === 0) {
      keyStates.forEach((state, key) => {
        if (state.holds === 0) keyStates.delete(key)
      })
    }
  }

  /** Removes an entry that was read as unusable, unless the key changed since the read. */
  async function discardEntry(storageKey: string, since: number) {
    const state = holdKey(storageKey)
    try {
      await runInOrder(state, () =>
        state.generation <= since ? storage!.removeItem(storageKey) : undefined,
      )
    } finally {
      releaseKey(storageKey, state)
    }
  }

  async function removeEntry(storageKey: string, generation: number) {
    const state = holdKey(storageKey)
    if (state.generation < generation) {
      state.generation = generation
      state.removedAt = generation
    }
    try {
      await runInOrder(state, () =>
        state.generation === generation
          ? storage!.removeItem(storageKey)
          : undefined,
      )
    } finally {
      releaseKey(storageKey, state)
    }
  }

  function isExpiredOrBusted(persistedQuery: PersistedQuery) {
    if (persistedQuery.state.dataUpdatedAt) {
      const queryAge = Date.now() - persistedQuery.state.dataUpdatedAt
      const expired = queryAge > maxAge
      const busted = persistedQuery.buster !== buster

      if (expired || busted) {
        return true
      }

      return false
    }

    return true
  }

  async function retrieveQuery<T>(
    queryHash: string,
    afterRestoreMacroTask?: (persistedQuery: PersistedQuery) => void,
  ) {
    if (storage != null) {
      const storageKey = `${prefix}-${queryHash}`
      const read = startRead()
      try {
        const storedData = await storage.getItem(storageKey)
        if (storedData != null) {
          let persistedQuery: PersistedQuery
          try {
            persistedQuery = await deserialize(storedData)
          } catch {
            if (read.isCurrent(storageKey)) {
              await discardEntry(storageKey, read.since)
            }
            return
          }

          if (!read.isCurrent(storageKey)) {
            // A save or removal for this key overlapped the read, so the
            // stored value may be one that has since been replaced or removed.
            return
          }

          if (isExpiredOrBusted(persistedQuery)) {
            await discardEntry(storageKey, read.since)
          } else {
            if (afterRestoreMacroTask) {
              // Just after restoring we want to get fresh data from the server if it's stale
              notifyManager.schedule(() =>
                afterRestoreMacroTask(persistedQuery),
              )
            }
            // We must resolve the promise here, as otherwise we will have `loading` state in the app until `queryFn` resolves
            return persistedQuery.state.data as T
          }
        }
      } catch (err) {
        if (process.env.NODE_ENV === 'development') {
          console.error(err)
          console.warn(
            'Encountered an error attempting to restore query cache from persisted location.',
          )
        }
        if (read.isCurrent(storageKey)) {
          await discardEntry(storageKey, read.since)
        }
      } finally {
        endRead()
      }
    }

    return
  }

  async function persistQueryByKey(
    queryKey: QueryKey,
    queryClient: QueryClient,
  ) {
    if (storage != null) {
      const query = queryClient.getQueryCache().find({ queryKey })
      if (query) {
        await persistQuery(query)
      } else {
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            'Could not find query to be persisted. QueryKey:',
            JSON.stringify(queryKey),
          )
        }
      }
    }
  }

  function holdQueryKey(query: Query) {
    const storageKey = `${prefix}-${query.queryHash}`
    const state = holdKey(storageKey)
    state.queryKey = query.queryKey
    state.queryHash = query.queryHash
    return { storageKey, state }
  }

  async function persistQuery(query: Query) {
    if (storage != null) {
      const { storageKey, state } = holdQueryKey(query)
      const generation = ++lastGeneration
      state.generation = generation
      try {
        const value = await serialize({
          state: query.state,
          queryKey: query.queryKey,
          queryHash: query.queryHash,
          buster: buster,
        })
        await runInOrder(state, () =>
          state.generation === generation
            ? storage.setItem(storageKey, value)
            : undefined,
        )
      } finally {
        releaseKey(storageKey, state)
      }
    }
  }

  async function persisterFn<T, TQueryKey extends QueryKey>(
    queryFn: (context: QueryFunctionContext<TQueryKey>) => T | Promise<T>,
    ctx: QueryFunctionContext<TQueryKey>,
    query: Query,
  ) {
    const matchesFilter = filters ? matchQuery(filters, query) : true

    // Try to restore only if we do not have any data in the cache and we have persister defined
    if (matchesFilter && query.state.data === undefined && storage != null) {
      const restoredData = await retrieveQuery(
        query.queryHash,
        (persistedQuery: PersistedQuery) => {
          // Set proper updatedAt, since resolving in the first pass overrides those values
          query.setState({
            dataUpdatedAt: persistedQuery.state.dataUpdatedAt,
            errorUpdatedAt: persistedQuery.state.errorUpdatedAt,
          })

          if (
            refetchOnRestore === 'always' ||
            (refetchOnRestore === true && query.isStale())
          ) {
            query.fetch()
          }
        },
      )

      if (restoredData !== undefined) {
        return Promise.resolve(restoredData as T)
      }
    }

    // If we did not restore, or restoration failed - fetch
    const queryFnResult = await queryFn(ctx)

    if (matchesFilter && storage != null) {
      // The save is requested now, so a removal requested before the timeout
      // fires must still win over it.
      const { storageKey, state } = holdQueryKey(query)
      const requestedAt = lastGeneration
      // Persist if we have storage defined, we use timeout to get proper state to be persisted
      notifyManager.schedule(() => {
        if (state.removedAt <= requestedAt) {
          persistQuery(query)
        }
        releaseKey(storageKey, state)
      })
    }

    return Promise.resolve(queryFnResult)
  }

  async function persisterGc() {
    if (storage?.entries) {
      const storageKeyPrefix = `${prefix}-`
      const read = startRead()
      try {
        const entries = await storage.entries()
        for (const [key, value] of entries) {
          if (key.startsWith(storageKeyPrefix) && read.isCurrent(key)) {
            let persistedQuery: PersistedQuery
            try {
              persistedQuery = await deserialize(value)
            } catch {
              await discardEntry(key, read.since)
              continue
            }
            if (isExpiredOrBusted(persistedQuery)) {
              await discardEntry(key, read.since)
            }
          }
        }
      } finally {
        endRead()
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Garbage collection is not possible without ability to iterate over storage items.',
      )
    }
  }

  async function restoreQueries(
    queryClient: QueryClient,
    filters: Pick<QueryFilters, 'queryKey' | 'exact'> = {},
  ): Promise<void> {
    const { exact, queryKey } = filters

    if (storage?.entries) {
      const storageKeyPrefix = `${prefix}-`
      const read = startRead()
      try {
        const entries = await storage.entries()
        for (const [key, value] of entries) {
          if (key.startsWith(storageKeyPrefix)) {
            let persistedQuery: PersistedQuery
            try {
              persistedQuery = await deserialize(value)
            } catch {
              if (read.isCurrent(key)) {
                await discardEntry(key, read.since)
              }
              continue
            }
            if (!read.isCurrent(key)) {
              continue
            }
            if (isExpiredOrBusted(persistedQuery)) {
              await discardEntry(key, read.since)
              continue
            }

            if (queryKey) {
              if (exact) {
                if (persistedQuery.queryHash !== hashKey(queryKey)) {
                  continue
                }
              } else if (!partialMatchKey(persistedQuery.queryKey, queryKey)) {
                continue
              }
            }

            queryClient.setQueryData(
              persistedQuery.queryKey,
              persistedQuery.state.data,
              {
                updatedAt: persistedQuery.state.dataUpdatedAt,
              },
            )
          }
        }
      } finally {
        endRead()
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Restoration of all stored entries is not possible without ability to iterate over storage items.',
      )
    }
  }

  async function removeQueries(
    filters: Pick<QueryFilters, 'queryKey' | 'exact'> = {},
  ): Promise<void> {
    const { exact, queryKey } = filters

    if (storage?.entries) {
      const generation = ++lastGeneration
      const storageKeyPrefix = `${prefix}-`
      const matches = (persisted: { queryKey: QueryKey; queryHash: string }) =>
        !queryKey ||
        (exact
          ? persisted.queryHash === hashKey(queryKey)
          : partialMatchKey(persisted.queryKey, queryKey))
      const removals = new Map<string, Promise<void>>()
      const remove = (key: string) => {
        if (!removals.has(key)) {
          const removal = removeEntry(key, generation)
          removal.catch(noop)
          removals.set(key, removal)
        }
      }

      activeReads++
      try {
        // Keys with a save in progress may not be in storage yet; the removal
        // has to be ordered after those saves.
        keyStates.forEach((state, key) => {
          if (
            !queryKey ||
            (state.queryKey !== undefined &&
              state.queryHash !== undefined &&
              matches({ queryKey: state.queryKey, queryHash: state.queryHash }))
          ) {
            remove(key)
          }
        })

        const entries = await storage.entries()
        for (const [key, value] of entries) {
          if (!key.startsWith(storageKeyPrefix) || removals.has(key)) {
            continue
          }

          if (queryKey) {
            let persistedQuery: PersistedQuery
            try {
              persistedQuery = await deserialize(value)
            } catch {
              remove(key)
              continue
            }

            if (!matches(persistedQuery)) {
              continue
            }
          }

          remove(key)
        }

        await Promise.all(removals.values())
      } finally {
        endRead()
      }
    } else if (process.env.NODE_ENV === 'development') {
      throw new Error(
        'Provided storage does not implement `entries` method. Removal of stored entries is not possible without ability to iterate over storage items.',
      )
    }
  }

  return {
    persisterFn,
    persistQuery,
    persistQueryByKey,
    retrieveQuery,
    persisterGc,
    restoreQueries,
    removeQueries,
  }
}
