import type { QueryClient } from '@tanstack/query-core'
import { render } from '@testing-library/preact'
import { useRef } from 'preact/hooks'
import { afterEach, describe, expect, it } from 'vitest'

import {
  QueryClient as CreateQueryClient,
  QueryClientProvider,
  useIsMutating,
  useMutationState,
} from '..'

/**
 * These tests pin the mutation-state snapshot to the render that observes a
 * new client or a new filter. A subscription-only update, or a list computed
 * in an effect after that render, still fails them.
 */

type AccountPayload = {
  accountId: string
  note: string
}

type AccountResult = {
  receipt: string
}

type RenderSnapshot = {
  instance: number
  value: unknown
}

const ACCOUNT_A = 'account-a'
const ACCOUNT_B = 'account-b'
const ACCOUNT_A_NOTE = 'account-a-private-note'
const ACCOUNT_B_NOTE = 'account-b-private-note'
const ACCOUNT_A_RECEIPT = 'account-a-receipt'
const ACCOUNT_B_RECEIPT = 'account-b-receipt'

const releases: Array<() => void> = []

afterEach(() => {
  for (const release of releases.splice(0)) {
    release()
  }
})

function createClient(): QueryClient {
  return new CreateQueryClient({
    defaultOptions: { mutations: { gcTime: Infinity, retry: false } },
  })
}

function payload(accountId: string, note: string): AccountPayload {
  return { accountId, note }
}

function result(receipt: string): AccountResult {
  return { receipt }
}

async function seedSuccess(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: AccountPayload,
  data: AccountResult,
): Promise<void> {
  const mutation = client.getMutationCache().build(client, {
    mutationKey,
    gcTime: Infinity,
    retry: false,
    mutationFn: () => Promise.resolve(data),
  })
  await mutation.execute(variables)
}

function seedPending(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: AccountPayload,
): void {
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  releases.push(releaseGate)

  const mutation = client.getMutationCache().build(client, {
    mutationKey,
    gcTime: Infinity,
    retry: false,
    mutationFn: async () => {
      await gate
      return result('released')
    },
  })
  const execution = mutation.execute(variables)
  releases.push(() => {
    void execution.catch(() => undefined)
  })
}

function createRecorder() {
  let nextInstance = 0
  const snapshots: Array<RenderSnapshot> = []

  function useRecord(value: unknown): void {
    const instance = useRef(0)
    if (instance.current === 0) {
      nextInstance += 1
      instance.current = nextInstance
    }
    snapshots.push({ instance: instance.current, value })
  }

  return { snapshots, useRecord }
}

function selectedState(mutation: {
  state: { variables: unknown; data: unknown; status: string }
}) {
  return {
    status: mutation.state.status,
    variables: mutation.state.variables,
    data: mutation.state.data,
  }
}

