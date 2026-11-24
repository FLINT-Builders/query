/**
 * @vitest-environment node
 *
 * A visitor who can make a Solid server-rendered query fail must not receive
 * the thrown value in the HTML. These assertions fail while that value is
 * serialized with the resource.
 */
/* eslint vitest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectNotDisclosed"] }] */
import { ErrorBoundary, Suspense } from 'solid-js'
import { isServer, renderToStream, renderToStringAsync } from 'solid-js/web'
import { describe, expect, it } from 'vitest'
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from '..'
import type { JSX } from 'solid-js'

const MESSAGE = 'failed to load marker-record'
const FIELD = 'marker-upstream-detail'
const STACK_NAME = 'leakyQueryFunction'
const PUBLIC_LABEL = 'public-record'

function leakedError(): Error {
  const error = new Error(MESSAGE)
  Object.assign(error, { upstream: FIELD })
  return error
}

function leakedPlain(): { detail: string } {
  return { detail: FIELD }
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function pageShell(page: () => JSX.Element, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary fallback={<p>unavailable</p>}>
        <Suspense fallback={<p>loading</p>}>{page()}</Suspense>
      </ErrorBoundary>
    </QueryClientProvider>
  )
}

async function renderPage(
  page: () => JSX.Element,
  queryClient = client(),
): Promise<string> {
  return renderToStringAsync(() => pageShell(page, queryClient))
}

async function renderStreamedPage(
  page: () => JSX.Element,
  queryClient = client(),
): Promise<string> {
  const chunks: Array<string> = []
  const stream = renderToStream(() => pageShell(page, queryClient))
  stream.pipe({
    write(value: string) {
      chunks.push(value)
    },
    end() {},
  } as { write: (value: string) => void })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const html = chunks.join('')
  expect(html).toContain('<p>')
  return html
}

function expectNotDisclosed(html: string) {
  expect(html).not.toContain(MESSAGE)
  expect(html).not.toContain(FIELD)
  expect(html).not.toContain(STACK_NAME)
}

describe.skipIf(!isServer)('solid server rendering error disclosure', () => {
  it('runs with the Solid server build', () => {
    expect(isServer).toBe(true)
  })

  it('still serializes successful query data', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'ok'],
        queryFn: () => ({ label: PUBLIC_LABEL }),
      }))
      return <p>{query.data?.label ?? 'unavailable'}</p>
    })

    expect(html).toContain(PUBLIC_LABEL)
  })

  it('does not serialize an async useQuery failure into the HTML', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'requested-id'],
        queryFn: async function leakyQueryFunction(): Promise<{
          label: string
        }> {
          await Promise.resolve()
          throw leakedError()
        },
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    })

    expectNotDisclosed(html)
  })

  it('does not serialize a plain thrown object from useQuery into the HTML', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'plain'],
        queryFn: async function leakyQueryFunction(): Promise<{
          label: string
        }> {
          await Promise.resolve()
          throw leakedPlain()
        },
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    })

    expectNotDisclosed(html)
  })

  it('does not serialize an async useInfiniteQuery failure into the HTML', async () => {
    const html = await renderPage(() => {
      const query = useInfiniteQuery(() => ({
        queryKey: ['pages', 'requested-id'],
        queryFn: async function leakyQueryFunction(): Promise<{
          label: string
        }> {
          await Promise.resolve()
          throw leakedError()
        },
        initialPageParam: 0,
        getNextPageParam: () => undefined,
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    })

    expectNotDisclosed(html)
  })

  it('does not serialize a deferred-stream useQuery failure into the HTML', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'deferred'],
        deferStream: true,
        queryFn: async function leakyQueryFunction(): Promise<{
          label: string
        }> {
          await Promise.resolve()
          throw leakedError()
        },
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    })

    expectNotDisclosed(html)
  })

  it('does not serialize a select failure into the HTML', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'select'],
        queryFn: async () => {
          await Promise.resolve()
          return { value: 1 }
        },
        select: function leakyQueryFunction(): { value: number } {
          throw leakedError()
        },
      }))
      return <p>{query.fetchStatus}</p>
    })

    expect(html).toContain('value')
    expectNotDisclosed(html)
  })

  it('does not serialize a cached error that is fetched again during render', async () => {
    const queryClient = client()
    await queryClient
      .query({
        queryKey: ['record', 'cached'],
        queryFn: function leakyQueryFunction() {
          throw leakedError()
        },
      })
      .catch(() => undefined)

    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'cached'],
        queryFn: function leakyQueryFunction(): Promise<{ label: string }> {
          throw leakedError()
        },
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    }, queryClient)

    expectNotDisclosed(html)
  })

  it('does not serialize a cached error when the server resource rejects it', async () => {
    const queryClient = client()
    const queryKey = ['record', 'no-refetch']
    await queryClient
      .query({
        queryKey,
        queryFn: function leakyQueryFunction() {
          throw leakedError()
        },
      })
      .catch(() => undefined)

    const html = await renderStreamedPage(() => {
      const query = useQuery(() => ({
        queryKey,
        retryOnMount: false,
        queryFn: function leakyQueryFunction(): Promise<{ label: string }> {
          throw leakedError()
        },
      }))
      return <p>{query.data == null ? 'unavailable' : 'ready'}</p>
    }, queryClient)

    expectNotDisclosed(html)
  })

  it('does not serialize a failure when the query already has data', async () => {
    const queryClient = client()
    const queryKey = ['record', 'with-data']
    const error = leakedError()
    queryClient.setQueryData(queryKey, { value: 'previous' })
    queryClient.getQueryCache().find({ queryKey })?.setState({
      status: 'error',
      error,
      fetchFailureReason: error,
      fetchStatus: 'idle',
    })

    const html = await renderStreamedPage(() => {
      const query = useQuery(() => ({
        queryKey,
        refetchOnMount: false,
        queryFn: function leakyQueryFunction(): Promise<{ value: string }> {
          throw leakedError()
        },
      }))
      return <p>{query.data?.value ?? 'unavailable'}</p>
    }, queryClient)

    expectNotDisclosed(html)
  })

  it('does not serialize a later refetch failure after initial data was sent', async () => {
    const html = await renderPage(() => {
      const query = useQuery(() => ({
        queryKey: ['record', 'initial'],
        initialData: { value: 'previous' },
        queryFn: async function leakyQueryFunction(): Promise<{
          value: string
        }> {
          await Promise.resolve()
          throw leakedError()
        },
      }))
      return <p>{query.data.value}</p>
    })

    expect(html).toContain('previous')
    expectNotDisclosed(html)
  })
})
