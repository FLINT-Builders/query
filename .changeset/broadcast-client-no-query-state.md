---
'@tanstack/query-broadcast-client-experimental': patch
---

fix: stop posting query data, errors, and keys on the cross-tab channel, which any same-origin page can read. Tabs now announce only that a query changed, and other tabs invalidate and refetch it with their own `queryFn`.
