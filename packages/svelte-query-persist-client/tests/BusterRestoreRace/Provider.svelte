<script lang="ts">
  import PersistQueryClientProvider from '../../src/PersistQueryClientProvider.svelte'
  import type { QueryClient } from '@tanstack/svelte-query'
  import type { Persister } from '@tanstack/query-persist-client-core'

  interface Props {
    client: QueryClient
    persister: Persister
    buster: string
  }

  let { client, persister, buster }: Props = $props()
</script>

<PersistQueryClientProvider {client} persistOptions={{ persister, buster }}>
  <p>persist</p>
</PersistQueryClientProvider>
