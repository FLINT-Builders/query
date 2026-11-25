---
'@tanstack/query-devtools': patch
'@tanstack/solid-query-devtools': patch
---

Keep the Solid Query devtools and devtools panel bound to the current `QueryClient` when the `client` prop or the `QueryClientProvider` client changes, including query details actions, data edits, and cache subscriptions.
