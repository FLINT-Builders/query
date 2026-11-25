import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createEffect } from 'solid-js'
import { createLocalStorage } from '@solid-primitives/storage'
import { PiPProvider, usePiPWindow } from '../../contexts'

type FakePipWindowOverrides = {
  document?: Document
  innerWidth?: number
  innerHeight?: number
}

function stubPipWindow(overrides: FakePipWindowOverrides = {}) {
  const pipDocument =
    overrides.document ?? document.implementation.createHTMLDocument('PiP')
  const fakeWindow = {
    document: pipDocument,
    innerWidth: overrides.innerWidth ?? 800,
    innerHeight: overrides.innerHeight ?? 600,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }
  const open = vi.fn(() => fakeWindow)
  vi.stubGlobal('open', open)
  return { pipDocument, fakeWindow, open }
}

describe('PiPContext', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  function renderAndAct(
    action: (pip: ReturnType<typeof usePiPWindow>) => void,
    options: {
      disabled?: boolean
      initialStorage?: Record<string, string>
    } = {},
  ) {
    Object.entries(options.initialStorage ?? {}).forEach(([key, value]) => {
      localStorage.setItem(key, value)
    })
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

  describe('usePiPWindow', () => {
    it('should throw when used outside a "PiPProvider"', () => {
      function PiPProbe() {
        usePiPWindow()
        return null
      }

      expect(() => render(() => <PiPProbe />)).toThrow(
        'usePiPWindow must be used within a PiPProvider',
      )
    })
  })

  describe('"requestPipWindow"', () => {
    it('should call "window.open" with the expected target and features', () => {
      const { open } = stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480))

      expect(open).toHaveBeenCalledWith(
        '',
        expect.stringMatching(/^TSQD-Devtools-Panel-[0-9a-f]{32}$/),
        'width=640,height=480,popup',
      )
    })

    it('should use a new window name for every open', () => {
      const { open, fakeWindow } = stubPipWindow()

      renderAndAct(
        (pip) => {
          pip().requestPipWindow(640, 480)
          const pagehideHandler = fakeWindow.addEventListener.mock.calls.find(
            ([event]) => event === 'pagehide',
          )?.[1]
          pagehideHandler?.()
          pip().requestPipWindow(640, 480)
        },
        { disabled: true },
      )

      const names = open.mock.calls.map((call) => (call as Array<unknown>)[1])
      expect(names).toHaveLength(2)
      expect(names[0]).not.toBe(names[1])
    })

    it('should set the "pipWindow" signal to the opened window', () => {
      const { fakeWindow } = stubPipWindow()
      let observed: Window | null = null

      renderAndAct((pip) => {
        pip().requestPipWindow(640, 480)
        observed = pip().pipWindow
      })

      expect(observed).toBe(fakeWindow)
    })

    it('should persist "pip_open" as "true" to "localStore" after a successful open', () => {
      stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480))

      expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
        'true',
      )
    })

    it('should set the PiP document title to "TanStack Query Devtools"', () => {
      const { pipDocument } = stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480))

      expect(pipDocument.title).toBe('TanStack Query Devtools')
    })

    it('should reset the PiP document body margin to "0"', () => {
      const { pipDocument } = stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480))

      expect(pipDocument.body.style.margin).toMatch(/^0(px)?$/)
    })

    describe('when the returned window is not a new blank popup', () => {
      function expectRefused(
        observed: Array<Window | null>,
        consoleError: ReturnType<typeof vi.spyOn>,
      ) {
        expect(observed).toEqual([null])
        expect(consoleError).toHaveBeenCalledWith(
          'Refusing to open the devtools in picture-in-picture mode: the popup returned by the browser is not a new blank window.',
        )
        expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
          'false',
        )
      }

      it('should leave existing nodes in the returned document "head" untouched', () => {
        const { pipDocument, fakeWindow } = stubPipWindow()
        const meta = pipDocument.createElement('meta')
        pipDocument.head.appendChild(meta)
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {})
        const observed: Array<Window | null> = []

        try {
          renderAndAct((pip) => {
            pip().requestPipWindow(640, 480)
            observed.push(pip().pipWindow)
          })

          expect(pipDocument.head.contains(meta)).toBe(true)
          expect(pipDocument.title).toBe('PiP')
          expect(fakeWindow.addEventListener).not.toHaveBeenCalled()
          expectRefused(observed, consoleError)
        } finally {
          consoleError.mockRestore()
        }
      })

      it('should leave existing nodes in the returned document "body" untouched', () => {
        const { pipDocument } = stubPipWindow()
        const leftover = pipDocument.createElement('div')
        leftover.id = 'leftover'
        pipDocument.body.appendChild(leftover)
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {})
        const observed: Array<Window | null> = []

        try {
          renderAndAct((pip) => {
            pip().requestPipWindow(640, 480)
            observed.push(pip().pipWindow)
          })

          expect(pipDocument.body.querySelector('#leftover')).toBe(leftover)
          expectRefused(observed, consoleError)
        } finally {
          consoleError.mockRestore()
        }
      })

      it('should not render into the calling window when it is returned', () => {
        const open = vi.fn(() => window)
        vi.stubGlobal('open', open)
        const marker = document.createElement('main')
        document.body.appendChild(marker)
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {})
        const observed: Array<Window | null> = []

        try {
          renderAndAct((pip) => {
            pip().requestPipWindow(640, 480)
            observed.push(pip().pipWindow)
          })

          expect(open).toHaveBeenCalledTimes(1)
          expect(document.body.contains(marker)).toBe(true)
          expectRefused(observed, consoleError)
        } finally {
          consoleError.mockRestore()
          marker.remove()
        }
      })

      it('should not auto-open into a non-blank window from "pip_open"', () => {
        const { pipDocument } = stubPipWindow()
        const leftover = pipDocument.createElement('div')
        pipDocument.body.appendChild(leftover)
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {})

        try {
          renderAndAct(() => {}, {
            initialStorage: { 'TanstackQueryDevtools.pip_open': 'true' },
          })

          expect(pipDocument.body.contains(leftover)).toBe(true)
          expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
            'false',
          )
        } finally {
          consoleError.mockRestore()
        }
      })
    })
  })

  describe('opener "pagehide"', () => {
    function dispatchOpenerPageHide(persisted: boolean) {
      const event = new Event('pagehide')
      Object.defineProperty(event, 'persisted', { value: persisted })
      window.dispatchEvent(event)
    }

    it('should close the popup when the opener is unloaded', () => {
      const { fakeWindow } = stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480), {
        disabled: true,
      })
      dispatchOpenerPageHide(false)

      expect(fakeWindow.close).toHaveBeenCalledTimes(1)
      expect(fakeWindow.removeEventListener).toHaveBeenCalledWith(
        'pagehide',
        expect.any(Function),
      )
    })

    it('should keep the popup open when the opener enters the back/forward cache', () => {
      const { fakeWindow } = stubPipWindow()

      renderAndAct((pip) => pip().requestPipWindow(640, 480), {
        disabled: true,
      })
      dispatchOpenerPageHide(true)

      expect(fakeWindow.close).not.toHaveBeenCalled()
      dispatchOpenerPageHide(false)
    })
  })

  describe('styleSheet propagation', () => {
    type FakeCssRule = { readonly cssText: string }
    type FakeStyleSheet = {
      readonly cssRules?: ArrayLike<FakeCssRule>
      readonly href?: string | null
      readonly type?: string
      readonly media?: { toString: () => string }
      readonly ownerNode?: Element | null
    }

    function makeCssRules(...cssTexts: Array<string>): ArrayLike<FakeCssRule> {
      return cssTexts.map((cssText) => ({ cssText }))
    }

    function stubParentStyleSheet(sheet: FakeStyleSheet) {
      return vi
        .spyOn(document, 'styleSheets', 'get')
        .mockReturnValue([sheet] as unknown as StyleSheetList)
    }

    it('should copy parent stylesheets as "<style>" with the same id into the PiP document head', () => {
      const sourceStyle = document.createElement('style')
      sourceStyle.id = 'tsqd-source'
      const sheetSpy = stubParentStyleSheet({
        cssRules: makeCssRules('.tsqd { color: red; }'),
        ownerNode: sourceStyle,
      })
      const { pipDocument } = stubPipWindow()

      try {
        renderAndAct((pip) => pip().requestPipWindow(640, 480))

        const copied = pipDocument.head.querySelector('style#tsqd-source')
        expect(copied).not.toBeNull()
        expect(copied?.textContent).toBe('.tsqd { color: red; }')
      } finally {
        sheetSpy.mockRestore()
      }
    })

    it('should fall back to a "<link>" for cross-origin stylesheets whose "cssRules" throw', () => {
      const sheetSpy = stubParentStyleSheet({
        get cssRules(): CSSRuleList {
          throw new DOMException('blocked', 'SecurityError')
        },
        href: 'https://example.com/external.css',
        type: 'text/css',
        media: { toString: () => 'all' },
      })
      const { pipDocument } = stubPipWindow()

      try {
        renderAndAct((pip) => pip().requestPipWindow(640, 480))

        const link = pipDocument.head.querySelector<HTMLLinkElement>(
          'link[href="https://example.com/external.css"]',
        )
        expect(link).not.toBeNull()
        expect(link?.rel).toBe('stylesheet')
      } finally {
        sheetSpy.mockRestore()
      }
    })

    it('should skip the "<link>" fallback when the cross-origin stylesheet has no "href"', () => {
      const sheetSpy = stubParentStyleSheet({
        get cssRules(): CSSRuleList {
          throw new DOMException('blocked', 'SecurityError')
        },
        href: null,
        type: 'text/css',
        media: { toString: () => 'all' },
      })
      const { pipDocument } = stubPipWindow()

      try {
        renderAndAct((pip) => pip().requestPipWindow(640, 480))

        expect(pipDocument.head.querySelector('link')).toBeNull()
        expect(pipDocument.head.querySelector('style')).toBeNull()
      } finally {
        sheetSpy.mockRestore()
      }
    })
  })

  describe('"pagehide" lifecycle', () => {
    it('should reset the "pipWindow" signal and "pip_open" when the "pagehide" event fires on the opened window', () => {
      const { fakeWindow } = stubPipWindow()
      const observed: Array<Window | null> = []

      renderAndAct(
        (pip) => {
          pip().requestPipWindow(640, 480)
          observed.push(pip().pipWindow)
          const pagehideHandler = fakeWindow.addEventListener.mock.calls.find(
            ([event]) => event === 'pagehide',
          )?.[1]
          pagehideHandler?.()
          observed.push(pip().pipWindow)
        },
        { disabled: true },
      )

      expect(observed).toEqual([fakeWindow, null])
      expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
        'false',
      )
    })
  })

  describe('"closePipWindow"', () => {
    it('should be a noop when no window is open', () => {
      const { fakeWindow } = stubPipWindow()

      renderAndAct((pip) => {
        pip().closePipWindow()
      })

      expect(fakeWindow.close).not.toHaveBeenCalled()
    })

    it('should call "close" on the opened window and reset the "pipWindow" signal', () => {
      const { fakeWindow } = stubPipWindow()
      const observed: Array<Window | null> = []

      renderAndAct(
        (pip) => {
          pip().requestPipWindow(640, 480)
          observed.push(pip().pipWindow)
          pip().closePipWindow()
          observed.push(pip().pipWindow)
        },
        { disabled: true },
      )

      expect(fakeWindow.close).toHaveBeenCalledTimes(1)
      expect(observed).toEqual([fakeWindow, null])
    })

    it('should call "close" only once when "closePipWindow" runs twice in a row', () => {
      const { fakeWindow } = stubPipWindow()

      renderAndAct(
        (pip) => {
          pip().requestPipWindow(640, 480)
          pip().closePipWindow()
          pip().closePipWindow()
        },
        { disabled: true },
      )

      expect(fakeWindow.close).toHaveBeenCalledTimes(1)
    })

    it('should reset "pip_open" in "localStore" so the auto-open createEffect does not reopen the window', () => {
      stubPipWindow()

      renderAndAct(
        (pip) => {
          pip().requestPipWindow(640, 480)
          pip().closePipWindow()
        },
        { disabled: true },
      )

      expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
        'false',
      )
    })
  })

  describe('"pip_open" auto-open createEffect', () => {
    it('should auto-open a PiP window when "pip_open" is "true" on mount', () => {
      const { open } = stubPipWindow()

      renderAndAct(() => {}, {
        initialStorage: { 'TanstackQueryDevtools.pip_open': 'true' },
      })

      expect(open).toHaveBeenCalled()
    })

    it('should not auto-open a PiP window when "disabled" is true', () => {
      const { open } = stubPipWindow()

      renderAndAct(() => {}, {
        disabled: true,
        initialStorage: { 'TanstackQueryDevtools.pip_open': 'true' },
      })

      expect(open).not.toHaveBeenCalled()
    })

    it('should reset "pip_open"/"open" and log when "window.open" returns null on auto-open', () => {
      vi.stubGlobal(
        'open',
        vi.fn(() => null),
      )
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})

      try {
        renderAndAct(() => {}, {
          initialStorage: { 'TanstackQueryDevtools.pip_open': 'true' },
        })

        expect(consoleError).toHaveBeenCalledWith(
          'Failed to open popup. Please allow popups for this site to view the devtools in picture-in-picture mode.',
        )
        expect(localStorage.getItem('TanstackQueryDevtools.pip_open')).toBe(
          'false',
        )
        expect(localStorage.getItem('TanstackQueryDevtools.open')).toBe('false')
      } finally {
        consoleError.mockRestore()
      }
    })

    it('should re-throw non-"PipOpenError" errors from "window.open" on auto-open', () => {
      vi.stubGlobal(
        'open',
        vi.fn(() => {
          throw new Error('unexpected')
        }),
      )

      expect(() =>
        renderAndAct(() => {}, {
          initialStorage: { 'TanstackQueryDevtools.pip_open': 'true' },
        }),
      ).toThrow('unexpected')
    })
  })

  describe('"#_goober" MutationObserver', () => {
    function stubMutationObserver() {
      let observerCallback: MutationCallback | undefined
      const observeSpy = vi.fn()
      const disconnectSpy = vi.fn()
      class FakeMutationObserver {
        observe = observeSpy
        disconnect = disconnectSpy
        takeRecords = () => []
        constructor(cb: MutationCallback) {
          observerCallback = cb
        }
      }
      vi.stubGlobal('MutationObserver', FakeMutationObserver)
      return {
        observeSpy,
        disconnectSpy,
        fire: () => observerCallback?.([], {} as MutationObserver),
      }
    }

    it('should observe the parent "#_goober" style for childList and subtree mutations', () => {
      const gooberStyle = document.createElement('style')
      gooberStyle.id = '_goober'
      gooberStyle.textContent = '.initial { color: red; }'
      document.head.appendChild(gooberStyle)
      const { observeSpy } = stubMutationObserver()
      stubPipWindow()

      try {
        renderAndAct((pip) => pip().requestPipWindow(640, 480), {
          disabled: true,
        })

        expect(observeSpy).toHaveBeenCalledWith(gooberStyle, {
          childList: true,
          subtree: true,
          characterDataOldValue: true,
        })
      } finally {
        gooberStyle.remove()
      }
    })

    it('should copy parent "#_goober" "textContent" into the PiP mirror when the observer fires', () => {
      const gooberStyle = document.createElement('style')
      gooberStyle.id = '_goober'
      gooberStyle.textContent = '.initial { color: red; }'
      document.head.appendChild(gooberStyle)
      const { fire } = stubMutationObserver()
      const { pipDocument } = stubPipWindow()

      try {
        const pipGooberStyle = pipDocument.createElement('style')
        pipGooberStyle.id = '_goober'

        renderAndAct(
          (pip) => {
            pip().requestPipWindow(640, 480)
            // `requestPipWindow` only renders into a blank popup, so install
            // the goober mirror style after that point.
            pipDocument.head.appendChild(pipGooberStyle)
          },
          { disabled: true },
        )

        gooberStyle.textContent = '.next { color: blue; }'
        fire()

        expect(pipGooberStyle.textContent).toBe('.next { color: blue; }')
      } finally {
        gooberStyle.remove()
      }
    })
  })
})
