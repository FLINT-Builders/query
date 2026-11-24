<script lang="ts">
  import PersistQueryClientProvider from '../../src/PersistQueryClientProvider.svelte'
  import Profile from './Profile.svelte'
  import type { QueryClient } from '@tanstack/svelte-query'
  import type { Persister } from '@tanstack/query-persist-client-core'

  let {
    queryClient,
    persister,
    buster,
    showProfile = false,
    fetches = { count: 0 },
    onSuccess,
  }: {
    queryClient: QueryClient
    persister: Persister
    buster: string
    showProfile?: boolean
    fetches?: { count: number }
    onSuccess?: () => void
  } = $props()
</script>

<PersistQueryClientProvider
  client={queryClient}
  persistOptions={{ persister, buster }}
  {onSuccess}
>
  {#if showProfile}
    <Profile {fetches} />
  {:else}
    <div>mounted</div>
  {/if}
</PersistQueryClientProvider>
