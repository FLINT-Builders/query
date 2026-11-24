interface WriteState {
  started: number
  pending: number
}

const writes = new WeakMap<object, Map<string, WriteState>>()

function getWriteState(target: object, key: string) {
  let byKey = writes.get(target)
  if (!byKey) {
    byKey = new Map()
    writes.set(target, byKey)
  }
  let state = byKey.get(key)
  if (!state) {
    state = { started: 0, pending: 0 }
    byKey.set(key, state)
  }
  return state
}

/**
 * Records that a write to `key` of `target` has started.
 * @returns a function to call once the write has settled
 */
export function trackWrite(target: object, key = ''): () => void {
  const state = getWriteState(target, key)
  state.started++
  state.pending++
  let settled = false
  return () => {
    if (!settled) {
      settled = true
      state.pending--
    }
  }
}

/**
 * Starts watching writes to `key` of `target`.
 * @returns a function that reports whether no write was in flight when
 * watching started and none has started since
 */
export function watchWrites(target: object, key = ''): () => boolean {
  const state = getWriteState(target, key)
  const started = state.started
  const idle = state.pending === 0
  return () => idle && state.started === started
}
