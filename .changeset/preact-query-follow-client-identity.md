---
'@tanstack/preact-query': patch
---

fix(preact-query): recreate query, queries and mutation observers when the resolved `QueryClient` changes, so mounted hooks stop reading from and writing to the previous client
