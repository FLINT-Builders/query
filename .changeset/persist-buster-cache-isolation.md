---
'@tanstack/react-query-persist-client': patch
'@tanstack/preact-query-persist-client': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/svelte-query-persist-client': patch
---

fix(persist-client): clear and restore the QueryClient again when `client`, `persister` or `buster` changes, keep saving with the latest options, and ignore restores that finish after the persister or buster has changed, so data cached for a previous user does not remain in memory
