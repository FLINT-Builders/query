---
'@tanstack/query-devtools': patch
---

Keep the devtools panel rendering when query data, query keys, or mutation keys contain `constructor`, `prototype`, or `__proto__` properties or are nested very deeply, instead of letting the superjson error escape render.
