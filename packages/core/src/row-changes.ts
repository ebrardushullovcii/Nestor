export type RowChange<T> = {
  id: string;
  before: T | undefined;
  after: T | undefined;
};
type Changes = {
  before: WeakRef<readonly object[]>;
  rows: readonly RowChange<object>[];
};
const changes = new WeakMap<readonly object[], Changes>();

export function readRowChangeBase<T extends object>(
  after: readonly T[],
): readonly T[] | null {
  return (
    (changes.get(after)?.before.deref() as readonly T[] | undefined) ?? null
  );
}

/** Hints name exact immutable versions; they never keep old collections alive. */
export function rememberRowChanges<T extends object>(
  before: readonly T[],
  after: readonly T[],
  rows: readonly RowChange<T>[],
): void {
  if (before === after || !Object.isFrozen(before) || !Object.isFrozen(after))
    return;
  changes.set(after, { before: new WeakRef(before), rows });
}

/** Fall back to a full diff if a held baseline is outside this known lineage. */
export function readRowChanges<T extends object>(
  before: readonly T[],
  after: readonly T[],
): readonly RowChange<T>[] | null {
  if (before === after) return [];
  const combined = new Map<string, RowChange<object>>();
  let cursor: readonly object[] = after;
  for (let depth = 0; depth < 64; depth += 1) {
    const hint = changes.get(cursor);
    const prior = hint?.before.deref();
    if (!hint || !prior) return null;
    for (const row of hint.rows) {
      const current = combined.get(row.id);
      if (current) current.before = row.before;
      else combined.set(row.id, { ...row });
    }
    if (prior === before) return [...combined.values()] as RowChange<T>[];
    cursor = prior;
  }
  return null;
}
