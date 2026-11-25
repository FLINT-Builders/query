import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import { QueryClient, QueryClientProvider, createQueries, useQueries } from '..'
import type { Accessor } from 'solid-js'
import type { QueryClient as QueryClientType } from '..'

/**
 * Spec for the parallel-query client boundary.
 *
 * These tests fail while `useQueries` / `createQueries` keep the
 * `QueriesObserver` that was constructed for the first `QueryClient`.
 * Swapping the client accessor or the `QueryClientProvider` client, without
 * remounting the page, must show only the new client's cache and must write
 * later fetches only into that client. The single-query hook already does
 * this by replacing its observer.
 */

const accountARecord1 = 'account-a-record-1'
const accountARecord2 = 'account-a-record-2'
const accountBRecord1 = 'account-b-record-1'
const accountBRecord2 = 'account-b-record-2'

function recordFor(client: QueryClientType, accountA: QueryClientType) {
  return client === accountA
    ? { first: accountARecord1, second: accountARecord2 }
    : { first: accountBRecord1, second: accountBRecord2 }
}

describe('useQueries client isolation', () => {
  let clientA: QueryClient
  let clientB: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    clientA = new QueryClient()
    clientB = new QueryClient()
  })

  afterEach(() => {
    clientA.clear()
    clientB.clear()
    vi.useRealTimers()
  })

  it('refetches into the new client when the client accessor changes and leaves the previous cache intact', async () => {
    const key1 = queryKey()
    const key2 = queryKey()
    const [client, setClient] = createSignal(clientA)
    let pageMounts = 0

    function Page(props: { client: Accessor<QueryClientType> }) {
      pageMounts++
      const results = useQueries(
        () => ({
          queries: [
            {
              queryKey: key1,
              staleTime: 0,
              queryFn: () =>
                sleep(10).then(() => recordFor(props.client(), clientA).first),
            },
            {
              queryKey: key2,
              staleTime: 0,
              queryFn: () =>
                sleep(10).then(() => recordFor(props.client(), clientA).second),
            },
          ],
        }),
        props.client,
      )

      return (
        <div>
          <div data-testid="data1">{String(results[0].data ?? 'none')}</div>
          <div data-testid="data2">{String(results[1].data ?? 'none')}</div>
        </div>
      )
    }

    const rendered = render(() => <Page client={client} />)

    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.getByTestId('data1')).toHaveTextContent(accountARecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent(accountARecord2)
    expect(clientA.getQueryData(key1)).toBe(accountARecord1)
    expect(clientA.getQueryData(key2)).toBe(accountARecord2)
    expect(clientB.getQueryData(key1)).toBeUndefined()

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(10)

    expect(pageMounts).toBe(1)
    expect(rendered.getByTestId('data1')).toHaveTextContent(accountBRecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent(accountBRecord2)
    expect(clientB.getQueryData(key1)).toBe(accountBRecord1)
    expect(clientB.getQueryData(key2)).toBe(accountBRecord2)
    expect(clientA.getQueryData(key1)).toBe(accountARecord1)
    expect(clientA.getQueryData(key2)).toBe(accountARecord2)
  })

  it('shows the new provider cache after QueryClientProvider swaps clients on a mounted page', async () => {
    const key1 = queryKey()
    const key2 = queryKey()
    clientA.setQueryData(key1, accountARecord1)
    clientA.setQueryData(key2, accountARecord2)
    clientB.setQueryData(key1, accountBRecord1)
    clientB.setQueryData(key2, accountBRecord2)

    const [client, setClient] = createSignal(clientA)
    let pageMounts = 0
    const queryFn = vi.fn(() =>
      sleep(10).then(() => 'fetched-instead-of-cache'),
    )

    function Page() {
      pageMounts++
      const results = useQueries(() => ({
        queries: [
          { queryKey: key1, queryFn, staleTime: Infinity },
          { queryKey: key2, queryFn, staleTime: Infinity },
        ],
      }))

      return (
        <div>
          <div data-testid="data1">{String(results[0].data ?? 'none')}</div>
          <div data-testid="data2">{String(results[1].data ?? 'none')}</div>
        </div>
      )
    }

    function Harness() {
      return (
        <QueryClientProvider client={client()}>
          <Page />
        </QueryClientProvider>
      )
    }

    const rendered = render(() => <Harness />)

    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.getByTestId('data1')).toHaveTextContent(accountARecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent(accountARecord2)
    expect(queryFn).not.toHaveBeenCalled()

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(10)

    expect(pageMounts).toBe(1)
    expect(rendered.getByTestId('data1')).toHaveTextContent(accountBRecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent(accountBRecord2)
    expect(queryFn).not.toHaveBeenCalled()
    expect(clientA.getQueryData(key1)).toBe(accountARecord1)
    expect(clientA.getQueryData(key2)).toBe(accountARecord2)
    expect(clientB.getQueryData(key1)).toBe(accountBRecord1)
    expect(clientB.getQueryData(key2)).toBe(accountBRecord2)
  })

  it('reads a query added after the client swap from the new client when using createQueries', async () => {
    const key1 = queryKey()
    const key2 = queryKey()
    clientA.setQueryData(key1, accountARecord1)
    clientB.setQueryData(key1, accountBRecord1)
    clientB.setQueryData(key2, accountBRecord2)

    const [client, setClient] = createSignal(clientA)
    const [includeSecond, setIncludeSecond] = createSignal(false)
    let pageMounts = 0
    const queryFn = vi.fn(() =>
      sleep(10).then(() => 'fetched-instead-of-cache'),
    )

    function Page(props: { client: Accessor<QueryClientType> }) {
      pageMounts++
      const results = createQueries(
        () => ({
          queries: [
            { queryKey: key1, queryFn, staleTime: Infinity },
            ...(includeSecond()
              ? [{ queryKey: key2, queryFn, staleTime: Infinity }]
              : []),
          ],
        }),
        props.client,
      )

      return (
        <div>
          <div data-testid="data1">{String(results[0].data ?? 'none')}</div>
          <div data-testid="data2">
            {results[1] ? String(results[1].data ?? 'none') : 'absent'}
          </div>
        </div>
      )
    }

    const rendered = render(() => <Page client={client} />)

    await vi.advanceTimersByTimeAsync(10)

    expect(rendered.getByTestId('data1')).toHaveTextContent(accountARecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent('absent')
    expect(queryFn).not.toHaveBeenCalled()

    setClient(clientB)
    await vi.advanceTimersByTimeAsync(10)

    expect(pageMounts).toBe(1)
    expect(rendered.getByTestId('data1')).toHaveTextContent(accountBRecord1)
    expect(clientA.getQueryData(key2)).toBeUndefined()

    setIncludeSecond(true)
    await vi.advanceTimersByTimeAsync(10)

    expect(pageMounts).toBe(1)
    expect(rendered.getByTestId('data1')).toHaveTextContent(accountBRecord1)
    expect(rendered.getByTestId('data2')).toHaveTextContent(accountBRecord2)
    expect(queryFn).not.toHaveBeenCalled()
    expect(clientA.getQueryData(key1)).toBe(accountARecord1)
    expect(clientA.getQueryData(key2)).toBeUndefined()
    expect(clientB.getQueryData(key1)).toBe(accountBRecord1)
    expect(clientB.getQueryData(key2)).toBe(accountBRecord2)
  })
})
