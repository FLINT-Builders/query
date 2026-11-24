<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'

  let { fetches }: { fetches: { count: number } } = $props()

  const query = createQuery(() => ({
    queryKey: ['account', 'profile'],
    queryFn: () => {
      fetches.count += 1
      return 'account-b-from-network'
    },
    staleTime: Infinity,
  }))
</script>

<h1>data: {query.data ?? 'empty'}</h1>
