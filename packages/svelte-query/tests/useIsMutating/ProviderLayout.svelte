<script lang="ts">
  import type { QueryClient } from '@tanstack/query-core'
  import { QueryClientProvider } from '../../src/index.js'
  import ProviderChild from './ProviderChild.svelte'

  type Props = {
    accountId: string
    queryClient: QueryClient
  }

  let { accountId, queryClient }: Props = $props()
</script>

<QueryClientProvider client={queryClient}>
  <ProviderChild {accountId} />
</QueryClientProvider>
