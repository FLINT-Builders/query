/**
 * Persisted timestamps come from storage that can be edited outside the app,
 * so anything that is not a finite number in the past is rejected.
 */
export function isPastTimestamp(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value <= now
}

export function isWithinMaxAge(
  value: unknown,
  maxAge: number,
  now: number,
): value is number {
  return isPastTimestamp(value, now) && now - value <= maxAge
}
