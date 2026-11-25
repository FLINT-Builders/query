---
'@tanstack/vue-query': patch
---

fix(vue-query): rebind observers and cache subscriptions when the `queryClient` passed to a composable (as a `ref`, `computed` or getter) or provided as a `ref` changes, so a mounted component no longer keeps showing or writing to the previous client's cache
