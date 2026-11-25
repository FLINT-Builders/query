---
'@tanstack/query-persist-client-core': patch
'@tanstack/angular-query-persist-client': patch
---

fix: roll back queries and mutations hydrated before a persisted restore throws, and wait for `onSuccess`/`onError` in `withPersistQueryClient` before finishing the restore
