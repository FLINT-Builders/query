import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { QueryClient } from '@tanstack/svelte-query'
import SvelteQueryDevtools from '../src/Devtools.svelte'
import AccountSwitch from './AccountSwitch.svelte'

// solid-transition-group@0.2.3 imports @solid-primitives/transition-group@1.1.2,
// whose package exports select ./src/index.ts under the @solid-primitives/source
// condition. That file is not published (package files are dist only), so the
// import throws before the panel can render. The stand-in only returns its
// children; it does not choose a query client.
vi.mock('solid-transition-group', () => ({
  TransitionGroup: (props: { children: unknown }) => props.children,
}))

const PREVIOUS_KEY = ['previous-account'] as const
const NEXT_KEY = ['next-account'] as const
const SESSION_KEY = ['session'] as const
const PREVIOUS_DATA = 'previous-account-cache-value'
const NEXT_DATA = 'next-account-cache-value'

describe('SvelteQueryDevtools client switching', { timeout: 20000 }, () => {
  let previousFontSize = ''

  beforeEach(() => {
    previousFontSize = document.documentElement.style.fontSize
    document.documentElement.style.fontSize = '16px'
    localStorage.clear()
    viStubBrowserApis()
  })

  afterEach(() => {
    document.documentElement.style.fontSize = previousFontSize
    localStorage.clear()
  })

  it('lists the new client cache after the client prop changes', async () => {
    const previous = await seedClient(PREVIOUS_KEY, PREVIOUS_DATA)
    const next = await seedClient(NEXT_KEY, NEXT_DATA)
    const view = render(SvelteQueryDevtools, {
      props: { client: previous, initialIsOpen: true },
    })

    await screen.findByRole(
      'button',
      { name: queryLabel(PREVIOUS_KEY) },
      { timeout: 5000 },
    )

    await view.rerender({ client: next, initialIsOpen: true })

    expect(
      await screen.findByRole(
        'button',
        { name: queryLabel(NEXT_KEY) },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: queryLabel(PREVIOUS_KEY) }),
    ).not.toBeInTheDocument()
  })

  it('shows the new client data and refetches with that client query function', async () => {
    const previousFetches: Array<string> = []
    const nextFetches: Array<string> = []
    const previous = await seedClient(SESSION_KEY, PREVIOUS_DATA, () => {
      previousFetches.push('refetch')
    })
    const next = await seedClient(SESSION_KEY, NEXT_DATA, () => {
      nextFetches.push('refetch')
    })
    previousFetches.length = 0
    nextFetches.length = 0

    const view = render(SvelteQueryDevtools, {
      props: { client: previous, initialIsOpen: true },
    })

    await screen.findByRole(
      'button',
      { name: queryLabel(SESSION_KEY) },
      { timeout: 5000 },
    )
    await fireEvent.click(
      screen.getByRole('button', { name: queryLabel(SESSION_KEY) }),
    )
    expect(await screen.findByDisplayValue(PREVIOUS_DATA)).toBeInTheDocument()

    await view.rerender({ client: next, initialIsOpen: true })

    expect(await screen.findByDisplayValue(NEXT_DATA)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(PREVIOUS_DATA)).not.toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Refetch' }))

    expect(nextFetches).toEqual(['refetch'])
    expect(previousFetches).toEqual([])
  })

  it('follows a client prop that replaces the client taken from context', async () => {
    const previous = await seedClient(PREVIOUS_KEY, PREVIOUS_DATA)
    const next = await seedClient(NEXT_KEY, NEXT_DATA)
    const view = render(AccountSwitch, {
      props: { contextClient: previous },
    })

    await screen.findByRole(
      'button',
      { name: queryLabel(PREVIOUS_KEY) },
      { timeout: 5000 },
    )

    await view.rerender({ contextClient: previous, devtoolsClient: next })

    expect(
      await screen.findByRole(
        'button',
        { name: queryLabel(NEXT_KEY) },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: queryLabel(PREVIOUS_KEY) }),
    ).not.toBeInTheDocument()
  })
})

async function seedClient(
  queryKey: readonly [string],
  data: string,
  onFetch?: () => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await client.fetchQuery({
    queryKey: [...queryKey],
    queryFn: () => {
      onFetch?.()
      return data
    },
  })
  return client
}

function queryLabel(queryKey: readonly [string]) {
  return new RegExp(`Query key ${escapeRegExp(JSON.stringify(queryKey))}(, |$)`)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function viStubBrowserApis() {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }

  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
}
