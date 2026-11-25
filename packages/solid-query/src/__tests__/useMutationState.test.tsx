import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createEffect, createSignal } from 'solid-js'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useMutationState,
} from '..'
import { renderWithClient } from './utils'
import type { MutationCache, MutationFilters } from '@tanstack/query-core'
import type { Accessor } from 'solid-js'

describe('useMutationState', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  it('should return all mutation states when called without options', async () => {
    const mutationKey = queryKey()

    function States() {
      const mutationStates = useMutationState()

      return <div>count: {mutationStates().length}</div>
    }

    function Mutate() {
      const mutation = useMutation(() => ({
        mutationKey,
        mutationFn: (input: number) => sleep(150).then(() => 'data' + input),
      }))

      return (
        <div>
          <button onClick={() => mutation.mutate(1)}>mutate</button>
        </div>
      )
    }

    function Page() {
      return (
        <div>
          <States />
          <Mutate />
        </div>
      )
    }

    const rendered = renderWithClient(queryClient, () => <Page />)

    expect(rendered.getByText('count: 0')).toBeInTheDocument()

    fireEvent.click(rendered.getByRole('button', { name: /mutate/i }))
    await vi.advanceTimersByTimeAsync(0)
    expect(rendered.getByText('count: 1')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(150)
    expect(rendered.getByText('count: 1')).toBeInTheDocument()
  })

  it('should return variables after calling mutate', async () => {
    const variables: Array<Array<unknown>> = []
    const mutationKey = queryKey()

    function Variables() {
      const states = useMutationState(() => ({
        filters: { mutationKey, status: 'pending' },
        select: (mutation) => mutation.state.variables,
      }))

      createEffect(() => {
        variables.push(states())
      })

      return null
    }

    function Mutate() {
      const mutation = useMutation(() => ({
        mutationKey,
        mutationFn: (input: number) => sleep(150).then(() => 'data' + input),
      }))

      return (
        <div>
          data: {mutation.data ?? 'null'}
          <button onClick={() => mutation.mutate(1)}>mutate</button>
        </div>
      )
    }

    function Page() {
      return (
        <div>
          <Variables />
          <Mutate />
        </div>
      )
    }

    const rendered = renderWithClient(queryClient, () => <Page />)

    expect(rendered.getByText('data: null')).toBeInTheDocument()

    fireEvent.click(rendered.getByRole('button', { name: /mutate/i }))
    await vi.advanceTimersByTimeAsync(150)
    expect(rendered.getByText('data: data1')).toBeInTheDocument()

    expect(variables).toEqual([[], [1], []])
  })

  it('replaces mutation variables and results when the custom query client changes', async () => {
    const accountA = new QueryClient()
    const accountB = new QueryClient()
    const [client, setClient] = createSignal(accountA)
    const key = queryKey()
    const listenerCalls = trackSubscriptionEvents(accountB.getMutationCache())

    const rendered = render(() => (
      <MutationRecords client={client} filters={{ mutationKey: key }} />
    ))

    expect(rendered.getByText('records: empty')).toBeInTheDocument()

    const pending = executeMutation(accountA, key, 'draft-a', 10_000)
    await flushMutationNotifications()

    expect(
      rendered.getByText('records: draft-a:undefined:pending'),
    ).toBeInTheDocument()

    setClient(accountB)

    expect(accountA.getMutationCache().hasListeners()).toBe(false)
    expect(accountB.getMutationCache().hasListeners()).toBe(true)
    expect(listenerCalls()).toBe(0)
    expect(rendered.getByText('records: empty')).toBeInTheDocument()
    expect(rendered.queryByText(/draft-a/)).not.toBeInTheDocument()

    const next = executeMutation(accountB, key, 'draft-b', 10)
    await vi.advanceTimersByTimeAsync(10)
    await next

    expect(
      rendered.getByText('records: draft-b:saved:draft-b:success'),
    ).toBeInTheDocument()
    expect(rendered.queryByText(/draft-a/)).not.toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(10_000)
    await pending
  })

  it('replaces the previous account mutation records when QueryClientProvider swaps clients', async () => {
    const accountA = new QueryClient()
    const accountB = new QueryClient()
    const [client, setClient] = createSignal(accountA)
    const keyA = queryKey()
    const keyB = queryKey()

    const rendered = render(() => (
      <QueryClientProvider client={client()}>
        <MutationRecords filters={{ status: 'success' }} />
      </QueryClientProvider>
    ))

    expect(rendered.getByText('records: empty')).toBeInTheDocument()

    const settledA = executeMutation(accountA, keyA, 'draft-a', 10)
    await vi.advanceTimersByTimeAsync(10)
    await settledA
    await flushMutationNotifications()

    expect(
      rendered.getByText('records: draft-a:saved:draft-a:success'),
    ).toBeInTheDocument()

    const settledB = executeMutation(accountB, keyB, 'draft-b', 10)
    await vi.advanceTimersByTimeAsync(10)
    await settledB
    await flushMutationNotifications()

    const listenerCalls = trackSubscriptionEvents(accountB.getMutationCache())

    setClient(accountB)

    expect(accountA.getMutationCache().hasListeners()).toBe(false)
    expect(accountB.getMutationCache().hasListeners()).toBe(true)
    expect(listenerCalls()).toBe(0)
    expect(
      rendered.getByText('records: draft-b:saved:draft-b:success'),
    ).toBeInTheDocument()
    expect(rendered.queryByText(/draft-a/)).not.toBeInTheDocument()
  })
})

function MutationRecords(props: {
  client?: Accessor<QueryClient>
  filters?: MutationFilters
}) {
  const states = useMutationState(
    () => ({
      filters: props.filters,
      select: (mutation) =>
        `${String(mutation.state.variables)}:${String(mutation.state.data)}:${mutation.state.status}`,
    }),
    props.client,
  )

  return <div>records: {states().join(',') || 'empty'}</div>
}

function executeMutation(
  client: QueryClient,
  mutationKey: ReturnType<typeof queryKey>,
  draft: string,
  delay: number,
) {
  const mutation = client.getMutationCache().build(client, {
    mutationKey,
    gcTime: Infinity,
    mutationFn: (input: string) => sleep(delay).then(() => `saved:${input}`),
  })

  return mutation.execute(draft)
}

function trackSubscriptionEvents(cache: MutationCache) {
  let calls = 0
  const originalSubscribe = cache.subscribe.bind(cache)

  vi.spyOn(cache, 'subscribe').mockImplementation((listener) => {
    return originalSubscribe((event) => {
      calls += 1
      listener(event)
    })
  })

  return () => calls
}

async function flushMutationNotifications() {
  await vi.advanceTimersByTimeAsync(0)
}
