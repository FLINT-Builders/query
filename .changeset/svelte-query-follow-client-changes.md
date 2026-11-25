---
'@tanstack/svelte-query': patch
---

fix(svelte-query): follow `QueryClient` and filter changes in `useMutationState`, `useIsMutating` and `useIsFetching`

These helpers now re-read their client and filters reactively, replacing their result and re-subscribing as soon as either changes, instead of keeping the previous client's mutations on screen. They accept a function for `options`/`filters` and `queryClient`. `QueryClientProvider` now passes a changed `client` to mounted descendants (including `createQuery`, `createQueries` and `createMutation`), and `setQueryClientContext` accepts a function returning the client.
