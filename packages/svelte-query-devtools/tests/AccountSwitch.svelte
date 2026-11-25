<script lang="ts">
  import { QueryClientProvider } from '@tanstack/svelte-query'
  import SvelteQueryDevtools from '../src/Devtools.svelte'
  import type { QueryClient } from '@tanstack/svelte-query'

  type Props = {
    contextClient: QueryClient
    devtoolsClient?: QueryClient
  }

  let { contextClient, devtoolsClient = undefined }: Props = $props()
</script>

<QueryClientProvider client={contextClient}>
  <SvelteQueryDevtools client={devtoolsClient} initialIsOpen={true} />
</QueryClientProvider>
