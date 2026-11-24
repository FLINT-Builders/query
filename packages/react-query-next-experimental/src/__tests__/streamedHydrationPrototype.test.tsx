// @vitest-environment jsdom

import { createServerInsertedHTML } from 'next/dist/server/app-render/server-inserted-html.js'
import { makeGetServerInsertedHTML } from 'next/dist/server/app-render/make-get-server-inserted-html.js'
import { afterEach, describe, expect, it } from 'vitest'
import * as React from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToReadableStream } from 'react-dom/server'
import { act } from 'react'
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  environmentManager,
  isServer,
  onlineManager,
  useSuspenseQuery,
} from '@tanstack/react-query'
import { ReactQueryStreamedHydration } from '../ReactQueryStreamedHydration'

const identifierPrefix = 'streamed'

const postBody =
  '{"title":"a<b & c>","__proto__":{"canModerate":true},"comments":[{"id":1,"body":"hi","__proto__":{"role":"admin"}}],"author":{"name":"ada","profile":{"bio":"hi","__proto__":{"trusted":true}}}}'

const laterBody = '{"note":"later","__proto__":{"canPublish":true}}'

const saveBody = '{"label":"save","__proto__":{"canApprove":true}}'

type Post = {
  title?: string
  canModerate?: boolean
  comments?: Array<{ id?: number; body?: string; role?: string }>
  author?: {
    name?: string
    profile?: { bio?: string; trusted?: boolean }
  }
}

type Later = {
  note?: string
  canPublish?: boolean
}

type SaveVariables = {
  label?: string
  canApprove?: boolean
}

let serveAttackerJson = true
let clientJsonReads = 0

async function readAttackerJson(body: string): Promise<unknown> {
  if (!serveAttackerJson) {
    clientJsonReads += 1
    return { title: 'client-refetch' }
  }

  const response = new Response(body, {
    headers: { 'content-type': 'application/json' },
  })
  return response.json()
}

function PostPage() {
  const { data } = useSuspenseQuery({
    queryKey: ['post'],
    queryFn: () => readAttackerJson(postBody),
  })
  const post = data as Post

  return (
    <div>
      <span data-testid="title">{post.title}</span>
      <span data-testid="moderate">{String(post.canModerate)}</span>
      <span data-testid="role">{String(post.comments?.[0]?.role)}</span>
      <span data-testid="trusted">{String(post.author?.profile?.trusted)}</span>
      <span data-testid="bio">{post.author?.profile?.bio}</span>
    </div>
  )
}

function executeInlineScripts(html: string) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  const inline = scripts.filter((match) => {
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    return !/\ssrc\s*=/i.test(attrs) && body.includes('window[')
  })
  expect(inline.length).toBeGreaterThan(0)
  for (const match of inline) {
    window.eval(match[2] ?? '')
  }
}

async function insertedHtml(
  renderServerInsertedHTML: () => React.ReactNode,
): Promise<string> {
  const getServerInsertedHTML = makeGetServerInsertedHTML({
    polyfills: [],
    renderServerInsertedHTML,
    serverCapturedErrors: [],
    basePath: '',
  })
  return getServerInsertedHTML()
}

