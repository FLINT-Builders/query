/* eslint-disable vitest/expect-expect -- assertions live in the shared helpers */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as VueDemi from 'vue-demi'
import {
  createApp,
  defineComponent,
  getCurrentInstance,
  h,
  hasInjectionContext,
  inject,
  nextTick,
  onScopeDispose,
  provide,
  ref,
} from 'vue'
import { QueryClient } from '../queryClient'
import { useInfiniteQuery } from '../useInfiniteQuery'
import { usePrefetchInfiniteQuery } from '../usePrefetchInfiniteQuery'
import { usePrefetchQuery } from '../usePrefetchQuery'
import { useQueries } from '../useQueries'
import { useQuery } from '../useQuery'
import { VUE_QUERY_CLIENT } from '../utils'
import { VueQueryPlugin } from '../vueQueryPlugin'
import type { App } from 'vue'

type PersistedClient = {
  clientState: unknown
}

type Persister = {
  persistClient: (client: PersistedClient) => Promise<void>
  restoreClient: () => Promise<undefined>
  removeClient: () => Promise<void>
}

type PersistQueryClient = (options: {
  queryClient: QueryClient
  persister: Persister
}) => [() => void, Promise<void>]

async function loadPersistQueryClient(): Promise<PersistQueryClient> {
  const loaded: { persistQueryClient: PersistQueryClient } =
    await vi.importActual('../../../query-persist-client-core/src/persist.ts')
  return loaded.persistQueryClient
}

/**
 * Spec for the frozen query-client capture in the Vue prefetch composables.
 *
 * A mounted composable must prefetch into the client currently provided for
 * the active account. Replacing that provided client (the same object
 * `app.provide` / `inject` read) and then changing the reactive query must
 * not write or persist the new account's pages into the previous client,
 * including when the provided client changes again between the cache check
 * and the fetch.
 */

type Page = { owner: string }

type ClientSlot = {
  armed: boolean
  /** Set once the next account's client is the one whose cache was checked. */
  checkedNext: boolean
  current: QueryClient
  next: QueryClient
  decoy: QueryClient
}

function accountClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  })
}

function installClientSlot(app: App<Element>, slot: ClientSlot): void {
  Object.defineProperty(app._context.provides, VUE_QUERY_CLIENT, {
    configurable: true,
    enumerable: true,
    get() {
      if (!slot.armed) {
        return slot.current
      }
      // The first lookup in the prefetch is the account that is current now.
      // A second lookup, after that client's cache was checked, is a
      // different client and must not receive the write.
      if (!slot.checkedNext) {
        return slot.next
      }
      return slot.decoy
    },
    set(value: QueryClient) {
      slot.current = value
    },
  })
}

function armNextClientCheck(slot: ClientSlot): void {
  const original = slot.next.getQueryState.bind(slot.next)
  slot.next.getQueryState = ((queryKey) => {
    slot.checkedNext = true
    return original(queryKey)
  }) as QueryClient['getQueryState']
}

function memoryPersister(): {
  persister: Persister
  snapshots: Array<PersistedClient>
} {
  const snapshots: Array<PersistedClient> = []
  const persister: Persister = {
    persistClient: (client) => {
      snapshots.push(JSON.parse(JSON.stringify(client)) as PersistedClient)
      return Promise.resolve()
    },
    restoreClient: () => Promise.resolve(undefined),
    removeClient: () => Promise.resolve(),
  }
  return { persister, snapshots }
}

