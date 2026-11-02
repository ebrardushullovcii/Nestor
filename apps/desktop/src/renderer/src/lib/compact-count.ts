/**
 * A count where room is short: exact to 9,999 ("1,242"), then the same
 * number abbreviated ("12.3k", "123k", "1.2m"), never a cap like "999+"
 * that reads as a different number. Callers keep the exact figure in the
 * tooltip and the accessible name.
 */
export function formatCompactCount(count: number): string {
  if (count < 10_000) return count.toLocaleString();
  if (count < 100_000)
    return `${(Math.floor(count / 100) / 10).toLocaleString()}k`;
  if (count < 1_000_000) return `${Math.floor(count / 1000).toLocaleString()}k`;
  return `${(Math.floor(count / 100_000) / 10).toLocaleString()}m`;
}
