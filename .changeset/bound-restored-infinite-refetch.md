---
'@tanstack/query-core': patch
'@tanstack/query-persist-client-core': patch
---

fix: only replay infinite query pages that the query fetched itself or that were written with `setQueryData`/`initialData`, cap refetches at `maxPages`, and restart restored pages from `initialPageParam`
