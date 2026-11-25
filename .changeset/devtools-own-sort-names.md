---
'@tanstack/query-devtools': patch
'@tanstack/vue-query': patch
---

fix(devtools): ignore saved sort names that are not own keys of the sort maps, such as `constructor`, and fall back to the default sort
