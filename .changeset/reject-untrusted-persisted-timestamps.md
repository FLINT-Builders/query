---
'@tanstack/query-persist-client-core': patch
---

fix(query-persist-client-core): discard persisted caches whose timestamps are not finite numbers in the past, so a future `dataUpdatedAt` or client `timestamp` can no longer bypass `maxAge` or keep restored data fresh
