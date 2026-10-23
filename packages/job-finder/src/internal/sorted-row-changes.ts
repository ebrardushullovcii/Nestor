/** Replace nominated rows in an immutable sorted list without sorting its survivors. */
export function mergeSortedRowChanges<T extends { id: string }>(
  previous: readonly T[],
  changedIds: ReadonlySet<string>,
  nextRows: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  if (changedIds.size === 0 && nextRows.length === 0) return previous as T[];
  const kept = previous.filter((row) => !changedIds.has(row.id));
  const added = [...nextRows].sort(compare);
  const result: T[] = [];
  let from = 0;
  for (const row of added) {
    let low = from;
    let high = kept.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(kept[middle]!, row) <= 0) low = middle + 1;
      else high = middle;
    }
    for (let index = from; index < low; index += 1) result.push(kept[index]!);
    result.push(row);
    from = low;
  }
  for (let index = from; index < kept.length; index += 1)
    result.push(kept[index]!);
  return Object.freeze(result) as T[];
}
