import { isVue2, shallowRef } from 'vue-demi'
import { environmentManager } from '@tanstack/query-core'

import { QueryClient } from './queryClient'
import { getClientKey, getClientSourceKey } from './utils'
import { setupDevtools } from './devtools/devtools'
import type { QueryClientConfig } from './types'
import type { QueryClientSource } from './utils'

type ClientPersister = (client: QueryClient) => [() => void, Promise<void>]

/**
 * Backs the app-level `clientKey` entry with a ref, so composables that are already mounted can follow a client
 * provided later with `app.provide(clientKey, nextClient)`.
 */
function trackProvidedClient(app: any, clientKey: string) {
  const provides: Record<PropertyKey, unknown> | undefined =
    app._context?.provides
  if (!provides) {
    return
  }

  const current = shallowRef(provides[clientKey] as QueryClient | undefined)
  let reads = 0

  Object.defineProperty(provides, clientKey, {
    configurable: true,
    enumerable: true,
    get() {
      reads++
      return current.value
    },
    set(this: object, value: QueryClient | undefined) {
      if (this === provides) {
        current.value = value
        return
      }
      // A component's `provide()` assigns on an object that inherits from the app's provides. It must get its own
      // entry, which shadows the app-level client for that subtree only.
      Object.defineProperty(this, clientKey, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      })
    },
  })

  const source: QueryClientSource = {
    current: () => current.value,
    readsFromApp: (read) => {
      const before = reads
      read()
      return reads !== before
    },
  }
  app.provide(getClientSourceKey(clientKey), source)
}

interface CommonOptions {
  /** Enables the legacy Vue Devtools v6 plugin panel. Prefer `@tanstack/vue-query-devtools` for Vue 3 apps. */
  enableDevtoolsV6Plugin?: boolean
  /**
   * Distinguishes multiple `QueryClient`s provided in the same app — pass the same key to `useQueryClient` to
   * pick this one. Only needed when installing more than one client.
   */
  queryClientKey?: string
  /**
   * Restores a persisted cache before the app mounts. While it runs, `queryClient.isRestoring` is `true`, which
   * suppresses fetches — see `usePersistQueryClient` in `@tanstack/query-persist-client-core` for building one.
   */
  clientPersister?: ClientPersister
  /** Called once `clientPersister`'s returned promise resolves and the cache has finished restoring. */
  clientPersisterOnSuccess?: (client: QueryClient) => void
}

interface ConfigOptions extends CommonOptions {
  /** Options for the `QueryClient` the plugin constructs. Ignored if `queryClient` is also set. */
  queryClientConfig?: QueryClientConfig
}

interface ClientOptions extends CommonOptions {
  /** Use your own `QueryClient` instance instead of having the plugin construct one from `queryClientConfig`. */
  queryClient?: QueryClient
}

export type VueQueryPluginOptions = ConfigOptions | ClientOptions

/**
 * Installs a `QueryClient` on the Vue app, making it available to every descendant component through
 * `useQueryClient` — the Vue equivalent of React's `QueryClientProvider`, but wired up as an app-level plugin
 * instead of a wrapping component.
 *
 * @example
 * ```ts
 * import { createApp } from 'vue'
 * import { VueQueryPlugin } from '@tanstack/vue-query'
 *
 * const app = createApp(App)
 * app.use(VueQueryPlugin)
 * ```
 *
 * @example
 * Pass a `queryClient` you constructed yourself — useful for SSR, where you need a fresh `QueryClient` per
 * request, or when the same instance also needs to be used outside of Vue components:
 * ```ts
 * import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
 *
 * const queryClient = new QueryClient()
 * app.use(VueQueryPlugin, { queryClient })
 * ```
 *
 * @example
 * Or pass `queryClientConfig` to let the plugin construct the `QueryClient` for you, with your own defaults:
 * ```ts
 * app.use(VueQueryPlugin, {
 *   queryClientConfig: {
 *     defaultOptions: { queries: { staleTime: 5 * 1000 } },
 *   },
 * })
 * ```
 */
export const VueQueryPlugin = {
  install: (app: any, options: VueQueryPluginOptions = {}) => {
    const clientKey = getClientKey(options.queryClientKey)
    let client: QueryClient

    if ('queryClient' in options && options.queryClient) {
      client = options.queryClient
    } else {
      const clientConfig =
        'queryClientConfig' in options ? options.queryClientConfig : undefined
      client = new QueryClient(clientConfig)
    }

    if (!environmentManager.isServer()) {
      client.mount()
    }

    let persisterUnmount = () => {
      // noop
    }

    if (options.clientPersister) {
      if (client.isRestoring) {
        client.isRestoring.value = true
      }
      const [unmount, promise] = options.clientPersister(client)
      persisterUnmount = unmount
      promise.then(() => {
        if (client.isRestoring) {
          client.isRestoring.value = false
        }
        options.clientPersisterOnSuccess?.(client)
      })
    }

    const cleanup = () => {
      client.unmount()
      persisterUnmount()
    }

    if (app.onUnmount) {
      app.onUnmount(cleanup)
    } else {
      const originalUnmount = app.unmount
      app.unmount = function vueQueryUnmount() {
        cleanup()
        originalUnmount()
      }
    }

    if (isVue2) {
      app.mixin({
        beforeCreate() {
          // HACK: taken from provide(): https://github.com/vuejs/composition-api/blob/master/src/apis/inject.ts#L30
          if (!this._provided) {
            const provideCache = {}
            Object.defineProperty(this, '_provided', {
              get: () => provideCache,
              set: (v) => Object.assign(provideCache, v),
            })
          }

          this._provided[clientKey] = client

          if (process.env.NODE_ENV === 'development') {
            if (this === this.$root && options.enableDevtoolsV6Plugin) {
              setupDevtools(this, client)
            }
          }
        },
      })
    } else {
      app.provide(clientKey, client)
      trackProvidedClient(app, clientKey)

      if (process.env.NODE_ENV === 'development') {
        if (options.enableDevtoolsV6Plugin) {
          setupDevtools(app, client)
        }
      }
    }
  },
}
