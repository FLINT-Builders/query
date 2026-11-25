import {
  DestroyRef,
  Injector,
  PLATFORM_ID,
  assertInInjectionContext,
  computed,
  effect,
  inject,
  runInInjectionContext,
  untracked,
} from '@angular/core'
import { QueryClient, onlineManager } from '@tanstack/query-core'
import { isPlatformBrowser } from '@angular/common'
import type { TanstackQueryDevtoolsPanel } from '@tanstack/query-devtools'
import type {
  DevtoolsPanelOptions,
  InjectDevtoolsPanel,
  InjectDevtoolsPanelOptions,
} from './types'

/**
 * Inject a TanStack Query devtools panel and render it in the DOM.
 *
 * Devtools panel allows programmatic control over the devtools, for example if you want to render
 * the devtools as part of your own devtools.
 *
 * Consider `withDevtools` instead if you don't need this.
 * @param injectDevtoolsPanelFn - A function that returns devtools panel options.
 * @param options - Additional configuration
 * @returns DevtoolsPanelRef
 * @see https://tanstack.com/query/v5/docs/framework/angular/devtools
 */
export const injectDevtoolsPanel: InjectDevtoolsPanel = (
  injectDevtoolsPanelFn: () => DevtoolsPanelOptions,
  options?: InjectDevtoolsPanelOptions,
) => {
  !options?.injector && assertInInjectionContext(injectDevtoolsPanel)
  const currentInjector = options?.injector ?? inject(Injector)

  return runInInjectionContext(currentInjector, () => {
    const destroyRef = inject(DestroyRef)
    const isBrowser = isPlatformBrowser(inject(PLATFORM_ID))
    const injectedClient = inject(QueryClient, { optional: true })

    const queryOptions = computed(injectDevtoolsPanelFn)
    let devtools: TanstackQueryDevtoolsPanel | null = null
    // Identifies the only devtools load allowed to mount a panel. Clearing it
    // makes any in-flight load discard its result.
    let pendingLoad: object | null = null

    const destroy = () => {
      pendingLoad = null
      devtools?.unmount()
      devtools = null
    }

    if (!isBrowser)
      return {
        destroy,
      }

    effect(() => {
      const {
        client = injectedClient,
        errorTypes = [],
        onClose,
        hostElement,
      } = queryOptions()

      untracked(() => {
        if (!client) throw new Error('No QueryClient found')
        if (!devtools && hostElement) {
          if (pendingLoad) return
          const load = {}
          pendingLoad = load
          import('@tanstack/query-devtools')
            .then((queryDevtools) => {
              if (pendingLoad !== load) return
              pendingLoad = null

              // Options may have changed while the module was loading, so the
              // panel is created from the current ones rather than those that
              // started the load.
              const {
                client: currentClient = injectedClient,
                errorTypes: currentErrorTypes = [],
                styleNonce,
                shadowDOMTarget,
                onClose: currentOnClose,
                hostElement: currentHostElement,
              } = untracked(queryOptions)
              if (!currentClient || !currentHostElement) return

              devtools = new queryDevtools.TanstackQueryDevtoolsPanel({
                client: currentClient,
                queryFlavor: 'Angular Query',
                version: '5',
                buttonPosition: 'bottom-left',
                position: 'bottom',
                initialIsOpen: true,
                errorTypes: currentErrorTypes,
                styleNonce,
                shadowDOMTarget,
                onClose: currentOnClose,
                onlineManager,
              })
              devtools.mount(currentHostElement.nativeElement)
            })
            .catch((error) => {
              if (pendingLoad === load) pendingLoad = null
              console.error(
                'Install @tanstack/query-devtools or reinstall without --omit=optional.',
                error,
              )
            })
        } else if (devtools && hostElement) {
          devtools.setClient(client)
          devtools.setErrorTypes(errorTypes)
          onClose && devtools.setOnClose(onClose)
        } else if (!hostElement) {
          destroy()
        }
      })
    })

    destroyRef.onDestroy(destroy)

    return {
      destroy,
    }
  })
}
