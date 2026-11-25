import { QueryClient, dehydrate } from '@tanstack/query-core'

/**
 * Strings an attacker would plant in the origin's query-cache storage.
 * They are placeholders, not credentials.
 */
export const FORGED_PROFILE = 'forged-profile'
export const FORGED_SESSION = 'forged-session'
export const FORGED_MUTATION = 'forged-mutation-result'

/** Default key used by createAsyncStoragePersister / createSyncStoragePersister. */
export const PERSIST_STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'

export interface MemoryStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function createMemoryStorage(): MemoryStorage {
  const items = new Map<string, string>()
  return {
    getItem: (key) => (items.has(key) ? (items.get(key) ?? null) : null),
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/**
 * Writes one persisted client: fresh timestamp, forged queries (and a paused
 * mutation) produced by dehydrate, then a following query object with no
 * `state`. JSON omits that field, which is what storage would hold.
 */
export function plantPoisonedQueryCache(storage: MemoryStorage): void {
  const attackerClient = new QueryClient()
  attackerClient.setQueryData(['profile'], FORGED_PROFILE)
  attackerClient.setQueryData(['session'], FORGED_SESSION)
  const dehydrated = dehydrate(attackerClient)
  const fresh = Date.now() + 60_000
  for (const query of dehydrated.queries) {
    query.state.dataUpdatedAt = fresh
    query.dehydratedAt = fresh
  }

  storage.setItem(
    PERSIST_STORAGE_KEY,
    JSON.stringify({
      timestamp: Date.now(),
      buster: '',
      clientState: {
        mutations: [
          {
            mutationKey: ['forged-mutation'],
            state: {
              context: undefined,
              data: FORGED_MUTATION,
              error: null,
              failureCount: 0,
              failureReason: null,
              isPaused: true,
              status: 'pending',
              variables: 'forged-variables',
              submittedAt: Date.now(),
            },
          },
        ],
        queries: [
          ...dehydrated.queries,
          {
            queryHash: JSON.stringify(['broken']),
            queryKey: ['broken'],
            dehydratedAt: Date.now(),
          },
        ],
      },
    }),
  )
  attackerClient.clear()
}

export function forgedValuesStillCached(
  queryClient: QueryClient,
): Array<string> {
  const found: Array<string> = []
  for (const query of queryClient.getQueryCache().getAll()) {
    if (
      query.state.data === FORGED_PROFILE ||
      query.state.data === FORGED_SESSION
    ) {
      found.push(String(query.state.data))
    }
  }
  for (const mutation of queryClient.getMutationCache().getAll()) {
    if (mutation.state.data === FORGED_MUTATION) {
      found.push(FORGED_MUTATION)
    }
  }
  return found
}
