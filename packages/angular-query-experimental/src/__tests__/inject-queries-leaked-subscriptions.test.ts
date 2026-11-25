import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/angular'
import { queryKey } from '@tanstack/query-test-utils'
import { QueriesObserver } from '@tanstack/query-core'
import { QueryClient, provideTanStackQuery } from '..'
import { injectQueries } from '../inject-queries'

/**
 * `injectQueries` must drop the previous observer listener when the query list
 * changes, and the value a caller acts on must be the combined result for the
 * list that is current after that change. These tests stay red while a listener
 * from an older list is still registered or can still publish its closed-over
 * combine result.
 */
describe('injectQueries leaked observer subscriptions', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTanStackQuery(queryClient),
      ],
    })
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  async function flush(): Promise<void> {
    TestBed.tick()
    await vi.advanceTimersByTimeAsync(0)
    TestBed.tick()
  }

  it('acts on the record for the current cached query list, not the previous one', async () => {
    const accountId = signal('acct-1')
    const key = queryKey()
    const fetches: Array<string> = []
    const deleted: Array<string> = []

    queryClient.setQueryData([...key, 'acct-1'], { recordId: 'rec-1' })
    queryClient.setQueryData([...key, 'acct-2'], { recordId: 'rec-2' })

    @Component({
      template: `<p>target: {{ combined().targetId }}</p>`,
    })
    class AccountRecords {
      readonly combined = injectQueries(() => {
        const id = accountId()
        return {
          queries: [
            {
              queryKey: [...key, id],
              queryFn: () => {
                fetches.push(id)
                return { recordId: id === 'acct-1' ? 'rec-1' : 'rec-2' }
              },
              staleTime: Infinity,
            },
          ],
          // Snapshot the account this result belongs to. Reading the signal
          // inside combine would observe a later account than the query that
          // produced `results`.
          combine: (results) => ({
            targetId: id,
            recordId: (results[0]?.data as { recordId?: string } | undefined)
              ?.recordId,
          }),
        }
      })

      deleteSelected(): void {
        deleted.push(this.combined().targetId)
      }
    }

    const rendered = await render(AccountRecords)
    await flush()
    rendered.fixture.detectChanges()

    expect(rendered.getByText('target: acct-1')).toBeInTheDocument()
    expect(fetches).toEqual([])

    accountId.set('acct-2')
    await flush()
    rendered.fixture.detectChanges()

    // Cached data must not be required to refetch before the new list is shown.
    expect(fetches).toEqual([])
    expect(rendered.getByText('target: acct-2')).toBeInTheDocument()

    rendered.fixture.componentInstance.deleteSelected()
    expect(deleted).toEqual(['acct-2'])
  })

  it('acts on the first id of a cached query list after that list shrinks', async () => {
    const ids = signal(['left', 'right'])
    const key = queryKey()
    const edited: Array<string> = []

    for (const id of ['left', 'right', 'only']) {
      queryClient.setQueryData([...key, id], { recordId: `record-${id}` })
    }

    @Component({
      template: `<p>edit: {{ combined().editId }}</p>`,
    })
    class BatchRecords {
      readonly combined = injectQueries(() => {
        const currentIds = ids()
        return {
          queries: currentIds.map((id) => ({
            queryKey: [...key, id],
            queryFn: () => ({ recordId: `record-${id}` }),
            staleTime: Infinity,
          })),
          combine: (results) => ({
            editId: currentIds[0]!,
            recordIds: results.map(
              (result) =>
                (result.data as { recordId?: string } | undefined)?.recordId,
            ),
          }),
        }
      })

      editFirst(): void {
        edited.push(this.combined().editId)
      }
    }

    const rendered = await render(BatchRecords)
    await flush()
    rendered.fixture.detectChanges()
    expect(rendered.getByText('edit: left')).toBeInTheDocument()

    ids.set(['only'])
    await flush()
    rendered.fixture.detectChanges()

    expect(rendered.getByText('edit: only')).toBeInTheDocument()
    rendered.fixture.componentInstance.editFirst()
    expect(edited).toEqual(['only'])
    expect(rendered.fixture.componentInstance.combined().recordIds).toEqual([
      'record-only',
    ])
  })

  it('does not let a listener from an older query list publish a record id after the list changes', async () => {
    const accountId = signal('acct-1')
    const key = queryKey()
    const published: Array<string> = []

    queryClient.setQueryData([...key, 'acct-1'], { recordId: 'rec-1' })
    queryClient.setQueryData([...key, 'acct-2'], { recordId: 'rec-2' })
    queryClient.setQueryData([...key, 'acct-3'], { recordId: 'rec-3' })

    @Component({
      template: `<p>{{ combined().targetId }}</p>`,
    })
    class AccountRecords {
      readonly combined = injectQueries(() => {
        const id = accountId()
        return {
          queries: [
            {
              queryKey: [...key, id],
              queryFn: () => ({ recordId: `rec-from-${id}` }),
              staleTime: Infinity,
            },
          ],
          combine: () => {
            published.push(id)
            return { targetId: id }
          },
        }
      })
    }

    const rendered = await render(AccountRecords)
    await flush()

    accountId.set('acct-2')
    await flush()
    accountId.set('acct-3')
    await flush()
    rendered.fixture.detectChanges()

    published.length = 0
    queryClient.setQueryData([...key, 'acct-3'], { recordId: 'rec-3-next' })
    await flush()
    rendered.fixture.detectChanges()

    // The current combine may run once for the observer notification and once
    // for the single live listener. Listeners closed over acct-1 or acct-2
    // must not run.
    expect(published.length).toBeGreaterThan(0)
    expect(published.length).toBeLessThanOrEqual(2)
    expect(published).toEqual(published.map(() => 'acct-3'))
    expect(rendered.getByText('acct-3')).toBeInTheDocument()
  })

  it('runs one observer listener per later cache update after the query list changes', async () => {
    const accountId = signal('acct-1')
    const key = queryKey()
    const originalSubscribe = QueriesObserver.prototype.subscribe
    let listenerRuns = 0

    vi.spyOn(QueriesObserver.prototype, 'subscribe').mockImplementation(
      function (this: QueriesObserver, listener) {
        return originalSubscribe.call(this, ((result: unknown) => {
          listenerRuns += 1
          listener(result)
        }) as typeof listener)
      },
    )

    @Component({
      template: `<p>{{ combined()[0].status() }}</p>`,
    })
    class AccountRecords {
      readonly combined = injectQueries(() => {
        const id = accountId()
        return {
          queries: [
            {
              queryKey: [...key, id],
              queryFn: () => ({ recordId: id }),
              staleTime: Infinity,
            },
          ],
        }
      })
    }

    queryClient.setQueryData([...key, 'acct-1'], { recordId: 'rec-1' })
    queryClient.setQueryData([...key, 'acct-2'], { recordId: 'rec-2' })
    queryClient.setQueryData([...key, 'acct-3'], { recordId: 'rec-3' })
    queryClient.setQueryData([...key, 'acct-4'], { recordId: 'rec-4' })

    const rendered = await render(AccountRecords)
    await flush()

    accountId.set('acct-2')
    await flush()
    accountId.set('acct-3')
    await flush()
    accountId.set('acct-4')
    await flush()

    listenerRuns = 0
    queryClient.setQueryData([...key, 'acct-4'], { recordId: 'rec-4-next' })
    await flush()
    rendered.fixture.detectChanges()

    expect(listenerRuns).toBe(1)
    expect(rendered.getByText('success')).toBeInTheDocument()
  })
})
