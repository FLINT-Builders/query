---
'@tanstack/vue-query-devtools': patch
'@tanstack/svelte-query-devtools': patch
'@tanstack/query-devtools': patch
'@tanstack/angular-query-experimental': patch
---

fix(devtools): follow the current QueryClient when the `client` prop or option changes, instead of keeping the client the devtools were created with
