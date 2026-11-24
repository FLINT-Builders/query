---
'@tanstack/query-broadcast-client-experimental': patch
---

fix(broadcast-client): require an app-specific `broadcastChannel` and validate incoming messages

`broadcastChannel` no longer defaults to `'tanstack-query'` and must be passed. Incoming messages are dropped unless their `queryHash` matches their `queryKey`, only query state fields that a sync needs are applied, and a `removed` message no longer removes a query that still has observers in the receiving tab.
