import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  shallowRef,
} from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import Devtools from '../devtools.vue'
import DevtoolsPanel from '../devtoolsPanel.vue'
import ProductionDevtools from '../production'
import type { Component, ShallowRef } from 'vue'

/**
 * The mounted devtools must follow the QueryClient the app passes in, including
 * a client prop that replaces the client injected by VueQueryPlugin.
 * Reading or editing the previous client's cache after that switch is the leak.
 */

type DevtoolsLike = Component

const components: Array<[string, DevtoolsLike, { panel: boolean }]> = [
  ['VueQueryDevtools', Devtools, { panel: false }],
  ['VueQueryDevtools production entry', ProductionDevtools, { panel: false }],
  ['VueQueryDevtoolsPanel', DevtoolsPanel, { panel: true }],
]

function installBrowserStubs() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    },
  )
}

function profile(name: string) {
  return { name, session: `${name}-session` }
}

function seedProfile(client: QueryClient, name: string) {
  client.setQueryData(['profile'], profile(name))
}

async function settle() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate: () => boolean, label: string) {
  const start = Date.now()
  while (Date.now() - start < 10000) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function mountDevtools(options: {
  component: DevtoolsLike
  client: ShallowRef<QueryClient | undefined>
  injected: QueryClient
  initialIsOpen?: boolean
  panel: boolean
}) {
  const Host = defineComponent({
    name: 'DevtoolsClientHost',
    setup() {
      return () => {
        const props: Record<string, unknown> = {}
        if (!options.panel) {
          props.initialIsOpen = options.initialIsOpen ?? true
        }
        if (options.client.value) {
          props.client = options.client.value
        }
        return h(options.component, props)
      }
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(Host)
  app.use(VueQueryPlugin, { queryClient: options.injected })
  app.mount(container)
  return {
    container,
    unmount() {
      app.unmount()
      container.remove()
    },
  }
}

function queryRows(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>('[aria-label^="Query key "]'),
  ]
}

function rowLabel(container: HTMLElement, queryKey: string) {
  return queryRows(container).find((row) =>
    row.getAttribute('aria-label')?.includes(queryKey),
  )
}

function fieldValues(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLInputElement>(
      '.tsqd-query-details-data-explorer input',
    ),
  ].map((input) => input.value)
}

async function openQuery(container: HTMLElement, queryKey: string) {
  const row = rowLabel(container, queryKey)
  expect(row).toBeTruthy()
  row!.click()
  await settle()
  if (!container.querySelector('.tsqd-query-details-container')) {
    row!.click()
    await settle()
  }
  await waitFor(
    () => container.querySelector('.tsqd-query-details-container') !== null,
    `details for ${queryKey}`,
  )
}

describe('Vue query devtools stay bound to the first QueryClient', () => {
  const mounts: Array<{ unmount: () => void }> = []

  beforeEach(() => {
    installBrowserStubs()
    localStorage.clear()
  })

  afterEach(() => {
    while (mounts.length) {
      mounts.pop()?.unmount()
    }
    localStorage.clear()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  async function renderWithClients(
    component: DevtoolsLike,
    panel: boolean,
    options?: {
      initialIsOpen?: boolean
      /**
       * `null` mounts the devtools with no client prop so it reads the
       * client injected by VueQueryPlugin.
       */
      propClient?: QueryClient | null
      waitForProfile?: boolean
    },
  ) {
    const previous = new QueryClient()
    const next = new QueryClient()
    const injected = new QueryClient()
    seedProfile(previous, 'alice')
    seedProfile(next, 'bob')
    seedProfile(injected, 'injected')
    previous.setQueryData(['alice-only'], { secret: 'alice-only-secret' })
    next.setQueryData(['bob-only'], { secret: 'bob-only-secret' })
    const client = shallowRef<QueryClient | undefined>(
      options?.propClient === null
        ? undefined
        : (options?.propClient ?? previous),
    )
    const mounted = mountDevtools({
      component,
      client,
      injected,
      panel,
      initialIsOpen: options?.initialIsOpen,
    })
    mounts.push(mounted)
    if (options?.waitForProfile !== false) {
      await waitFor(
        () => rowLabel(mounted.container, '["profile"]') !== undefined,
        'initial profile query row',
      )
    }
    return { previous, next, injected, client, container: mounted.container }
  }

  describe.each(components)('%s', (_name, component, { panel }) => {
    it('lists and shows the new client cache after the client prop changes', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )

      expect(rowLabel(container, '["alice-only"]')).toBeTruthy()
      expect(rowLabel(container, '["bob-only"]')).toBeUndefined()

      client.value = next
      await settle()

      expect(rowLabel(container, '["bob-only"]')).toBeTruthy()
      expect(rowLabel(container, '["alice-only"]')).toBeUndefined()
      expect(previous.getQueryData(['alice-only'])).toEqual({
        secret: 'alice-only-secret',
      })
      expect(next.getQueryData(['bob-only'])).toEqual({
        secret: 'bob-only-secret',
      })
    })

    it('shows the new client data when the same query was already selected', async () => {
      const { next, client, container } = await renderWithClients(
        component,
        panel,
      )

      await openQuery(container, '["profile"]')
      await waitFor(
        () => fieldValues(container).includes('alice'),
        'alice profile value',
      )

      client.value = next
      await settle()

      expect(fieldValues(container)).toContain('bob')
      expect(fieldValues(container)).not.toContain('alice')
      expect(fieldValues(container)).toContain('bob-session')
      expect(fieldValues(container)).not.toContain('alice-session')
    })

    it('edits the new client when the query is opened after the prop change', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )
      const aliceBefore = previous.getQueryData(['profile'])

      client.value = next
      await settle()

      await openQuery(container, '["profile"]')
      await waitFor(
        () =>
          container.querySelector('[aria-label="Bulk Edit Data"]') !== null,
        'bulk edit button',
      )
      container
        .querySelector<HTMLButtonElement>('[aria-label="Bulk Edit Data"]')
        ?.click()
      await settle()

      const textarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Edit query data as JSON"]',
      )
      expect(textarea).not.toBeNull()
      textarea!.value = JSON.stringify({ name: 'bobby', session: 'bob-session' })
      textarea!
        .closest('form')
        ?.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])')
        ?.click()
      await settle()

      expect({
        next: next.getQueryData(['profile']),
        previous: previous.getQueryData(['profile']),
      }).toEqual({
        next: { name: 'bobby', session: 'bob-session' },
        previous: aliceBefore,
      })
    })

    it('writes an inline field edit to the new client only', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )
      const aliceBefore = previous.getQueryData(['profile'])

      client.value = next
      await settle()

      await openQuery(container, '["profile"]')
      await waitFor(
        () =>
          fieldValues(container).includes('bob') ||
          fieldValues(container).includes('alice'),
        'profile name field',
      )

      const input = [
        ...container.querySelectorAll<HTMLInputElement>(
          '.tsqd-query-details-data-explorer input',
        ),
      ].find(
        (candidate) => candidate.value === 'bob' || candidate.value === 'alice',
      )
      expect(input).toBeTruthy()
      input!.value = 'robert'
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      input!.dispatchEvent(new Event('change', { bubbles: true }))
      await settle()

      expect({
        next: next.getQueryData(['profile']),
        previous: previous.getQueryData(['profile']),
      }).toEqual({
        next: { name: 'robert', session: 'bob-session' },
        previous: aliceBefore,
      })
    })

    it('removes the query from the new client and leaves the previous client intact', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )

      client.value = next
      await settle()

      await openQuery(container, '["profile"]')
      await waitFor(
        () =>
          container.querySelector('.tsqd-query-details-action-remove') !==
          null,
        'remove button',
      )
      container
        .querySelector<HTMLButtonElement>('.tsqd-query-details-action-remove')
        ?.click()
      await settle()

      expect({
        next: next.getQueryData(['profile']),
        previous: previous.getQueryData(['profile']),
      }).toEqual({
        next: undefined,
        previous: profile('alice'),
      })
    })

    it('clears only the new client cache', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )

      client.value = next
      await settle()

      container
        .querySelector<HTMLButtonElement>('[aria-label="Clear query cache"]')
        ?.click()
      await settle()

      expect({
        nextProfile: next.getQueryData(['profile']),
        nextOnly: next.getQueryData(['bob-only']),
        previousProfile: previous.getQueryData(['profile']),
        previousOnly: previous.getQueryData(['alice-only']),
      }).toEqual({
        nextProfile: undefined,
        nextOnly: undefined,
        previousProfile: profile('alice'),
        previousOnly: { secret: 'alice-only-secret' },
      })
    })

    it('lists the new client mutations and hides the previous client mutations', async () => {
      const { previous, next, client, container } = await renderWithClients(
        component,
        panel,
      )
      const previousMutation = previous.getMutationCache().build(previous, {
        mutationKey: ['save-alice'],
        mutationFn: () => Promise.resolve('alice'),
      })
      const nextMutation = next.getMutationCache().build(next, {
        mutationKey: ['save-bob'],
        mutationFn: () => Promise.resolve('bob'),
      })
      await previousMutation.execute({})
      await nextMutation.execute({})

      container
        .querySelector<HTMLElement>('[title="Toggle Mutations View"]')
        ?.click()
      await waitFor(
        () => String(container.textContent).includes('save-alice'),
        'previous mutation',
      )

      client.value = next
      await settle()

      expect(container.textContent).toContain('save-bob')
      expect(container.textContent).not.toContain('save-alice')
    })

    it('uses the client prop when it replaces the injected query client', async () => {
      const { next, injected, client, container } = await renderWithClients(
        component,
        panel,
        { propClient: null },
      )

      await openQuery(container, '["profile"]')
      await waitFor(
        () => fieldValues(container).includes('injected'),
        'injected profile value',
      )

      client.value = next
      await settle()

      expect(fieldValues(container)).toContain('bob')
      expect(fieldValues(container)).toContain('bob-session')
      expect(fieldValues(container)).not.toContain('injected')
      expect(fieldValues(container)).not.toContain('injected-session')
      expect(injected.getQueryData(['profile'])).toEqual(profile('injected'))
    })

    it('returns to the injected client when the client prop is removed', async () => {
      const { previous, injected, client, container } = await renderWithClients(
        component,
        panel,
      )

      await openQuery(container, '["profile"]')
      await waitFor(
        () => fieldValues(container).includes('alice'),
        'alice profile value',
      )

      client.value = undefined
      await settle()

      expect(fieldValues(container)).toContain('injected')
      expect(fieldValues(container)).toContain('injected-session')
      expect(fieldValues(container)).not.toContain('alice')
      expect(fieldValues(container)).not.toContain('alice-session')
      expect(previous.getQueryData(['profile'])).toEqual(profile('alice'))
      expect(injected.getQueryData(['profile'])).toEqual(profile('injected'))
    })
  })

  it('opens the devtools from localStorage onto the client prop that is current', async () => {
    localStorage.setItem('TanstackQueryDevtools.open', 'true')
    const { next, client, container } = await renderWithClients(
      Devtools,
      false,
      { initialIsOpen: false },
    )

    expect(rowLabel(container, '["alice-only"]')).toBeTruthy()

    client.value = next
    await settle()

    expect(rowLabel(container, '["bob-only"]')).toBeTruthy()
    expect(rowLabel(container, '["alice-only"]')).toBeUndefined()
  })

  it('shows the current client when the panel is opened after the client prop changes', async () => {
    const { next, client, container } = await renderWithClients(
      Devtools,
      false,
      { initialIsOpen: false, waitForProfile: false },
    )
    await waitFor(
      () =>
        container.querySelector(
          '[aria-label="Open Tanstack query devtools"]',
        ) !== null,
      'devtools open button',
    )

    client.value = next
    await settle()

    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Open Tanstack query devtools"]',
      )
      ?.click()
    await waitFor(
      () => rowLabel(container, '["profile"]') !== undefined,
      'profile row after opening',
    )

    expect(rowLabel(container, '["bob-only"]')).toBeTruthy()
    expect(rowLabel(container, '["alice-only"]')).toBeUndefined()
  })
})
