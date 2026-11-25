<script lang="ts">
  import type { QueryClient } from '@tanstack/query-core'
  import { setQueryClientContext } from '../../src/context.js'
  import {
    useIsFetching,
    useIsMutating,
    useMutationState,
  } from '../../src/index.js'

  type Props = {
    accountId: string
    queryClient: QueryClient
  }

  let { accountId, queryClient }: Props = $props()

  // Stays mounted across an account switch. The signed-in account id is part
  // of the filter, and that account's client is passed to each helper.
  setQueryClientContext(queryClient)

  const isMutating = useIsMutating(
    { mutationKey: ['account', accountId] },
    queryClient,
  )
  const isFetching = useIsFetching(
    { queryKey: ['account', accountId] },
    queryClient,
  )
  const pendingMutations = useMutationState(
    {
      filters: { mutationKey: ['account', accountId], status: 'pending' },
      select: (mutation) => mutation.options.mutationKey,
    },
    queryClient,
  )
</script>

<p>account: {accountId}</p>
<p>isMutating: {isMutating.current}</p>
<p>isFetching: {isFetching.current}</p>
<p>pendingMutations: {JSON.stringify(pendingMutations)}</p>
