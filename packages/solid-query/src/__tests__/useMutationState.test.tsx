import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createEffect, createSignal } from 'solid-js'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { QueryClient, useMutation, useMutationState } from '..'
import { renderWithClient } from './utils'

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

  it('shows only the current client mutation variables after the client accessor changes', async () => {
    const accountA = new QueryClient()
    const accountB = new QueryClient()
    const [client, setClient] = createSignal(accountA)

    const startedOnA = accountA
      .getMutationCache()
      .build(accountA, {
        mutationKey: ['save-profile'],
        mutationFn: (variables: string) => sleep(30).then(() => variables),
      })
      .execute('secret-a')

    await vi.advanceTimersByTimeAsync(0)

    function Page() {
      const variables = useMutationState(
        () => ({
          select: (mutation) => mutation.state.variables as string,
        }),
        client,
      )

      return <div>variables: {variables().join(',') || 'none'}</div>
    }

    const rendered = render(() => <Page />)

    expect(rendered.getByText('variables: secret-a')).toBeInTheDocument()

    setClient(accountB)

    expect(rendered.getByText('variables: none')).toBeInTheDocument()

    const startedOnB = accountB
      .getMutationCache()
      .build(accountB, {
        mutationKey: ['save-profile'],
        mutationFn: (variables: string) => sleep(30).then(() => variables),
      })
      .execute('secret-b')

    await vi.advanceTimersByTimeAsync(0)

    expect(rendered.getByText('variables: secret-b')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(30)
    await Promise.all([startedOnA, startedOnB])
    accountA.clear()
    accountB.clear()
  })
})
