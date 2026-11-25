import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import { QueryClient } from '@tanstack/query-core'
import { flushSync } from 'svelte'
import FetchingFromContext from './FetchingFromContext.svelte'
import FetchingIndicator from './FetchingIndicator.svelte'
import MutatingFromContext from './MutatingFromContext.svelte'
import MutatingIndicator from './MutatingIndicator.svelte'
import MutationStateFromContext from './MutationStateFromContext.svelte'
import MutationStateIndicator from './MutationStateIndicator.svelte'
import type { MountLifetime } from './lifetime.js'
import type { ComponentProps, SvelteComponent } from 'svelte'
import type { RenderResult } from '@testing-library/svelte'

/**
 * These tests are the spec for a mounted Svelte layout that calls the
 * fetch-count, mutation-count, or mutation-state helper with the signed-in
 * account's client and account id, then stays mounted while the app passes
 * the next account. They fail while that helper keeps the first client and
 * the first filter.
 */

type AccountId = 'alice' | 'bob'

type SwitchProps = {
  accountId: string
  queryClient?: QueryClient
  lifetime: MountLifetime
  scope?: 'account' | 'inbox'
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: 'always' },
      mutations: { retry: false, networkMode: 'always' },
    },
  })
}

function deferred() {
  let resolve: (value: string) => void = () => {}
  const promise = new Promise<string>((res) => {
    resolve = res
  })
  return {
    promise,
    settle: () => resolve('done'),
  }
}

const open = new Set<() => void>()

function startQuery(client: QueryClient, queryKey: Array<string>) {
  const pending = deferred()
  open.add(pending.settle)
  const request = client.query({
    queryKey,
    queryFn: () => pending.promise,
  })
  request.catch(() => {})
  return pending
}

function startMutation(
  client: QueryClient,
  mutationKey: Array<string>,
  variables: string,
) {
  const pending = deferred()
  open.add(pending.settle)
  const mutation = client.getMutationCache().build(client, {
    mutationKey,
    mutationFn: () => pending.promise,
  })
  const request = mutation.execute(variables)
  request.catch(() => {})
  return pending
}

function accountQueryKey(accountId: AccountId) {
  return ['account', accountId]
}

function accountMutationKey(accountId: AccountId) {
  return ['account', accountId]
}

afterEach(() => {
  for (const settle of open) settle()
  open.clear()
})

async function switchAccount<TComponent extends SvelteComponent<SwitchProps>>(
  view: RenderResult<TComponent>,
  props: ComponentProps<TComponent>,
) {
  await view.rerender(props)
  flushSync()
  expect(view.container).toHaveTextContent(`account: ${props.accountId}`)
  expect(props.lifetime.mounts).toBe(1)
}

describe('useIsFetching account switch', () => {
  it('stops reporting the previous account fetch count when the account id changes', async () => {
    const client = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    const alice = startQuery(client, accountQueryKey('alice'))

    const view = render(FetchingIndicator, {
      props: { accountId: 'alice', queryClient: client, lifetime },
    })

    expect(view.container).toHaveTextContent('isFetching: 1')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: client,
      lifetime,
    })
    expect(view.container).toHaveTextContent('isFetching: 0')

    const bob = startQuery(client, accountQueryKey('bob'))
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    alice.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 0')
  })

  it('reports fetches for the client passed after the layout stays mounted', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }

    const view = render(FetchingIndicator, {
      props: {
        accountId: 'alice',
        queryClient: aliceClient,
        lifetime,
        scope: 'inbox',
      },
    })

    expect(view.container).toHaveTextContent('isFetching: 0')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
      scope: 'inbox',
    })
    expect(view.container).toHaveTextContent('isFetching: 0')

    const bob = startQuery(bobClient, ['inbox'])
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    const alice = startQuery(aliceClient, ['inbox'])
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 0')

    alice.settle()
  })

  it('drops the previous client subscription when the signed-in client changes', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    startQuery(aliceClient, accountQueryKey('alice'))

    const view = render(FetchingIndicator, {
      props: { accountId: 'alice', queryClient: aliceClient, lifetime },
    })

    expect(view.container).toHaveTextContent('isFetching: 1')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
    })
    expect(view.container).toHaveTextContent('isFetching: 0')

    const bob = startQuery(bobClient, accountQueryKey('bob'))
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    startQuery(aliceClient, ['account', 'alice', 'later'])
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 0')
  })

  it('follows the provider client for the signed-in account', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    startQuery(aliceClient, accountQueryKey('alice'))

    const view = render(FetchingFromContext, {
      props: { accountId: 'alice', queryClient: aliceClient, lifetime },
    })

    expect(view.container).toHaveTextContent('isFetching: 1')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
    })
    expect(view.container).toHaveTextContent('isFetching: 0')

    const bob = startQuery(bobClient, accountQueryKey('bob'))
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    startQuery(aliceClient, ['account', 'alice', 'later'])
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isFetching: 0')
  })
})

