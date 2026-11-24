<script lang="ts">
  import { setQueryClientContext } from './context.js'
  import type { QueryClientProviderProps } from './types.js'

  const { client, children }: QueryClientProviderProps = $props()

  // QueryClientProvider remounts this component whenever `client` changes.
  // svelte-ignore state_referenced_locally
  setQueryClientContext(client)
</script>

{@render children()}
