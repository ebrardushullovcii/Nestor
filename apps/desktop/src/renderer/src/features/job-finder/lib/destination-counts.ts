/**
 * The one zero rule for every destination badge: a count of 0 renders nothing.
 * A grey permanent "0" beside a destination name says "nothing is happening"
 * in the loudest available place.
 */
export function toDestinationBadgeCount(count: number): number | null {
  return count > 0 ? count : null;
}
