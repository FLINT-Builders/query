import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import {
  SolidQueryDevtools,
  SolidQueryDevtoolsPanel,
} from '..'
import type { Accessor } from 'solid-js'

const previousQueryLabel = /Query key \["previous-account"\]/
const currentQueryLabel = /Query key \["current-account"\]/
const previousMutationText = /\["previous-mutation"\]/
const currentMutationText = /\["current-mutation"\]/

type Surface = 'devtools' | 'panel'
type Source = 'prop' | 'context'

const surfaces = [
  ['devtools', 'prop'],
  ['devtools', 'context'],
  ['panel', 'prop'],
  ['panel', 'context'],
] as const satisfies ReadonlyArray<readonly [Surface, Source]>

const clients: Array<QueryClient> = []

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  for (const client of clients) client.clear()
  clients.length = 0
})

function installDomStubs() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe = vi.fn((target: Element) => {
        this.callback(
          [
            {
              target,
              contentRect: { width: 1000, height: 500 } as DOMRectReadOnly,
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        )
      })
      unobserve = vi.fn()
      disconnect = vi.fn()
    },
  )
}

function track(client: QueryClient) {
  clients.push(client)
  return client
}

function pair() {
  return {
    previous: track(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    current: track(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
  }
}

function renderSurface(
  surface: Surface,
  source: Source,
  client: Accessor<QueryClient>,
) {
  return render(() => {
    if (surface === 'devtools') {
      return source === 'context' ? (
        <QueryClientProvider client={client()}>
          <SolidQueryDevtools initialIsOpen />
        </QueryClientProvider>
      ) : (
        <SolidQueryDevtools client={client()} initialIsOpen />
      )
    }
    return source === 'context' ? (
      <QueryClientProvider client={client()}>
        <SolidQueryDevtoolsPanel />
      </QueryClientProvider>
    ) : (
      <SolidQueryDevtoolsPanel client={client()} />
    )
  })
}

async function openCurrentQuery(
  rendered: ReturnType<typeof renderSurface>,
) {
  const row = await rendered.findByLabelText(currentQueryLabel)
  // The selected hash lives in devtools module state and can still point at
  // a details view created for the previous client. Close it, then open the
  // current client's query so the action buttons bind to that client.
  if (rendered.queryByText('Query Details')) {
    fireEvent.click(row)
    await rendered.findByLabelText(currentQueryLabel)
    expect(rendered.queryByText('Query Details')).not.toBeInTheDocument()
  }
  fireEvent.click(row)
  await rendered.findByText('Query Details')
}

async function switchAccount(options: {
  surface: Surface
  source: Source
  previous: QueryClient
  current: QueryClient
}) {
  const [client, setClient] = createSignal(options.previous)
  const rendered = renderSurface(options.surface, options.source, client)
  // The panel must be showing the first account before the swap. A mount that
  // already sees the second client would not exercise the frozen capture.
  await rendered.findByLabelText(previousQueryLabel, {}, { timeout: 5000 })
  setClient(options.current)
  return rendered
}

async function seedMutation(client: QueryClient, key: string) {
  const mutation = client.getMutationCache().build(client, {
    mutationKey: [key],
    mutationFn: async () => key,
  })
  await mutation.execute({})
}

describe.each(surfaces)(
  'Solid Query devtools (%s, client from %s)',
  (surface, source) => {
    it('lists the replacement client cache after an account switch that keeps the panel mounted', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })

      await rendered.findByLabelText(currentQueryLabel)
      expect(
        rendered.queryByLabelText(previousQueryLabel),
      ).not.toBeInTheDocument()
    })

    it('lists the replacement client mutations after an account switch that keeps the panel mounted', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })
      await seedMutation(previous, 'previous-mutation')
      await seedMutation(current, 'current-mutation')

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await rendered.findByLabelText(currentQueryLabel)
      fireEvent.click(rendered.getByText('Mutations'))

      expect(await rendered.findByText(currentMutationText)).toBeInTheDocument()
      expect(rendered.queryByText(previousMutationText)).not.toBeInTheDocument()
    })

    it('refetches the replacement client query after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      const previousFetch = vi.fn(async () => ({ name: 'previous' }))
      const currentFetch = vi.fn(async () => ({ name: 'current' }))
      await previous.prefetchQuery({
        queryKey: ['previous-account'],
        queryFn: previousFetch,
      })
      await current.prefetchQuery({
        queryKey: ['current-account'],
        queryFn: currentFetch,
      })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(rendered.getByText('Refetch'))
      await vi.waitFor(() => {
        expect(currentFetch).toHaveBeenCalledTimes(2)
      })

      expect(previousFetch).toHaveBeenCalledTimes(1)
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
    })

    it('writes a bulk data edit to the replacement client after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(await rendered.findByLabelText('Bulk Edit Data'))
      const textarea = rendered.getByLabelText('Edit query data as JSON')
      fireEvent.input(textarea, {
        target: { value: JSON.stringify({ name: 'edited' }) },
      })
      fireEvent.submit(textarea.closest('form')!)

      expect(current.getQueryData(['current-account'])).toEqual({
        name: 'edited',
      })
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
      expect(previous.getQueryData(['current-account'])).toBeUndefined()
    })

    it('writes an inline data edit to the replacement client after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      const input = await rendered.findByRole('textbox', { name: 'name:' })
      fireEvent.change(input, { target: { value: 'edited-inline' } })

      expect(current.getQueryData(['current-account'])).toEqual({
        name: 'edited-inline',
      })
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
      expect(previous.getQueryData(['current-account'])).toBeUndefined()
    })

    it('invalidates the replacement client query after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(await rendered.findByRole('button', { name: 'Invalidate' }))

      expect(
        current.getQueryState(['current-account'])?.isInvalidated,
      ).toBe(true)
      expect(
        previous.getQueryState(['previous-account'])?.isInvalidated,
      ).toBe(false)
    })

    it('resets the replacement client query after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(await rendered.findByRole('button', { name: 'Reset' }))

      expect(current.getQueryData(['current-account'])).toBeUndefined()
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
    })

    it('removes the replacement client query after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(await rendered.findByRole('button', { name: 'Remove' }))

      expect(
        current.getQueryCache().find({ queryKey: ['current-account'] }),
      ).toBeUndefined()
      expect(
        previous.getQueryCache().find({ queryKey: ['previous-account'] }),
      ).toBeDefined()
    })

    it('marks the replacement client query as errored after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await openCurrentQuery(rendered)
      fireEvent.click(
        await rendered.findByRole('button', { name: 'Trigger Error' }),
      )

      expect(current.getQueryState(['current-account'])?.status).toBe('error')
      expect(previous.getQueryState(['previous-account'])?.status).toBe(
        'success',
      )
    })

    it('clears the replacement client query cache after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await rendered.findByLabelText(currentQueryLabel)
      fireEvent.click(rendered.getByLabelText('Clear query cache'))

      expect(current.getQueryCache().getAll()).toHaveLength(0)
      expect(previous.getQueryCache().getAll()).toHaveLength(1)
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
    })

    it('clears the replacement client mutation cache after an account switch', async () => {
      installDomStubs()
      const { previous, current } = pair()
      previous.setQueryData(['previous-account'], { name: 'previous' })
      current.setQueryData(['current-account'], { name: 'current' })
      await seedMutation(previous, 'previous-mutation')
      await seedMutation(current, 'current-mutation')

      const rendered = await switchAccount({
        surface,
        source,
        previous,
        current,
      })
      await rendered.findByLabelText(currentQueryLabel)
      fireEvent.click(rendered.getByText('Mutations'))
      await rendered.findByText(currentMutationText)
      fireEvent.click(rendered.getByLabelText('Clear query cache'))

      expect(current.getMutationCache().getAll()).toHaveLength(0)
      expect(previous.getMutationCache().getAll()).toHaveLength(1)
      expect(previous.getQueryData(['previous-account'])).toEqual({
        name: 'previous',
      })
    })
  },
)
