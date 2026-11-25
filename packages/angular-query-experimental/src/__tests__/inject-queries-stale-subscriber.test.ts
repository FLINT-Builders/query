import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { render } from '@testing-library/angular'
import { sleep } from '@tanstack/query-test-utils'
import { QueryClient as QueryClientImpl, provideTanStackQuery } from '..'
import { injectMutation } from '../inject-mutation'
import { injectQueries } from '../inject-queries'
import type { QueryClient, QueryKey } from '@tanstack/query-core'

/**
 * A record the screen can show and then edit or delete.
 * The id is what that later action would send.
 */
interface RecordRow {
  id: string
  title: string
}

/**
 * `injectQueries` prefers the last value written by its cache subscription
 * over the optimistic result for the current query list, and nothing clears
 * that saved value when the list changes.
 *
 * These tests mount one component, let the subscription store a combined
 * result, then replace the id list with queries that are already cached.
 * The value read by the template and by a delete action must be the combined
 * result for the new list. An older subscription callback that was already
 * queued must not put the previous records back.
 */
describe('injectQueries stale subscriber snapshot', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClientImpl({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
        },
      },
    })
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(queryClient),
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function seed(id: string, title = `Record ${id}`): RecordRow {
    const row: RecordRow = { id, title }
    queryClient.setQueryData(recordKey(id), row)
    return row
  }

  it('shows the new combined records after the id list changes on a mounted component', async () => {
    seed('acct-a')
    seed('acct-b')

    const rendered = await render(RecordsScreen)
    const screen = rendered.fixture.componentInstance

    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a')

    // A cache update is what stores the subscriber snapshot. The list of ids
    // has not changed; the screen still shows account A.
    queryClient.setQueryData(recordKey('acct-a'), {
      id: 'acct-a',
      title: 'Record acct-a renamed',
    })
    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a')
    expect(screen.combined().records[0]?.title).toBe('Record acct-a renamed')

    screen.ids.set(['acct-b'])
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-b')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-b')

    // No further cache write. The previous snapshot must not remain on screen.
    await flushNotifications()
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-b')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-b')
  })

  it('does not apply a queued update from the previous id list after the list changes', async () => {
    seed('acct-a')
    seed('acct-b')
    seed('acct-c')

    const rendered = await render(RecordsScreen)
    const screen = rendered.fixture.componentInstance
    screen.ids.set(['acct-a', 'acct-b'])

    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a,acct-b')

    queryClient.setQueryData(recordKey('acct-a'), {
      id: 'acct-a',
      title: 'Record acct-a renamed',
    })
    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a,acct-b')

    // Queue one more update for a record that is about to leave the list,
    // and switch before that notification is applied.
    queryClient.setQueryData(recordKey('acct-a'), {
      id: 'acct-a',
      title: 'Record acct-a queued',
    })

    screen.ids.set(['acct-c'])
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-c')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-c')

    await flushNotifications()
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-c')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-c')
  })

  it('keeps per-query results aligned when combine is omitted', async () => {
    seed('acct-a')
    seed('acct-b')
    seed('acct-c')

    @Component({
      selector: 'plain-records-screen',
      template: `
        <p data-testid="shown">{{ shownIds() }}</p>
        <button type="button" (click)="deleteShown()">Delete</button>
      `,
    })
    class PlainRecordsScreen {
      readonly ids = signal<Array<string>>(['acct-a', 'acct-b'])
      deletedId: string | undefined

      readonly queries = injectQueries(() => ({
        queries: this.ids().map((id) => ({
          queryKey: recordKey(id),
          queryFn: () => loadRecord(queryClient, id),
        })),
      }))

      shownIds(): string {
        return this.queries()
          .map((query) => query.data()?.id)
          .filter((id): id is string => id != null)
          .join(',')
      }

      deleteShown(): void {
        this.deletedId = this.queries()[0]?.data()?.id
      }
    }

    const rendered = await render(PlainRecordsScreen)
    const screen = rendered.fixture.componentInstance

    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a,acct-b')

    queryClient.setQueryData(recordKey('acct-a'), {
      id: 'acct-a',
      title: 'Record acct-a renamed',
    })
    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(shown(rendered)).toBe('acct-a,acct-b')

    screen.ids.set(['acct-c'])
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-c')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-c')

    await flushNotifications()
    rendered.fixture.detectChanges()

    expect(shown(rendered)).toBe('acct-c')
    screen.deleteShown()
    expect(screen.deletedId).toBe('acct-c')
  })
})

