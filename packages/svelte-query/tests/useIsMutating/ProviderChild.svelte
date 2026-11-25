<script lang="ts">
  import {
    useIsFetching,
    useIsMutating,
    useMutationState,
  } from '../../src/index.js'

  type Props = {
    accountId: string
  }

  let { accountId }: Props = $props()

  // No explicit client: the helpers take the client from context.
  const isMutating = useIsMutating({ mutationKey: ['account', accountId] })
  const isFetching = useIsFetching({ queryKey: ['account', accountId] })
  const pendingMutations = useMutationState({
    filters: { mutationKey: ['account', accountId], status: 'pending' },
    select: (mutation) => mutation.options.mutationKey,
  })
</script>

<p>account: {accountId}</p>
<p>isMutating: {isMutating.current}</p>
<p>isFetching: {isFetching.current}</p>
<p>pendingMutations: {JSON.stringify(pendingMutations)}</p>
