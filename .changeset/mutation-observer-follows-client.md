---
'@tanstack/react-query': patch
'@tanstack/preact-query': patch
'@tanstack/solid-query': patch
---

fix: recreate mutation and query observers when the resolved `QueryClient` changes, so mutations started after a client switch run on the new client and mounted queries read from its cache
