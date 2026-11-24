---
'@tanstack/svelte-query': patch
---

fix(svelte-query): re-hydrate `HydrationBoundary` when its `state`, `options` or `queryClient` props change, so a mounted boundary no longer keeps the previous snapshot after client-side navigation. `useHydrate` now also accepts accessors for its arguments to follow updates.