describe('useIsMutating account switch', () => {
  it('stops reporting the previous account mutation count when the account id changes', async () => {
    const client = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    const alice = startMutation(
      client,
      accountMutationKey('alice'),
      'alice-activity',
    )

    const view = render(MutatingIndicator, {
      props: { accountId: 'alice', queryClient: client, lifetime },
    })

    expect(view.container).toHaveTextContent('isMutating: 1')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: client,
      lifetime,
    })
    expect(view.container).toHaveTextContent('isMutating: 0')

    const bob = startMutation(client, accountMutationKey('bob'), 'bob-activity')
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 1')

    alice.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 0')
  })

  it('reports mutations for the client passed after the layout stays mounted', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }

    const view = render(MutatingIndicator, {
      props: {
        accountId: 'alice',
        queryClient: aliceClient,
        lifetime,
        scope: 'inbox',
      },
    })

    expect(view.container).toHaveTextContent('isMutating: 0')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
      scope: 'inbox',
    })

    const bob = startMutation(bobClient, ['inbox'], 'bob-activity')
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 1')

    const alice = startMutation(aliceClient, ['inbox'], 'alice-activity')
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 1')

    bob.settle()
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 0')

    alice.settle()
  })

  it('follows the provider client for mutation counts', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    startMutation(aliceClient, accountMutationKey('alice'), 'alice-activity')

    const view = render(MutatingFromContext, {
      props: { accountId: 'alice', queryClient: aliceClient, lifetime },
    })

    expect(view.container).toHaveTextContent('isMutating: 1')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
    })
    expect(view.container).toHaveTextContent('isMutating: 0')

    const bob = startMutation(
      bobClient,
      accountMutationKey('bob'),
      'bob-activity',
    )
    flushSync()
    expect(view.container).toHaveTextContent('isMutating: 1')

    bob.settle()
  })
})

describe('useMutationState account switch', () => {
  it('stops showing the previous account mutation variables when the account id changes', async () => {
    const client = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    const alice = startMutation(
      client,
      accountMutationKey('alice'),
      'alice-activity',
    )

    const view = render(MutationStateIndicator, {
      props: { accountId: 'alice', queryClient: client, lifetime },
    })

    expect(view.container).toHaveTextContent('mutations: ["alice-activity"]')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: client,
      lifetime,
    })
    expect(view.container).toHaveTextContent('mutations: []')
    expect(view.container).not.toHaveTextContent('alice-activity')

    const bob = startMutation(client, accountMutationKey('bob'), 'bob-activity')
    flushSync()
    expect(view.container).toHaveTextContent('mutations: ["bob-activity"]')
    expect(view.container).not.toHaveTextContent('alice-activity')

    alice.settle()
    bob.settle()
  })

  it('shows mutation variables for the client passed after the layout stays mounted', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    const alice = startMutation(aliceClient, ['inbox'], 'alice-activity')

    const view = render(MutationStateIndicator, {
      props: {
        accountId: 'alice',
        queryClient: aliceClient,
        lifetime,
        scope: 'inbox',
      },
    })

    expect(view.container).toHaveTextContent('mutations: ["alice-activity"]')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
      scope: 'inbox',
    })
    expect(view.container).toHaveTextContent('mutations: []')
    expect(view.container).not.toHaveTextContent('alice-activity')

    const bob = startMutation(bobClient, ['inbox'], 'bob-activity')
    flushSync()
    expect(view.container).toHaveTextContent('mutations: ["bob-activity"]')
    expect(view.container).not.toHaveTextContent('alice-activity')

    startMutation(aliceClient, ['inbox'], 'alice-later')
    flushSync()
    expect(view.container).toHaveTextContent('mutations: ["bob-activity"]')
    expect(view.container).not.toHaveTextContent('alice-later')

    alice.settle()
    bob.settle()
  })

  it('follows the provider client for mutation variables', async () => {
    const aliceClient = createClient()
    const bobClient = createClient()
    const lifetime: MountLifetime = { mounts: 0 }
    const alice = startMutation(
      aliceClient,
      accountMutationKey('alice'),
      'alice-activity',
    )

    const view = render(MutationStateFromContext, {
      props: { accountId: 'alice', queryClient: aliceClient, lifetime },
    })

    expect(view.container).toHaveTextContent('mutations: ["alice-activity"]')

    await switchAccount(view, {
      accountId: 'bob',
      queryClient: bobClient,
      lifetime,
    })
    expect(view.container).toHaveTextContent('mutations: []')
    expect(view.container).not.toHaveTextContent('alice-activity')

    const bob = startMutation(
      bobClient,
      accountMutationKey('bob'),
      'bob-activity',
    )
    flushSync()
    expect(view.container).toHaveTextContent('mutations: ["bob-activity"]')

    alice.settle()
    bob.settle()
  })
})
