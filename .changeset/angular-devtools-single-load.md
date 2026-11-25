---
'@tanstack/angular-query-experimental': patch
---

Mount a single devtools instance per `injectDevtoolsPanel` / `withDevtools` when options change while `@tanstack/query-devtools` is still loading, and bind it to the current query client instead of the one that started the load.
