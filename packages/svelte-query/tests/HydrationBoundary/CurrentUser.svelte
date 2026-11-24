<script lang="ts">
  import { createQuery } from '../../src/index.js'

  type Props = {
    staleTime: number
    queryFn: () => Promise<string>
  }

  let { staleTime, queryFn }: Props = $props()

  const query = createQuery(() => ({
    queryKey: ['currentUser'],
    queryFn,
    staleTime,
  }))
</script>

<div>user:{query.data ?? 'none'}</div>
