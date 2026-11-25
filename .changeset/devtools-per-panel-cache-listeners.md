---
'@tanstack/query-devtools': patch
---

Keep query and mutation cache listeners per devtools panel, so one panel no longer shows another client's cache and unmounting a panel no longer stops the remaining panels from updating
