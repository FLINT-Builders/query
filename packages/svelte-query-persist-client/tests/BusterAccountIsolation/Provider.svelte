<script lang="ts">
  import PersistQueryClientProvider from '../../src/PersistQueryClientProvider.svelte'
  import Page from './Page.svelte'
  import type { QueryClient, QueryKey } from '@tanstack/svelte-query'
  import type { Persister } from '@tanstack/query-persist-client-core'

  let {
    queryClient,
    persister,
    buster,
    profileKey,
    inboxKey,
    onProfileFetch,
    fetchDelay,
  }: {
    queryClient: QueryClient
    persister: Persister
    buster: string
    profileKey: QueryKey
    inboxKey: QueryKey
    onProfileFetch: () => void
    fetchDelay: number
  } = $props()
</script>

<PersistQueryClientProvider
  client={queryClient}
  persistOptions={{ persister, buster }}
>
  <Page {profileKey} {inboxKey} {onProfileFetch} {fetchDelay} />
</PersistQueryClientProvider>
