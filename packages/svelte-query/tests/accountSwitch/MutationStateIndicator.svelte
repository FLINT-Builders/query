<script lang="ts">
  import { onMount } from 'svelte'
  import type { QueryClient } from '@tanstack/query-core'
  import { useMutationState } from '../../src/index.js'
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
  const options =
    scope === 'inbox'
      ? {
          filters: { mutationKey: ['inbox'] },
          select: (mutation: { state: { variables: unknown } }) =>
            mutation.state.variables,
        }
      : {
          filters: { mutationKey: ['account', accountId] },
          select: (mutation: { state: { variables: unknown } }) =>
            mutation.state.variables,
        }

  // svelte-ignore state_referenced_locally
  const mutationState = useMutationState(options, queryClient)
</script>

<div>account: {accountId}</div>
<div>mutations: {JSON.stringify(mutationState)}</div>
