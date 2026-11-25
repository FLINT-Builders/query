import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { fireEvent, render } from '@solidjs/testing-library'
import DevtoolsPanelComponent from '../DevtoolsPanelComponent'
import type { QueryClient as QueryClientType } from '@tanstack/query-core'

// `solid-transition-group` internally imports from
// `@solid-primitives/transition-group`, whose `exports` field points at
// `src/index.ts` (not published) under a `@solid-primitives/source` condition
// that Vite can't fall through, so we stub it with a transparent pass-through.
vi.mock('solid-transition-group', () => ({
  TransitionGroup: (props: { children: unknown }) => props.children,
}))

// `goober` compiles every `css\`...\`` template literal at mount time
// (template parsing + class hashing + style serialization), which
// dominates mount cost and produces no value for label/role-based
// assertions, so we replace it with a no-op factory.
vi.mock('goober', () => {
  let counter = 0
  const css = Object.assign(() => `tsqd-${++counter}`, {
    bind: () => css,
  })
  return { css, glob: () => {}, setup: () => {} }
})

/**
 * Two devtools panels share one module-level query/mutation listener map.
 * These tests describe the isolation that map must provide:
 * a cache event updates only the panel bound to the cache that emitted it,
 * and unmounting one panel removes only that panel's listeners.
 */
