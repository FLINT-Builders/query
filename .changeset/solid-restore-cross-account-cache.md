---
'@tanstack/solid-query': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/svelte-query-persist-client': patch
---

fix: stop mounted queries from writing the previous cache into the client while `PersistQueryClientProvider` restores again after its persist options change
