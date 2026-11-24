<script lang="ts">
  import { QueryClient } from '@tanstack/query-core'
  import QueryClientScope from './QueryClientScope.svelte'
  import type { QueryClientProviderProps } from './types.js'

  const { client = new QueryClient(), children }: QueryClientProviderProps =
    $props()

  const currentClient = $derived(client)

  $effect(() => {
    const mountedClient = currentClient
    mountedClient.mount()
    return () => {
      mountedClient.unmount()
    }
  })
</script>

<!-- Context and everything that read it (observers, `useQueryClient` results, hydration) are bound to a
single client, so a new client gets a freshly mounted subtree instead of one still holding the previous. -->
{#key currentClient}
  <QueryClientScope client={currentClient}>
    {@render children()}
  </QueryClientScope>
{/key}
