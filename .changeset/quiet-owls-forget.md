---
'@tanstack/query-async-storage-persister': patch
'@tanstack/query-sync-storage-persister': patch
'@tanstack/query-persist-client-core': patch
---

fix: do not write a pending throttled or scheduled persist after the persisted cache was removed
