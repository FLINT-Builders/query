import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createEffect } from 'solid-js'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { createLocalStorage } from '@solid-primitives/storage'
import { Devtools } from '../../Devtools'
import {
  PiPProvider,
  QueryDevtoolsContext,
  ThemeContext,
  usePiPWindow,
} from '../../contexts'

// HTML Standard "window open steps": an empty URL does not navigate an
// existing navigable, and choosing a navigable returns one whose target name
// already matches. Chrome 157 follows that for this popup name: opening an
// empty URL with the features string returns the existing same-origin window,
// including the caller when its name is that target.
const POPUP_NAME = 'TSQD-Devtools-Panel'

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

type ApplicationMarkers = {
  head: HTMLMetaElement
  app: HTMLElement
}

function seedApplication(doc: Document): ApplicationMarkers {
  doc.title = 'Application'
  const head = doc.createElement('meta')
  head.setAttribute('name', 'application-head')
  head.setAttribute('content', 'keep')
  doc.head.appendChild(head)
  const app = doc.createElement('main')
  app.id = 'application-root'
  app.textContent = 'application'
  doc.body.appendChild(app)
  return { head, app }
}

function expectApplicationIntact(doc: Document, markers: ApplicationMarkers) {
  expect(doc.head.contains(markers.head)).toBe(true)
  expect(doc.body.contains(markers.app)).toBe(true)
  expect(markers.app.textContent).toBe('application')
  expect(doc.title).toBe('Application')
}

