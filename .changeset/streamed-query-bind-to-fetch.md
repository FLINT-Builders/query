---
'@tanstack/query-core': patch
---

fix(query-core): stop `streamedQuery` from writing chunks after its query is removed, reset, cancelled or fetched again
