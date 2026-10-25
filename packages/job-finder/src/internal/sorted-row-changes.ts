import { rememberRowChanges, type RowChange } from "@nestor/core";

/** Replace nominated rows in an immutable sorted list without sorting its survivors. */
export function mergeSortedRowChanges<T extends { id: string }>(
  previous: readonly T[],
  changedIds: ReadonlySet<string>,
  nextRows: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  if (changedIds.size === 0 && nextRows.length === 0) return previous as T[];
  const edits = new Map<string, RowChange<T>>();
  const kept = previous.filter((row) => {
    if (!changedIds.has(row.id)) return true;
    edits.set(row.id, { id: row.id, before: row, after: undefined });
    return false;
  });
  for (const row of nextRows) {
    const edit = edits.get(row.id);
    if (edit) edit.after = row;
    else edits.set(row.id, { id: row.id, before: undefined, after: row });
  }
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
  Object.freeze(result);
  rememberRowChanges(previous, result, [...edits.values()]);
  return result;
}
