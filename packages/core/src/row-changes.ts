export type RowChange<T> = {
  id: string;
  before: T | undefined;
  after: T | undefined;
};
type Changes = {
  before: WeakRef<readonly object[]>;
  beforeMapped: WeakRef<readonly object[]> | null;
  rows: readonly RowChange<object>[];
};
const changes = new WeakMap<readonly object[], Changes>();
const mappedVersions = new WeakMap<
  readonly object[],
  WeakRef<readonly object[]>
>();

/** Hints name exact immutable versions; they never keep old collections alive. */
export function rememberRowChanges<T extends object>(
  before: readonly T[],
  after: readonly T[],
  rows: readonly RowChange<T>[],
): void {
  if (before === after || !Object.isFrozen(before) || !Object.isFrozen(after))
    return;
  changes.set(after, {
    before: new WeakRef(before),
    beforeMapped: mappedVersions.get(before) ?? null,
    rows,
  });
}

/** Carry changes to the held thin versions, then release the full-row hint. */
export function transferRowChanges<T extends object, U extends object>(
  source: readonly T[],
  mapped: readonly U[],
  project: (row: T) => U,
): void {
  if (!Object.isFrozen(source) || !Object.isFrozen(mapped)) return;
  if (Object.is(source, mapped)) return;
  const hint = changes.get(source);
  const before = hint?.beforeMapped?.deref();
  if (hint && before)
    rememberRowChanges(
      before as readonly U[],
      mapped,
      (hint.rows as readonly RowChange<T>[]).map((row) => ({
        id: row.id,
        before: row.before && project(row.before),
        after: row.after && project(row.after),
      })),
    );
  changes.delete(source);
  mappedVersions.set(source, new WeakRef(mapped));
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
