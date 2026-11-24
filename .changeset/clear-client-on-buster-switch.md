---
'@tanstack/query-persist-client-core': patch
'@tanstack/svelte-query-persist-client': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/react-query-persist-client': patch
'@tanstack/preact-query-persist-client': patch
'@tanstack/angular-query-persist-client': patch
---

Clear the `QueryClient` before restoring it for a different `persister` or `buster`, and ignore restores that a newer restore for the same client has replaced, so a previous cache is no longer kept in memory and saved under the new `persister` or `buster`. Adds `persistQueryClientRestoreLatest`, used by `persistQueryClient` and the persist providers. The Svelte and Solid providers now subscribe only after the restore for the current options has finished.
