<script lang="ts">
  import { QueryClientProvider } from '../../src/index.js'
  import MutationStateIndicator from './MutationStateIndicator.svelte'
  import type { QueryClient } from '@tanstack/query-core'
  import type { MountLifetime } from './lifetime.js'

  type Props = {
    accountId: string
    queryClient: QueryClient
    lifetime: MountLifetime
    scope?: 'account' | 'inbox'
  }

  let { accountId, queryClient, lifetime, scope = 'account' }: Props = $props()
</script>

<QueryClientProvider client={queryClient}>
  <MutationStateIndicator {accountId} {lifetime} {scope} />
</QueryClientProvider>
