---
id: useIsMutating
title: useIsMutating
---

```ts
function useIsMutating(filters?: 
  | MutationFilters<unknown, Error, unknown, unknown>
  | Accessor<
  | MutationFilters<unknown, Error, unknown, unknown>
  | undefined>, queryClient?: 
  | QueryClient
| Accessor<QueryClient>): ReactiveValue<number>;
```

Defined in: [packages/svelte-query/src/useIsMutating.svelte.ts:30](https://github.com/TanStack/query/blob/main/packages/svelte-query/src/useIsMutating.svelte.ts#L30)

`useIsMutating` is an optional function that returns the `number` of mutations that your application is
running (useful for app-wide loading indicators).

## Parameters

### filters?

[MutationFilters](../interfaces/MutationFilters.md) to narrow down which mutations to count. Pass a function returning
them to recount when they change.

[`MutationFilters`](../interfaces/MutationFilters.md)\<`unknown`, `Error`, `unknown`, `unknown`\> | [`Accessor`](../type-aliases/Accessor.md)\<
\| [`MutationFilters`](../interfaces/MutationFilters.md)\<`unknown`, `Error`, `unknown`, `unknown`\>
\| `undefined`\>

### queryClient?

Use this to use a custom `QueryClient`, or pass a function returning it to follow a
client that changes. Otherwise, the one from the nearest context will be used.

[`QueryClient`](../classes/QueryClient.md) | [`Accessor`](../type-aliases/Accessor.md)\<[`QueryClient`](../classes/QueryClient.md)\>

## Returns

`ReactiveValue`\<`number`\>

A reactive value — read `.current` to get how many matching mutations are currently running.

## Example

```svelte
<script lang="ts">
  import { useIsMutating } from '@tanstack/svelte-query'

  // How many mutations matching the posts prefix are in progress?
  const isMutatingPosts = useIsMutating({ mutationKey: ['posts'] })
</script>

{#if isMutatingPosts.current}
  <span>Saving posts...</span>
{/if}
```
