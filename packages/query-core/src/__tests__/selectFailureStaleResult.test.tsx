/* eslint vitest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectSelectErrorWithoutPreviousResult"] }] */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKey, sleep } from '@tanstack/query-test-utils'
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  keepPreviousData,
} from '..'
import type {
  DefaultedInfiniteQueryObserverOptions,
  InfiniteData,
  QueryObserverResult,
} from '..'

/**
 * Selected view of an account. Distinct from the raw record so a placeholder
 * that still carries the previous payload cannot satisfy these assertions.
 */
type SelectedAccount = {
  accountId: string
  email: string
}

type AccountRecord = {
  id: string
  email: string
}

const accountA: AccountRecord = {
  id: 'account-a',
  email: 'account-a@example.test',
}

const accountB: AccountRecord = {
  id: 'account-b',
  email: 'account-b@example.test',
}

const selectedA: SelectedAccount = {
  accountId: accountA.id,
  email: accountA.email,
}

const staticPlaceholder: AccountRecord = {
  id: 'placeholder',
  email: 'placeholder@example.test',
}

/**
 * After the observed query changes, a thrown select must surface that error
 * without publishing the previous query's selected value as this result.
 * Placeholder data may still be shown, but only while `isPlaceholderData`
 * stays set. Any other defined `data` is the stale select result.
 */
function expectSelectErrorWithoutPreviousResult(
  result: Pick<
    QueryObserverResult<SelectedAccount, Error>,
    'data' | 'error' | 'isError' | 'isPlaceholderData' | 'isSuccess' | 'status'
  >,
  selectError: Error,
) {
  expect(result.status).toBe('error')
  expect(result.isError).toBe(true)
  expect(result.isSuccess).toBe(false)
  expect(result.error).toBe(selectError)
  // Placeholder data may remain only while `isPlaceholderData` is true.
  // `data: undefined` is the other accepted outcome. The previous select
  // result with the placeholder flag cleared is the leak.
  expect({
    data: result.data,
    isPlaceholderData: result.isPlaceholderData,
  }).not.toEqual({
    data: selectedA,
    isPlaceholderData: false,
  })

  if (result.isPlaceholderData) {
    expect(result.data).not.toEqual(selectedA)
  } else {
    expect(result.data).toBeUndefined()
  }
}

function selectAccount(activeId: string, selectError: Error) {
  return (record: AccountRecord): SelectedAccount => {
    if (record.id !== activeId) {
      throw selectError
    }
    return { accountId: record.id, email: record.email }
  }
}

function selectInfiniteAccount(activeId: string, selectError: Error) {
  return (data: InfiniteData<AccountRecord, number>): SelectedAccount => {
    const page = data.pages.find((item) => item.id === activeId)
    if (!page) {
      throw selectError
    }
    return { accountId: page.id, email: page.email }
  }
}

