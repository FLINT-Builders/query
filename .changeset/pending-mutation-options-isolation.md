---
'@tanstack/query-core': patch
---

fix(query-core): keep a pending mutation bound to the options it was started with

Updating a `MutationObserver`'s options (for example by re-rendering `useMutation` with a new `mutationFn` or callbacks) no longer replaces the `mutationFn`, callbacks or other options of a mutation that is already pending. The new options apply to the next `mutate()` call. A pending call keeps its original options for retries, scope queuing and resumes after being paused.
