import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey } from '@tanstack/query-test-utils'
import { streamedQuery } from '../streamedQuery'
import { QueryClient, QueryObserver } from '..'
import type { QueryClient as QueryClientType, QueryKey } from '..'

/**
 * Streams that never read `context.signal`. Chunks are pushed by the test,
 * which is the shape the library allows for generators over sockets and SDKs.
 */
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
    finish() {
      deliver({ done: true })
    },
    get closed() {
      return closed
    },
  }
}

type PushStream<T> = ReturnType<typeof createPushStream<T>>

function createStreamSource<T>() {
  const streams: Array<PushStream<T>> = []
  return {
    streams,
    streamFn: () => {
      const stream = createPushStream<T>()
      streams.push(stream)
      return stream.values()
    },
  }
}

function watchVisibleData(queryClient: QueryClientType, key: QueryKey) {
  const snapshots: Array<unknown> = []
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === 'added' ||
      event.type === 'updated' ||
      event.type === 'removed'
    ) {
      snapshots.push(queryClient.getQueryData(key))
    }
  })

  return {
    unsubscribe,
    since(start: number) {
      return snapshots.slice(start)
    },
    mark() {
      return snapshots.length
    },
  }
}

function containsChunk(data: unknown, chunk: string): boolean {
  return Array.isArray(data) && data.includes(chunk)
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('streamedQuery cache isolation after the originating fetch is dropped', () => {
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

  async function mountStream(
    key: QueryKey,
    source: ReturnType<typeof createStreamSource<string>>,
    options?: {
      staleTime?: number
      refetchMode?: 'append' | 'reset' | 'replace'
      reducer?: (acc: Array<string>, chunk: string) => Array<string>
      initialValue?: Array<string>
    },
  ) {
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      staleTime: options?.staleTime,
      queryFn: streamedQuery({
        streamFn: () => source.streamFn(),
        refetchMode: options?.refetchMode,
        reducer: options?.reducer as (
          acc: Array<string>,
          chunk: string,
        ) => Array<string>,
        initialValue: options?.initialValue as Array<string>,
      }),
    })
    const unsubscribe = observer.subscribe(vi.fn())
    await settle()
    return { observer, unsubscribe }
  }

  it('does not recreate the cache entry when chunks arrive after clear()', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { unsubscribe } = await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    queryClient.clear()
    expect(queryClient.getQueryData(key)).toBeUndefined()

    const afterClear = visible.mark()
    source.streams[0]!.push('from-a-after-clear')
    source.streams[0]!.push('from-a-still-going')
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined()
    expect(
      visible
        .since(afterClear)
        .every((data) => !containsChunk(data, 'from-a-after-clear')),
    ).toBe(true)
    expect(
      visible
        .since(afterClear)
        .every((data) => !containsChunk(data, 'from-a-still-going')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not recreate the cache entry when chunks arrive after removeQueries()', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { unsubscribe } = await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    queryClient.removeQueries({ queryKey: key })
    expect(queryClient.getQueryData(key)).toBeUndefined()

    const afterRemove = visible.mark()
    source.streams[0]!.push('from-a-after-remove')
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(queryClient.getQueryCache().find({ queryKey: key })).toBeUndefined()
    expect(
      visible
        .since(afterRemove)
        .every((data) => !containsChunk(data, 'from-a-after-remove')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not write later chunks after resetQueries() drops an inactive stream', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { unsubscribe } = await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    await queryClient.resetQueries({ queryKey: key })
    expect(queryClient.getQueryData(key)).toBeUndefined()

    const afterReset = visible.mark()
    source.streams[0]!.push('from-a-after-reset')
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(
      visible
        .since(afterReset)
        .every((data) => !containsChunk(data, 'from-a-after-reset')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not append the reset stream onto the query resetQueries() refetches', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    const resetPromise = queryClient.resetQueries({ queryKey: key })
    await settle()
    expect(source.streams[1]).toBeDefined()

    source.streams[1]!.push('from-refetch')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-refetch'])

    const afterRefetch = visible.mark()
    source.streams[0]!.push('from-a-after-reset')
    await settle()

    expect(queryClient.getQueryData(key)).toEqual(['from-refetch'])
    expect(
      visible
        .since(afterRefetch)
        .every((data) => !containsChunk(data, 'from-a-after-reset')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    await resetPromise
    visible.unsubscribe()
  })

  it('does not keep writing chunks after cancelQueries() aborts the fetch', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    await queryClient.cancelQueries({ queryKey: key })

    const afterCancel = visible.mark()
    source.streams[0]!.push('from-a-after-cancel')
    await settle()

    expect(queryClient.getQueryData(key)).toEqual(['from-a'])
    expect(
      visible
        .since(afterCancel)
        .every((data) => !containsChunk(data, 'from-a-after-cancel')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not show the previous stream to the next observer that mounts the same key', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { unsubscribe } = await mountStream(key, source, {
      staleTime: Number.POSITIVE_INFINITY,
    })

    source.streams[0]!.push('from-a')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    queryClient.clear()

    source.streams[0]!.push('from-a-after-logout')
    await settle()

    const next = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: streamedQuery({
        streamFn: () => source.streamFn(),
      }),
    })
    const seen: Array<unknown> = []
    const unsubscribeNext = next.subscribe((result) => {
      seen.push(result.data)
    })
    await settle()

    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(next.getCurrentResult().data).toBeUndefined()
    expect(seen.every((data) => !containsChunk(data, 'from-a'))).toBe(true)
    expect(
      seen.every((data) => !containsChunk(data, 'from-a-after-logout')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    unsubscribeNext()
    visible.unsubscribe()
  })

  it('does not append chunks from a cleared stream into the next stream on the same key', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { unsubscribe } = await mountStream(key, source)

    source.streams[0]!.push('from-a')
    await settle()

    unsubscribe()
    queryClient.clear()

    const next = new QueryObserver(queryClient, {
      queryKey: key,
      retry: false,
      queryFn: streamedQuery({
        streamFn: () => source.streamFn(),
      }),
    })
    const unsubscribeNext = next.subscribe(vi.fn())
    await settle()

    source.streams[1]!.push('from-b')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-b'])

    const afterNext = visible.mark()
    source.streams[0]!.push('from-a-after-logout')
    await settle()

    expect(queryClient.getQueryData(key)).toEqual(['from-b'])
    expect(next.getCurrentResult().data).toEqual(['from-b'])
    expect(
      visible
        .since(afterNext)
        .every((data) => !containsChunk(data, 'from-a-after-logout')),
    ).toBe(true)
    expect(source.streams[0]!.closed).toBe(true)

    unsubscribeNext()
    visible.unsubscribe()
  })

  it('does not let an append refetch write chunks after the query was cleared', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { observer, unsubscribe } = await mountStream(key, source, {
      refetchMode: 'append',
    })

    source.streams[0]!.push('from-a')
    source.streams[0]!.finish()
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    void observer.refetch()
    await settle()
    expect(source.streams[1]).toBeDefined()

    unsubscribe()
    queryClient.clear()
    queryClient.setQueryData(key, ['from-b'])

    const afterClear = visible.mark()
    source.streams[1]!.push('from-a-append')
    await settle()

    expect(queryClient.getQueryData(key)).toEqual(['from-b'])
    expect(
      visible
        .since(afterClear)
        .every((data) => !containsChunk(data, 'from-a-append')),
    ).toBe(true)
    expect(source.streams[1]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not let a replace refetch publish its result after the query was cleared', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    const visible = watchVisibleData(queryClient, key)
    const { observer, unsubscribe } = await mountStream(key, source, {
      refetchMode: 'replace',
    })

    source.streams[0]!.push('from-a')
    source.streams[0]!.finish()
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    void observer.refetch()
    await settle()
    expect(source.streams[1]).toBeDefined()

    source.streams[1]!.push('from-a-replace')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['from-a'])

    unsubscribe()
    queryClient.clear()
    queryClient.setQueryData(key, ['from-b'])

    const afterClear = visible.mark()
    source.streams[1]!.finish()
    await settle()

    expect(queryClient.getQueryData(key)).toEqual(['from-b'])
    expect(
      visible
        .since(afterClear)
        .every((data) => !containsChunk(data, 'from-a-replace')),
    ).toBe(true)
    expect(source.streams[1]!.closed).toBe(true)

    visible.unsubscribe()
  })

  it('does not apply a chunk to a cache entry that replaces the originating query during the write', async () => {
    const key = queryKey()
    const source = createStreamSource<string>()
    let replaced = false

    await mountStream(key, source, {
      initialValue: [],
      reducer: (acc, chunk) => {
        const next = [...acc, chunk]
        if (chunk === 'swap' && !replaced) {
          replaced = true
          const current = queryClient
            .getQueryCache()
            .find({ queryKey: key, exact: true })
          if (current) {
            queryClient.getQueryCache().remove(current)
          }
          queryClient.setQueryData(key, ['next-session'])
        }
        return next
      },
    })

    source.streams[0]!.push('keep')
    await settle()
    expect(queryClient.getQueryData(key)).toEqual(['keep'])

    source.streams[0]!.push('swap')
    await settle()

    expect(replaced).toBe(true)
    expect(queryClient.getQueryData(key)).toEqual(['next-session'])
    const live = queryClient
      .getQueryCache()
      .find({ queryKey: key, exact: true })
    expect(live?.state.data).toEqual(['next-session'])
  })
})
