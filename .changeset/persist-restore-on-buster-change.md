---
'@tanstack/query-persist-client-core': patch
'@tanstack/react-query-persist-client': patch
'@tanstack/preact-query-persist-client': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/svelte-query-persist-client': patch
---

Restore the persisted cache again when the `buster`, `persister` or `client` of a `PersistQueryClientProvider` changes. Restoring a `QueryClient` with a different `buster` or `persister` now discards the data already in that client, ignores the restore that was still in progress, and saves later changes with the new `buster`, so a previously restored cache (e.g. of another signed-in user) no longer stays in memory.
