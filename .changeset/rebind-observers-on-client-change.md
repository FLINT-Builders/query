---
'@tanstack/react-query': patch
'@tanstack/preact-query': patch
'@tanstack/solid-query': patch
---

fix: create a new observer when the `QueryClient` of a mounted query, queries, or mutation hook changes, so the hook stops reading and writing the previous client's cache; `useMutationState` also stops returning mutations from the previous client
