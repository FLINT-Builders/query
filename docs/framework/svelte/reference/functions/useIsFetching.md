---
id: useIsFetching
title: useIsFetching
---

```ts
function useIsFetching(filters?: 
  | QueryFilters<readonly unknown[]>
  | Accessor<
  | QueryFilters<readonly unknown[]>
  | undefined>, queryClient?: 
  | QueryClient
| Accessor<QueryClient>): ReactiveValue<number>;
```

Defined in: [packages/svelte-query/src/useIsFetching.svelte.ts:44](https://github.com/TanStack/query/blob/main/packages/svelte-query/src/useIsFetching.svelte.ts#L44)

The `useIsFetching` function returns the `number` of the queries that your application is loading or
fetching in the background (useful for app-wide loading indicators).

## Parameters

### filters?

[QueryFilters](../interfaces/QueryFilters.md) to narrow down which queries to count. Omit to count every fetching
query. Pass a function returning them to recount when they change.

[`QueryFilters`](../interfaces/QueryFilters.md)\<readonly `unknown`[]\> | [`Accessor`](../type-aliases/Accessor.md)\<
\| [`QueryFilters`](../interfaces/QueryFilters.md)\<readonly `unknown`[]\>
\| `undefined`\>

### queryClient?

Use this to use a custom `QueryClient`, or pass a function returning it to follow a
client that changes. Otherwise, the one from the nearest context will be used.

[`QueryClient`](../classes/QueryClient.md) | [`Accessor`](../type-aliases/Accessor.md)\<[`QueryClient`](../classes/QueryClient.md)\>

## Returns

`ReactiveValue`\<`number`\>

A reactive value — read `.current` to get how many matching queries are currently fetching.

## Examples

```svelte
<script lang="ts">
  import { useIsFetching } from '@tanstack/svelte-query'

  // How many queries matching the posts prefix are fetching?
  const isFetchingPosts = useIsFetching({ queryKey: ['posts'] })
</script>

{#if isFetchingPosts.current}
  <span>Refreshing posts...</span>
{/if}
```

A global loading indicator for any query fetching in the background, not just the ones on screen:
```svelte
<script lang="ts">
  import { useIsFetching } from '@tanstack/svelte-query'

  const isFetching = useIsFetching()
</script>

{#if isFetching.current}
  <div>Queries are fetching in the background...</div>
{/if}
```
