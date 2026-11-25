import { fireEvent, render } from '@testing-library/preact'
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQueries,
  useSuspenseQuery,
} from '..'
import type { MutationFunctionContext, UseMutationOptions } from '..'

const profileKey = ['profile'] as const
const feedKey = ['feed'] as const

type CallbackRecord = {
  phase: string
  client: QueryClient
}

function createAccountClient(
  accountId: string,
  record?: Array<CallbackRecord>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
    mutationCache: new MutationCache({
      onMutate: (_variables, _mutation, context) => {
        record?.push({ phase: 'cache.onMutate', client: context.client })
      },
      onSuccess: (_data, _variables, _onMutateResult, _mutation, context) => {
        record?.push({ phase: 'cache.onSuccess', client: context.client })
      },
      onError: (_error, _variables, _onMutateResult, _mutation, context) => {
        record?.push({ phase: 'cache.onError', client: context.client })
      },
      onSettled: (
        _data,
        _error,
        _variables,
        _onMutateResult,
        _mutation,
        context,
      ) => {
        record?.push({ phase: 'cache.onSettled', client: context.client })
      },
    }),
  })
  queryClient.setQueryData(['account-id'], accountId)
  queryClient.setQueryData(profileKey, `${accountId}-profile`)
  queryClient.setQueryData(feedKey, {
    pages: [`${accountId}-page`],
    pageParams: [0],
  })
  return queryClient
}

function mutationVariables(client: QueryClient) {
  return client
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.variables)
}

function profileInvalidated(client: QueryClient) {
  return (
    client.getQueryCache().find({ queryKey: profileKey })?.state
      .isInvalidated ?? false
  )
}

function sameClients(actual: Array<QueryClient>, expected: Array<QueryClient>) {
  return (
    actual.length === expected.length &&
    actual.every((client, index) => client === expected[index])
  )
}

