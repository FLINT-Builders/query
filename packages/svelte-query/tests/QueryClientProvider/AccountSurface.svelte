<script lang="ts">
  import {
    createInfiniteQuery,
    createMutation,
    createQueries,
    createQuery,
    useIsFetching,
    useIsMutating,
    useMutationState,
    useQueryClient,
  } from '../../src/index.js'

  type AccountAction = {
    accountId: string
    operation: string
  }

  type Props = {
    mutationFn: (variables: AccountAction) => Promise<string>
  }

  let { mutationFn }: Props = $props()

  // Same keys the layout keeps across an account switch: they do not include
  // the signed-in user, so a client that is never swapped keeps returning the
  // previous account's cache.
  const user = createQuery(() => ({
    queryKey: ['current-user'],
    queryFn: () =>
      Promise.reject(new Error('current-user queryFn should not run')),
    staleTime: Infinity,
    retry: false,
  }))

  const feed = createInfiniteQuery(() => ({
    queryKey: ['feed'],
    queryFn: () => Promise.reject(new Error('feed queryFn should not run')),
    initialPageParam: 0,
    getNextPageParam: () => undefined,
    staleTime: Infinity,
    retry: false,
  }))

  const lists = createQueries(() => ({
    queries: [
      {
        queryKey: ['inbox'],
        queryFn: () =>
          Promise.reject(new Error('inbox queryFn should not run')),
        staleTime: Infinity,
        retry: false,
      },
    ],
  }))

  const activeClient = useQueryClient()
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const pendingActions = useMutationState<AccountAction>({
    filters: { mutationKey: ['account-action'], status: 'pending' },
    select: (mutation) => mutation.state.variables as AccountAction,
  })

  const action = createMutation(() => ({
    mutationKey: ['account-action'],
    mutationFn,
    retry: false,
    networkMode: 'online',
  }))
</script>

<div data-testid="mounted-user">{user.data}</div>
<div data-testid="mounted-feed">{feed.data?.pages?.[0]}</div>
<div data-testid="mounted-inbox">{lists[0]?.data}</div>
<div data-testid="mounted-client-user">
  {activeClient.getQueryData<string>(['current-user'])}
</div>
<div data-testid="mounted-fetching">{fetching.current}</div>
<div data-testid="mounted-mutating">{mutating.current}</div>
<div data-testid="mounted-pending">
  {pendingActions.map((variables) => variables.accountId).join(',')}
</div>

<button
  type="button"
  onclick={() =>
    action.mutate({ accountId: 'account-a', operation: 'save-draft' })}
>
  Run paused action
</button>
