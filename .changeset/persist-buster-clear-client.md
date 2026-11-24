---
'@tanstack/query-persist-client-core': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/svelte-query-persist-client': patch
---

fix(persist-client): clear the QueryClient when it is restored with a different buster or persister, and ignore restores that were superseded, so the previous cache is not shown or persisted under the new buster
