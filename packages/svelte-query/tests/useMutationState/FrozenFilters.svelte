<script lang="ts">
  import type { MutationFilters, QueryClient } from '@tanstack/query-core'
  import { useMutationState } from '../../src/index.js'

  let {
    queryClient,
    filters,
  }: {
    queryClient: QueryClient
    filters: MutationFilters
  } = $props()

  // The filters getter stays live so a later mutation key can be read again.
  // The helper still has to refresh its snapshot when that key changes.
  const payloads = useMutationState(
    {
      get filters() {
        return filters
      },
      select: (mutation) => ({
        variables: mutation.state.variables,
        data: mutation.state.data,
      }),
    },
    queryClient,
  )
</script>

<div data-testid="payloads">{JSON.stringify(payloads)}</div>
