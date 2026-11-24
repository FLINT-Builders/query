---
'@tanstack/query-core': patch
'@tanstack/react-query': patch
'@tanstack/preact-query': patch
'@tanstack/query-broadcast-client-experimental': patch
---

fix: derive the cache hash of hydrated and broadcast queries from their query key instead of trusting the serialized `queryHash`, and always fetch with the query key of the active options
