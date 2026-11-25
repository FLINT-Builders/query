---
'@tanstack/react-query': patch
'@tanstack/preact-query': patch
'@tanstack/solid-query': patch
---

fix: recreate query and mutation observers when the resolved QueryClient changes, so mutations, mutation callbacks and query reads use the current client instead of the one from the first render
