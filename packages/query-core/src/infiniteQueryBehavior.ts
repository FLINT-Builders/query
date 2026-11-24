import {
  addConsumeAwareSignal,
  addToEnd,
  addToStart,
  ensureQueryFn,
  replaceEqualDeep,
} from './utils'
import type { Query, QueryBehavior } from './query'
import type {
  InfiniteData,
  InfiniteQueryPageParamsOptions,
  OmitKeyof,
  QueryFunctionContext,
  QueryKey,
} from './types'

/**
 * Page params that a query fetched itself or that app code wrote through
 * `setQueryData` or `initialData`. Data restored from elsewhere (hydration,
 * persisters, `setState`) is never recorded here, so a refetch only replays
 * stored pages that start at one of these params, and never more pages than
 * were recorded.
 */
const knownPageParams = new WeakMap<Query<any, any, any, any>, Array<unknown>>()

/** @internal */
export function rememberPageParams(
  query: Query<any, any, any, any>,
  data: unknown,
): void {
  const pageParams = (data as Partial<InfiniteData<unknown>> | undefined)
    ?.pageParams
  if (Array.isArray(pageParams)) {
    knownPageParams.set(query, [...pageParams])
  }
}

export function infiniteQueryBehavior<TQueryFnData, TError, TData, TPageParam>(
  pages?: number,
): QueryBehavior<TQueryFnData, TError, InfiniteData<TData, TPageParam>> {
  return {
    onFetch: (context, query) => {
      const options = context.options as InfiniteQueryPageParamsOptions<TData>
      const direction = context.fetchOptions?.meta?.fetchMore?.direction
      const oldPages = context.state.data?.pages || []
      const oldPageParams = context.state.data?.pageParams || []
      let result: InfiniteData<unknown> = { pages: [], pageParams: [] }
      let currentPage = 0

      const fetchFn = async () => {
        let cancelled = false
        const addSignalProperty = (object: unknown) => {
          addConsumeAwareSignal(
            object,
            () => context.signal,
            () => (cancelled = true),
          )
        }

        const queryFn = ensureQueryFn(context.options, context.fetchOptions)

        // Create function to fetch a page
        const fetchPage = async (
          data: InfiniteData<unknown>,
          param: unknown,
          previous?: boolean,
        ): Promise<InfiniteData<unknown>> => {
          if (cancelled) {
            return Promise.reject(context.signal.reason)
          }

          if (param == null && data.pages.length) {
            return Promise.resolve(data)
          }

          const createQueryFnContext = () => {
            const queryFnContext: OmitKeyof<
              QueryFunctionContext<QueryKey, unknown>,
              'signal'
            > = {
              client: context.client,
              queryKey: context.queryKey,
              pageParam: param,
              direction: previous ? 'backward' : 'forward',
              meta: context.options.meta,
            }
            addSignalProperty(queryFnContext)
            return queryFnContext as QueryFunctionContext<QueryKey, unknown>
          }

          const queryFnContext = createQueryFnContext()

          const page = await queryFn(queryFnContext)

          const { maxPages } = context.options
          const addTo = previous ? addToStart : addToEnd

          return {
            pages: addTo(data.pages, page, maxPages),
            pageParams: addTo(data.pageParams, param, maxPages),
          }
        }

        const known = knownPageParams.get(query) ?? []
        const storedPagesAreKnown =
          oldPages.length > 0 &&
          known.some(
            (param) => replaceEqualDeep(param, oldPageParams[0]) === param,
          )

        // fetch next / previous page?
        if (direction && oldPages.length) {
          const previous = direction === 'backward'
          const pageParamFn = previous ? getPreviousPageParam : getNextPageParam
          const oldData = {
            pages: oldPages,
            pageParams: oldPageParams,
          }
          const param = pageParamFn(options, oldData)

          result = await fetchPage(oldData, param, previous)
          if (storedPagesAreKnown && result !== oldData) {
            const addTo = previous ? addToStart : addToEnd
            knownPageParams.set(
              query,
              addTo(known, param, context.options.maxPages),
            )
          }
        } else {
          const storedPages = storedPagesAreKnown
            ? Math.min(oldPages.length, known.length)
            : 1
          const remainingPages = Math.min(
            pages ?? storedPages,
            context.options.maxPages || Infinity,
          )

          // Fetch all pages
          do {
            const param =
              currentPage === 0
                ? storedPagesAreKnown
                  ? (oldPageParams[0] ?? options.initialPageParam)
                  : options.initialPageParam
                : getNextPageParam(options, result)
            if (currentPage > 0 && param == null) {
              break
            }
            result = await fetchPage(result, param)
            currentPage++
          } while (currentPage < remainingPages)

          rememberPageParams(query, result)
        }

        return result
      }
      if (context.options.persister) {
        context.fetchFn = () => {
          return context.options.persister?.(
            fetchFn as any,
            {
              client: context.client,
              queryKey: context.queryKey,
              meta: context.options.meta,
              signal: context.signal,
            },
            query,
          )
        }
      } else {
        context.fetchFn = fetchFn
      }
    },
  }
}

function getNextPageParam(
  options: InfiniteQueryPageParamsOptions<any>,
  { pages, pageParams }: InfiniteData<unknown>,
): unknown | undefined {
  const lastIndex = pages.length - 1
  return pages.length > 0
    ? options.getNextPageParam(
        pages[lastIndex],
        pages,
        pageParams[lastIndex],
        pageParams,
      )
    : undefined
}

function getPreviousPageParam(
  options: InfiniteQueryPageParamsOptions<any>,
  { pages, pageParams }: InfiniteData<unknown>,
): unknown | undefined {
  return pages.length > 0
    ? options.getPreviousPageParam?.(pages[0], pages, pageParams[0], pageParams)
    : undefined
}

/**
 * Checks if there is a next page.
 */
export function hasNextPage(
  options: InfiniteQueryPageParamsOptions<any, any>,
  data?: InfiniteData<unknown>,
): boolean {
  if (!data) return false
  return getNextPageParam(options, data) != null
}

/**
 * Checks if there is a previous page.
 */
export function hasPreviousPage(
  options: InfiniteQueryPageParamsOptions<any, any>,
  data?: InfiniteData<unknown>,
): boolean {
  if (!data || !options.getPreviousPageParam) return false
  return getPreviousPageParam(options, data) != null
}
