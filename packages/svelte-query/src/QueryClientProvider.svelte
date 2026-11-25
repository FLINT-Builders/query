<script lang="ts">
  import { QueryClient } from '@tanstack/query-core'
  import { setQueryClientContext } from './context.js'
  import type { QueryClientProviderProps } from './types.js'

  const { client = new QueryClient(), children }: QueryClientProviderProps =
    $props()

  $effect(() => {
    const mounted = client
    mounted.mount()
    return () => mounted.unmount()
  })

  setQueryClientContext(() => client)
</script>

{@render children()}
