---
'@tanstack/query-core': patch
---

fix(query-core): keep own `__proto__` fields in `hashKey` so keys that differ only by that field no longer share a cache entry
