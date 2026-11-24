import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { QueryClient } from '../queryClient'
import {
  defaultShouldDehydrateQuery,
  dehydrate,
  dehydrateQuery,
} from '../hydration'
import { noop } from '../utils'
import { setIsServer } from './utils'
import type { DehydrateOptions, DehydratedState } from '../hydration'
import type { Query } from '../query'

/**
 * Placeholder for an enumerable field on a thrown value. The tests assert this
 * text never survives into a redacted dehydrated snapshot.
 */
const MARKER = 'PLACEHOLDER_ERROR_DETAIL'

type ThrownBody = {
  body: { detail: string }
}

function plainFailure(): ThrownBody {
  return { body: { detail: MARKER } }
}

function errorFailure(): Error & ThrownBody {
  return Object.assign(new Error('upstream request failed'), {
    body: { detail: MARKER },
  })
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === 'function') {
      return undefined
    }
    return inner
  })
}

function queryByKey(state: DehydratedState, key: ReadonlyArray<unknown>) {
  const match = state.queries.find((query) => query.queryKey[0] === key[0])
  if (!match) {
    throw new Error(`missing dehydrated query ${String(key[0])}`)
  }
  return match
}

function expectRedacted(value: unknown) {
  expect(value).toBeInstanceOf(Error)
  expect(value).toMatchObject({ message: 'redacted' })
  expect(value).not.toHaveProperty('body')
  expect(serialized(value)).not.toContain(MARKER)
}

function streamingFilter(query: Query): boolean {
  return defaultShouldDehydrateQuery(query) || query.state.status === 'pending'
}

