---
'@tanstack/query-core': patch
---

fix(query-core): treat a `dataUpdatedAt` in the future as the current time, so a restored or broadcast timestamp ahead of the clock can no longer keep a query fresh past its `staleTime`
