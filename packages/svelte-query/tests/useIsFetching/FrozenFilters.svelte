<script lang="ts">
  import type { QueryClient, QueryFilters } from '@tanstack/query-core'
  import { useIsFetching } from '../../src/index.js'

  let {
    queryClient,
    filters,
  }: {
    queryClient: QueryClient
    filters: QueryFilters
  } = $props()

  const fetching = useIsFetching(() => filters, queryClient)
</script>

<div data-testid="fetching">{fetching.current}</div>
