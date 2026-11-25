/**
 * @vitest-environment node
 *
 * Server renders share one Node process. `@lit-labs/ssr` 3.3.1 calls the
 * element's `connectedCallback` only when `litSsrCallConnectedCallback` is set
 * (see `LitElementRenderer.connectedCallback`). `QueryClientProvider` registers
 * in that callback. These tests pin the isolation that callback must keep:
 * another request in the same process must not read or write the registered
 * cache, and a second connected provider must not make the helper throw.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { html, LitElement } from 'lit'
import { QueryClient } from '@tanstack/query-core'
import { render } from '../../../../examples/lit/ssr/node_modules/@lit-labs/ssr/index.js'
import {
  collectResult,
  collectResultSync,
} from '../../../../examples/lit/ssr/node_modules/@lit-labs/ssr/lib/render-result.js'
import {
  getDefaultQueryClient,
  QueryClientProvider,
  resolveQueryClient,
  unregisterDefaultQueryClient,
  useQueryClient,
} from '../index.js'

declare global {
  var litSsrCallConnectedCallback: boolean | undefined
}

const providerTag = 'ssr-cross-request-provider'
const readerTag = 'ssr-cross-request-reader'
const writerTag = 'ssr-cross-request-writer'
const markerTag = 'ssr-cross-request-marker'

if (!customElements.get(providerTag)) {
  customElements.define(providerTag, QueryClientProvider)
}

const profileKey = ['ssr-cross-request', 'profile'] as const

type Profile = {
  userId: string
  label: string
}

const createdClients: Array<QueryClient> = []

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readGlobalClient(read: () => QueryClient): {
  client: QueryClient | undefined
  error: string
} {
  try {
    return { client: read(), error: '' }
  } catch (error) {
    return { client: undefined, error: messageOf(error) }
  }
}

function expectIsolatedFrom(
  result: { client: QueryClient | undefined; error: string },
  foreignClients: Array<QueryClient>,
): void {
  expect(result.error).not.toMatch(/Multiple QueryClients are mounted/)
  expect(foreignClients.includes(result.client as QueryClient)).toBe(false)
  for (const client of foreignClients) {
    expect(result.client?.getQueryData<Profile>(profileKey)).not.toEqual(
      client.getQueryData<Profile>(profileKey),
    )
  }
  expect(
    result.client !== undefined ||
      /No QueryClient available/.test(result.error),
  ).toBe(true)
}

function createPrefetchedClient(profile: Profile): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  createdClients.push(client)
  client.setQueryData(profileKey, profile)
  return client
}

function enableConnectedCallbacks(): void {
  globalThis.litSsrCallConnectedCallback = true
}

function renderProvider(client: QueryClient) {
  return render(html`
    <ssr-cross-request-provider .client=${client}></ssr-cross-request-provider>
  `)
}

class CrossRequestReader extends LitElement {
  seenClient: QueryClient | undefined
  seenProfile: Profile | undefined
  seenError = ''

  override render() {
    try {
      const client = useQueryClient()
      this.seenClient = client
      this.seenProfile = client.getQueryData<Profile>(profileKey)
    } catch (error) {
      this.seenError = messageOf(error)
      this.seenClient = undefined
      this.seenProfile = undefined
    }

    const userId = this.seenProfile?.userId ?? ''
    const label = this.seenProfile?.label ?? ''
    return html`<p>${userId} ${label}</p>`
  }
}

class CrossRequestWriter extends LitElement {
  override render() {
    const client = resolveQueryClient()
    const current = client.getQueryData<Profile>(profileKey)
    client.setQueryData(profileKey, {
      userId: 'request-b',
      label: 'written-by-request-b',
    })
    client.setQueryData(['ssr-cross-request', 'note'], {
      previousUserId: current?.userId ?? '',
    })
    return html`<p>wrote</p>`
  }
}

class CrossRequestMarker extends LitElement {
  static markerReached = false

  override render() {
    CrossRequestMarker.markerReached = true
    return html`<span>marker</span>`
  }
}

if (!customElements.get(readerTag)) {
  customElements.define(readerTag, CrossRequestReader)
}
if (!customElements.get(writerTag)) {
  customElements.define(writerTag, CrossRequestWriter)
}
if (!customElements.get(markerTag)) {
  customElements.define(markerTag, CrossRequestMarker)
}

async function renderConnectedProvider(client: QueryClient): Promise<string> {
  enableConnectedCallbacks()
  return collectResult(renderProvider(client))
}

afterEach(() => {
  globalThis.litSsrCallConnectedCallback = false
  for (const client of createdClients) {
    unregisterDefaultQueryClient(client)
    unregisterDefaultQueryClient(client)
  }
  createdClients.length = 0
  CrossRequestMarker.markerReached = false
})

describe('SSR cross-request QueryClient isolation', () => {
  it('does not return another request cache from useQueryClient after that request connects a provider', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    expectIsolatedFrom(
      readGlobalClient(() => useQueryClient()),
      [alice],
    )
  })

  it('does not return another request cache from resolveQueryClient when no client is passed', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    expectIsolatedFrom(
      readGlobalClient(() => resolveQueryClient()),
      [alice],
    )
  })

  it('does not return another request cache from getDefaultQueryClient', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    const resolved = getDefaultQueryClient()
    expect(resolved).not.toBe(alice)
    expect(resolved).toBeUndefined()
  })

  it('does not let useQueryClient write into another request cache', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    const write = readGlobalClient(() => {
      const client = useQueryClient()
      client.setQueryData(profileKey, {
        userId: 'request-b',
        label: 'written-by-request-b',
      })
      return client
    })

    expectIsolatedFrom(write, [alice])
    expect(alice.getQueryData<Profile>(profileKey)).toEqual({
      userId: 'alice',
      label: 'alice-prefetched',
    })
  })

  it('does not let resolveQueryClient write into another request cache during a later render', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    let error = ''
    try {
      await collectResult(
        render(html`<ssr-cross-request-writer></ssr-cross-request-writer>`),
      )
    } catch (caught) {
      error = messageOf(caught)
    }

    expect(alice.getQueryData<Profile>(profileKey)).toEqual({
      userId: 'alice',
      label: 'alice-prefetched',
    })
    expect(
      alice.getQueryData<{ previousUserId: string }>([
        'ssr-cross-request',
        'note',
      ]),
    ).toBeUndefined()
    expect(error).not.toMatch(/Multiple QueryClients are mounted/)
  })

  it('does not render another request prefetched profile into the next response', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })

    await renderConnectedProvider(alice)

    let htmlText = ''
    let error = ''
    let seenClient: QueryClient | undefined
    const readers: Array<CrossRequestReader> = []
    const original = CrossRequestReader.prototype.render
    CrossRequestReader.prototype.render = function renderReader() {
      readers.push(this)
      return original.call(this)
    }

    try {
      htmlText = await collectResult(
        render(html`<ssr-cross-request-reader></ssr-cross-request-reader>`),
      )
      seenClient = readers[0]?.seenClient
      error = readers[0]?.seenError ?? ''
    } catch (caught) {
      error = messageOf(caught)
    } finally {
      CrossRequestReader.prototype.render = original
    }

    expect(htmlText).not.toContain('alice')
    expect(htmlText).not.toContain('alice-prefetched')
    expectIsolatedFrom({ client: seenClient, error }, [alice])
  })

  it('does not throw Multiple QueryClients when two server renders have connected providers', async () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })
    const bob = createPrefetchedClient({
      userId: 'bob',
      label: 'bob-prefetched',
    })

    await renderConnectedProvider(alice)
    await renderConnectedProvider(bob)

    expectIsolatedFrom(
      readGlobalClient(() => useQueryClient()),
      [alice, bob],
    )
    expectIsolatedFrom(
      readGlobalClient(() => resolveQueryClient()),
      [alice, bob],
    )
    expect(getDefaultQueryClient()).toBeUndefined()
  })

  it('does not leak the in-flight request cache into a second render started before the first finishes', () => {
    const alice = createPrefetchedClient({
      userId: 'alice',
      label: 'alice-prefetched',
    })
    enableConnectedCallbacks()
    CrossRequestMarker.markerReached = false

    const firstRender = render(html`
      <ssr-cross-request-provider .client=${alice}>
        <ssr-cross-request-marker></ssr-cross-request-marker>
      </ssr-cross-request-provider>
    `)[Symbol.iterator]()

    let streamed = ''
    for (
      let step = 0;
      step < 1000 && !CrossRequestMarker.markerReached;
      step++
    ) {
      const next = firstRender.next()
      if (next.done) {
        break
      }
      if (typeof next.value === 'string') {
        streamed += next.value
      }
    }

    expect(CrossRequestMarker.markerReached).toBe(true)
    expect(streamed.length).toBeGreaterThan(0)
    expect(getDefaultQueryClient()).not.toBe(alice)

    let secondHtml = ''
    let error = ''
    try {
      secondHtml = collectResultSync(
        render(html`<ssr-cross-request-reader></ssr-cross-request-reader>`),
      )
    } catch (caught) {
      error = messageOf(caught)
    }

    expect(secondHtml).not.toContain('alice')
    expect(secondHtml).not.toContain('alice-prefetched')
    expect(error).not.toMatch(/Multiple QueryClients are mounted/)
    expect(alice.getQueryData<Profile>(profileKey)).toEqual({
      userId: 'alice',
      label: 'alice-prefetched',
    })
  })
})
