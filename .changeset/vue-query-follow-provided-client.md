---
'@tanstack/vue-query': patch
---

fix(vue-query): mounted composables follow a client provided later with `app.provide`, so mutations, refetches, prefetches and cache counts no longer act on the client that was provided during setup
