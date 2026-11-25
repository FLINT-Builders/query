---
'@tanstack/solid-query': patch
---

fix(solid-query): recreate the `useQueries`/`createQueries` and `useMutation` observers when the resolved `QueryClient` changes, so a mounted component reads from and writes to the new client instead of the one it was first created with
