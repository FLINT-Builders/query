/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/preact'
import { dehydrate, focusManager } from '../../../query-core/src'
import { QueryClient, useQuery } from '../../../preact-query/src'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import type { QueryKey } from '../../../query-core/src'
import type {
  PersistedClient,
  Persister,
} from '../../../query-persist-client-core/src'

import { PersistQueryClientProvider } from '../PersistQueryClientProvider'

const FRESH_AT = () => Date.now() + 60_000

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
  })
}

function persistedClient(
  buster: string,
  entries: Array<{ queryKey: QueryKey; data: string; updatedAt: number }>,
): PersistedClient {
  const client = createQueryClient()
  for (const entry of entries) {
    client.setQueryData(entry.queryKey, entry.data, {
      updatedAt: entry.updatedAt,
    })
  }
  return {
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(client),
  }
}

function createMemoryPersister(initial?: PersistedClient): Persister & {
  saves: Array<PersistedClient>
} {
  let stored = initial
  const saves: Array<PersistedClient> = []
  return {
    saves,
    persistClient(client) {
      stored = client
      saves.push(client)
    },
    async restoreClient() {
      await sleep(10)
      return stored
    },
    removeClient() {
      stored = undefined
    },
  }
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('PersistQueryClientProvider account switch (preact)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    focusManager.setFocused(undefined)
    vi.useRealTimers()
  })

  it('does not keep the previous account on screen when the cache buster changes', async () => {
    const visibleKey = queryKey()
    const hiddenKey = queryKey()
    const queryFn = vi.fn(() => Promise.resolve('fetched'))
    const persister = createMemoryPersister(
      persistedClient('account-a', [
        {
          queryKey: visibleKey,
          data: 'account-a-secret',
          updatedAt: FRESH_AT(),
        },
        {
          queryKey: hiddenKey,
          data: 'account-a-hidden',
          updatedAt: FRESH_AT(),
        },
      ]),
    )
    const queryClient = createQueryClient()

    function Page() {
      const state = useQuery({
        queryKey: visibleKey,
        queryFn,
        staleTime: Infinity,
      })
      return <h1 data-testid="visible">{state.data ?? ''}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-a' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )

    await flush(10)

    expect(rendered.getByTestId('visible').textContent).toBe('account-a-secret')
    expect(queryClient.getQueryData(hiddenKey)).toBe('account-a-hidden')
    expect(queryFn).not.toHaveBeenCalled()

    act(() => {
      focusManager.setFocused(false)
    })
    act(() => {
      focusManager.setFocused(true)
    })

    expect(rendered.getByTestId('visible').textContent).toBe('account-a-secret')
    expect(queryFn).not.toHaveBeenCalled()

    rendered.rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-b' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(20)

    expect(rendered.getByTestId('visible').textContent).toBe('fetched')
    expect(queryClient.getQueryData(visibleKey)).toBe('fetched')
    expect(queryClient.getQueryData(hiddenKey)).toBeUndefined()
    expect(queryFn).toHaveBeenCalled()
  })

  it('drops the previous account when a different persister is restored for the same client', async () => {
    const visibleKey = queryKey()
    const hiddenKey = queryKey()
    const queryFn = vi.fn(() => Promise.resolve('fetched'))
    const updatedAt = FRESH_AT()
    const persisterA = createMemoryPersister(
      persistedClient('shared', [
        { queryKey: visibleKey, data: 'account-a-secret', updatedAt },
        { queryKey: hiddenKey, data: 'account-a-hidden', updatedAt },
      ]),
    )
    const persisterB = createMemoryPersister(
      persistedClient('shared', [
        { queryKey: visibleKey, data: 'account-b-secret', updatedAt },
      ]),
    )
    const queryClient = createQueryClient()

    function Page() {
      const state = useQuery({
        queryKey: visibleKey,
        queryFn,
        staleTime: Infinity,
      })
      return <h1 data-testid="visible">{state.data ?? ''}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: persisterA, buster: 'shared' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(10)
    expect(rendered.getByTestId('visible').textContent).toBe('account-a-secret')

    rendered.rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister: persisterB, buster: 'shared' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(20)

    expect(queryClient.getQueryData(hiddenKey)).toBeUndefined()
    expect(queryClient.getQueryData(visibleKey)).toBe('account-b-secret')
    expect(rendered.getByTestId('visible').textContent).toBe('account-b-secret')
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('restores the persisted cache into a query client that replaces the first one', async () => {
    const visibleKey = queryKey()
    const queryFn = vi.fn(() => Promise.resolve('fetched'))
    const persister = createMemoryPersister(
      persistedClient('', [
        {
          queryKey: visibleKey,
          data: 'account-a-secret',
          updatedAt: FRESH_AT(),
        },
      ]),
    )
    const firstClient = createQueryClient()
    const secondClient = createQueryClient()

    function Page() {
      const state = useQuery({
        queryKey: visibleKey,
        queryFn,
        staleTime: Infinity,
      })
      return <h1 data-testid="visible">{state.data ?? ''}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={firstClient}
        persistOptions={{ persister }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(10)
    expect(rendered.getByTestId('visible').textContent).toBe('account-a-secret')
    expect(queryFn).not.toHaveBeenCalled()

    rendered.rerender(
      <PersistQueryClientProvider
        client={secondClient}
        persistOptions={{ persister }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(20)

    expect(secondClient.getQueryData(visibleKey)).toBe('account-a-secret')
    expect(rendered.getByTestId('visible').textContent).toBe('account-a-secret')
  })

  it('ignores a restore that finishes after a newer buster has already been applied', async () => {
    const visibleKey = queryKey()
    const hiddenKey = queryKey()
    let resolveAccountA: (client: PersistedClient) => void = () => {}
    const accountARestore = new Promise<PersistedClient>((resolve) => {
      resolveAccountA = resolve
    })
    const accountA = persistedClient('account-a', [
      {
        queryKey: visibleKey,
        data: 'account-a-secret',
        updatedAt: Date.now() + 30_000,
      },
      {
        queryKey: hiddenKey,
        data: 'account-a-hidden',
        updatedAt: Date.now() + 30_000,
      },
    ])
    const accountB = persistedClient('account-b', [
      {
        queryKey: visibleKey,
        data: 'account-b-secret',
        updatedAt: Date.now() + 10_000,
      },
    ])
    const accountC = persistedClient('account-c', [
      {
        queryKey: visibleKey,
        data: 'account-c-secret',
        updatedAt: Date.now() + 20_000,
      },
    ])
    const restores: Array<Promise<PersistedClient | undefined>> = [
      accountARestore,
      Promise.resolve(accountB),
      Promise.resolve(accountC),
    ]
    const persister: Persister = {
      persistClient() {},
      restoreClient() {
        return restores.shift() ?? Promise.resolve(undefined)
      },
      removeClient() {},
    }
    const queryClient = createQueryClient()

    function Page() {
      const state = useQuery({
        queryKey: visibleKey,
        queryFn: () => Promise.resolve('fetched'),
        staleTime: Infinity,
      })
      return <h1 data-testid="visible">{state.data ?? ''}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-a' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )

    rendered.rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-b' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    rendered.rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-c' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(0)

    resolveAccountA(accountA)
    await flush(0)

    expect(queryClient.getQueryData(hiddenKey)).toBeUndefined()
    expect(queryClient.getQueryData(visibleKey)).toBe('account-c-secret')
    expect(rendered.getByTestId('visible').textContent).toBe('account-c-secret')
  })

  it('writes later cache updates with the latest buster', async () => {
    const visibleKey = queryKey()
    const draftKey = queryKey()
    const persister = createMemoryPersister(
      persistedClient('account-a', [
        {
          queryKey: visibleKey,
          data: 'account-a-secret',
          updatedAt: FRESH_AT(),
        },
      ]),
    )
    const queryClient = createQueryClient()

    function Page() {
      const state = useQuery({
        queryKey: visibleKey,
        queryFn: () => Promise.resolve('fetched'),
        staleTime: Infinity,
      })
      return <h1>{state.data ?? ''}</h1>
    }

    const rendered = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-a' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(10)

    rendered.rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister, buster: 'account-b' }}
      >
        <Page />
      </PersistQueryClientProvider>,
    )
    await flush(20)

    persister.saves.length = 0
    act(() => {
      queryClient.setQueryData(draftKey, 'account-b-draft')
    })

    expect(persister.saves.length).toBeGreaterThan(0)
    const saved = persister.saves[persister.saves.length - 1]
    expect(saved?.buster).toBe('account-b')
    expect(
      saved?.clientState.queries.some(
        (query) => query.state.data === 'account-b-draft',
      ),
    ).toBe(true)
  })
})
