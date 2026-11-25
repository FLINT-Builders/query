---
id: setQueryClientContext
title: setQueryClientContext
---

```ts
function setQueryClientContext(client: 
  | QueryClient
  | Accessor<QueryClient>): void;
```

Defined in: [packages/svelte-query/src/context.ts:63](https://github.com/TanStack/query/blob/main/packages/svelte-query/src/context.ts#L63)

Sets a `QueryClient` on Svelte's context, so it can be read with [getQueryClientContext](getQueryClientContext.md) (or
[useQueryClient](useQueryClient.md)) from any descendant component. `QueryClientProvider` wraps this — use it directly
only if you need to set the client from your own component instead.

## Parameters

### client

The `QueryClient` to make available to descendant components, or a function returning it.
Pass a function when the client can change while descendants stay mounted, so they switch to the new one.

[`QueryClient`](../classes/QueryClient.md) | [`Accessor`](../type-aliases/Accessor.md)\<[`QueryClient`](../classes/QueryClient.md)\>

## Returns

`void`

## Example

```svelte
<script lang="ts">
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query'

  const queryClient = new QueryClient()
</script>

<QueryClientProvider client={queryClient}>
  ...
</QueryClientProvider>
```
