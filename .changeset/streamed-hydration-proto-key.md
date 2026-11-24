---
'@tanstack/query-core': patch
'@tanstack/react-query-next-experimental': patch
---

fix: keep `__proto__` keys in query data as own properties instead of setting the prototype, in streamed hydration scripts and structural sharing
