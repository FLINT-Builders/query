<script lang="ts">
  import type { MutationFilters, QueryClient } from '@tanstack/query-core'
  import { useIsMutating } from '../../src/index.js'

  let {
    queryClient,
    filters,
  }: {
    queryClient: QueryClient
    filters: MutationFilters
  } = $props()

  const pending = useIsMutating(() => filters, queryClient)
</script>

<div data-testid="pending">{pending.current}</div>
