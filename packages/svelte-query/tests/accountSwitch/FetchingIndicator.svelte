<script lang="ts">
  import { onMount } from 'svelte'
  import type { QueryClient } from '@tanstack/query-core'
  import { useIsFetching } from '../../src/index.js'
  import type { MountLifetime } from './lifetime.js'

  type Props = {
    accountId: string
    queryClient?: QueryClient
    lifetime: MountLifetime
    /**
     * `account` counts queries for the signed-in account id.
     * `inbox` counts a key that does not include the account id, so only the
     * client argument distinguishes the two accounts.
     */
    scope?: 'account' | 'inbox'
  }

  let { accountId, queryClient, lifetime, scope = 'account' }: Props = $props()

  onMount(() => {
    lifetime.mounts += 1
  })

  // The layout calls the helper once. A later account id or client is a new
  // argument from the parent; this component does not remount to pass it.
  // svelte-ignore state_referenced_locally
  const filters =
    scope === 'inbox'
      ? { queryKey: ['inbox'] }
      : { queryKey: ['account', accountId] }

  // svelte-ignore state_referenced_locally
  const isFetching = useIsFetching(filters, queryClient)
</script>

<div>account: {accountId}</div>
<div>isFetching: {isFetching.current}</div>
