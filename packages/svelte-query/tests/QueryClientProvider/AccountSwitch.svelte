<script lang="ts">
  import { QueryClientProvider } from '../../src/index.js'
  import AccountPage from './AccountPage.svelte'
  import AccountSurface from './AccountSurface.svelte'
  import type { QueryClient } from '@tanstack/query-core'

  type AccountAction = {
    accountId: string
    operation: string
  }

  type Props = {
    client: QueryClient
    showFreshPage?: boolean
    mutationFn: (variables: AccountAction) => Promise<string>
  }

  // Mirrors the documented SvelteKit layout: `data.queryClient` is passed
  // straight through, and the layout component stays mounted when that load
  // runs again.
  let { client, showFreshPage = false, mutationFn }: Props = $props()
</script>

<QueryClientProvider {client}>
  <AccountSurface {mutationFn} />
  {#if showFreshPage}
    <AccountPage />
  {/if}
</QueryClientProvider>
