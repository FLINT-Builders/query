---
'@tanstack/vue-query': patch
'@tanstack/query-core': patch
---

fix(vue-query): rebind composables to a `QueryClient` replaced through `app.provide`, and empty the mutation cache before `MutationCache.clear` notifies listeners
