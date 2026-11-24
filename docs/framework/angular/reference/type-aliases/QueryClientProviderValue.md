---
id: QueryClientProviderValue
title: QueryClientProviderValue
---

```ts
type QueryClientProviderValue = 
  | QueryClient
  | InjectionToken<QueryClient>
  | () => QueryClient;
```

Defined in: [packages/angular-query-experimental/src/providers.ts:17](https://github.com/TanStack/query/blob/main/packages/angular-query-experimental/src/providers.ts#L17)

A `QueryClient` instance, an `InjectionToken` which provides a `QueryClient`, or a factory function which
creates a new `QueryClient`. The factory runs in an injection context once per injector the provider is
added to, so with server-side rendering every request gets its own `QueryClient`.
