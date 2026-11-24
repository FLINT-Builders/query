---
'@tanstack/query-sync-storage-persister': patch
'@tanstack/query-async-storage-persister': patch
'@tanstack/query-persist-client-core': patch
---

fix: drop pending throttled or scheduled writes when the persisted cache is removed, so `removeClient` and `removeQueries` cannot be undone by a save that was captured before removal
