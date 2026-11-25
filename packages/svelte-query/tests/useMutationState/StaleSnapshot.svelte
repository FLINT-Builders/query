<script lang="ts">
  import { useMutationState } from '../../src/index.js'
  import type { QueryClient } from '@tanstack/query-core'
  import type { MutationStateOptions } from '../../src/index.js'

  type AccountVariables = {
    accountId: string
    submittedValue: string
  }

  let {
    client,
    accountId,
    field = 'submittedValue',
    status = 'pending',
  }: {
    client: QueryClient
    accountId: string
    field?: 'accountId' | 'submittedValue' | 'data'
    status?: 'pending' | 'success'
  } = $props()

  // The initial filters are the props from this mount. Later prop updates are
  // written onto this same object by the effect below.
  // svelte-ignore state_referenced_locally
  const options = $state<MutationStateOptions<string>>({
    filters: {
      mutationKey: ['profile', accountId],
      status,
      exact: true,
    },
    select: (mutation) => {
      if (field === 'data') {
        return mutation.state.data as string
      }
      return (mutation.state.variables as AccountVariables)[field]
    },
  })

  // The mounted screen updates the same options object the hook already holds.
  // No mutation-cache event is emitted here.
  $effect(() => {
    options.filters = {
      mutationKey: ['profile', accountId],
      status,
      exact: true,
    }
    options.select = (mutation) => {
      if (field === 'data') {
        return mutation.state.data as string
      }
      return (mutation.state.variables as AccountVariables)[field]
    }
  })

  // svelte-ignore state_referenced_locally
  const selected = useMutationState(options, client)
</script>

<output data-testid="selected">{JSON.stringify(selected)}</output>
