---
id: broadcastQueryClient
title: broadcastQueryClient (Experimental)
---

> VERY IMPORTANT: This utility is currently in an experimental stage. This means that breaking changes will happen in minor AND patch releases. Use at your own risk. If you choose to rely on this in production in an experimental stage, please lock your version to a patch-level version to avoid unexpected breakages.

`broadcastQueryClient` is a utility for keeping your queryClient in sync between browser tabs/windows with the same origin.

Every page on the same origin can join a `BroadcastChannel` (or read its `localStorage` fallback), including pages that are not part of your app, so the channel name is not a secret. For that reason, query data, errors, and query keys are never sent. When a query is fetched or updated with `setQueryData` in one tab, other tabs are only told _which_ query changed (by a one-way digest of its hash). If they have that query cached, they invalidate it, and active queries refetch through their own `queryFn`. Queries removed with `removeQueries` while observed are removed in other tabs too.

## Installation

This utility comes as a separate package and is available under the `'@tanstack/query-broadcast-client-experimental'` import.

## Usage

Import the `broadcastQueryClient` function, and pass it your `QueryClient` instance, and optionally, set a `broadcastChannel`.

```tsx
import { broadcastQueryClient } from '@tanstack/query-broadcast-client-experimental'

const queryClient = new QueryClient()

broadcastQueryClient({
  queryClient,
  broadcastChannel: 'my-app',
})
```

## API

### `broadcastQueryClient`

Pass this function a `QueryClient` instance and optionally, a `broadcastChannel`.

```tsx
broadcastQueryClient({ queryClient, broadcastChannel })
```

### `Options`

An object of options:

```tsx
interface BroadcastQueryClientOptions {
  /** The QueryClient to sync */
  queryClient: QueryClient
  /** This is the unique channel name that will be used
   * to communicate between tabs and windows */
  broadcastChannel?: string
  /** Options for the BroadcastChannel API */
  options?: BroadcastChannelOptions
  /**
   * Called when a query event fails to broadcast to other tabs, for example
   * because the underlying channel was closed.
   *
   * If omitted, a `console.warn` is emitted in development so failures
   * are never entirely silent. May return a `Promise`; any rejection is
   * caught internally.
   */
  onBroadcastError?: (
    error: unknown,
    event: BroadcastErrorEvent,
  ) => void | Promise<void>
}

interface BroadcastErrorEvent {
  type: 'updated' | 'removed'
  queryHash: string
  queryKey: QueryKey
}
```

The default options are:

```tsx
{
  broadcastChannel = 'tanstack-query',
}
```

## Handling broadcast errors

If the underlying `BroadcastChannel.postMessage` call rejects for a query event, cross-tab sync is skipped for that event; the rest of the cache continues to broadcast normally.

By default, a `console.warn` is emitted in development so failures are never silent. Provide `onBroadcastError` to route failures to your own error tracker:

```tsx
import * as Sentry from '@sentry/browser'
import { broadcastQueryClient } from '@tanstack/query-broadcast-client-experimental'

broadcastQueryClient({
  queryClient,
  broadcastChannel: 'my-app',
  onBroadcastError: (error, event) => {
    Sentry.captureException(error, {
      tags: { broadcastEvent: event.type },
      extra: { queryHash: event.queryHash, queryKey: event.queryKey },
    })
  },
})
```
