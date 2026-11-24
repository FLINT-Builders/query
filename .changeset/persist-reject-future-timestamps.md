---
'@tanstack/query-persist-client-core': patch
---

fix(query-persist-client-core): treat persisted timestamps that are not finite numbers or lie in the future as expired, so restored caches can no longer outlive `maxAge`