describe('select failure after a query change', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    queryClient = new QueryClient()
    queryClient.mount()
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  async function observeAccount(
    key: Array<string>,
    record: AccountRecord,
    options?: {
      placeholderData?:
        | AccountRecord
        | ((
            previousData: AccountRecord | undefined,
          ) => AccountRecord | undefined)
    },
  ) {
    const selectError = new Error('select failed')
    const observer = new QueryObserver<
      AccountRecord,
      Error,
      SelectedAccount,
      AccountRecord,
      Array<string>
    >(queryClient, {
      queryKey: key,
      queryFn: () => record,
      select: selectAccount(record.id, selectError),
      ...options,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult()).toMatchObject({
      status: 'success',
      data: { accountId: record.id, email: record.email },
      isPlaceholderData: false,
      error: null,
    })
    return { observer, unsubscribe, selectError }
  }

  it('does not publish the previous select result when keepPreviousData makes select throw while the next query is pending', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA, {
      placeholderData: keepPreviousData,
    })

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      placeholderData: keepPreviousData,
      select: selectAccount('account-b', selectError),
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    observer.updateResult()
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result when a copied placeholder makes a stable select throw', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const placeholderData = (previous: AccountRecord | undefined) =>
      previous ? { ...previous } : undefined
    const { observer, unsubscribe } = await observeAccount(keyA, accountA, {
      placeholderData,
    })
    const select = selectAccount('account-b', selectError)

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      placeholderData,
      select,
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      placeholderData,
      select,
    })
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result when a static placeholder makes select throw', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA, {
      placeholderData: staticPlaceholder,
    })

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      placeholderData: staticPlaceholder,
      select: selectAccount('account-b', selectError),
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )
    observer.updateResult()
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result when select throws on the next query payload', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA)

    observer.setOptions({
      queryKey: keyB,
      queryFn: () =>
        sleep(10).then(() => ({
          id: 'missing',
          email: 'missing@example.test',
        })),
      select: selectAccount('account-b', selectError),
    })

    expect(observer.getCurrentResult()).toMatchObject({
      status: 'pending',
      data: undefined,
      error: null,
      isPlaceholderData: false,
    })

    await vi.advanceTimersByTimeAsync(10)

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )
    observer.updateResult()
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result when select throws on cached data for the next query', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const missing = {
      id: 'missing',
      email: 'missing@example.test',
    }
    queryClient.setQueryData(keyB, missing)
    const { observer, unsubscribe } = await observeAccount(keyA, accountA)

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => missing,
      select: selectAccount('account-b', selectError),
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )
    const refetchResult = await observer.refetch()
    expectSelectErrorWithoutPreviousResult(refetchResult, selectError)

    unsubscribe()
  })

  it('does not publish the previous select result from getOptimisticResult when the rendered query key changes', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA, {
      placeholderData: keepPreviousData,
    })

    const nextOptions = queryClient.defaultQueryOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      placeholderData: keepPreviousData,
      select: selectAccount('account-b', selectError),
      _optimisticResults: 'optimistic' as const,
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getOptimisticResult(nextOptions),
      selectError,
    )
    expectSelectErrorWithoutPreviousResult(
      observer.getOptimisticResult(nextOptions),
      selectError,
    )

    observer.setOptions(nextOptions)
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result from getOptimisticResult when the next query data is already cached', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    queryClient.setQueryData(keyB, {
      id: 'missing',
      email: 'missing@example.test',
    })
    const { observer, unsubscribe } = await observeAccount(keyA, accountA)

    const nextOptions = queryClient.defaultQueryOptions({
      queryKey: keyB,
      queryFn: () => accountB,
      select: selectAccount('account-b', selectError),
      _optimisticResults: 'optimistic' as const,
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getOptimisticResult(nextOptions),
      selectError,
    )
    observer.setOptions(nextOptions)
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous select result from fetchOptimistic when select throws on the fetched query', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA)

    const result = await observer.fetchOptimistic({
      queryKey: keyB,
      queryFn: () => ({
        id: 'missing',
        email: 'missing@example.test',
      }),
      select: selectAccount('account-b', selectError),
    })

    expectSelectErrorWithoutPreviousResult(result, selectError)

    unsubscribe()
  })

  it('does not publish the previous select result from the fetchOptimistic cache subscription', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeAccount(keyA, accountA)
    const missing = {
      id: 'missing',
      email: 'missing@example.test',
    }

    const promise = observer.fetchOptimistic({
      queryKey: keyB,
      queryFn: () => sleep(100).then(() => missing),
      select: selectAccount('account-b', selectError),
    })

    await vi.advanceTimersByTimeAsync(10)
    queryClient.setQueryData(keyB, missing)
    await vi.advanceTimersByTimeAsync(0)
    const result = await promise

    expectSelectErrorWithoutPreviousResult(result, selectError)
    expect(queryClient.getQueryState(keyB)?.fetchStatus).toBe('fetching')

    await vi.advanceTimersByTimeAsync(100)
    unsubscribe()
  })

  async function observeInfiniteAccount(
    key: Array<string>,
    record: AccountRecord,
  ) {
    const selectError = new Error('select failed')
    const observer = new InfiniteQueryObserver<
      AccountRecord,
      Error,
      SelectedAccount,
      Array<string>,
      number
    >(queryClient, {
      queryKey: key,
      queryFn: () => record,
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      placeholderData: keepPreviousData,
      select: selectInfiniteAccount(record.id, selectError),
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult()).toMatchObject({
      status: 'success',
      data: { accountId: record.id, email: record.email },
      isPlaceholderData: false,
      error: null,
    })
    return { observer, unsubscribe }
  }

  it('does not publish the previous infinite select result when keepPreviousData makes select throw', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeInfiniteAccount(
      keyA,
      accountA,
    )

    observer.setOptions({
      queryKey: keyB,
      queryFn: () => sleep(10).then(() => accountB),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      placeholderData: keepPreviousData,
      select: selectInfiniteAccount('account-b', selectError),
    })

    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )
    observer.updateResult()
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous infinite select result when select throws on the next page payload', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeInfiniteAccount(
      keyA,
      accountA,
    )

    observer.setOptions({
      queryKey: keyB,
      queryFn: () =>
        sleep(10).then(() => ({
          id: 'missing',
          email: 'missing@example.test',
        })),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      select: selectInfiniteAccount('account-b', selectError),
    })

    expect(observer.getCurrentResult()).toMatchObject({
      status: 'pending',
      data: undefined,
      error: null,
      isPlaceholderData: false,
    })

    await vi.advanceTimersByTimeAsync(10)
    expectSelectErrorWithoutPreviousResult(
      observer.getCurrentResult(),
      selectError,
    )

    unsubscribe()
  })

  it('does not publish the previous infinite select result from getOptimisticResult or fetchOptimistic', async () => {
    const keyA = queryKey()
    const keyB = queryKey()
    const keyC = queryKey()
    const selectError = new Error('select failed for account-b')
    const { observer, unsubscribe } = await observeInfiniteAccount(
      keyA,
      accountA,
    )

    const nextOptions = {
      ...queryClient.defaultQueryOptions({
        queryKey: keyB,
        queryFn: () => sleep(10).then(() => accountB),
        placeholderData: keepPreviousData,
        select: selectInfiniteAccount('account-b', selectError),
        _optimisticResults: 'optimistic' as const,
      }),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      _type: 'infinite' as const,
    } as DefaultedInfiniteQueryObserverOptions<
      AccountRecord,
      Error,
      SelectedAccount,
      Array<string>,
      number
    >

    expectSelectErrorWithoutPreviousResult(
      observer.getOptimisticResult(nextOptions),
      selectError,
    )

    const fetched = await observer.fetchOptimistic({
      ...queryClient.defaultQueryOptions({
        queryKey: keyC,
        queryFn: () => ({
          id: 'missing',
          email: 'missing@example.test',
        }),
        select: selectInfiniteAccount('account-b', selectError),
      }),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
      _type: 'infinite' as const,
    } as Parameters<typeof observer.fetchOptimistic>[0])
    expectSelectErrorWithoutPreviousResult(fetched, selectError)

    unsubscribe()
  })
})
