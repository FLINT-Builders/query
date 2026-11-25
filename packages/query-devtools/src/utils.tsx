import { serialize, stringify } from 'superjson'
import { createSignal, onCleanup, onMount } from 'solid-js'
import type { Mutation, Query } from '@tanstack/query-core'
import type { DevtoolsPosition } from './contexts'

export function getQueryStatusLabel(query: Query) {
  return query.state.fetchStatus === 'fetching'
    ? 'fetching'
    : !query.getObserversCount()
      ? 'inactive'
      : query.state.fetchStatus === 'paused'
        ? 'paused'
        : query.isStale()
          ? 'stale'
          : 'fresh'
}

type QueryStatusLabel = 'fresh' | 'stale' | 'paused' | 'inactive' | 'fetching'

export function getSidedProp<T extends string>(
  prop: T,
  side: DevtoolsPosition,
) {
  return `${prop}${
    side.charAt(0).toUpperCase() + side.slice(1)
  }` as `${T}${Capitalize<DevtoolsPosition>}`
}

export function getQueryStatusColor({
  queryState,
  observerCount,
  isStale,
}: {
  queryState: Query['state'] | undefined
  observerCount: number
  isStale: boolean
}) {
  return queryState?.fetchStatus === 'fetching'
    ? 'blue'
    : !observerCount
      ? 'gray'
      : queryState?.fetchStatus === 'paused'
        ? 'purple'
        : isStale
          ? 'yellow'
          : 'green'
}

export function getMutationStatusColor({
  status,
  isPaused,
}: {
  status: Mutation['state']['status']
  isPaused: boolean
}) {
  return isPaused
    ? 'purple'
    : status === 'error'
      ? 'red'
      : status === 'pending'
        ? 'yellow'
        : status === 'success'
          ? 'green'
          : 'gray'
}

export function getQueryStatusColorByLabel(label: QueryStatusLabel) {
  return label === 'fresh'
    ? 'green'
    : label === 'stale'
      ? 'yellow'
      : label === 'paused'
        ? 'purple'
        : label === 'inactive'
          ? 'gray'
          : 'blue'
}

// superjson throws on these keys and recurses once per level of nesting, so
// values that contain them or nest deeper than this never reach it.
const MAX_SERIALIZE_DEPTH = 100
const SUPERJSON_REJECTED_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

function canUseSuperjson(value: unknown): boolean {
  const visited = new Set<object>()
  const stack: Array<[unknown, number]> = [[value, 0]]
  while (stack.length) {
    const [current, depth] = stack.pop()!
    if (typeof current !== 'object' || current === null) continue
    if (visited.has(current)) continue
    if (depth > MAX_SERIALIZE_DEPTH) return false
    visited.add(current)
    if (ArrayBuffer.isView(current)) continue

    const children: Array<[unknown, number]> = []
    if (current instanceof Map) {
      // superjson walks a Map as an array of [key, value] arrays
      for (const [k, v] of current) {
        children.push([k, depth + 2], [v, depth + 2])
      }
    } else if (current instanceof Set) {
      for (const v of current) children.push([v, depth + 1])
    } else {
      for (const [k, v] of Object.entries(current)) {
        if (SUPERJSON_REJECTED_KEYS.has(k)) return false
        children.push([v, depth + 1])
      }
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!)
    }
  }
  return true
}

function isSuperjsonSafe(value: unknown): boolean {
  try {
    return canUseSuperjson(value)
  } catch {
    return false
  }
}

function toPlainJson(
  value: unknown,
  depth: number = 0,
  ancestors: Array<object> = [],
): unknown {
  switch (typeof value) {
    case 'undefined':
    case 'function':
      return null
    case 'bigint':
    case 'symbol':
      return value.toString()
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'object':
      break
    default:
      return value
  }
  if (value === null) return null
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (value instanceof RegExp) return String(value)
  if (ancestors.includes(value)) return '[Circular]'
  if (depth >= MAX_SERIALIZE_DEPTH) return '[Max depth exceeded]'

  const next = (v: unknown) => toPlainJson(v, depth + 1, [...ancestors, value])
  if (Array.isArray(value) || value instanceof Set) {
    return Array.from(value, next)
  }
  if (value instanceof Map) {
    return Array.from(value, ([k, v]) => [next(k), next(v)])
  }
  // Object.fromEntries keeps a `__proto__` key as an own data property
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, next(v)]))
}

