---
'@tanstack/angular-query-experimental': patch
---

fix(angular-query): do not share a `QueryClient` cache between server-rendered requests. `provideTanStackQuery` and `provideQueryClient` now accept a factory such as `() => new QueryClient()`. On the server, a `QueryClient` can only be used by one application at a time, a second concurrent application using the same instance throws, and the cache is cleared when the application is destroyed.