describe('devtools panels isolate query and mutation caches', () => {
  const storage: { [key: string]: string } = {}
  let previousRootFontSize = ''

  beforeEach(() => {
    previousRootFontSize = document.documentElement.style.fontSize
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        Object.prototype.hasOwnProperty.call(storage, key)
          ? storage[key]
          : null,
      setItem: (key: string, value: string) => {
        storage[key] = value
      },
      removeItem: (key: string) => {
        delete storage[key]
      },
      clear: () => {
        Object.keys(storage).forEach((key) => delete storage[key])
      },
    })
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
        callback: ResizeObserverCallback
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback
        }
        observe = vi.fn((target: Element) => {
          this.callback(
            [
              {
                target,
                contentRect: { width: 1200, height: 800 } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          )
        })
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
    )
    document.documentElement.style.fontSize = '16px'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.keys(storage).forEach((key) => delete storage[key])
    onlineManager.setOnline(true)
    document.documentElement.style.fontSize = previousRootFontSize
  })

  function renderPanel(client: QueryClientType) {
    return render(() => (
      <DevtoolsPanelComponent
        client={client}
        queryFlavor="TanStack Query"
        version="5"
        onlineManager={onlineManager}
      />
    ))
  }

  function statusCount(container: HTMLElement, label: string) {
    const button = Array.from(container.querySelectorAll('button')).find(
      (entry) => entry.textContent?.includes(label),
    )
    return (
      button?.querySelector('.tsqd-query-status-tag-count')?.textContent ?? ''
    )
  }

  function renderedText(container: HTMLElement) {
    const fields = Array.from(
      container.querySelectorAll('input, textarea'),
    ).map((element) => (element as HTMLInputElement).value)
    return `${container.textContent ?? ''}\n${fields.join('\n')}`
  }

  function showMutations(container: HTMLElement) {
    const toggle = container.querySelector(
      '[title="Toggle Mutations View"]',
    ) as HTMLElement | null
    if (!toggle) {
      throw new Error('Mutations view toggle was not rendered')
    }
    fireEvent.click(toggle)
  }

  it('does not copy one client query cache into another panel when that cache updates', () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    clientB.setQueryData(['catalog'], 'public-catalog-beta')

    const panelA = renderPanel(clientA)
    const panelB = renderPanel(clientB)

    clientA.setQueryData(['session-user'], 'session-token-alpha')
    clientA.setQueryData(['session-profile'], 'session-profile-alpha')

    expect(renderedText(panelA.container)).toContain('["session-user"]')
    expect(renderedText(panelB.container)).not.toContain('["session-user"]')
    expect(renderedText(panelB.container)).not.toContain('session-token-alpha')
    expect(renderedText(panelB.container)).toContain('["catalog"]')

    fireEvent.click(panelA.getByLabelText('Query key ["session-user"]'))
    clientA.setQueryData(['session-user'], 'session-token-alpha-rotated')

    expect(renderedText(panelA.container)).toContain(
      'session-token-alpha-rotated',
    )
    expect(renderedText(panelB.container)).not.toContain(
      'session-token-alpha-rotated',
    )
    expect(renderedText(panelB.container)).not.toContain('["session-user"]')
    expect(renderedText(panelB.container)).toContain('public-catalog-beta')
    expect(statusCount(panelB.container, 'Inactive')).toBe('1')

    clientA.clear()
    clientB.clear()
    panelA.unmount()
    panelB.unmount()
  })

  it('does not copy one client mutation cache into another panel when that cache updates', async () => {
    const clientA = new QueryClient()
    const clientB = new QueryClient()
    const panelA = renderPanel(clientA)
    const panelB = renderPanel(clientB)

    showMutations(panelA.container)
    showMutations(panelB.container)

    const mutation = clientA.getMutationCache().build(clientA, {
      mutationKey: ['rotate-session'],
      mutationFn: async () => 'mutation-session-alpha',
    })
    await mutation.execute(undefined)

    expect(renderedText(panelA.container)).toContain('["rotate-session"]')
    expect(renderedText(panelB.container)).not.toContain('["rotate-session"]')
    expect(renderedText(panelB.container)).not.toContain(
      'mutation-session-alpha',
    )

    fireEvent.click(
      panelA.getByRole('button', { name: /Mutation submitted at/ }),
    )
    await mutation.execute(undefined)

    expect(renderedText(panelA.container)).toContain('mutation-session-alpha')
    expect(renderedText(panelB.container)).not.toContain(
      'mutation-session-alpha',
    )
    expect(renderedText(panelB.container)).not.toContain('["rotate-session"]')
    expect(statusCount(panelB.container, 'Success')).toBe('0')

    clientA.clear()
    clientB.clear()
    panelA.unmount()
    panelB.unmount()
  })

  it('keeps following its own cache after the other panel unmounts', () => {
    const client = new QueryClient()
    client.setQueryData(['session-user'], 'session-token-before-logout')

    const panelA = renderPanel(client)
    const panelB = renderPanel(client)

    fireEvent.click(panelB.getByLabelText('Query key ["session-user"]'))
    expect(renderedText(panelB.container)).toContain(
      'session-token-before-logout',
    )

    panelA.unmount()
    client.clear()

    expect(renderedText(panelB.container)).not.toContain(
      'session-token-before-logout',
    )
    expect(renderedText(panelB.container)).not.toContain('["session-user"]')

    client.setQueryData(['signed-in-user'], 'session-token-after-login')

    expect(renderedText(panelB.container)).toContain('["signed-in-user"]')
    expect(renderedText(panelB.container)).toContain(
      'session-token-after-login',
    )
    expect(renderedText(panelB.container)).not.toContain(
      'session-token-before-logout',
    )

    client.clear()
    panelB.unmount()
  })

  it('keeps following its own mutation cache after the other panel unmounts', async () => {
    const client = new QueryClient()
    const panelA = renderPanel(client)
    const panelB = renderPanel(client)

    showMutations(panelA.container)
    showMutations(panelB.container)

    const beforeLogout = client.getMutationCache().build(client, {
      mutationKey: ['before-logout'],
      mutationFn: async () => 'mutation-before-logout',
    })
    await beforeLogout.execute(undefined)

    expect(renderedText(panelB.container)).toContain('["before-logout"]')
    fireEvent.click(
      panelB.getByRole('button', { name: /Mutation submitted at/ }),
    )
    expect(renderedText(panelB.container)).toContain('mutation-before-logout')

    panelA.unmount()
    client.getMutationCache().clear()

    expect(renderedText(panelB.container)).not.toContain('["before-logout"]')
    expect(renderedText(panelB.container)).not.toContain(
      'mutation-before-logout',
    )

    const afterLogin = client.getMutationCache().build(client, {
      mutationKey: ['after-login'],
      mutationFn: async () => 'mutation-after-login',
    })
    await afterLogin.execute(undefined)

    expect(renderedText(panelB.container)).toContain('["after-login"]')
    expect(renderedText(panelB.container)).toContain('mutation-after-login')
    expect(renderedText(panelB.container)).not.toContain(
      'mutation-before-logout',
    )

    client.clear()
    panelB.unmount()
  })
})
