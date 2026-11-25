import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import {
  QueryClient,
  dehydrate,
  focusManager,
  onlineManager,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/solid-query'
import { queryKey } from '@tanstack/query-test-utils'
import { PersistQueryClientProvider } from '../PersistQueryClientProvider'
import type { QueryKey } from '@tanstack/solid-query'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

const ACCOUNT_A = 'account-a'
const ACCOUNT_B = 'account-b'
const PREVIOUS_PAYLOAD = 'previous-account-profile'
const NEXT_PAYLOAD = 'next-account-profile'
const FOCUS_PAYLOAD = 'previous-account-focus-refetch'
const INTERVAL_PAYLOAD = 'previous-account-interval-refetch'
const ONLINE_PAYLOAD = 'previous-account-online-refetch'

type Gate = {
  promise: Promise<void>
  open: () => void
}

function createGate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function createAccountPersister(readBuster: () => string) {
  const stored = new Map<string, PersistedClient>()
  const gates: Array<Gate> = []
  let restoreCount = 0

  const persister: Persister = {
    persistClient(persistClient) {
      stored.set(persistClient.buster, persistClient)
    },
    async restoreClient() {
      const gate = gates[restoreCount] ?? createGate()
      gates[restoreCount] = gate
      restoreCount++
      await gate.promise
      return stored.get(readBuster())
    },
    removeClient() {
      stored.delete(readBuster())
    },
  }

  return {
    persister,
    gate(index: number) {
      return (gates[index] ??= createGate())
    },
    seedKey(buster: string, key: QueryKey, data: unknown) {
      const seedClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      })
      seedClient.setQueryData(key, data, { updatedAt: 1 })
      stored.set(buster, {
        buster,
        timestamp: Date.now(),
        clientState: dehydrate(seedClient),
      })
    },
    queries(buster: string) {
      return stored.get(buster)?.clientState.queries ?? []
    },
  }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('account switch while a Solid query stays mounted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  afterEach(() => {
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
  })

  it('does not keep an in-flight previous-account response that resolves while the next snapshot is restoring', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    let releasePrevious: (value: string) => void = () => {
      throw new Error('previous response was not started')
    }
    const queryFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releasePrevious = resolve
        }),
    )

    function Page() {
      const state = useQuery(() => ({
        queryKey: key,
        queryFn,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }))

      return <div data-testid="data">{state.data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('data')).toHaveTextContent('empty')

    setBuster(ACCOUNT_B)
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    releasePrevious(PREVIOUS_PAYLOAD)
    await flush()
    accounts.gate(1).open()
    await flush()

    expect(queryClient.getQueryData(key)).toBe(NEXT_PAYLOAD)
    expect(screen.getByTestId('data')).toHaveTextContent(NEXT_PAYLOAD)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      PREVIOUS_PAYLOAD,
    )
  })

  it('does not let an in-flight previous-account response overwrite the next snapshot after hydrate or persist it under the next buster', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    let releasePrevious: (value: string) => void = () => {
      throw new Error('previous response was not started')
    }
    const queryFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releasePrevious = resolve
        }),
    )

    function Page() {
      const state = useQuery(() => ({
        queryKey: key,
        queryFn,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }))

      return <div data-testid="data">{state.data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    setBuster(ACCOUNT_B)
    await flush()
    accounts.gate(1).open()
    await flush()
    expect(queryClient.getQueryData(key)).toBe(NEXT_PAYLOAD)

    releasePrevious(PREVIOUS_PAYLOAD)
    await flush()

    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      PREVIOUS_PAYLOAD,
    )
    expect(queryClient.getQueryData(key)).toBe(NEXT_PAYLOAD)
    expect(screen.getByTestId('data')).toHaveTextContent(NEXT_PAYLOAD)
  })

  it('does not focus-refetch the previous account into the shared cache while the next snapshot is restoring', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    const responses = [PREVIOUS_PAYLOAD, FOCUS_PAYLOAD]
    const queryFn = vi.fn(() =>
      Promise.resolve(responses.shift() ?? FOCUS_PAYLOAD),
    )

    function Page() {
      const state = useQuery(() => ({
        queryKey: key,
        queryFn,
        refetchOnReconnect: false,
      }))

      return <div data-testid="data">{state.data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(key)).toBe(PREVIOUS_PAYLOAD)

    setBuster(ACCOUNT_B)
    await flush()
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await flush()

    expect(queryClient.getQueryData(key)).not.toBe(FOCUS_PAYLOAD)
    expect(queryFn).toHaveBeenCalledTimes(1)

    accounts.gate(1).open()
    await flush()

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(key)).not.toBe(FOCUS_PAYLOAD)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      FOCUS_PAYLOAD,
    )
  })

  it('does not interval-refetch the previous account into the shared cache while the next snapshot is restoring', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    const responses = [PREVIOUS_PAYLOAD, INTERVAL_PAYLOAD]
    const queryFn = vi.fn(() =>
      Promise.resolve(responses.shift() ?? INTERVAL_PAYLOAD),
    )

    function Page() {
      const state = useQuery(() => ({
        queryKey: key,
        queryFn,
        refetchInterval: 1000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }))

      return <div data-testid="data">{state.data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    setBuster(ACCOUNT_B)
    await flush()
    await vi.advanceTimersByTimeAsync(1000)

    expect(queryClient.getQueryData(key)).not.toBe(INTERVAL_PAYLOAD)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      INTERVAL_PAYLOAD,
    )
  })

  it('does not reconnect-refetch the previous account into the shared cache while the next snapshot is restoring', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    const responses = [PREVIOUS_PAYLOAD, ONLINE_PAYLOAD]
    const queryFn = vi.fn(() =>
      Promise.resolve(responses.shift() ?? ONLINE_PAYLOAD),
    )

    function Page() {
      const state = useQuery(() => ({
        queryKey: key,
        queryFn,
        refetchOnWindowFocus: false,
      }))

      return <div data-testid="data">{state.data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(key)).toBe(PREVIOUS_PAYLOAD)

    setBuster(ACCOUNT_B)
    await flush()
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await flush()

    expect(queryClient.getQueryData(key)).not.toBe(ONLINE_PAYLOAD)
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      ONLINE_PAYLOAD,
    )
  })

  it('does not keep an in-flight previous-account page from useInfiniteQuery across the next restore', async () => {
    const key = queryKey()
    const nextData = {
      pages: [NEXT_PAYLOAD],
      pageParams: [0],
    }
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, nextData)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    let releasePrevious: (value: string) => void = () => {
      throw new Error('previous response was not started')
    }
    const queryFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releasePrevious = resolve
        }),
    )

    function Page() {
      const state = useInfiniteQuery(() => ({
        queryKey: key,
        queryFn,
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }))

      return <div data-testid="data">{state.data?.pages[0] ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    setBuster(ACCOUNT_B)
    await flush()
    releasePrevious(PREVIOUS_PAYLOAD)
    await flush()
    accounts.gate(1).open()
    await flush()

    expect(queryClient.getQueryData(key)).toEqual(nextData)
    expect(screen.getByTestId('data')).toHaveTextContent(NEXT_PAYLOAD)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      PREVIOUS_PAYLOAD,
    )
  })

  it('does not keep an in-flight previous-account response from useQueries across the next restore', async () => {
    const key = queryKey()
    const [buster, setBuster] = createSignal(ACCOUNT_A)
    const accounts = createAccountPersister(buster)
    accounts.seedKey(ACCOUNT_B, key, NEXT_PAYLOAD)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    })
    let releasePrevious: (value: string) => void = () => {
      throw new Error('previous response was not started')
    }
    const queryFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releasePrevious = resolve
        }),
    )

    function Page() {
      const results = useQueries(() => ({
        queries: [
          {
            queryKey: key,
            queryFn,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        ],
      }))

      return <div data-testid="data">{results[0].data ?? 'empty'}</div>
    }

    render(() => (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: accounts.persister,
          buster: buster(),
          maxAge: Infinity,
        }}
      >
        <Page />
      </PersistQueryClientProvider>
    ))

    accounts.gate(0).open()
    await flush()
    expect(queryFn).toHaveBeenCalledTimes(1)

    setBuster(ACCOUNT_B)
    await flush()
    releasePrevious(PREVIOUS_PAYLOAD)
    await flush()
    accounts.gate(1).open()
    await flush()

    expect(queryClient.getQueryData(key)).toBe(NEXT_PAYLOAD)
    expect(screen.getByTestId('data')).toHaveTextContent(NEXT_PAYLOAD)
    expect(JSON.stringify(accounts.queries(ACCOUNT_B))).not.toContain(
      PREVIOUS_PAYLOAD,
    )
  })
})
