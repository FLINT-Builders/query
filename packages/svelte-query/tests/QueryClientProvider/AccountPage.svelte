<script lang="ts">
  import { createQuery, useQueryClient } from '../../src/index.js'

  // A page created after the layout's client prop changes. SvelteKit keeps the
  // layout mounted and mounts the page again, so this read goes through context
  // a second time.
  const user = createQuery(() => ({
    queryKey: ['current-user'],
    queryFn: () =>
      Promise.reject(new Error('fresh page queryFn should not run')),
    staleTime: Infinity,
    retry: false,
  }))

  const activeClient = useQueryClient()
</script>

<div data-testid="fresh-user">{user.data}</div>
<div data-testid="fresh-client-user">
  {activeClient.getQueryData<string>(['current-user'])}
</div>
