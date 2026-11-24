<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'

  let { onFetch }: { onFetch: () => void } = $props()

  const profile = createQuery(() => ({
    queryKey: ['account', 'profile'],
    staleTime: Infinity,
    queryFn: () => {
      onFetch()
      return 'fetched-for-current-account'
    },
  }))
</script>

<div data-testid="profile">{profile.data ?? ''}</div>
<div data-testid="fetch-status">{profile.fetchStatus}</div>
