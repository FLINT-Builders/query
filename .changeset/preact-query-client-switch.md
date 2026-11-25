---
'@tanstack/preact-query': patch
---

fix(preact-query): recreate observers when the `QueryClient` changes, so mounted `useQuery`, `useInfiniteQuery`, `useQueries`, their suspense variants, `useMutation`, `useMutationState` and `useIsMutating` read from and write to the current client instead of the one they first rendered with
