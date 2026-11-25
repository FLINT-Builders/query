<script lang="ts">
  import type { QueryClient } from '@tanstack/query-core'
  import { QueryClientProvider } from '../../src/index.js'
  import FrozenClientProviderChild from './FrozenClientProviderChild.svelte'

  let { client }: { client: QueryClient } = $props()
</script>

<QueryClientProvider {client}>
  <FrozenClientProviderChild />
</QueryClientProvider>
