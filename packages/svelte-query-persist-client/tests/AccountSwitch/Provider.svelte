<script lang="ts">
  import PersistQueryClientProvider from '../../src/PersistQueryClientProvider.svelte'
  import Profile from './Profile.svelte'
  import type { Persister } from '@tanstack/query-persist-client-core'
  import type { QueryClient } from '@tanstack/svelte-query'

  let {
    queryClient,
    persister,
    buster,
    showProfile = false,
    onFetch = () => {},
  }: {
    queryClient: QueryClient
    persister: Persister
    buster: string
    showProfile?: boolean
    onFetch?: () => void
  } = $props()
</script>

<PersistQueryClientProvider
  client={queryClient}
  persistOptions={{ persister, buster }}
>
  {#if showProfile}
    <Profile {onFetch} />
  {:else}
    <div>persist-idle</div>
  {/if}
</PersistQueryClientProvider>
