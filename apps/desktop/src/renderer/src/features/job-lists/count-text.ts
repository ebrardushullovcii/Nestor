/**
 * A count for a tab, chip or menu: the number once it is known, and "–"
 * while it is not (a first read still on its way, or one that failed), so
 * an unread list never claims to hold 0.
 */
export function countText(count: number, known: boolean): string {
  return known ? count.toLocaleString() : "–";
}

/** The count's accessible words: "12", or "not known yet". */
export function countWords(count: number, known: boolean): string {
  return known ? count.toLocaleString() : "count not known yet";
}
