---
'@tanstack/query-core': patch
---

fix(query-core): keep a `__proto__` key as an own property in `replaceEqualDeep` and `hashKey` instead of changing the copied object's prototype
