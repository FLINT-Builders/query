import { timeoutManager } from '@tanstack/query-core'
import { noop } from './utils'

interface AsyncThrottleOptions {
  interval?: number
  onError?: (error: unknown) => void
}

export function asyncThrottle<TArgs extends ReadonlyArray<unknown>>(
  func: (...args: TArgs) => Promise<void>,
  { interval = 1000, onError = noop }: AsyncThrottleOptions = {},
) {
  if (typeof func !== 'function') throw new Error('argument is not function.')

  let nextExecutionTime = 0
  let lastArgs: TArgs | null = null
  let isExecuting = false
  let isScheduled = false

  const throttled = async (...args: TArgs) => {
    lastArgs = args
    if (isScheduled) return
    isScheduled = true
    while (isExecuting) {
      await new Promise((done) => timeoutManager.setTimeout(done, interval))
    }
    while (Date.now() < nextExecutionTime) {
      await new Promise((done) =>
        timeoutManager.setTimeout(done, nextExecutionTime - Date.now()),
      )
    }
    isScheduled = false
    // `cancel` may have cleared lastArgs while this call was waiting
    const scheduledArgs = lastArgs as TArgs | null
    lastArgs = null
    if (!scheduledArgs) return
    isExecuting = true
    try {
      await func(...scheduledArgs)
    } catch (error) {
      try {
        onError(error)
      } catch {}
    }
    nextExecutionTime = Date.now() + interval
    isExecuting = false
  }

  /** Drops the pending arguments so a scheduled call that has not started yet does nothing. */
  throttled.cancel = () => {
    lastArgs = null
  }

  return throttled
}