describe('useMutationState stale snapshot', () => {
  it('replaces the previous client variables and results on the render that receives a new provider client', async () => {
    const clientA = createClient()
    const clientB = createClient()
    const eventsOnB: Array<string> = []
    const unsubscribe = clientB.getMutationCache().subscribe((event) => {
      eventsOnB.push(event.type)
    })
    releases.push(unsubscribe)

    await seedSuccess(
      clientA,
      ['profile'],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )

    const { snapshots, useRecord } = createRecorder()

    function Viewer() {
      const states = useMutationState({
        filters: { mutationKey: ['profile'], exact: true, status: 'success' },
        select: selectedState,
      })
      useRecord(states)
      return <pre data-testid="mutation-state">{JSON.stringify(states)}</pre>
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={clientA} />)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.value).toEqual([
      {
        status: 'success',
        variables: payload(ACCOUNT_A, ACCOUNT_A_NOTE),
        data: result(ACCOUNT_A_RECEIPT),
      },
    ])
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App client={clientB} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(eventsOnB).toEqual([])
    expect(clientB.getMutationCache().findAll()).toEqual([])
    expect(switched?.value).toEqual([])
    expect(JSON.stringify(switched?.value)).not.toContain(ACCOUNT_A_NOTE)
    expect(JSON.stringify(switched?.value)).not.toContain(ACCOUNT_A_RECEIPT)
  })

  it('replaces the previous client variables and results on the render that receives a new queryClient argument', async () => {
    const clientA = createClient()
    const clientB = createClient()
    await seedSuccess(
      clientA,
      ['profile'],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )
    await seedSuccess(
      clientB,
      ['profile'],
      payload(ACCOUNT_B, ACCOUNT_B_NOTE),
      result(ACCOUNT_B_RECEIPT),
    )

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ client }: { client: QueryClient }) {
      const states = useMutationState(
        {
          filters: { mutationKey: ['profile'], exact: true, status: 'success' },
          select: selectedState,
        },
        client,
      )
      useRecord(states)
      return <pre>{JSON.stringify(states)}</pre>
    }

    const rendered = render(<Viewer client={clientA} />)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<Viewer client={clientB} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toEqual([
      {
        status: 'success',
        variables: payload(ACCOUNT_B, ACCOUNT_B_NOTE),
        data: result(ACCOUNT_B_RECEIPT),
      },
    ])
  })

  it('recomputes when the mutationKey filter changes to another account without a cache event', async () => {
    const client = createClient()
    const events: Array<string> = []
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      events.push(event.type)
    })
    releases.push(unsubscribe)

    await seedSuccess(
      client,
      ['account', ACCOUNT_A],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )
    await seedSuccess(
      client,
      ['account', ACCOUNT_B],
      payload(ACCOUNT_B, ACCOUNT_B_NOTE),
      result(ACCOUNT_B_RECEIPT),
    )
    events.splice(0)

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ account }: { account: string }) {
      const states = useMutationState({
        filters: {
          mutationKey: ['account', account],
          exact: true,
          status: 'success',
        },
        select: selectedState,
      })
      useRecord(states)
      return <pre>{JSON.stringify(states)}</pre>
    }

    function App({ account }: { account: string }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer account={account} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App account={ACCOUNT_A} />)
    const mountedInstance = snapshots[0]?.instance
    const eventsBeforeSwitch = events.length

    rendered.rerender(<App account={ACCOUNT_B} />)

    expect(events.length).toBe(eventsBeforeSwitch)
    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toEqual([
      {
        status: 'success',
        variables: payload(ACCOUNT_B, ACCOUNT_B_NOTE),
        data: result(ACCOUNT_B_RECEIPT),
      },
    ])
  })

  it('recomputes when the status filter changes without a cache event', async () => {
    const client = createClient()
    await seedSuccess(
      client,
      ['profile'],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )
    seedPending(client, ['draft'], payload(ACCOUNT_B, ACCOUNT_B_NOTE))

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ status }: { status: 'success' | 'pending' }) {
      const states = useMutationState({
        filters: { status },
        select: selectedState,
      })
      useRecord(states)
      return <pre>{JSON.stringify(states)}</pre>
    }

    function App({ status }: { status: 'success' | 'pending' }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer status={status} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App status="success" />)
    expect(snapshots[0]?.value).toEqual([
      {
        status: 'success',
        variables: payload(ACCOUNT_A, ACCOUNT_A_NOTE),
        data: result(ACCOUNT_A_RECEIPT),
      },
    ])
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App status="pending" />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toEqual([
      {
        status: 'pending',
        variables: payload(ACCOUNT_B, ACCOUNT_B_NOTE),
        data: undefined,
      },
    ])
  })

  it('recomputes when the predicate filter changes without a cache event', async () => {
    const client = createClient()
    await seedSuccess(
      client,
      ['profile', ACCOUNT_A],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )
    await seedSuccess(
      client,
      ['profile', ACCOUNT_B],
      payload(ACCOUNT_B, ACCOUNT_B_NOTE),
      result(ACCOUNT_B_RECEIPT),
    )

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ account }: { account: string }) {
      const states = useMutationState({
        filters: {
          predicate: (mutation) =>
            mutation.options.mutationKey?.[1] === account,
        },
        select: (mutation) => mutation.state.variables,
      })
      useRecord(states)
      return <pre>{JSON.stringify(states)}</pre>
    }

    function App({ account }: { account: string }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer account={account} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App account={ACCOUNT_A} />)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App account={ACCOUNT_B} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toEqual([payload(ACCOUNT_B, ACCOUNT_B_NOTE)])
  })

  it('recomputes when select changes without a cache event', async () => {
    const client = createClient()
    await seedSuccess(
      client,
      ['profile'],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
      result(ACCOUNT_A_RECEIPT),
    )

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ field }: { field: 'variables' | 'data' }) {
      const states = useMutationState({
        filters: { mutationKey: ['profile'], exact: true },
        select: (mutation) => mutation.state[field],
      })
      useRecord(states)
      return <pre>{JSON.stringify(states)}</pre>
    }

    function App({ field }: { field: 'variables' | 'data' }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer field={field} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App field="variables" />)
    expect(snapshots[0]?.value).toEqual([payload(ACCOUNT_A, ACCOUNT_A_NOTE)])
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App field="data" />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toEqual([result(ACCOUNT_A_RECEIPT)])
  })
})

