<script lang="ts">
  import { onMount } from 'svelte'
  import type { QueryClient } from '@tanstack/query-core'
  import { useIsMutating } from '../../src/index.js'
  import type { MountLifetime } from './lifetime.js'

  type Props = {
    accountId: string
    queryClient?: QueryClient
    lifetime: MountLifetime
    scope?: 'account' | 'inbox'
  }

  let { accountId, queryClient, lifetime, scope = 'account' }: Props = $props()

  onMount(() => {
    lifetime.mounts += 1
  })

  // svelte-ignore state_referenced_locally
  const filters =
    scope === 'inbox'
      ? { mutationKey: ['inbox'] }
      : { mutationKey: ['account', accountId] }

  // svelte-ignore state_referenced_locally
  const isMutating = useIsMutating(filters, queryClient)
</script>

<div>account: {accountId}</div>
<div>isMutating: {isMutating.current}</div>
