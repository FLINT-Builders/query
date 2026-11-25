---
'@tanstack/query-core': patch
---

fix: a mutation restored in a `pending` state via `hydrate` no longer holds up its `scope` until it is resumed, and `hydrate` only restores the mutation options that `dehydrate` writes (`mutationKey`, `meta`, `scope`)
