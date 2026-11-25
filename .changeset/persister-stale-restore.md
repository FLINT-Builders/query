---
'@tanstack/query-persist-client-core': patch
---

fix(query-persist-client-core): don't let `experimental_createQueryPersister` restore data over a newer write to the query, or restore data for a cancelled fetch
