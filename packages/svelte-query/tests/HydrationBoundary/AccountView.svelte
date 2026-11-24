<script lang="ts">
  import type {
    DehydratedState,
    HydrateOptions,
    QueryClient,
  } from '@tanstack/query-core'
  import { HydrationBoundary, setQueryClientContext } from '../../src/index.js'
  import CurrentUser from './CurrentUser.svelte'

  type Props = {
    queryClient: QueryClient
    state: DehydratedState
    options?: HydrateOptions
    boundaryClient?: QueryClient
    staleTime?: number
    queryFn: () => Promise<string>
    onInit?: () => void
  }

  let {
    queryClient,
    state,
    options = undefined,
    boundaryClient = undefined,
    staleTime = 60_000,
    queryFn,
    onInit,
  }: Props = $props()

  setQueryClientContext(queryClient)
  onInit?.()
</script>

<HydrationBoundary {state} {options} queryClient={boundaryClient}>
  <CurrentUser {staleTime} {queryFn} />
</HydrationBoundary>
