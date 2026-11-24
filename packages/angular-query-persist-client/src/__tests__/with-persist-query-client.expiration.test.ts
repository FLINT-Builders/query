import { describe, expect, it } from 'vitest'
import {
  QueryClient,
  dehydrate,
  injectQuery,
  provideTanStackQuery,
} from '@tanstack/angular-query-experimental'
import { Component, provideZonelessChangeDetection } from '@angular/core'
import { render } from '@testing-library/angular'
import { withPersistQueryClient } from '../with-persist-query-client'
import type {
  PersistedClient,
  Persister,
} from '@tanstack/query-persist-client-core'

const STORAGE_KEY = 'REACT_QUERY_OFFLINE_CACHE'
const QUERY_KEY = ['persisted-profile']
const MINUTE = 60 * 1000

function persistedRecord(data: string, timestamp: unknown) {
  const source = new QueryClient()
  source.setQueryData(QUERY_KEY, data)
  return JSON.stringify({
    buster: '',
    timestamp,
    clientState: dehydrate(source),
  })
}

/**
 * Restore path of `createAsyncStoragePersister`: read the stored string and
 * JSON.parse it. The async persister package covers that function directly.
 */
function cacheHasNoRestoredData(client: QueryClient) {
  return (
    client
      .getQueryCache()
      .getAll()
      .every((query) => query.state.data === undefined) &&
    client.getMutationCache().getAll().length === 0
  )
}

function storagePersister(
  items: Map<string, string>,
  onRemove: () => void,
  replacement?: string,
): Persister {
  let swapped = false
  return {
    persistClient(client) {
      const cacheString = JSON.stringify(client)
      items.set(STORAGE_KEY, cacheString)
    },
    restoreClient() {
      const cacheString = items.get(STORAGE_KEY)
      if (!cacheString) {
        return
      }
      if (replacement !== undefined && !swapped) {
        items.set(STORAGE_KEY, replacement)
        swapped = true
      }
      return JSON.parse(cacheString) as PersistedClient
    },
    removeClient() {
      onRemove()
      items.delete(STORAGE_KEY)
    },
  }
}

async function renderRestoringApp(stored: string, replacement?: string) {
  const items = new Map<string, string>([[STORAGE_KEY, stored]])
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const removedWhileEmpty: Array<boolean> = []
  const persister = storagePersister(
    items,
    () => {
      removedWhileEmpty.push(cacheHasNoRestoredData(queryClient))
    },
    replacement,
  )

  let resolveNetwork: (value: string) => void = () => undefined
  const network = new Promise<string>((resolve) => {
    resolveNetwork = resolve
  })

  let finishRestore: () => void = () => undefined
  let failRestore: (error: unknown) => void = () => undefined
  const restoreDone = new Promise<void>((resolve, reject) => {
    finishRestore = resolve
    failRestore = reject
  })

  @Component({
    template: `<h1>{{ state.data() }}</h1>`,
  })
  class Page {
    state = injectQuery(() => ({
      queryKey: QUERY_KEY,
      queryFn: () => network,
    }))
  }

  const rendered = await render(Page, {
    providers: [
      provideZonelessChangeDetection(),
      provideTanStackQuery(
        queryClient,
        withPersistQueryClient({
          persistOptions: { persister },
          onSuccess: () => {
            try {
              expect(queryClient.getQueryData(QUERY_KEY)).toBeUndefined()
              expect(cacheHasNoRestoredData(queryClient)).toBe(true)
              expect(items.has(STORAGE_KEY)).toBe(false)
              expect(removedWhileEmpty).toEqual([true])
              finishRestore()
            } catch (error) {
              failRestore(error)
            }
          },
          onError: () => {
            failRestore(new Error('persist restore rejected the client'))
          },
        }),
      ),
    ],
  })

  return { rendered, queryClient, items, resolveNetwork, restoreDone }
}

describe('withPersistQueryClient expiration bypass', () => {
  it('does not hydrate a snapshot whose timestamp is one minute ahead of the clock', async () => {
    const { rendered, queryClient, resolveNetwork, restoreDone } =
      await renderRestoringApp(
        persistedRecord('forged-soon', Date.now() + MINUTE),
      )

    await restoreDone
    await Promise.resolve()
    rendered.fixture.detectChanges()
    expect(rendered.queryByText('forged-soon')).not.toBeInTheDocument()

    resolveNetwork('from-network')
    expect(await rendered.findByText('from-network')).toBeInTheDocument()
    expect(queryClient.getQueryData(QUERY_KEY)).toBe('from-network')
    rendered.fixture.destroy()
  })

  it('does not hydrate a snapshot whose timestamp is a word', async () => {
    const { rendered, queryClient, resolveNetwork, restoreDone } =
      await renderRestoringApp(persistedRecord('forged-word', 'not-a-time'))

    await restoreDone
    await Promise.resolve()
    rendered.fixture.detectChanges()
    expect(rendered.queryByText('forged-word')).not.toBeInTheDocument()

    resolveNetwork('from-network')
    expect(await rendered.findByText('from-network')).toBeInTheDocument()
    expect(queryClient.getQueryData(QUERY_KEY)).toBe('from-network')
    rendered.fixture.destroy()
  })

  it('does not hydrate a snapshot loaded again between the age check and hydrate', async () => {
    const { rendered, resolveNetwork, restoreDone } = await renderRestoringApp(
      persistedRecord('forged-first-read', Date.now() + MINUTE),
      persistedRecord('forged-second-read', 'not-a-time'),
    )

    await restoreDone
    await Promise.resolve()
    rendered.fixture.detectChanges()
    expect(rendered.queryByText('forged-first-read')).not.toBeInTheDocument()
    expect(rendered.queryByText('forged-second-read')).not.toBeInTheDocument()

    resolveNetwork('from-network')
    expect(await rendered.findByText('from-network')).toBeInTheDocument()
    rendered.fixture.destroy()
  })

  it('still hydrates a fresh snapshot through the Angular persist provider', async () => {
    const items = new Map<string, string>([
      [STORAGE_KEY, persistedRecord('saved-profile', Date.now())],
    ])
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const persister = storagePersister(items, () => undefined)

    let resolveNetwork: (value: string) => void = () => undefined
    const network = new Promise<string>((resolve) => {
      resolveNetwork = resolve
    })
    let finishRestore: () => void = () => undefined
    const restoreDone = new Promise<void>((resolve) => {
      finishRestore = resolve
    })

    @Component({
      template: `<h1>{{ state.data() }}</h1>`,
    })
    class Page {
      state = injectQuery(() => ({
        queryKey: QUERY_KEY,
        queryFn: () => network,
      }))
    }

    const rendered = await render(Page, {
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(
          queryClient,
          withPersistQueryClient({
            persistOptions: { persister },
            onSuccess: () => {
              finishRestore()
            },
          }),
        ),
      ],
    })

    await restoreDone
    await Promise.resolve()
    rendered.fixture.detectChanges()
    expect(queryClient.getQueryData(QUERY_KEY)).toBe('saved-profile')
    expect(rendered.getByText('saved-profile')).toBeInTheDocument()
    expect(items.has(STORAGE_KEY)).toBe(true)

    resolveNetwork('from-network')
    expect(await rendered.findByText('from-network')).toBeInTheDocument()
    rendered.fixture.destroy()
  })
})
