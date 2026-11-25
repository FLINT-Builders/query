---
'@tanstack/vue-query': patch
---

fix(vue-query): resolve `suspense()` with the current result when the query is disabled instead of leaving the promise pending
