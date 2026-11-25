---
'@tanstack/solid-query': patch
---

fix: recreate the observer in `useMutation` and `useQueries` when the `QueryClient` changes, and recompute `useMutationState` from the new client's mutation cache, so a swapped client no longer receives state from, or writes into, the previous client
