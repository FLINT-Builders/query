<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { BROWSER, DEV } from 'esm-env'
  import { onlineManager, useQueryClient } from '@tanstack/svelte-query'
  import type { QueryClient } from '@tanstack/svelte-query'
  import type {
    DevtoolsButtonPosition,
    DevtoolsErrorType,
    DevtoolsPosition,
    TanstackQueryDevtools,
    Theme,
  } from '@tanstack/query-devtools'

  interface DevtoolsOptions {
    /**
     * Set this true if you want the dev tools to default to being open
     */
    initialIsOpen?: boolean
    /**
     * The position of the TanStack logo to open and close the devtools panel.
     * 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'relative'
     *
     * @defaultValue bottom-right
     */
    buttonPosition?: DevtoolsButtonPosition
    /**
     * The position of the Svelte Query devtools panel.
     * 'top' | 'bottom' | 'left' | 'right'
     *
     * @defaultValue bottom
     */
    position?: DevtoolsPosition
    /**
     * Custom instance of QueryClient
     */
    client?: QueryClient
    /**
     * Use this so you can define custom errors that can be shown in the devtools.
     */
    errorTypes?: Array<DevtoolsErrorType>
    /**
     * Use this to pass a nonce to the style tag that is added to the document head. This is useful if you are using a Content Security Policy (CSP) nonce to allow inline styles.
     */
    styleNonce?: string
    /**
     * Use this so you can attach the devtool's styles to specific element in the DOM.
     */
    shadowDOMTarget?: ShadowRoot
    /**
     * Set this to true to hide disabled queries from the devtools panel.
     */
    hideDisabledQueries?: boolean
    /**
     * Set this to 'light', 'dark', or 'system' to change the theme of the devtools panel.
     * Defaults to 'system'.
     */
    theme?: Theme
  }

  let {
    initialIsOpen = false,
    buttonPosition = 'bottom-right',
    position = 'bottom',
    client: clientProp = undefined,
    errorTypes = [],
    styleNonce = undefined,
    shadowDOMTarget = undefined,
    hideDisabledQueries = false,
    theme = 'system',
  }: DevtoolsOptions = $props()

  // Context can only be read during initialization, so the context client is
  // captured here for when the `client` prop is unset later on.
  const contextClient = untrack(() => clientProp)
    ? getOptionalContextClient()
    : useQueryClient()

  const client = $derived.by(() => {
    const resolved = clientProp ?? contextClient
    if (!resolved) {
      throw new Error(
        'No QueryClient was found in Svelte context. Did you forget to wrap your component with QueryClientProvider?',
      )
    }
    return resolved
  })

  function getOptionalContextClient() {
    try {
      return useQueryClient()
    } catch {
      return undefined
    }
  }

  let ref: HTMLDivElement
  let devtools: TanstackQueryDevtools | undefined = $state.raw()

  if (DEV && BROWSER) {
    onMount(() => {
      let destroyed = false
      import('@tanstack/query-devtools').then((m) => {
        if (destroyed) return
        const QueryDevtools = m.TanstackQueryDevtools

        devtools = new QueryDevtools({
          client,
          queryFlavor: 'Svelte Query',
          version: '5',
          onlineManager,
          buttonPosition,
          position,
          initialIsOpen,
          errorTypes,
          styleNonce,
          shadowDOMTarget,
          hideDisabledQueries,
          theme,
        })

        devtools.mount(ref)
      })
      return () => {
        destroyed = true
        devtools?.unmount()
      }
    })

    $effect(() => {
      devtools?.setClient(client)
    })

    $effect(() => {
      devtools?.setButtonPosition(buttonPosition)
    })

    $effect(() => {
      devtools?.setPosition(position)
    })

    $effect(() => {
      devtools?.setInitialIsOpen(initialIsOpen)
    })

    $effect(() => {
      devtools?.setErrorTypes(errorTypes)
    })

    $effect(() => {
      devtools?.setTheme(theme)
    })
  }
</script>

<div class="tsqd-parent-container" bind:this={ref}></div>
