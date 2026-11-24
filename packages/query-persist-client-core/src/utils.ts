/**
 * A persisted timestamp is only trusted when it is a finite number that is
 * not ahead of the current time; anything else could keep a stored entry
 * restorable forever.
 */
export function isExpired(timestamp: unknown, maxAge: number): boolean {
  const now = Date.now()
  return (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp > maxAge
  )
}
