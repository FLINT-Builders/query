---
'@tanstack/query-persist-client-core': patch
'@tanstack/react-query-persist-client': patch
'@tanstack/preact-query-persist-client': patch
'@tanstack/solid-query-persist-client': patch
'@tanstack/svelte-query-persist-client': patch
---

fix: ignore superseded persist restores so a snapshot read for a previous buster is never hydrated, and only discard stored caches that were not replaced during the read. Persist providers now clear the client and restore again when the buster changes.