function blankPopup(name: string): Window {
  const popupDocument = document.implementation.createHTMLDocument('')
  popupDocument.title = ''
  const popup = {
    name,
    document: popupDocument,
    closed: false,
    close: vi.fn(),
    focus: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  return popup as unknown as Window
}

/**
 * Stand-in for the browser's named-navigable lookup. `extra` holds familiar
 * same-origin windows other than the caller. A second call with the same
 * target returns the same navigable, matching "find a navigable by target
 * name". `noopener` yields null for a normal target (window open step 18).
 */
function installNamedWindowOpen(extra: Map<string, Window> = new Map()) {
  const open = vi.fn((url: string, target?: string, features?: string) => {
    const name = target ?? ''
    const noopener = /(?:^|,)\s*noopener\b/i.test(features ?? '')
    let chosen: Window | null = null
    if (name === '' || name.toLowerCase() === '_self') {
      chosen = window
    } else if (name.toLowerCase() !== '_blank') {
      if (window.name === name) chosen = window
      else chosen = extra.get(name) ?? null
    }
    if (!chosen) {
      chosen = blankPopup(name === '_blank' ? '' : name)
      if (name !== '' && name.toLowerCase() !== '_blank')
        extra.set(name, chosen)
    } else if (url) {
      // A non-empty URL would navigate the existing navigable. The devtools
      // pass an empty URL, which must leave the document in place.
      chosen = extra.get(name) ?? chosen
    }
    if (
      noopener &&
      !['_self', '_parent', '_top'].includes(name.toLowerCase())
    ) {
      return null
    }
    return chosen
  })
  vi.stubGlobal('open', open)
  return open
}

function renderPiP(
  action: (pip: ReturnType<typeof usePiPWindow>) => void,
  options: { disabled?: boolean; pipOpen?: boolean } = {},
) {
  if (options.pipOpen) {
    localStorage.setItem('TanstackQueryDevtools.pip_open', 'true')
  }
  render(() => {
    const [localStore, setLocalStore] = createLocalStorage({
      prefix: 'TanstackQueryDevtools',
    })
    return (
      <PiPProvider
        localStore={localStore}
        setLocalStore={setLocalStore}
        disabled={options.disabled}
      >
        <PiPActor run={action} />
      </PiPProvider>
    )
  })
}

function PiPActor(props: {
  run: (pip: ReturnType<typeof usePiPWindow>) => void
}) {
  const pip = usePiPWindow()
  let hasRun = false
  createEffect(() => {
    pip()
    if (!hasRun) {
      hasRun = true
      props.run(pip)
    }
  })
  return null
}

function renderDevtools(options: { pipOpen?: boolean } = {}) {
  if (options.pipOpen) {
    localStorage.setItem('TanstackQueryDevtools.pip_open', 'true')
  }
  const queryClient = new QueryClient()
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

function withCallerApplication(
  name: string,
  run: (markers: ApplicationMarkers) => void,
) {
  const previousName = window.name
  const previousTitle = document.title
  window.name = name
  const markers = seedApplication(document)
  const sheets = vi
    .spyOn(document, 'styleSheets', 'get')
    .mockReturnValue([] as unknown as StyleSheetList)
  let intact = false
  try {
    let thrown: unknown
    try {
      run(markers)
    } catch (error) {
      thrown = error
    }
    intact =
      document.head.contains(markers.head) &&
      document.body.contains(markers.app) &&
      markers.app.textContent === 'application' &&
      document.title === 'Application'
    if (intact && thrown) throw thrown
    return intact
  } finally {
    sheets.mockRestore()
    window.name = previousName
    if (!document.head.contains(markers.head))
      document.head.appendChild(markers.head)
    if (!document.body.contains(markers.app))
      document.body.appendChild(markers.app)
    markers.app.remove()
    markers.head.remove()
    document.title = previousTitle
  }
}

describe('picture-in-picture window name reuse', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  describe('requestPipWindow', () => {
    it('does not erase the application document when the popup name is already this window', () => {
      installNamedWindowOpen()

      expect(
        withCallerApplication(POPUP_NAME, () => {
          renderPiP((pip) => pip().requestPipWindow(640, 480))
        }),
      ).toBe(true)
    })

    it('does not erase another same-origin application window returned for the popup name', () => {
      const other = blankPopup(POPUP_NAME)
      const markers = seedApplication(other.document)
      installNamedWindowOpen(new Map([[POPUP_NAME, other]]))

      expect(
        withCallerApplication('', () => {
          renderPiP((pip) => pip().requestPipWindow(640, 480))
          expectApplicationIntact(other.document, markers)
        }),
      ).toBe(true)
    })

    it('does not erase the application document when a later lookup returns it', () => {
      const blank = blankPopup('blank')
      let lookups = 0
      vi.stubGlobal(
        'open',
        vi.fn(() => {
          lookups += 1
          // First resolution is a new blank popup. A fix that looks the name
          // up again before clearing must not clear the application window
          // that now owns the name.
          if (lookups === 1) return blank
          return window
        }),
      )

      expect(
        withCallerApplication(POPUP_NAME, () => {
          renderPiP((pip) => pip().requestPipWindow(640, 480))
        }),
      ).toBe(true)
    })
  })

  describe('pip_open reload', () => {
    it('does not erase the application document when pip_open reopens into this window', () => {
      installNamedWindowOpen()

      expect(
        withCallerApplication(POPUP_NAME, () => {
          renderPiP(() => {}, { pipOpen: true })
        }),
      ).toBe(true)
    })

    it('does not erase another application window when pip_open reopens into it', () => {
      const other = blankPopup(POPUP_NAME)
      const markers = seedApplication(other.document)
      installNamedWindowOpen(new Map([[POPUP_NAME, other]]))

      expect(
        withCallerApplication('', () => {
          renderPiP(() => {}, { pipOpen: true })
          expectApplicationIntact(other.document, markers)
        }),
      ).toBe(true)
    })
  })

  describe('picture-in-picture button', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe = vi.fn()
          unobserve = vi.fn()
          disconnect = vi.fn()
        },
      )
    })

    it('does not erase the application document when the button reuses this window', () => {
      installNamedWindowOpen()

      expect(
        withCallerApplication(POPUP_NAME, () => {
          const rendered = renderDevtools()
          fireEvent.click(
            rendered.getByLabelText('Open in picture-in-picture mode'),
          )
        }),
      ).toBe(true)
    })

    it('does not erase another application window when the button reuses that name', () => {
      const other = blankPopup(POPUP_NAME)
      const markers = seedApplication(other.document)
      installNamedWindowOpen(new Map([[POPUP_NAME, other]]))

      expect(
        withCallerApplication('', () => {
          const rendered = renderDevtools()
          fireEvent.click(
            rendered.getByLabelText('Open in picture-in-picture mode'),
          )
          expectApplicationIntact(other.document, markers)
        }),
      ).toBe(true)
    })
  })
})