function toDisplayJson(value: unknown): unknown {
  if (isSuperjsonSafe(value)) {
    try {
      return serialize(value).json
    } catch {}
  }
  return toPlainJson(value)
}

/**
 * Whether the value survives a `JSON.stringify` / `JSON.parse` round trip,
 * which is what the bulk data editor relies on.
 */
export const isBulkEditable = (value: unknown) => {
  if (!isSuperjsonSafe(value)) return false
  try {
    return !serialize(value).meta
  } catch {
    return false
  }
}

/**
 * Stringifies the value for the clipboard, using superjson when it can
 * represent the value and plain JSON otherwise.
 */
export const stringifyValue = (value: unknown) => {
  if (isSuperjsonSafe(value)) {
    try {
      return stringify(value)
    } catch {}
  }
  return JSON.stringify(toPlainJson(value))
}

/**
 * Displays a string regardless the type of the data
 * @param {unknown} value Value to be stringified
 * @param {boolean} beautify Formats json to multiline
 */
export const displayValue = (value: unknown, beautify: boolean = false) => {
  return JSON.stringify(toDisplayJson(value), null, beautify ? 2 : undefined)
}

// Sorting functions
type SortFn = (a: Query, b: Query) => number

const getStatusRank = (q: Query) =>
  q.state.fetchStatus !== 'idle'
    ? 0
    : !q.getObserversCount()
      ? 3
      : q.isStale()
        ? 2
        : 1

const queryHashSort: SortFn = (a, b) => a.queryHash.localeCompare(b.queryHash)

const dateSort: SortFn = (a, b) => {
  const diff = b.state.dataUpdatedAt - a.state.dataUpdatedAt
  return diff < 0 ? -1 : diff > 0 ? 1 : 0
}

const statusAndDateSort: SortFn = (a, b) => {
  if (getStatusRank(a) === getStatusRank(b)) {
    return dateSort(a, b)
  }

  return getStatusRank(a) > getStatusRank(b) ? 1 : -1
}

export const sortFns: Record<string, SortFn> = {
  status: statusAndDateSort,
  'query hash': queryHashSort,
  'last updated': dateSort,
}

type MutationSortFn = (a: Mutation, b: Mutation) => number

const getMutationStatusRank = (m: Mutation) =>
  m.state.isPaused
    ? 0
    : m.state.status === 'error'
      ? 2
      : m.state.status === 'pending'
        ? 1
        : 3

const mutationDateSort: MutationSortFn = (a, b) =>
  a.state.submittedAt < b.state.submittedAt ? 1 : -1

const mutationStatusSort: MutationSortFn = (a, b) => {
  if (getMutationStatusRank(a) === getMutationStatusRank(b)) {
    return mutationDateSort(a, b)
  }

  return getMutationStatusRank(a) > getMutationStatusRank(b) ? 1 : -1
}

export const mutationSortFns: Record<string, MutationSortFn> = {
  status: mutationStatusSort,
  'last updated': mutationDateSort,
}

export const convertRemToPixels = (rem: number) => {
  return rem * parseFloat(getComputedStyle(document.documentElement).fontSize)
}