function SwitchableProvider({
  first,
  second,
  children,
}: {
  first: QueryClient
  second: QueryClient
  children: ComponentChildren
}) {
  const [client, setClient] = useState(first)
  return (
    <QueryClientProvider client={client}>
      <button type="button" onClick={() => setClient(second)}>
        switch-to-second
      </button>
      <button type="button" onClick={() => setClient(first)}>
        switch-to-first
      </button>
      {children}
    </QueryClientProvider>
  )
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('useMutation client identity after QueryClient replacement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a mutation started after a provider switch on the current client', async () => {
    const callbacks: Array<CallbackRecord> = []
    const perCall: Array<CallbackRecord> = []
    const clientA = createAccountClient('A', callbacks)
    const clientB = createAccountClient('B', callbacks)
    const options: UseMutationOptions<string, Error, string> = {
      mutationKey: ['save-profile'],
      mutationFn: (variables, context) => {
        callbacks.push({ phase: 'mutationFn', client: context.client })
        return Promise.resolve(variables)
      },
      onMutate: (_variables, context) => {
        callbacks.push({ phase: 'onMutate', client: context.client })
        context.client.setQueryData(profileKey, 'optimistic')
      },
      onSuccess: async (_data, _variables, _onMutateResult, context) => {
        callbacks.push({ phase: 'onSuccess', client: context.client })
        await context.client.invalidateQueries({
          queryKey: profileKey,
          refetchType: 'none',
        })
      },
      onSettled: (_data, _error, _variables, _onMutateResult, context) => {
        callbacks.push({ phase: 'onSettled', client: context.client })
      },
    }

    function Screen() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched'),
        enabled: false,
      })
      const mutation = useMutation(options)
      return (
        <div>
          <h1>{String(profile.data)}</h1>
          <button
            type="button"
            onClick={() =>
              mutation.mutate('save', {
                onSuccess: (_data, _variables, _onMutateResult, context) => {
                  perCall.push({
                    phase: 'mutate.onSuccess',
                    client: context.client,
                  })
                },
                onSettled: (
                  _data,
                  _error,
                  _variables,
                  _onMutateResult,
                  context,
                ) => {
                  perCall.push({
                    phase: 'mutate.onSettled',
                    client: context.client,
                  })
                },
              })
            }
          >
            mutate
          </button>
        </div>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    expect(rendered.getByRole('heading').textContent).toBe('A-profile')

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect({
      displayed: rendered.getByRole('heading').textContent,
      currentProfile: clientB.getQueryData(profileKey),
      previousProfile: clientA.getQueryData(profileKey),
      currentInvalidated: profileInvalidated(clientB),
      previousInvalidated: profileInvalidated(clientA),
      currentMutations: mutationVariables(clientB),
      previousMutations: mutationVariables(clientA),
      phases: callbacks.map((entry) => entry.phase),
      callbacksUseCurrentClient: sameClients(
        callbacks.map((entry) => entry.client),
        callbacks.map(() => clientB),
      ),
      perCallUseCurrentClient: sameClients(
        perCall.map((entry) => entry.client),
        perCall.map(() => clientB),
      ),
    }).toEqual({
      displayed: 'optimistic',
      currentProfile: 'optimistic',
      previousProfile: 'A-profile',
      currentInvalidated: true,
      previousInvalidated: false,
      currentMutations: ['save'],
      previousMutations: [],
      phases: [
        'cache.onMutate',
        'onMutate',
        'mutationFn',
        'cache.onSuccess',
        'onSuccess',
        'cache.onSettled',
        'onSettled',
      ],
      callbacksUseCurrentClient: true,
      perCallUseCurrentClient: true,
    })
  })

  it('routes mutateAsync callbacks through the client that is current when it is called', async () => {
    const callbacks: Array<CallbackRecord> = []
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (_variables, context) => {
        callbacks.push({ phase: 'mutationFn', client: context.client })
        return Promise.resolve('async-result')
      },
      onSuccess: (_data, _variables, _onMutateResult, context) => {
        callbacks.push({ phase: 'onSuccess', client: context.client })
      },
    }

    function Screen() {
      const mutation = useMutation(options)
      return (
        <button
          type="button"
          onClick={() => {
            void mutation
              .mutateAsync('save-async', {
                onSuccess: (_data, _variables, _onMutateResult, context) => {
                  callbacks.push({
                    phase: 'mutateAsync.onSuccess',
                    client: context.client,
                  })
                },
                onSettled: (
                  _data,
                  _error,
                  _variables,
                  _onMutateResult,
                  context,
                ) => {
                  callbacks.push({
                    phase: 'mutateAsync.onSettled',
                    client: context.client,
                  })
                },
              })
              .catch(() => undefined)
          }}
        >
          mutate-async
        </button>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate-async' }))
    await flush()

    expect(mutationVariables(clientB)).toEqual(['save-async'])
    expect(mutationVariables(clientA)).toEqual([])
    expect(callbacks.map((entry) => entry.phase)).toEqual([
      'mutationFn',
      'onSuccess',
      'mutateAsync.onSuccess',
      'mutateAsync.onSettled',
    ])
    expect(
      sameClients(
        callbacks.map((entry) => entry.client),
        [clientB, clientB, clientB, clientB],
      ),
    ).toBe(true)
  })

  it('delivers the current client to error callbacks after a provider switch', async () => {
    const callbacks: Array<CallbackRecord> = []
    const clientA = createAccountClient('A', callbacks)
    const clientB = createAccountClient('B', callbacks)
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (_variables, context) => {
        callbacks.push({ phase: 'mutationFn', client: context.client })
        return Promise.reject(new Error('nope'))
      },
      onError: (_error, _variables, _onMutateResult, context) => {
        callbacks.push({ phase: 'onError', client: context.client })
      },
      onSettled: (_data, _error, _variables, _onMutateResult, context) => {
        callbacks.push({ phase: 'onSettled', client: context.client })
      },
    }

    function Screen() {
      const mutation = useMutation(options)
      return (
        <button
          type="button"
          onClick={() =>
            mutation.mutate('save', {
              onError: (_error, _variables, _onMutateResult, context) => {
                callbacks.push({
                  phase: 'mutate.onError',
                  client: context.client,
                })
              },
              onSettled: (
                _data,
                _error,
                _variables,
                _onMutateResult,
                context,
              ) => {
                callbacks.push({
                  phase: 'mutate.onSettled',
                  client: context.client,
                })
              },
            })
          }
        >
          mutate
        </button>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    const hookAndCallClients = callbacks.filter(
      (entry) => !entry.phase.startsWith('cache.'),
    )
    expect(hookAndCallClients.map((entry) => entry.phase)).toEqual([
      'mutationFn',
      'onError',
      'onSettled',
      'mutate.onError',
      'mutate.onSettled',
    ])
    expect(hookAndCallClients.every((entry) => entry.client === clientB)).toBe(
      true,
    )
    expect(
      callbacks
        .filter((entry) => entry.phase.startsWith('cache.'))
        .every((entry) => entry.client === clientB),
    ).toBe(true)
    expect(
      clientB
        .getMutationCache()
        .findAll()
        .map((mutation) => mutation.state.status),
    ).toEqual(['error'])
    expect(clientA.getMutationCache().findAll()).toEqual([])
  })

  it('uses mutation defaults from the client that is current when mutate runs', async () => {
    const seen: Array<QueryClient> = []
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    clientA.setMutationDefaults(['save-profile'], {
      mutationFn: (_variables, context) => {
        seen.push(context.client)
        return Promise.resolve('from-a')
      },
    })
    clientB.setMutationDefaults(['save-profile'], {
      mutationFn: (_variables, context) => {
        seen.push(context.client)
        return Promise.resolve('from-b')
      },
    })
    const options = { mutationKey: ['save-profile'] }

    function Screen() {
      const mutation = useMutation(options)
      return (
        <div>
          <h1>{String(mutation.data ?? 'empty')}</h1>
          <button type="button" onClick={() => mutation.mutate('save')}>
            mutate
          </button>
        </div>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect(sameClients(seen, [clientB])).toBe(true)
    expect(rendered.getByRole('heading').textContent).toBe('from-b')
    expect(mutationVariables(clientB)).toEqual(['save'])
    expect(mutationVariables(clientA)).toEqual([])
  })

  it('follows a new QueryClient passed as the hook argument', async () => {
    const seen: Array<QueryClient> = []
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (_variables, context) => {
        seen.push(context.client)
        return Promise.resolve('ok')
      },
    }

    function Screen({ client }: { client: QueryClient }) {
      const mutation = useMutation(options, client)
      return (
        <button type="button" onClick={() => mutation.mutate('save')}>
          mutate
        </button>
      )
    }

    function App() {
      const [client, setClient] = useState(clientA)
      return (
        <QueryClientProvider client={clientA}>
          <button type="button" onClick={() => setClient(clientB)}>
            switch-argument
          </button>
          <Screen client={client} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App />)

    fireEvent.click(rendered.getByRole('button', { name: 'switch-argument' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect(sameClients(seen, [clientB])).toBe(true)
    expect(mutationVariables(clientB)).toEqual(['save'])
    expect(mutationVariables(clientA)).toEqual([])
  })

  it('keeps an explicit QueryClient when only the provider client changes', async () => {
    const seen: Array<QueryClient> = []
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (_variables, context) => {
        seen.push(context.client)
        return Promise.resolve('ok')
      },
    }

    function Screen() {
      const mutation = useMutation(options, clientA)
      return (
        <button type="button" onClick={() => mutation.mutate('save')}>
          mutate
        </button>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect(sameClients(seen, [clientA])).toBe(true)
    expect(mutationVariables(clientA)).toEqual(['save'])
    expect(mutationVariables(clientB)).toEqual([])
  })

  it('leaves an in-flight mutation on its original client and routes the next one to the current client', async () => {
    const seen: Array<{ variables: string; client: QueryClient }> = []
    let releaseFirst: (value: string) => void = () => undefined
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (variables, context) => {
        seen.push({ variables, client: context.client })
        if (variables === 'before') {
          return new Promise<string>((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve('after-ok')
      },
      onSuccess: (_data, variables, _onMutateResult, context) => {
        seen.push({ variables: `${variables}:success`, client: context.client })
      },
    }

    function Screen() {
      const mutation = useMutation(options)
      return (
        <div>
          <button type="button" onClick={() => mutation.mutate('before')}>
            mutate-before
          </button>
          <button type="button" onClick={() => mutation.mutate('after')}>
            mutate-after
          </button>
        </div>
      )
    }

    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'mutate-before' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate-after' }))
    await flush()

    expect(seen.map((entry) => entry.variables)).toEqual([
      'before',
      'after',
      'after:success',
    ])
    expect(
      sameClients(
        seen.map((entry) => entry.client),
        [clientA, clientB, clientB],
      ),
    ).toBe(true)
    expect(mutationVariables(clientA)).toEqual(['before'])
    expect(mutationVariables(clientB)).toEqual(['after'])

    releaseFirst('before-ok')
    await flush()

    expect(seen.map((entry) => entry.variables)).toEqual([
      'before',
      'after',
      'after:success',
      'before:success',
    ])
    expect(
      sameClients(
        seen.map((entry) => entry.client),
        [clientA, clientB, clientB, clientA],
      ),
    ).toBe(true)
    expect(mutationVariables(clientA)).toEqual(['before'])
    expect(mutationVariables(clientB)).toEqual(['after'])
  })

  it('uses the client from the latest switch when the provider changes more than once', async () => {
    const seen: Array<QueryClient> = []
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const clientC = createAccountClient('C')
    const options: UseMutationOptions<string, Error, string> = {
      mutationFn: (_variables, context: MutationFunctionContext) => {
        seen.push(context.client)
        return Promise.resolve('ok')
      },
    }

    function Screen() {
      const mutation = useMutation(options)
      return (
        <button type="button" onClick={() => mutation.mutate('save')}>
          mutate
        </button>
      )
    }

    function App() {
      const [client, setClient] = useState(clientA)
      return (
        <QueryClientProvider client={client}>
          <button type="button" onClick={() => setClient(clientB)}>
            switch-to-b
          </button>
          <button type="button" onClick={() => setClient(clientC)}>
            switch-to-c
          </button>
          <button type="button" onClick={() => setClient(clientA)}>
            switch-to-a
          </button>
          <Screen />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App />)

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-b' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-c' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect(sameClients(seen, [clientC])).toBe(true)
    expect(mutationVariables(clientC)).toEqual(['save'])
    expect(mutationVariables(clientA)).toEqual([])
    expect(mutationVariables(clientB)).toEqual([])

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-a' }))
    await flush()
    fireEvent.click(rendered.getByRole('button', { name: 'mutate' }))
    await flush()

    expect(sameClients(seen, [clientC, clientA])).toBe(true)
    expect(mutationVariables(clientA)).toEqual(['save'])
    expect(mutationVariables(clientC)).toEqual(['save'])
  })

  async function readAfterSwitch(Screen: () => ComponentChildren) {
    const clientA = createAccountClient('A')
    const clientB = createAccountClient('B')
    const rendered = render(
      <SwitchableProvider first={clientA} second={clientB}>
        <Screen />
      </SwitchableProvider>,
    )

    fireEvent.click(rendered.getByRole('button', { name: 'switch-to-second' }))
    await flush()

    return rendered.getByRole('heading').textContent
  }

  it('reads useQuery from the client that replaced the provider', async () => {
    function ProfileScreen() {
      const profile = useQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched-profile'),
        enabled: false,
      })
      return <h1>{String(profile.data)}</h1>
    }

    expect(await readAfterSwitch(ProfileScreen)).toBe('B-profile')
  })

  it('reads useInfiniteQuery from the client that replaced the provider', async () => {
    function FeedScreen() {
      const feed = useInfiniteQuery({
        queryKey: feedKey,
        queryFn: () => Promise.resolve('fetched-page'),
        initialPageParam: 0,
        getNextPageParam: () => undefined,
        enabled: false,
      })
      return <h1>{String(feed.data?.pages[0])}</h1>
    }

    expect(await readAfterSwitch(FeedScreen)).toBe('B-page')
  })

  it('reads useSuspenseQuery from the client that replaced the provider', async () => {
    function ProfileScreen() {
      const profile = useSuspenseQuery({
        queryKey: profileKey,
        queryFn: () => Promise.resolve('fetched-profile'),
      })
      return <h1>{String(profile.data)}</h1>
    }

    expect(await readAfterSwitch(ProfileScreen)).toBe('B-profile')
  })

  it('reads useSuspenseInfiniteQuery from the client that replaced the provider', async () => {
    function FeedScreen() {
      const feed = useSuspenseInfiniteQuery({
        queryKey: feedKey,
        queryFn: () => Promise.resolve('fetched-page'),
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      })
      return <h1>{String(feed.data.pages[0])}</h1>
    }

    expect(await readAfterSwitch(FeedScreen)).toBe('B-page')
  })

  it('reads useQueries from the client that replaced the provider', async () => {
    function ProfileScreen() {
      const listed = useQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('fetched-profile'),
            enabled: false,
          },
        ],
      })
      return <h1>{String(listed[0]?.data)}</h1>
    }

    expect(await readAfterSwitch(ProfileScreen)).toBe('B-profile')
  })

  it('reads useSuspenseQueries from the client that replaced the provider', async () => {
    function ProfileScreen() {
      const listed = useSuspenseQueries({
        queries: [
          {
            queryKey: profileKey,
            queryFn: () => Promise.resolve('fetched-profile'),
          },
        ],
      })
      return <h1>{String(listed[0]?.data)}</h1>
    }

    expect(await readAfterSwitch(ProfileScreen)).toBe('B-profile')
  })
})