function containsOwner(value: unknown, owner: string): boolean {
  return JSON.stringify(value).includes(`"owner":"${owner}"`)
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function waitForOwner(
  clients: Array<QueryClient>,
  queryKey: ReadonlyArray<string>,
  owner: string,
): Promise<void> {
  await vi.waitFor(() => {
    const landed = clients.some((client) =>
      containsOwner(client.getQueryData(queryKey), owner),
    )
    expect(landed).toBe(true)
  })
}

describe('cross-account prefetch client', () => {
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    vi.mocked(VueDemi.inject).mockImplementation(inject)
    vi.mocked(VueDemi.provide).mockImplementation(provide)
    vi.mocked(VueDemi.hasInjectionContext).mockImplementation(
      hasInjectionContext,
    )
    vi.mocked(VueDemi.onScopeDispose).mockImplementation(onScopeDispose)
    vi.mocked(VueDemi.getCurrentInstance).mockImplementation(getCurrentInstance)
  })

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
    vi.mocked(VueDemi.inject).mockReset()
    vi.mocked(VueDemi.provide).mockReset()
    vi.mocked(VueDemi.hasInjectionContext).mockReset()
    vi.mocked(VueDemi.onScopeDispose).mockReset()
    vi.mocked(VueDemi.getCurrentInstance).mockReset()
    vi.mocked(VueDemi.getCurrentInstance).mockReturnValue({
      proxy: {},
    } as never)
    vi.mocked(VueDemi.hasInjectionContext).mockReturnValue(true)
  })

  async function mountAccountSwitch(
    setupComposable: (account: { value: string }) => void,
    options?: { flipBetweenCheckAndUse?: boolean },
  ): Promise<{
    previous: QueryClient
    next: QueryClient
    decoy: QueryClient
    switchAccount: () => void
  }> {
    const previous = accountClient()
    const next = accountClient()
    const decoy = accountClient()
    const slot: ClientSlot = {
      armed: false,
      checkedNext: false,
      current: previous,
      next,
      decoy,
    }
    if (options?.flipBetweenCheckAndUse) {
      armNextClientCheck(slot)
    }

    const account = ref('previous')
    const Root = defineComponent({
      setup() {
        setupComposable(account)
        return () => h('div')
      },
    })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(Root)
    if (options?.flipBetweenCheckAndUse) {
      installClientSlot(app, slot)
    }
    app.use(VueQueryPlugin, { queryClient: previous })
    app.mount(host)

    cleanups.push(() => {
      app.unmount()
      host.remove()
      previous.clear()
      next.clear()
      decoy.clear()
    })

    await waitForOwner([previous], ['account-feed', 'previous'], 'previous')

    return {
      previous,
      next,
      decoy,
      switchAccount: () => {
        if (options?.flipBetweenCheckAndUse) {
          slot.armed = true
        } else {
          app.provide(VUE_QUERY_CLIENT, next)
        }
        account.value = 'next'
      },
    }
  }

  function infiniteOptions(account: { value: string }) {
    return () => ({
      queryKey: ['account-feed', account.value],
      queryFn: () => Promise.resolve({ owner: account.value } satisfies Page),
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    })
  }

  function queryOptions(account: { value: string }) {
    return () => ({
      queryKey: ['account-feed', account.value],
      queryFn: () => Promise.resolve({ owner: account.value } satisfies Page),
    })
  }

  function expectOnlyOnNextClient(
    previous: QueryClient,
    next: QueryClient,
    decoy: QueryClient,
    shape: 'infinite' | 'query',
  ): void {
    const nextKey = ['account-feed', 'next']
    const expected =
      shape === 'infinite'
        ? { pages: [{ owner: 'next' }], pageParams: [0] }
        : { owner: 'next' }

    expect(previous.getQueryData(['account-feed', 'previous'])).toEqual(
      shape === 'infinite'
        ? { pages: [{ owner: 'previous' }], pageParams: [0] }
        : { owner: 'previous' },
    )
    expect(previous.getQueryData(nextKey)).toBeUndefined()
    expect(decoy.getQueryData(nextKey)).toBeUndefined()
    expect(next.getQueryData(nextKey)).toEqual(expected)
  }

  async function expectPreviousPersisterOmitsNextAccount(
    previous: QueryClient,
  ): Promise<Array<PersistedClient>> {
    const { persister, snapshots } = memoryPersister()
    const persistQueryClient = await loadPersistQueryClient()
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: previous,
      persister,
    })
    cleanups.push(unsubscribe)
    await restored
    return snapshots
  }

  describe('usePrefetchInfiniteQuery', () => {
    it('stores the new account page on the client provided for that account', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          usePrefetchInfiniteQuery(infiniteOptions(account))
        },
      )
      const snapshots = await expectPreviousPersisterOmitsNextAccount(previous)

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )
      await flushTimers()

      expectOnlyOnNextClient(previous, next, decoy, 'infinite')
      expect(
        snapshots.some((snapshot) => containsOwner(snapshot, 'next')),
      ).toBe(false)
    })

    it('keeps the prefetch on the client that was checked when the provided client changes before the write', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          usePrefetchInfiniteQuery(infiniteOptions(account))
        },
        { flipBetweenCheckAndUse: true },
      )
      const snapshots = await expectPreviousPersisterOmitsNextAccount(previous)

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )
      await flushTimers()

      expectOnlyOnNextClient(previous, next, decoy, 'infinite')
      expect(
        snapshots.some((snapshot) => containsOwner(snapshot, 'next')),
      ).toBe(false)
    })
  })

  describe('usePrefetchQuery', () => {
    it('stores the new account page on the client provided for that account', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          usePrefetchQuery(queryOptions(account))
        },
      )

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )

      expectOnlyOnNextClient(previous, next, decoy, 'query')
    })

    it('keeps the prefetch on the client that was checked when the provided client changes before the write', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          usePrefetchQuery(queryOptions(account))
        },
        { flipBetweenCheckAndUse: true },
      )

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )

      expectOnlyOnNextClient(previous, next, decoy, 'query')
    })
  })

  describe('useInfiniteQuery', () => {
    it('fetches the new account page into the client provided for that account', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          useInfiniteQuery(infiniteOptions(account))
        },
      )

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )

      expectOnlyOnNextClient(previous, next, decoy, 'infinite')
    })
  })

  describe('useQuery', () => {
    it('fetches the new account page into the client provided for that account', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          useQuery(queryOptions(account))
        },
      )

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )

      expectOnlyOnNextClient(previous, next, decoy, 'query')
    })
  })

  describe('useQueries', () => {
    it('fetches the new account page into the client provided for that account', async () => {
      const { previous, next, decoy, switchAccount } = await mountAccountSwitch(
        (account) => {
          useQueries({
            queries: () => [queryOptions(account)()],
          })
        },
      )

      switchAccount()
      await nextTick()
      await waitForOwner(
        [previous, next, decoy],
        ['account-feed', 'next'],
        'next',
      )

      expectOnlyOnNextClient(previous, next, decoy, 'query')
    })
  })
})
