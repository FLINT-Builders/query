---
id: provideQueryClient
title: provideQueryClient
---

```ts
function provideQueryClient(queryClient: QueryClientProviderValue): Provider;
```

Defined in: [packages/angular-query-experimental/src/providers.ts:67](https://github.com/TanStack/query/blob/main/packages/angular-query-experimental/src/providers.ts#L67)

Usually [provideTanStackQuery](provideTanStackQuery.md) is used once to set up TanStack Query and the
[`QueryClient`](https://tanstack.com/query/latest/docs/reference/QueryClient) for the entire application —
it calls `provideQueryClient` internally. Use `provideQueryClient` directly to provide a different
`QueryClient` instance for part of the application, or for unit testing.

On the server, a `QueryClient` can only be used by one application at a time, and its cache is cleared when
that application is destroyed. Pass a factory so every server request gets its own `QueryClient`.

## Parameters

### queryClient

[`QueryClientProviderValue`](../type-aliases/QueryClientProviderValue.md)

A factory function which creates a `QueryClient`, a `QueryClient` instance, or an
`InjectionToken` which provides a `QueryClient`.

## Returns

`Provider`

A provider object that can be used to provide the `QueryClient` instance.

## Example

Providing a test-only `QueryClient` in a component test, without wiring up `provideTanStackQuery`'s other
defaults:
```ts
TestBed.configureTestingModule({
  providers: [provideQueryClient(() => new QueryClient())],
})
```
