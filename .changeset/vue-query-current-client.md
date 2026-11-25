---
'@tanstack/vue-query': patch
---

fix(vue-query): use the currently provided `QueryClient` when a mounted composable re-runs, instead of the client injected during `setup()`
