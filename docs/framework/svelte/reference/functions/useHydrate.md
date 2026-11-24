---
id: useHydrate
title: useHydrate
---

```ts
function useHydrate(
   state?: unknown, 
   options?: 
  | HydrateOptions
  | Accessor<HydrateOptions | undefined>, 
   queryClient?: 
  | QueryClient
  | Accessor<QueryClient | undefined>): void;
```

Defined in: [packages/svelte-query/src/useHydrate.svelte.ts:44](https://github.com/TanStack/query/blob/main/packages/svelte-query/src/useHydrate.svelte.ts#L44)

Adds a previously dehydrated `state` into the `queryClient` (from the nearest context, or the one
passed explicitly). If the client already contains data, the new queries will be intelligently merged based
on update timestamp. `HydrationBoundary` wraps this — use it directly only if you need to hydrate from your
own component instead.

Each argument can be passed as a value or as an [Accessor](../type-aliases/Accessor.md). Values are hydrated once, when the
component initializes. Accessors are hydrated when the component initializes and again whenever any of them
returns something new, so pass accessors when `state` comes from props or other reactive state that can
change while the component stays mounted (e.g. on client-side navigation).

## Parameters

### state?

`unknown`

The dehydrated state to hydrate into the cache, as produced by `dehydrate`.

### options?

[HydrateOptions](../interfaces/HydrateOptions.md) to control the hydration.

[`HydrateOptions`](../interfaces/HydrateOptions.md) | [`Accessor`](../type-aliases/Accessor.md)\<[`HydrateOptions`](../interfaces/HydrateOptions.md) \| `undefined`\>

### queryClient?

Use this to use a custom `QueryClient`. Otherwise, the one from the nearest context will
be used.

[`QueryClient`](../classes/QueryClient.md) | [`Accessor`](../type-aliases/Accessor.md)\<[`QueryClient`](../classes/QueryClient.md) \| `undefined`\>

## Returns

`void`

## Example

Server-side prefetch handed off to the client via `dehydrate` — `dehydratedState` would typically come
from a server load function that prefetched with `queryClient.query` and called `dehydrate(queryClient)`:
```svelte
<script lang="ts">
  import { HydrationBoundary } from '@tanstack/svelte-query'
  import type { DehydratedState } from '@tanstack/svelte-query'
  import Posts from './Posts.svelte'

  let { dehydratedState }: { dehydratedState: DehydratedState } = $props()
</script>

<HydrationBoundary state={dehydratedState}>
  <Posts />
</HydrationBoundary>
```
