---
'@tanstack/query-core': patch
---

fix(hydration): restore only `mutationKey`, `meta` and `scope` from dehydrated mutations, so a snapshot can no longer override options like `retry` or `mutationFn`
