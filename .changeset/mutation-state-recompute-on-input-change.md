---
'@tanstack/react-query': patch
'@tanstack/preact-query': patch
'@tanstack/solid-query': patch
'@tanstack/svelte-query': patch
---

fix: recompute `useMutationState` (and React/Preact `useIsMutating`) when the `QueryClient`, `filters` or `select` change, instead of returning the previous snapshot until the next mutation cache event
