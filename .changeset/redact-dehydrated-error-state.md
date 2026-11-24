---
'@tanstack/query-core': patch
---

fix(query-core): apply `shouldRedactErrors` to the dehydrated query and mutation state

`dehydrate` and `dehydrateQuery` only redacted the rejection of a pending query's promise. `state.error` and `state.fetchFailureReason` of dehydrated queries, and `state.error` and `state.failureReason` of dehydrated mutations, were copied into the snapshot as-is, so fields on a thrown value could reach the client. These are now replaced with `Error('redacted')` unless `shouldRedactErrors` returns `false` for the error, matching the existing promise behavior. Pass `shouldRedactErrors: () => false` to keep the original errors.
