---
'@tanstack/query-persist-client-core': patch
---

Order `experimental_createQueryPersister` storage writes per key, so an older snapshot can no longer overwrite a newer save or bring back an entry removed with `removeQueries` when async `setItem` calls settle out of order.
