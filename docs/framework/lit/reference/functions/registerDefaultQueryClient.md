---
id: registerDefaultQueryClient
title: registerDefaultQueryClient
---

```ts
function registerDefaultQueryClient(client: QueryClient): void;
```

Defined in: [packages/lit-query/src/context.ts:37](https://github.com/TanStack/query/blob/main/packages/lit-query/src/context.ts#L37)

Registers a `QueryClient` as a process-local fallback for APIs that resolve a
client without an explicit argument.

`QueryClientProvider` calls this automatically while it is connected to a
document. Prefer passing an explicit client or rendering under a provider
when possible.

The registration is shared by everything running in the same JavaScript
realm. Do not call this during server rendering, where one process renders
many requests.

## Parameters

### client

[`QueryClient`](../classes/QueryClient.md)

The query client to register as the current default.

## Returns

`void`
