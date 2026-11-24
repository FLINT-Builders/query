<script lang="ts">
  import { createQueries, createQuery } from '@tanstack/svelte-query'
  import { sleep } from '@tanstack/query-test-utils'
  import type { QueryKey } from '@tanstack/svelte-query'

  let {
    profileKey,
    inboxKey,
    onProfileFetch,
    fetchDelay,
  }: {
    profileKey: QueryKey
    inboxKey: QueryKey
    onProfileFetch: () => void
    fetchDelay: number
  } = $props()

  const profile = createQuery(() => ({
    queryKey: profileKey,
    queryFn: async () => {
      onProfileFetch()
      await sleep(fetchDelay)
      return 'fetched-profile'
    },
    staleTime: Infinity,
  }))

  const queries = createQueries(() => ({
    queries: [
      {
        queryKey: inboxKey,
        queryFn: async () => {
          await sleep(fetchDelay)
          return 'fetched-inbox'
        },
        staleTime: Infinity,
      },
    ],
  }))
</script>

<h1>profile: {profile.data ?? 'null'}</h1>
<h2>inbox: {queries[0].data ?? 'null'}</h2>