describe('streamed hydration script payload', () => {
  afterEach(() => {
    serveAttackerJson = true
    clientJsonReads = 0
    environmentManager.setIsServer(() => isServer)
    onlineManager.setOnline(true)
  })

  it('does not let a __proto__ key in prefetched JSON become inherited data on the client cache', async () => {
    serveAttackerJson = true
    environmentManager.setIsServer(() => true)
    onlineManager.setOnline(true)

    const serverClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000, networkMode: 'always' },
      },
    })
    const saveVariables = (await readAttackerJson(saveBody)) as SaveVariables
    const { ServerInsertedHTMLProvider, renderServerInsertedHTML } =
      createServerInsertedHTML()

    const page = await renderToReadableStream(
      <ServerInsertedHTMLProvider>
        <QueryClientProvider client={serverClient}>
          <ReactQueryStreamedHydration>
            <React.Suspense fallback={<p>loading</p>}>
              <PostPage />
            </React.Suspense>
          </ReactQueryStreamedHydration>
        </QueryClientProvider>
      </ServerInsertedHTMLProvider>,
      { identifierPrefix },
    )
    await page.allReady
    const pageHtml = await new Response(page).text()

    onlineManager.setOnline(false)
    const observer = new MutationObserver(serverClient, {
      mutationKey: ['save-post'],
      networkMode: 'online',
      mutationFn: () => Promise.resolve('saved'),
    })
    const pendingSave = observer.mutate(saveVariables)
    void Promise.resolve(pendingSave).catch(() => {
      // A paused mutation stays pending while the browser is offline.
    })

    const firstHtml = await insertedHtml(renderServerInsertedHTML)
    expect(firstHtml).toContain('window[')
    executeInlineScripts(firstHtml)

    const serverPost = serverClient.getQueryData(['post']) as Post
    expect(serverPost.title).toBe('a<b & c>')
    expect(serverPost.canModerate).toBeUndefined()
    expect(Object.getPrototypeOf(serverPost)).toBe(Object.prototype)

    serveAttackerJson = false
    onlineManager.setOnline(true)
    environmentManager.setIsServer(() => false)

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60_000, networkMode: 'always' },
      },
    })
    const container = document.createElement('div')
    container.innerHTML = pageHtml
    document.body.appendChild(container)
    await act(() => {
      hydrateRoot(
        container,
        <QueryClientProvider client={client}>
          <ReactQueryStreamedHydration>
            <React.Suspense fallback={<p>loading</p>}>
              <PostPage />
            </React.Suspense>
          </ReactQueryStreamedHydration>
        </QueryClientProvider>,
        {
          identifierPrefix,
          onRecoverableError() {
            // Client text can disagree with the server HTML until this is fixed.
          },
        },
      )
    })

    const post = client.getQueryData(['post']) as Post
    expect(clientJsonReads).toBe(0)
    expect(post.title).toBe('a<b & c>')
    expect(post.comments?.[0]?.id).toBe(1)
    expect(post.comments?.[0]?.body).toBe('hi')
    expect(post.author?.name).toBe('ada')
    expect(post.author?.profile?.bio).toBe('hi')
    expect(container.querySelector('[data-testid="title"]')?.textContent).toBe(
      'a<b & c>',
    )
    expect(container.querySelector('[data-testid="bio"]')?.textContent).toBe(
      'hi',
    )

    expect(post.canModerate).toBeUndefined()
    expect(post.comments?.[0]?.role).toBeUndefined()
    expect(post.author?.profile?.trusted).toBeUndefined()
    expect(
      container.querySelector('[data-testid="moderate"]')?.textContent,
    ).toBe('undefined')
    expect(container.querySelector('[data-testid="role"]')?.textContent).toBe(
      'undefined',
    )
    expect(
      container.querySelector('[data-testid="trusted"]')?.textContent,
    ).toBe('undefined')
    expect(Object.getPrototypeOf(post)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(post.comments?.[0])).toBe(Object.prototype)
    expect(Object.getPrototypeOf(post.author?.profile)).toBe(Object.prototype)

    const save = client.getMutationCache().find({ mutationKey: ['save-post'] })
    const variables = save?.state.variables as SaveVariables | undefined
    expect(variables?.label).toBe('save')
    expect(variables?.canApprove).toBeUndefined()
    expect(Object.getPrototypeOf(variables)).toBe(Object.prototype)

    serveAttackerJson = true
    await serverClient.query({
      queryKey: ['later'],
      queryFn: () => readAttackerJson(laterBody),
    })
    serveAttackerJson = false
    const secondHtml = await insertedHtml(renderServerInsertedHTML)
    expect(secondHtml).toContain('window[')
    executeInlineScripts(secondHtml)

    const later = client.getQueryData(['later']) as Later
    expect(later.note).toBe('later')
    expect(later.canPublish).toBeUndefined()
    expect(Object.getPrototypeOf(later)).toBe(Object.prototype)
    expect(({} as { canModerate?: boolean }).canModerate).toBeUndefined()

    container.remove()
    serverClient.clear()
    client.clear()
  })
})
