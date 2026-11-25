---
'@tanstack/solid-query': patch
---

fix(solid-query): make `useQuery`, `useInfiniteQuery`, `useQueries` and `useMutation` switch to a replaced `QueryClient` instead of keeping the previous client's observer and data
