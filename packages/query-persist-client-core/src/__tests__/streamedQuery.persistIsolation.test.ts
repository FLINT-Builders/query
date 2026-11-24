import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import {
  QueryClient,
  QueryObserver,
  experimental_streamedQuery,
} from '@tanstack/query-core'
import { persistQueryClientSubscribe } from '../persist'
import type { PersistedClient, Persister } from '../persist'

function createPushStream<T>() {
  type Item = { done: false; value: T } | { done: true }
  const queue: Array<Item> = []
  let pending: ((item: Item) => void) | undefined
  let closed = false

  function deliver(item: Item) {
    if (closed) {
      return
    }
    if (pending) {
      const resolve = pending
      pending = undefined
      resolve(item)
      return
    }
    queue.push(item)
  }

  async function* values(): AsyncGenerator<T> {
    try {
      let stopped = false
      while (!stopped) {
        const queued = queue.shift()
        const item =
          queued ??
          (await new Promise<Item>((resolve) => {
            pending = resolve
          }))
        if (item.done) {
          stopped = true
        } else {
          yield item.value
        }
      }
    } finally {
      closed = true
      pending = undefined
    }
  }

  return {
    values,
    push(value: T) {
      deliver({ done: false, value })
    },
    get closed() {
      return closed
    },
  }
}

function recordingPersister() {
  const saved: Array<PersistedClient> = []
  const persister: Persister = {
    persistClient(client) {
      saved.push(client)
    },
    restoreClient() {
      return saved[saved.length - 1]
    },
    removeClient() {
      saved.length = 0
    },
  }
  return { persister, saved }
}

function persistedDataFor(
  client: PersistedClient | undefined,
  key: Array<string>,
) {
  return client?.clientState.queries.find(
    (query) => JSON.stringify(query.queryKey) === JSON.stringify(key),
  )?.state.data
}

describe('streamedQuery persistence after the cache is cleared', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
    queryClient.mount()
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  it('does not persist chunks that arrive after clear()', async () => {
    const key = queryKey()
    const stream = createPushStream<string>()
    const { persister, saved } = recordingPersister()
    const unsubscribePersist = persistQueryClientSubscribe({
      queryClient,
      persister,
    })

    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      queryFn: experimental_streamedQuery({
        streamFn: () => stream.values(),
      }),
    })
    const unsubscribe = observer.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    stream.push('from-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    queryClient.clear()
    expect(queryClient.getQueryData(key)).toBeUndefined()

    const savedAfterClear = saved.length
    stream.push('from-a-after-clear')
    await vi.advanceTimersByTimeAsync(0)

    const laterData = saved
      .slice(savedAfterClear)
      .map((client) => persistedDataFor(client, key))
    expect(laterData).toEqual(
      laterData.filter(
        (data) => !Array.isArray(data) || !data.includes('from-a-after-clear'),
      ),
    )
    expect(persistedDataFor(saved[saved.length - 1], key)).toEqual(
      queryClient.getQueryData(key),
    )
    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(stream.closed).toBe(true)

    unsubscribePersist()
  })

  it('does not persist the previous stream into the next session entry', async () => {
    const key = queryKey()
    const first = createPushStream<string>()
    const second = createPushStream<string>()
    const streams = [first, second]
    const { persister, saved } = recordingPersister()
    const unsubscribePersist = persistQueryClientSubscribe({
      queryClient,
      persister,
    })

    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      queryFn: experimental_streamedQuery({
        streamFn: () => streams.shift()!.values(),
      }),
    })
    const unsubscribe = observer.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    first.push('from-a')
    await vi.advanceTimersByTimeAsync(0)

    unsubscribe()
    queryClient.clear()

    const next = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      queryFn: experimental_streamedQuery({
        streamFn: () => streams.shift()!.values(),
      }),
    })
    const unsubscribeNext = next.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    second.push('from-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(queryClient.getQueryData(key)).toEqual(['from-b'])

    const savedAfterNext = saved.length
    first.push('from-a-after-logout')
    await vi.advanceTimersByTimeAsync(0)

    const laterData = saved
      .slice(savedAfterNext)
      .map((client) => persistedDataFor(client, key))
    expect(laterData).toEqual(
      laterData.filter(
        (data) => !Array.isArray(data) || !data.includes('from-a-after-logout'),
      ),
    )
    expect(persistedDataFor(saved[saved.length - 1], key)).toEqual(['from-b'])
    expect(queryClient.getQueryData(key)).toEqual(['from-b'])
    expect(first.closed).toBe(true)

    unsubscribeNext()
    unsubscribePersist()
  })
})
