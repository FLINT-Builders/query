<script lang="ts">
  import PersistQueryClientProvider from '../../src/PersistQueryClientProvider.svelte'
  import Page from './Page.svelte'
  import type { OmitKeyof, QueryClient } from '@tanstack/svelte-query'
  import type { PersistQueryClientOptions } from '@tanstack/query-persist-client-core'

  interface Props {
    queryClient: QueryClient
    persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'>
  }

  let { queryClient, persistOptions }: Props = $props()
</script>

<PersistQueryClientProvider client={queryClient} {persistOptions}>
  <Page />
</PersistQueryClientProvider>
