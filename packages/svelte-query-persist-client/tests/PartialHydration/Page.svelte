<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query'
  import { sleep } from '@tanstack/query-test-utils'

  const query = createQuery(() => ({
    queryKey: ['session'],
    queryFn: () => sleep(10).then(() => 'fetched-session'),
  }))
</script>

<h1>{query.data}</h1>
