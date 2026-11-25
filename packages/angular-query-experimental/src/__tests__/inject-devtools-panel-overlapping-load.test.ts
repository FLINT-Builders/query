import { ElementRef, provideZonelessChangeDetection, signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import { injectDevtoolsPanel } from '../devtools-panel'
import type { Query } from '@tanstack/query-core'

/**
 * Loads the built devtools panel. Requiring it from a dependency keeps
 * Vitest from substituting the server Solid build of the package source.
 * `pnpm --filter @tanstack/query-devtools build` must be run first.
 */
const devtoolsBuild = vi.hoisted(() => {
  const { createRequire } = process.getBuiltinModule('module')
  const { resolve } = process.getBuiltinModule('path')
  const requireFromPackage = createRequire(resolve(process.cwd(), 'package.json'))
  const requireFromNodeModules = createRequire(
    requireFromPackage.resolve('vitest/package.json'),
  )
  return requireFromNodeModules(
    resolve(process.cwd(), '../query-devtools/build/dev.cjs'),
  )
})

vi.mock('@tanstack/query-devtools', () => devtoolsBuild)

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function seedQuery(
  client: QueryClient,
  queryKey: Array<string>,
  marker: string,
  queryFn: () => Promise<{ marker: string }>,
) {
  const query: Query = client.getQueryCache().build(client, {
    queryKey,
    queryFn,
  })
  query.setData({ marker })
  return query
}

function devtoolsPanels(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>('.tsqd-main-panel')]
}

function buttonLabeled(root: ParentNode, label: string) {
  return [...root.querySelectorAll('button')].find((element) => {
    const aria = element.getAttribute('aria-label') ?? ''
    const text = element.textContent?.trim() ?? ''
    return aria === label || text === label || aria.includes(label)
  })
}

describe('injectDevtoolsPanel overlapping loads', () => {
  beforeEach(() => {
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
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    })
  })

  afterEach(() => {
    try {
      TestBed.resetTestingModule()
    } catch {
      // A stale panel can be stored after its mount threw. The assertions
      // above are the ones that record the leaked client.
    }
    document.body.replaceChildren()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('keeps refetch, edit, and clear on the client that is current when the panel load finishes', async () => {
    const previousClient = createClient()
    const currentClient = createClient()
    const refetchPrevious = vi.fn(() =>
      Promise.resolve({ marker: 'refetched-previous-account' }),
    )
    const refetchCurrent = vi.fn(() =>
      Promise.resolve({ marker: 'refetched-current-account' }),
    )
    const previousQuery = seedQuery(
      previousClient,
      ['previous-account'],
      'previous-account-cache',
      refetchPrevious,
    )
    const currentQuery = seedQuery(
      currentClient,
      ['current-account'],
      'current-account-cache',
      refetchCurrent,
    )
    const hostElement = new ElementRef(document.createElement('div'))
    document.body.appendChild(hostElement.nativeElement)
    const client = signal(previousClient)

    TestBed.runInInjectionContext(() => {
      return injectDevtoolsPanel(() => ({
        client: client(),
        hostElement,
      }))
    })

    TestBed.tick()
    client.set(currentClient)
    TestBed.tick()
    await vi.dynamicImportSettled()
    await vi.waitFor(() => {
      expect(devtoolsPanels(hostElement.nativeElement).length).toBeGreaterThan(
        0,
      )
    })

    const host = hostElement.nativeElement
    const panels = devtoolsPanels(host)
    expect(panels).toHaveLength(1)
    expect(host.textContent).not.toContain(previousQuery.queryHash)
    expect(host.textContent).toContain(currentQuery.queryHash)
    const panel = panels[0]!

    const previousButton = buttonLabeled(panel, previousQuery.queryHash)
    const currentButton = buttonLabeled(panel, currentQuery.queryHash)
    ;(currentButton ?? previousButton)?.click()
    await vi.waitFor(() => {
      expect(buttonLabeled(panel, 'Refetch')).toBeTruthy()
    })
    buttonLabeled(panel, 'Refetch')!.click()
    await vi.waitFor(() => {
      expect(refetchPrevious.mock.calls.length + refetchCurrent.mock.calls.length)
        .toBeGreaterThan(0)
    })

    buttonLabeled(panel, 'Bulk Edit Data')?.click()
    const form = panel.querySelector('form')
    const textarea = form?.querySelector('textarea')
    if (textarea && form) {
      textarea.value = JSON.stringify({ marker: 'edited-from-panel' })
      form.requestSubmit()
    }
    buttonLabeled(panel, 'Clear query cache')?.click()

    expect(refetchPrevious).not.toHaveBeenCalled()
    expect(previousClient.getQueryData(['previous-account'])).toEqual({
      marker: 'previous-account-cache',
    })
    expect(refetchCurrent).toHaveBeenCalled()
    expect(currentClient.getQueryCache().findAll()).toHaveLength(0)
  })
})
