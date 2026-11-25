<script lang="ts">
  import {
    useIsFetching,
    useIsMutating,
    useMutationState,
  } from '../../src/index.js'

  const payloads = useMutationState({
    select: (mutation) => ({
      variables: mutation.state.variables,
      data: mutation.state.data,
    }),
  })
  const pending = useIsMutating()
  const fetching = useIsFetching()
</script>

<div data-testid="payloads">{JSON.stringify(payloads)}</div>
<div data-testid="pending">{pending.current}</div>
<div data-testid="fetching">{fetching.current}</div>