describe('useIsMutating stale snapshot', () => {
  it('returns the new client pending count on the render that receives a new provider client', () => {
    const clientA = createClient()
    const clientB = createClient()
    const eventsOnB: Array<string> = []
    const unsubscribe = clientB.getMutationCache().subscribe((event) => {
      eventsOnB.push(event.type)
    })
    releases.push(unsubscribe)

    seedPending(clientA, ['profile'], payload(ACCOUNT_A, ACCOUNT_A_NOTE))

    const { snapshots, useRecord } = createRecorder()

    function Viewer() {
      const pending = useIsMutating()
      useRecord(pending)
      return <div>pending: {pending}</div>
    }

    function App({ client }: { client: QueryClient }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App client={clientA} />)
    expect(snapshots[0]?.value).toBe(1)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App client={clientB} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(eventsOnB).toEqual([])
    expect(switched?.value).toBe(0)
  })

  it('returns the new client pending count on the render that receives a new queryClient argument', () => {
    const clientA = createClient()
    const clientB = createClient()
    seedPending(clientA, ['profile'], payload(ACCOUNT_A, ACCOUNT_A_NOTE))
    seedPending(clientB, ['billing'], payload(ACCOUNT_B, ACCOUNT_B_NOTE))
    seedPending(clientB, ['audit'], payload(ACCOUNT_B, ACCOUNT_B_NOTE))

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ client }: { client: QueryClient }) {
      const pending = useIsMutating(undefined, client)
      useRecord(pending)
      return <div>pending: {pending}</div>
    }

    const rendered = render(<Viewer client={clientA} />)
    expect(snapshots[0]?.value).toBe(1)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<Viewer client={clientB} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toBe(2)
  })

  it('recomputes when the mutationKey filter changes without a cache event', () => {
    const client = createClient()
    seedPending(
      client,
      ['account', ACCOUNT_A],
      payload(ACCOUNT_A, ACCOUNT_A_NOTE),
    )
    seedPending(
      client,
      ['account', ACCOUNT_B],
      payload(ACCOUNT_B, ACCOUNT_B_NOTE),
    )

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ account }: { account: string }) {
      const pending = useIsMutating({
        mutationKey: ['account', account],
        exact: true,
      })
      useRecord(pending)
      return <div>pending: {pending}</div>
    }

    function App({ account }: { account: string }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer account={account} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App account={ACCOUNT_A} />)
    expect(snapshots[0]?.value).toBe(1)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App account="account-c" />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toBe(0)
  })

  it('recomputes when the predicate filter changes without a cache event', () => {
    const client = createClient()
    seedPending(client, ['profile'], payload(ACCOUNT_A, ACCOUNT_A_NOTE))

    const { snapshots, useRecord } = createRecorder()

    function Viewer({ match }: { match: boolean }) {
      const pending = useIsMutating({
        predicate: () => match,
      })
      useRecord(pending)
      return <div>pending: {pending}</div>
    }

    function App({ match }: { match: boolean }) {
      return (
        <QueryClientProvider client={client}>
          <Viewer match={match} />
        </QueryClientProvider>
      )
    }

    const rendered = render(<App match />)
    expect(snapshots[0]?.value).toBe(1)
    const mountedInstance = snapshots[0]?.instance

    rendered.rerender(<App match={false} />)

    const switched = snapshots[1]
    expect(switched?.instance).toBe(mountedInstance)
    expect(switched?.value).toBe(0)
  })
})
