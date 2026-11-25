import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { fireEvent, render } from '@solidjs/testing-library'
import { createLocalStorage } from '@solid-primitives/storage'
import { Devtools } from '../Devtools'
import { PiPProvider, QueryDevtoolsContext, ThemeContext } from '../contexts'
import type { QueryDevtoolsProps } from '../contexts'

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

// superjson 2.2.6 throws while walking these keys, and its walker has no
// depth limit. Depths past a couple thousand overflow the stack in this runtime.
const DEEP_NESTING = 8000

const forbiddenKeyJson =
  '{"name":"ok","constructor":{"role":"admin"},"prototype":{"id":1},"__proto__":{"flag":true}}'

function nest(depth: number): unknown {
  let data: unknown = { leaf: true }
  for (let i = 0; i < depth; i++) {
    data = { nested: data }
  }
  return data
}

describe('devtools panel with poisoned query data', () => {
  const storage: { [key: string]: string } = {}
  let queryClient: QueryClient
  let previousRootFontSize = ''

  beforeEach(() => {
    vi.useFakeTimers()
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
                contentRect: { width: 1000, height: 500 } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          )
        })
        unobserve = vi.fn()
        disconnect = vi.fn()
      },
    )
    queryClient = new QueryClient()
    document.documentElement.style.fontSize = '16px'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.keys(storage).forEach((key) => delete storage[key])
    queryClient.clear()
    onlineManager.setOnline(true)
    document.documentElement.style.fontSize = previousRootFontSize
    vi.useRealTimers()
  })

  function renderDevtools(overrides: Partial<QueryDevtoolsProps> = {}) {
    return render(() => {
      const [localStore, setLocalStore] = createLocalStorage({
        prefix: 'TanstackQueryDevtools',
      })
      return (
        <QueryDevtoolsContext.Provider
          value={{
            client: queryClient,
            queryFlavor: 'TanStack Query',
            version: '5',
            onlineManager,
            initialIsOpen: true,
            ...overrides,
          }}
        >
          <PiPProvider localStore={localStore} setLocalStore={setLocalStore}>
            <ThemeContext.Provider value={() => 'dark'}>
              <Devtools localStore={localStore} setLocalStore={setLocalStore} />
            </ThemeContext.Provider>
          </PiPProvider>
        </QueryDevtoolsContext.Provider>
      )
    })
  }

  async function storeQuery(queryKey: ReadonlyArray<unknown>, data: unknown) {
    await queryClient.query({
      queryKey: queryKey as Array<unknown>,
      queryFn: () => data,
    })
  }

  function openQuery(
    rendered: ReturnType<typeof renderDevtools>,
    queryKeyLabel: RegExp,
  ) {
    fireEvent.click(rendered.getByLabelText(queryKeyLabel))
  }

  it('should keep the data explorer up when cached JSON has constructor, prototype, and __proto__ keys', async () => {
    const response = JSON.parse(forbiddenKeyJson) as Record<string, unknown>
    await storeQuery(['remote-resource'], response)
    await storeQuery(['safe-resource'], { name: 'safe' })

    const cached = queryClient.getQueryData(['remote-resource']) as Record<
      string,
      unknown
    >
    expect(cached).toBe(response)
    expect(
      Object.getOwnPropertyDescriptor(cached, 'constructor')?.value,
    ).toEqual({
      role: 'admin',
    })
    expect(Object.getOwnPropertyDescriptor(cached, 'prototype')?.value).toEqual(
      {
        id: 1,
      },
    )
    expect(
      Object.getOwnPropertyDescriptor(cached, '__proto__')?.enumerable,
    ).toBe(true)

    const rendered = renderDevtools()

    expect(() =>
      openQuery(rendered, /Query key \["remote-resource"\]/),
    ).not.toThrow()

    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
    expect(rendered.getByText('Query Details')).toBeInTheDocument()
    expect(rendered.getByText('name:')).toBeInTheDocument()
    expect(rendered.getByText('"ok"')).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /constructor/ }),
    ).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /prototype/ }),
    ).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /__proto__/ }),
    ).toBeInTheDocument()

    expect(() =>
      openQuery(rendered, /Query key \["safe-resource"\]/),
    ).not.toThrow()
    expect(rendered.getByText('"safe"')).toBeInTheDocument()
    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
  })

  it('should keep the data explorer up when those keys are nested inside the cached JSON', async () => {
    const response = JSON.parse(
      '{"profile":{"name":"ok","constructor":{"role":"admin"},"prototype":{"id":1},"__proto__":{"flag":true}},"items":[{"constructor":{"role":"admin"}}]}',
    )
    await storeQuery(['nested-resource'], response)

    const rendered = renderDevtools()

    expect(() =>
      openQuery(rendered, /Query key \["nested-resource"\]/),
    ).not.toThrow()

    expect(rendered.getByText('Query Details')).toBeInTheDocument()
    fireEvent.click(rendered.getByRole('button', { name: /profile/ }))

    expect(rendered.getByText('name:')).toBeInTheDocument()
    expect(rendered.getByText('"ok"')).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /constructor/ }),
    ).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /prototype/ }),
    ).toBeInTheDocument()
    expect(
      rendered.getByRole('button', { name: /__proto__/ }),
    ).toBeInTheDocument()

    fireEvent.click(rendered.getByRole('button', { name: /items/ }))
    fireEvent.click(rendered.getByRole('button', { name: /^0\b/ }))
    expect(
      rendered.getAllByRole('button', { name: /constructor/ }).length,
    ).toBeGreaterThan(1)
    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
  })

  it('should keep the data explorer up when cached JSON is nested thousands of levels deep', async () => {
    await storeQuery(['deep-resource'], nest(DEEP_NESTING))

    const rendered = renderDevtools()

    expect(() =>
      openQuery(rendered, /Query key \["deep-resource"\]/),
    ).not.toThrow()

    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
    expect(rendered.getByText('Query Details')).toBeInTheDocument()

    const nested = rendered.getAllByRole('button', { name: /nested/ })
    expect(nested.length).toBeGreaterThan(0)
    expect(() => fireEvent.click(nested[0]!)).not.toThrow()
    expect(
      rendered.getAllByRole('button', { name: /nested/ }).length,
    ).toBeGreaterThan(1)
  })

  it('should not throw when copying cached JSON that contains those keys', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await storeQuery(['remote-resource'], JSON.parse(forbiddenKeyJson))

    const rendered = renderDevtools()
    openQuery(rendered, /Query key \["remote-resource"\]/)

    const copyButtons = rendered.getAllByLabelText('Copy object to clipboard')
    expect(copyButtons.length).toBeGreaterThan(0)
    for (const button of copyButtons) {
      expect(() => fireEvent.click(button)).not.toThrow()
    }
    expect(rendered.getByText('Query Details')).toBeInTheDocument()
    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
  })

  it('should keep query details up when the query key contains those keys', async () => {
    const filters = JSON.parse(forbiddenKeyJson)
    await storeQuery(['search', filters], { name: 'result' })

    const rendered = renderDevtools()

    expect(() => openQuery(rendered, /Query key \["search"/)).not.toThrow()

    expect(rendered.getByText('Query Details')).toBeInTheDocument()
    expect(rendered.getByText('"result"')).toBeInTheDocument()
    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
  })

  it('should keep mutation details up when the mutation key contains those keys', async () => {
    const rendered = renderDevtools()
    fireEvent.click(rendered.getByText('Mutations'))

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: ['save', JSON.parse(forbiddenKeyJson)],
      mutationFn: () => Promise.resolve({ name: 'saved' }),
    })
    mutation.execute({})
    await vi.advanceTimersByTimeAsync(0)

    expect(() =>
      fireEvent.click(rendered.getByLabelText(/Mutation submitted at/)),
    ).not.toThrow()

    expect(rendered.getByText('Mutation Details')).toBeInTheDocument()
    expect(
      rendered.getByLabelText('Tanstack query devtools'),
    ).toBeInTheDocument()
  })
})