export const getPreferredColorScheme = () => {
  const [colorScheme, setColorScheme] = createSignal<'light' | 'dark'>('dark')

  onMount(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    setColorScheme(query.matches ? 'dark' : 'light')
    const listener = (e: MediaQueryListEvent) => {
      setColorScheme(e.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', listener)
    onCleanup(() => query.removeEventListener('change', listener))
  })

  return colorScheme
}

/**
 * updates nested data by path
 *
 * @param {unknown} oldData Data to be updated
 * @param {Array<string>} updatePath Path to the data to be updated
 * @param {unknown} value New value
 */
export const updateNestedDataByPath = (
  oldData: unknown,
  updatePath: Array<string>,
  value: unknown,
): any => {
  if (updatePath.length === 0) {
    return value
  }

  if (oldData instanceof Map) {
    const newData = new Map(oldData)

    if (updatePath.length === 1) {
      newData.set(updatePath[0], value)
      return newData
    }

    const [head, ...tail] = updatePath
    newData.set(head, updateNestedDataByPath(newData.get(head), tail, value))
    return newData
  }

  if (oldData instanceof Set) {
    const setAsArray = updateNestedDataByPath(
      Array.from(oldData),
      updatePath,
      value,
    )

    return new Set(setAsArray)
  }

  if (Array.isArray(oldData)) {
    const newData = [...oldData]

    if (updatePath.length === 1) {
      // @ts-expect-error
      newData[updatePath[0]] = value
      return newData
    }

    const [head, ...tail] = updatePath
    // @ts-expect-error
    newData[head] = updateNestedDataByPath(newData[head], tail, value)

    return newData
  }

  if (oldData instanceof Object) {
    const newData = { ...oldData }

    if (updatePath.length === 1) {
      // @ts-expect-error
      newData[updatePath[0]] = value
      return newData
    }

    const [head, ...tail] = updatePath
    // @ts-expect-error
    newData[head] = updateNestedDataByPath(newData[head], tail, value)

    return newData
  }

  return oldData
}

/**
 * Deletes nested data by path
 *
 * @param {unknown} oldData Data to be updated
 * @param {Array<string>} deletePath Path to the data to be deleted
 * @returns newData without the deleted items by path
 */
export const deleteNestedDataByPath = (
  oldData: unknown,
  deletePath: Array<string>,
): any => {
  if (oldData instanceof Map) {
    const newData = new Map(oldData)

    if (deletePath.length === 1) {
      newData.delete(deletePath[0])
      return newData
    }

    const [head, ...tail] = deletePath
    newData.set(head, deleteNestedDataByPath(newData.get(head), tail))
    return newData
  }

  if (oldData instanceof Set) {
    const setAsArray = deleteNestedDataByPath(Array.from(oldData), deletePath)
    return new Set(setAsArray)
  }

  if (Array.isArray(oldData)) {
    const newData = [...oldData]

    if (deletePath.length === 1) {
      return newData.filter((_, idx) => idx.toString() !== deletePath[0])
    }

    const [head, ...tail] = deletePath

    // @ts-expect-error
    newData[head] = deleteNestedDataByPath(newData[head], tail)

    return newData
  }

  if (oldData instanceof Object) {
    const newData = { ...oldData }

    if (deletePath.length === 1) {
      // @ts-expect-error
      delete newData[deletePath[0]]
      return newData
    }

    const [head, ...tail] = deletePath
    // @ts-expect-error
    newData[head] = deleteNestedDataByPath(newData[head], tail)

    return newData
  }

  return oldData
}

// Sets up the goober stylesheet
// Adds a nonce to the style tag if needed
export const setupStyleSheet = (nonce?: string, target?: ShadowRoot) => {
  if (!nonce)
    return // Goober reads window.__nonce__ every time it creates or accesses its style
    // element (el.nonce = window.__nonce__). Without this, goober overwrites the
    // nonce we set on the pre-created element with undefined, clearing it.
  ;(window as any).__nonce__ = nonce

  const root = target ?? document.head
  if (root.querySelector('#_goober')) return
  const styleTag = document.createElement('style')
  const textNode = document.createTextNode('')
  styleTag.appendChild(textNode)
  styleTag.id = '_goober'
  styleTag.setAttribute('nonce', nonce)
  root.appendChild(styleTag)
}
