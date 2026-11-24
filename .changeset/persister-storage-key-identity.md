---
'@tanstack/query-persist-client-core': patch
---

fix(query-persist-client-core): use the storage key as the identity of entries in `experimental_createQueryPersister`, so `removeQueries` and `restoreQueries` no longer trust a `queryHash` or `queryKey` edited inside a stored entry