describe('sibling helpers with the same subscriber snapshot', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClientImpl({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
      },
    })
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(queryClient),
      ],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('injectMutation drops the previous result when mutationKey changes', async () => {
    const mutationKey = signal<Array<string>>(['records', 'acct-a'])

    @Component({
      template: `<p data-testid="shown">{{ mutation.data() ?? 'idle' }}</p>`,
    })
    class Page {
      readonly mutation = injectMutation(() => ({
        mutationKey: mutationKey(),
        mutationFn: (recordId: string) => sleep(10).then(() => recordId),
      }))

      /** Id a follow-up action would read from the mutation result. */
      actedOn: string | undefined

      actOnResult(): void {
        const data = this.mutation.data()
        this.actedOn = data == null ? 'idle' : String(data)
      }
    }

    const rendered = await render(Page)
    const page = rendered.fixture.componentInstance
    page.mutation.mutate('acct-a')
    await vi.advanceTimersByTimeAsync(11)
    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(rendered.getByTestId('shown').textContent).toBe('acct-a')

    mutationKey.set(['records', 'acct-b'])
    rendered.fixture.detectChanges()
    expect(rendered.getByTestId('shown').textContent).toBe('idle')
    page.actOnResult()
    expect(page.actedOn).toBe('idle')

    await flushNotifications()
    rendered.fixture.detectChanges()
    expect(rendered.getByTestId('shown').textContent).toBe('idle')
    page.actOnResult()
    expect(page.actedOn).toBe('idle')
  })
})

@Component({
  selector: 'records-screen',
  template: `
    <p data-testid="shown">{{ shownIds() }}</p>
    <button type="button" (click)="deleteShown()">Delete</button>
  `,
})
class RecordsScreen {
  readonly ids = signal<Array<string>>(['acct-a'])
  /** Id a delete action would send, taken from the combined result. */
  deletedId: string | undefined

  readonly combined = injectQueries(() => ({
    queries: this.ids().map((id) => ({
      queryKey: recordKey(id),
      queryFn: () => loadRecord(queryClientFromScreen(), id),
    })),
    combine: (results: Array<{ data: RecordRow | undefined }>) => ({
      records: results
        .map((result) => result.data)
        .filter((row): row is RecordRow => row != null),
    }),
  }))

  shownIds(): string {
    return this.combined()
      .records.map((row) => row.id)
      .join(',')
  }

  deleteShown(): void {
    this.deletedId = this.combined().records[0]?.id
  }
}

/**
 * `RecordsScreen` is declared at module scope so both tests share it.
 * The query client is the one installed for the current test.
 */
function queryClientFromScreen(): QueryClient {
  return TestBed.inject(QueryClientImpl)
}

function recordKey(id: string): QueryKey {
  return ['record', id]
}

function loadRecord(queryClient: QueryClient, id: string): Promise<RecordRow> {
  const row = queryClient.getQueryData<RecordRow>(recordKey(id))
  if (!row) {
    return Promise.reject(new Error(`missing record ${id}`))
  }
  return Promise.resolve(row)
}

function shown(rendered: {
  getByTestId: (id: string) => { textContent: string | null }
}): string {
  return rendered.getByTestId('shown').textContent ?? ''
}

async function flushNotifications(): Promise<void> {
  // notifyManager queues the subscriber write on a timeout, from inside
  // another timeout. Flush until a further flush would be a no-op.
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}