describe('dehydrated query errors are redacted with the query state', () => {
  let restoreIsServer: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    restoreIsServer = setIsServer(true)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    restoreIsServer?.()
    vi.useRealTimers()
  })

  async function startRetryingQuery(
    queryClient: QueryClient,
    queryFn: () => Promise<unknown>,
    extra?: { initialData?: string },
  ) {
    const key = queryKey()
    const promise = queryClient
      .query({
        queryKey: key,
        retry: 1,
        retryDelay: 60_000,
        queryFn,
        ...extra,
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(0)
    const query = queryClient.getQueryCache().find({ queryKey: key })!
    return { key, promise, query }
  }

  it('redacts enumerable failure fields on a pending query while retries continue', async () => {
    const plain = plainFailure()
    const asError = errorFailure()
    const queryClient = new QueryClient()
    const plainKey = queryKey()
    const errorKey = queryKey()
    const untouchedKey = queryKey()

    const plainPromise = queryClient
      .query({
        queryKey: plainKey,
        retry: 1,
        retryDelay: 60_000,
        queryFn: () => Promise.reject(plain),
      })
      .catch(noop)
    const errorPromise = queryClient
      .query({
        queryKey: errorKey,
        retry: 1,
        retryDelay: 60_000,
        queryFn: () => Promise.reject(asError),
      })
      .catch(noop)
    const untouchedPromise = queryClient
      .query({
        queryKey: untouchedKey,
        retry: false,
        queryFn: () => sleep(120_000).then(() => 'later'),
      })
      .catch(noop)

    await vi.advanceTimersByTimeAsync(0)

    const plainQuery = queryClient.getQueryCache().find({ queryKey: plainKey })!
    const errorQuery = queryClient.getQueryCache().find({ queryKey: errorKey })!
    expect(plainQuery.state.status).toBe('pending')
    expect(plainQuery.state.error).toBeNull()
    expect(plainQuery.state.fetchFailureReason).toBe(plain)
    expect(errorQuery.state.fetchFailureReason).toBe(asError)

    const dehydrated = dehydrate(queryClient, {
      shouldDehydrateQuery: streamingFilter,
    })

    expect(plainQuery.state.fetchFailureReason).toBe(plain)
    expect(errorQuery.state.fetchFailureReason).toBe(asError)

    const plainSnapshot = queryByKey(dehydrated, plainKey)
    const errorSnapshot = queryByKey(dehydrated, errorKey)
    const untouchedSnapshot = queryByKey(dehydrated, untouchedKey)

    expect(plainSnapshot.state.status).toBe('pending')
    expect(plainSnapshot.state.error).toBeNull()
    expectRedacted(plainSnapshot.state.fetchFailureReason)
    expect(errorSnapshot.state.error).toBeNull()
    expectRedacted(errorSnapshot.state.fetchFailureReason)
    expect(untouchedSnapshot.state.error).toBeNull()
    expect(untouchedSnapshot.state.fetchFailureReason).toBeNull()
    expect(serialized(dehydrated.queries)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(plainSnapshot.promise).rejects.toThrow('redacted')
    await expect(errorSnapshot.promise).rejects.toThrow('redacted')
    await plainPromise
    await errorPromise
    await queryClient.cancelQueries({ queryKey: untouchedKey })
    await untouchedPromise
    queryClient.clear()
  })

  it('redacts a synchronous throw the same way as a rejected promise', async () => {
    const thrown = plainFailure()
    const queryClient = new QueryClient()
    const { key, promise, query } = await startRetryingQuery(
      queryClient,
      () => {
        throw thrown
      },
    )

    expect(query.state.status).toBe('pending')
    expect(query.state.fetchFailureReason).toBe(thrown)

    const dehydrated = dehydrate(queryClient, {
      shouldDehydrateQuery: streamingFilter,
    })

    expect(query.state.fetchFailureReason).toBe(thrown)
    const snapshot = queryByKey(dehydrated, key)
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(serialized(snapshot)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(snapshot.promise).rejects.toThrow('redacted')
    await promise
    queryClient.clear()
  })

  it('uses client default redaction options for a pending query', async () => {
    const thrown = plainFailure()
    const queryClient = new QueryClient({
      defaultOptions: {
        dehydrate: {
          shouldDehydrateQuery: streamingFilter,
          shouldRedactErrors: () => true,
        },
      },
    })
    const { key, promise, query } = await startRetryingQuery(queryClient, () =>
      Promise.reject(thrown),
    )

    const dehydrated = dehydrate(queryClient)

    expect(query.state.fetchFailureReason).toBe(thrown)
    const snapshot = queryByKey(dehydrated, key)
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(serialized(snapshot.state)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await promise
    queryClient.clear()
  })

  it('redacts state when dehydrateQuery is called directly', async () => {
    const thrown = errorFailure()
    const queryClient = new QueryClient()
    const { promise, query } = await startRetryingQuery(queryClient, () =>
      Promise.reject(thrown),
    )

    const dehydrated = dehydrateQuery(query, undefined, () => true)

    expect(query.state.fetchFailureReason).toBe(thrown)
    expect(query.state.error).toBeNull()
    expectRedacted(dehydrated.state.fetchFailureReason)
    expect(dehydrated.state.error).toBeNull()
    expect(serialized(dehydrated.state)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(dehydrated.promise).rejects.toThrow('redacted')
    await promise
    queryClient.clear()
  })

  it('redacts error and fetchFailureReason after a failed query settles', async () => {
    const thrown = plainFailure()
    const shouldRedactErrors = vi.fn(() => true)
    const queryClient = new QueryClient()
    const key = queryKey()
    const promise = queryClient
      .query({
        queryKey: key,
        retry: false,
        queryFn: () => Promise.reject(thrown),
      })
      .catch(noop)

    await vi.advanceTimersByTimeAsync(0)
    await promise

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.state.status).toBe('error')
    expect(query.state.error).toBe(thrown)
    expect(query.state.fetchFailureReason).toBe(thrown)
    expect(query.promise).toBeUndefined()

    const dehydrated = dehydrate(queryClient, {
      shouldDehydrateQuery: () => true,
      shouldRedactErrors,
    })

    expect(query.state.error).toBe(thrown)
    expect(query.state.fetchFailureReason).toBe(thrown)
    expect(shouldRedactErrors).toHaveBeenCalledWith(thrown)

    const snapshot = queryByKey(dehydrated, key)
    expect(snapshot.promise).toBeUndefined()
    expect(snapshot.state.status).toBe('error')
    expectRedacted(snapshot.state.error)
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(serialized(snapshot)).not.toContain(MARKER)

    queryClient.clear()
  })

  it('redacts fetchFailureReason on a successful query included by the default filter', async () => {
    const thrown = errorFailure()
    const queryClient = new QueryClient()
    const key = queryKey()
    const promise = queryClient
      .query({
        queryKey: key,
        initialData: 'public',
        retry: 1,
        retryDelay: 60_000,
        queryFn: () => Promise.reject(thrown),
      })
      .catch(noop)

    await vi.advanceTimersByTimeAsync(0)

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.state.status).toBe('success')
    expect(query.state.data).toBe('public')
    expect(query.state.error).toBeNull()
    expect(query.state.fetchFailureReason).toBe(thrown)
    expect(defaultShouldDehydrateQuery(query)).toBe(true)

    const dehydrated = dehydrate(queryClient)

    expect(query.state.fetchFailureReason).toBe(thrown)
    expect(dehydrated.queries).toHaveLength(1)
    const snapshot = queryByKey(dehydrated, key)
    expect(snapshot.state.status).toBe('success')
    expect(snapshot.state.data).toBe('public')
    expect(snapshot.state.error).toBeNull()
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(serialized(snapshot)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await promise
    queryClient.clear()
  })

  it('redacts a pending infinite query through the same snapshot', async () => {
    const thrown = plainFailure()
    const queryClient = new QueryClient()
    const key = queryKey()
    const promise = queryClient
      .infiniteQuery({
        queryKey: key,
        initialPageParam: 0,
        retry: 1,
        retryDelay: 60_000,
        queryFn: () => Promise.reject(thrown),
      })
      .catch(noop)

    await vi.advanceTimersByTimeAsync(0)

    const query = queryClient.getQueryCache().find({ queryKey: key })!
    expect(query.queryType).toBe('infinite')
    expect(query.state.status).toBe('pending')
    expect(query.state.fetchFailureReason).toBe(thrown)

    const dehydrated = dehydrate(queryClient, {
      shouldDehydrateQuery: streamingFilter,
    })

    expect(query.state.fetchFailureReason).toBe(thrown)
    const snapshot = queryByKey(dehydrated, key)
    expect(snapshot.queryType).toBe('infinite')
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(snapshot.state.error).toBeNull()
    expect(serialized(snapshot)).not.toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await promise
    queryClient.clear()
  })

  it('keeps the thrown value when the redaction predicate returns false', async () => {
    const pendingThrown = plainFailure()
    const settledThrown = errorFailure()
    const queryClient = new QueryClient({
      defaultOptions: {
        dehydrate: {
          shouldDehydrateQuery: () => true,
          shouldRedactErrors: () => true,
        },
      },
    })
    const pendingKey = queryKey()
    const settledKey = queryKey()

    const pendingPromise = queryClient
      .query({
        queryKey: pendingKey,
        retry: 1,
        retryDelay: 60_000,
        queryFn: () => Promise.reject(pendingThrown),
      })
      .catch(noop)
    const settledPromise = queryClient
      .query({
        queryKey: settledKey,
        retry: false,
        queryFn: () => Promise.reject(settledThrown),
      })
      .catch(noop)

    await vi.advanceTimersByTimeAsync(0)
    await settledPromise

    const pendingQuery = queryClient
      .getQueryCache()
      .find({ queryKey: pendingKey })!
    expect(pendingQuery.state.fetchFailureReason).toBe(pendingThrown)

    const dehydrated = dehydrate(queryClient, {
      shouldRedactErrors: () => false,
    })

    const pendingSnapshot = queryByKey(dehydrated, pendingKey)
    const settledSnapshot = queryByKey(dehydrated, settledKey)
    expect(pendingSnapshot.state.fetchFailureReason).toBe(pendingThrown)
    expect(settledSnapshot.state.error).toBe(settledThrown)
    expect(settledSnapshot.state.fetchFailureReason).toBe(settledThrown)
    expect(serialized(dehydrated.queries)).toContain(MARKER)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(pendingSnapshot.promise).rejects.toBe(pendingThrown)
    await pendingPromise
    queryClient.clear()
  })

  it('keeps a thrown value when only the client default predicate returns false', async () => {
    const thrown = plainFailure()
    const queryClient = new QueryClient({
      defaultOptions: {
        dehydrate: {
          shouldDehydrateQuery: () => true,
          shouldRedactErrors: () => false,
        },
      },
    })
    const key = queryKey()
    const promise = queryClient
      .query({
        queryKey: key,
        retry: false,
        queryFn: () => Promise.reject(thrown),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    const dehydrated = dehydrate(queryClient)
    const snapshot = queryByKey(dehydrated, key)
    expect(snapshot.state.error).toBe(thrown)
    expect(snapshot.state.fetchFailureReason).toBe(thrown)
    expect(serialized(snapshot.state)).toContain(MARKER)

    queryClient.clear()
  })

  it('applies a per-call predicate that redacts one settled error and keeps another', async () => {
    const hidden = { ...plainFailure(), expose: false }
    const exposed = { ...plainFailure(), expose: true }
    const shouldRedactErrors = (error: unknown) =>
      !(
        typeof error === 'object' &&
        error !== null &&
        'expose' in error &&
        error.expose === true
      )
    const queryClient = new QueryClient()
    const hiddenKey = queryKey()
    const exposedKey = queryKey()

    const hiddenPromise = queryClient
      .query({
        queryKey: hiddenKey,
        retry: false,
        queryFn: () => Promise.reject(hidden),
      })
      .catch(noop)
    const exposedPromise = queryClient
      .query({
        queryKey: exposedKey,
        retry: false,
        queryFn: () => Promise.reject(exposed),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(0)
    await hiddenPromise
    await exposedPromise

    const options: DehydrateOptions = {
      shouldDehydrateQuery: () => true,
      shouldRedactErrors,
    }
    const dehydrated = dehydrate(queryClient, options)
    const hiddenSnapshot = queryByKey(dehydrated, hiddenKey)
    const exposedSnapshot = queryByKey(dehydrated, exposedKey)

    expectRedacted(hiddenSnapshot.state.error)
    expectRedacted(hiddenSnapshot.state.fetchFailureReason)
    expect(exposedSnapshot.state.error).toBe(exposed)
    expect(exposedSnapshot.state.fetchFailureReason).toBe(exposed)
    expect(serialized(hiddenSnapshot)).not.toContain(MARKER)
    expect(serialized(exposedSnapshot.state.error)).toContain(MARKER)

    queryClient.clear()
  })

  it('lets a per-call predicate redact when the client default would keep the error', async () => {
    const thrown = plainFailure()
    const queryClient = new QueryClient({
      defaultOptions: {
        dehydrate: {
          shouldDehydrateQuery: () => true,
          shouldRedactErrors: () => false,
        },
      },
    })
    const key = queryKey()
    const promise = queryClient
      .query({
        queryKey: key,
        retry: false,
        queryFn: () => Promise.reject(thrown),
      })
      .catch(noop)
    await vi.advanceTimersByTimeAsync(0)
    await promise

    const dehydrated = dehydrate(queryClient, {
      shouldRedactErrors: () => true,
    })
    const snapshot = queryByKey(dehydrated, key)
    expectRedacted(snapshot.state.error)
    expectRedacted(snapshot.state.fetchFailureReason)
    expect(serialized(snapshot)).not.toContain(MARKER)

    queryClient.clear()
  })
})
