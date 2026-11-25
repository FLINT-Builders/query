---
'@tanstack/query-core': patch
---

fix(query-core): skip the callbacks of an in-flight mutation after it is removed by `MutationCache.clear`, `MutationCache.remove` or `QueryClient.clear`, so they cannot write the cleared cache back
