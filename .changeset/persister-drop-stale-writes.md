---
'@tanstack/query-persist-client-core': patch
---

fix(query-persist-client-core): drop per-query persister writes that started before `removeQueries` or before the query was removed from the cache
