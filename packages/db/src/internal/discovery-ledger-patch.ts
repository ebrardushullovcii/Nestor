import type { DiscoveryLedgerEntry } from "@nestor/contracts";

export type DiscoveryLedgerChange = {
  id: string;
  moveToEnd?: boolean;
  update(current: DiscoveryLedgerEntry | null): DiscoveryLedgerEntry;
};

type Index = {
  source: readonly DiscoveryLedgerEntry[];
  positions: Map<string, number>;
};
const indexes = new WeakMap<readonly DiscoveryLedgerEntry[], Index>();
const changesByLedger = new WeakMap<
  readonly object[],
  {
    before: readonly object[];
    removed: readonly DiscoveryLedgerEntry[];
    added: readonly DiscoveryLedgerEntry[];
  }
>();

export function readDiscoveryLedgerChanges(
  before: readonly DiscoveryLedgerEntry[],
  after: readonly DiscoveryLedgerEntry[],
) {
  const changes = changesByLedger.get(after);
  return changes?.before === before ? changes : null;
}
export const discoveryLedgerPatches = new WeakMap<
  readonly object[],
  {
    before: readonly object[];
    rows: readonly {
      index: number;
      previousIndex: number | undefined;
      moveToEnd: boolean;
    }[];
  }
>();

export function adoptDiscoveryLedgerIndex(
  from: readonly object[],
  to: readonly object[],
): void {
  const index = indexes.get(from as readonly DiscoveryLedgerEntry[]);
  if (index?.source === from) {
    index.source = to as readonly DiscoveryLedgerEntry[];
    indexes.set(index.source, index);
  }
  const patch = discoveryLedgerPatches.get(from);
  if (patch) {
    changesByLedger.delete(patch.before);
    changesByLedger.set(to, {
      before: patch.before,
      removed: patch.rows.flatMap((row) =>
        row.previousIndex === undefined
          ? []
          : [patch.before[row.previousIndex] as DiscoveryLedgerEntry],
      ),
      added: patch.rows.map((row) => to[row.index] as DiscoveryLedgerEntry),
    });
  }
}

/** Apply only nominated identities to transaction-current ledger rows, retaining order. */
export function patchDiscoveryLedger(
  before: readonly DiscoveryLedgerEntry[],
  changes: readonly DiscoveryLedgerChange[],
): DiscoveryLedgerEntry[] {
  if (changes.length === 0) return before as DiscoveryLedgerEntry[];
  const apply = (
    change: DiscoveryLedgerChange,
    current: DiscoveryLedgerEntry | null,
  ) => {
    const next = change.update(current);
    if (next.id !== change.id)
      throw new Error("Ledger patches must preserve the nominated id.");
    return next;
  };
  let index = indexes.get(before);
  if (!index || index.source !== before) {
    index = {
      source: before,
      positions: new Map(before.map((entry, position) => [entry.id, position])),
    };
    indexes.set(before, index);
  }
  // Legacy duplicate ids retain the ordinary writer's occurrence-key handling.
  if (index.positions.size !== before.length) {
    const updates = new Map(changes.map((change) => [change.id, change]));
    const seen = new Set(before.map((entry) => entry.id));
    return [
      ...before.map((entry) => {
        const change = updates.get(entry.id);
        return change ? apply(change, entry) : entry;
      }),
      ...[...updates.values()]
        .filter((change) => !seen.has(change.id))
        .map((change) => apply(change, null)),
    ];
  }
  let result = before.slice();
  const previousPositions = new Map(
    changes.map((change) => [change.id, index.positions.get(change.id)]),
  );
  const changed = new Set<string>();
  const moving = new Map<string, DiscoveryLedgerEntry>();
  for (const change of changes) {
    const position = index.positions.get(change.id) ?? result.length;
    const current = result[position] ?? null;
    const next = apply(change, current);
    if (next === current && !change.moveToEnd) continue;
    result[position] = next;
    index.positions.set(change.id, position);
    changed.add(change.id);
    if (change.moveToEnd) moving.set(change.id, next);
  }
  if (changed.size === 0) return before as DiscoveryLedgerEntry[];
  if (moving.size > 0) {
    result = [
      ...result.filter((entry) => !moving.has(entry.id)),
      ...moving.values(),
    ];
    result.forEach((entry, position) =>
      index.positions.set(entry.id, position),
    );
  }
  index.source = result;
  indexes.set(result, index);
  discoveryLedgerPatches.set(result, {
    before,
    rows: [...changed].map((id) => ({
      index: index.positions.get(id)!,
      previousIndex: previousPositions.get(id),
      moveToEnd: moving.has(id),
    })),
  });
  return result;
}
