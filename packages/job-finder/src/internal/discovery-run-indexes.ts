import type { DiscoveryLedgerEntry } from "@nestor/contracts";
import {
  createJobIdentityIndex,
  type JobIdentityIndex,
  type JobIdentityInput,
} from "./job-identity";
import {
  applyInactiveLedgerMarks,
  buildDiscoveryLedgerEntry,
  createDiscoveryLedgerIndex,
  type DiscoveryLedgerIndex,
  type DiscoveryLedgerSighting,
} from "./workspace-discovery-ledger";

/**
 * An identity index a search keeps for its whole run and brings in step
 * with the working job list by object identity.
 *
 * Each source used to build several indexes over every saved job; at 6,000
 * jobs and 900 sources that was most of a search's main-process time, and
 * the event-loop stalls it caused timed the provider downloads out. Rows are
 * immutable, so `sync` only adds the rows it has not seen and drops the ones
 * that left. Changes made through the index itself (a merge adding or
 * replacing rows) are tracked too.
 */
export function createSyncedJobIdentityIndex<T extends object>(
  selectIdentity: (value: T) => JobIdentityInput,
): { sync(values: readonly T[]): JobIdentityIndex<T> } {
  const inner = createJobIdentityIndex<T>([], selectIdentity);
  const members = new Set<T>();
  let syncedWith: readonly T[] | null = null;
  const index: JobIdentityIndex<T> = {
    add(value) {
      syncedWith = null;
      members.add(value);
      inner.add(value);
    },
    remove(value) {
      syncedWith = null;
      members.delete(value);
      inner.remove(value);
    },
    replace(previous, next) {
      syncedWith = null;
      members.delete(previous);
      members.add(next);
      inner.replace(previous, next);
    },
    resolve: (identity) => inner.resolve(identity),
    find: (identity) => inner.find(identity),
  };
  return {
    sync(values) {
      if (values === syncedWith) return index;
      const wanted = new Set(values);
      for (const value of members) {
        if (!wanted.has(value)) {
          members.delete(value);
          inner.remove(value);
        }
      }
      for (const value of wanted) {
        if (!members.has(value)) {
          members.add(value);
          inner.add(value);
        }
      }
      syncedWith = values;
      return index;
    },
  };
}

/**
 * The discovery ledger a search writes to as it goes, with one identity
 * index kept current beside it.
 *
 * Recording a sighting used to copy the whole ledger (7,000+ entries), and
 * every source built a fresh index over it. Entries are keyed by id in
 * insertion order, which keeps the old order exactly: an entry recorded
 * again moves to the end, an entry marked inactive keeps its place.
 */
export function createRunDiscoveryLedger(
  initial: readonly DiscoveryLedgerEntry[],
) {
  let byId = new Map(initial.map((entry) => [entry.id, entry]));
  let snapshot: readonly DiscoveryLedgerEntry[] | null = initial;
  let index: DiscoveryLedgerIndex | null = null;
  let version = 0;

  const entries = (): readonly DiscoveryLedgerEntry[] =>
    (snapshot ??= [...byId.values()]);
  const ledgerIndex = (): DiscoveryLedgerIndex =>
    (index ??= createDiscoveryLedgerIndex(entries()));
  const changed = () => {
    snapshot = null;
    version += 1;
  };

  return {
    /** The ledger as it stands; an array handed out is never changed later. */
    entries,
    /** Grows with every change, so a reader can tell nothing moved. */
    get version() {
      return version;
    },
    /** The index over `entries()`. */
    index: ledgerIndex,
    find(posting: Parameters<DiscoveryLedgerIndex["find"]>[0]) {
      return ledgerIndex().find(posting);
    },
    record(sighting: DiscoveryLedgerSighting): DiscoveryLedgerEntry {
      const currentIndex = ledgerIndex();
      const existing = currentIndex.find(sighting.posting);
      const next = buildDiscoveryLedgerEntry(sighting, existing);
      if (existing) {
        currentIndex.replace(existing, next);
        byId.delete(existing.id);
      } else {
        currentIndex.add(next);
      }
      byId.set(next.id, next);
      changed();
      return next;
    },
    /** Marks a source's entries it no longer lists; returns how many. */
    markInactive(
      input: Omit<Parameters<typeof applyInactiveLedgerMarks>[0], "ledger">,
    ): number {
      if (!input.allowInactiveMarking) return 0;
      const before = entries();
      const after = applyInactiveLedgerMarks({ ...input, ledger: before });
      let newlyInactive = 0;
      let moved = false;
      after.forEach((entry, position) => {
        const previous = before[position];
        if (!previous || previous === entry) return;
        moved = true;
        if (previous.latestStatus !== "inactive") newlyInactive += 1;
        index?.replace(previous, entry);
        byId.set(entry.id, entry);
      });
      if (moved) changed();
      return newlyInactive;
    },
    /** Puts back an array `entries()` handed out earlier (a rolled-back attempt). */
    restore(previous: readonly DiscoveryLedgerEntry[]): void {
      if (previous === snapshot) return;
      byId = new Map(previous.map((entry) => [entry.id, entry]));
      snapshot = previous;
      index = null;
      version += 1;
    },
  };
}

export type RunDiscoveryLedger = ReturnType<typeof createRunDiscoveryLedger>;
