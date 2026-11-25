<script lang="ts">
  import type { QueryClient } from '@tanstack/query-core'
  import { useMutationState } from '../../src/index.js'

  let { queryClient }: { queryClient: QueryClient } = $props()

  const payloads = useMutationState(
    () => ({
      filters: { mutationKey: ['profile'] },
      select: (mutation) => ({
        variables: mutation.state.variables,
        data: mutation.state.data,
      }),
    }),
    () => queryClient,
  )
</script>

<div data-testid="payloads">{JSON.stringify(payloads)}</div>
