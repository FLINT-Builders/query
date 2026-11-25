import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { fireEvent, render } from '@solidjs/testing-library'
import DevtoolsComponent from '../DevtoolsComponent'
import DevtoolsPanelComponent from '../DevtoolsPanelComponent'
import type { Mutation, Query } from '@tanstack/query-core'

vi.mock('solid-transition-group', () => ({
  TransitionGroup: (props: { children: unknown }) => props.children,
}))

vi.mock('goober', () => {
  let counter = 0
  const css = Object.assign(() => `tsqd-${++counter}`, {
    bind: () => css,
  })
  return { css, glob: () => {}, setup: () => {} }
})

const STORAGE_PREFIX = 'TanstackQueryDevtools'

// Names that exist on Object.prototype and are therefore visible through a
// normal property lookup on the sort maps. `constructor` is the name called
// out by the report; the others are the same lookup.
const inheritedSortNames = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
] as const

const defaultMutationState: Mutation['state'] = {
  context: undefined,
  data: undefined,
  error: null,
  failureCount: 0,
  failureReason: null,
  isPaused: false,
  status: 'idle',
  variables: undefined,
  submittedAt: 0,
}

describe('inherited devtools sort names', () => {
  let queryClient: QueryClient
  let previousRootFontSize = ''

  beforeEach(() => {
    previousRootFontSize = document.documentElement.style.fontSize
    document.documentElement.style.fontSize = '16px'
    localStorage.clear()
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
    queryClient = new QueryClient()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    queryClient.clear()
    onlineManager.setOnline(true)
    document.documentElement.style.fontSize = previousRootFontSize
  })

  function store(key: string, value: string) {
    localStorage.setItem(`${STORAGE_PREFIX}.${key}`, value)
  }

  function seedQueries(): { older: Query; newer: Query } {
    const older = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['a-query'],
    })
    older.setState({
      data: 'older',
      dataUpdatedAt: 1_000,
      status: 'success',
      fetchStatus: 'idle',
    })
    const newer = queryClient.getQueryCache().build(queryClient, {
      queryKey: ['b-query'],
    })
    newer.setState({
      data: 'newer',
      dataUpdatedAt: 2_000,
      status: 'success',
      fetchStatus: 'idle',
    })
    return { older, newer }
  }

  function seedMutations(): { success: Mutation; errored: Mutation } {
    // Insert the successful mutation first. Default status sort places the
    // errored mutation ahead of it, which is the opposite of insertion order.
    const success = queryClient
      .getMutationCache()
      .build(
        queryClient,
        { mutationKey: ['a-mutation'] },
        { ...defaultMutationState, status: 'success', submittedAt: 2_000 },
      )
    const errored = queryClient
      .getMutationCache()
      .build(
        queryClient,
        { mutationKey: ['b-mutation'] },
        { ...defaultMutationState, status: 'error', submittedAt: 1_000 },
      )
    return { success, errored }
  }

  function rowTexts(): Array<string> {
    return Array.from(document.querySelectorAll('.tsqd-query-hash'), (node) =>
      node.textContent.trim(),
    )
  }

  function renderFloating() {
    return render(() => (
      <DevtoolsComponent
        client={queryClient}
        queryFlavor="TanStack Query"
        version="5"
        onlineManager={onlineManager}
      />
    ))
  }

  function renderEmbedded() {
    return render(() => (
      <DevtoolsPanelComponent
        client={queryClient}
        queryFlavor="TanStack Query"
        version="5"
        onlineManager={onlineManager}
      />
    ))
  }

  describe.each([
    ['floating devtools', renderFloating, true],
    ['embedded devtools panel', renderEmbedded, false],
  ] as const)('%s', (_surface, renderSurface, requiresOpenFlag) => {
    describe('query list', () => {
      it.each(inheritedSortNames)(
        'uses the default status sort when the saved sort name is %s',
        (sortName) => {
          const { older, newer } = seedQueries()
          if (requiresOpenFlag) {
            store('open', 'true')
          }
          store('sort', sortName)

          expect(() => renderSurface()).not.toThrow()

          // Default status sort ranks both queries inactive and then orders
          // by dataUpdatedAt descending, so the newer query is first. An
          // inherited comparator either throws or keeps insertion order.
          expect(rowTexts()).toEqual([newer.queryHash, older.queryHash])
        },
      )

      it('uses the default status sort when the saved sort name is not a sort', () => {
        const { older, newer } = seedQueries()
        if (requiresOpenFlag) {
          store('open', 'true')
        }
        store('sort', 'not-a-sort')

        expect(() => renderSurface()).not.toThrow()
        expect(rowTexts()).toEqual([newer.queryHash, older.queryHash])
      })

      it('still applies an own sort name from storage', () => {
        const { older, newer } = seedQueries()
        if (requiresOpenFlag) {
          store('open', 'true')
        }
        store('sort', 'query hash')

        expect(() => renderSurface()).not.toThrow()
        expect(rowTexts()).toEqual([older.queryHash, newer.queryHash])
      })
    })

    describe('mutation list', () => {
      it.each(inheritedSortNames)(
        'uses the default status sort when the saved mutation sort name is %s',
        (sortName) => {
          const { success, errored } = seedMutations()
          if (requiresOpenFlag) {
            store('open', 'true')
          }
          store('mutationSort', sortName)

          const rendered = renderSurface()
          expect(() => {
            fireEvent.click(rendered.getByText('Mutations'))
          }).not.toThrow()

          const texts = rowTexts()
          expect(texts[0]).toContain(
            JSON.stringify(errored.options.mutationKey),
          )
          expect(texts[1]).toContain(
            JSON.stringify(success.options.mutationKey),
          )
        },
      )

      it('uses the default status sort when the saved mutation sort name is not a sort', () => {
        seedMutations()
        if (requiresOpenFlag) {
          store('open', 'true')
        }
        store('mutationSort', 'not-a-sort')

        const rendered = renderSurface()
        expect(() => {
          fireEvent.click(rendered.getByText('Mutations'))
        }).not.toThrow()

        const texts = rowTexts()
        expect(texts[0]).toContain('["b-mutation"]')
        expect(texts[1]).toContain('["a-mutation"]')
      })

      it('still applies an own mutation sort name from storage', () => {
        seedMutations()
        if (requiresOpenFlag) {
          store('open', 'true')
        }
        store('mutationSort', 'last updated')

        const rendered = renderSurface()
        expect(() => {
          fireEvent.click(rendered.getByText('Mutations'))
        }).not.toThrow()

        const texts = rowTexts()
        expect(texts[0]).toContain('["a-mutation"]')
        expect(texts[1]).toContain('["b-mutation"]')
      })
    })
  })
})
