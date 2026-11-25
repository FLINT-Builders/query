<script lang="ts">
  import type { QueryClient } from '@tanstack/query-core'
  import { createMutation, setQueryClientContext } from '../../src/index.js'

  type AccountName = 'previous' | 'next'
  type Variables = { accountId: string; body: string }
  type Payload = { echoed: string }

  type Calls = {
    fn: Array<{ account: AccountName; variables: Variables }>
    success: Array<{
      account: AccountName
      data: Payload
      variables: Variables
    }>
  }

  type Props = {
    queryClient: QueryClient
    calls: Calls
    request: Promise<string>
    variables: Variables
  }

  const { queryClient, calls, request, variables }: Props = $props()

  // svelte-ignore state_referenced_locally
  setQueryClientContext(queryClient)

  let account = $state<AccountName>('previous')

  const mutation = createMutation(() => {
    const current = account
    return {
      mutationFn: (input: Variables) => {
        calls.fn.push({ account: current, variables: input })
        return request.then((echoed) => ({ echoed }))
      },
      onSuccess: (data: Payload, input: Variables) => {
        calls.success.push({ account: current, data, variables: input })
        queryClient.setQueryData(['profile', current], {
          data,
          variables: input,
        })
      },
    }
  })
</script>

<button onclick={() => mutation.mutate(variables)}>save</button>
<button onclick={() => (account = 'next')}>switch</button>
