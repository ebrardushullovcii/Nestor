import type {
  DiscoveryLedgerEntry,
  DiscoveryIdentityStore,
} from "@nestor/contracts";
import { yieldToEventLoop } from "@nestor/core";
import {
  createJobIdentityIndex,
  type JobIdentityIndex,
  type JobIdentityInput,
  type JobIdentityResolution,
} from "./job-identity";
import {
  applyInactiveLedgerMarks,
  buildDiscoveryLedgerEntry,
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
  storage?: DiscoveryIdentityStore,
): {
  sync(values: readonly T[]): JobIdentityIndex<T>;
  warm(values: readonly T[]): Promise<void>;
  accept(values: readonly T[]): JobIdentityIndex<T>;
} {
  const inner = createJobIdentityIndex<T>(
    [],
    selectIdentity,
    undefined,
    storage,
  );
  const members = new Set<T>();
  let syncedWith: readonly T[] | null = null;
  let resolutions = new WeakMap<object, JobIdentityResolution<T>>();
  const invalidate = () => {
    resolutions = new WeakMap();
  };
  const index: JobIdentityIndex<T> = {
    add(value) {
      invalidate();
      syncedWith = null;
      members.add(value);
      inner.add(value);
    },
    remove(value) {
      invalidate();
      syncedWith = null;
      members.delete(value);
      inner.remove(value);
    },
    replace(previous, next) {
      invalidate();
      syncedWith = null;
      members.delete(previous);
      members.add(next);
      inner.replace(previous, next);
    },
    resolve: (identity) => {
      if (!Object.isFrozen(identity)) return inner.resolve(identity);
      let result = resolutions.get(identity);
      if (!result) {
        result = inner.resolve(identity);
        resolutions.set(identity, result);
      }
      return result;
    },
    find: (identity) => inner.find(identity),
  };
  return {
    // The caller already applied every merge through this index.
    accept(values) {
      syncedWith = values;
      return index;
    },
    async warm(values) {
      if (values === syncedWith) return;
      for (let start = 0; start < values.length; start += 100) {
        const add = () => {
          for (const value of values.slice(start, start + 100)) {
            if (!members.has(value)) {
              members.add(value);
              inner.add(value);
            }
          }
        };
        if (storage) storage.batch(add);
        else add();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      invalidate();
      // sync also removes rows that departed while the index was warming.
      this.sync(values);
    },
    sync(values) {
      if (values === syncedWith) return index;
      const wanted = new Set(values);
      for (const value of members) {
        if (!wanted.has(value)) {
          invalidate();
          members.delete(value);
          inner.remove(value);
        }
      }
      for (const value of wanted) {
        if (!members.has(value)) {
          invalidate();
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
  storage?: DiscoveryIdentityStore,
) {
  let byId = new Map(initial.map((entry) => [entry.id, entry]));
  let byTarget = new Map<string, Set<string>>();
  const addTarget = (entry: DiscoveryLedgerEntry) => {
    let ids = byTarget.get(entry.targetId);
    if (!ids) byTarget.set(entry.targetId, (ids = new Set()));
    ids.add(entry.id);
  };
  initial.forEach(addTarget);
  let snapshot: readonly DiscoveryLedgerEntry[] | null = initial;
  let version = 0;
  let sequence = 0;
  let acknowledged = 0;
  const dirty = new Map<
    string,
    { sequence: number; entry: DiscoveryLedgerEntry }
  >();
  type Range = { from: number; to: number };
  const ranges = new WeakMap<DiscoveryLedgerEntry, Range[]>();
  const historyCurrent = new Map<string, DiscoveryLedgerEntry>();
  const retired = new Set<DiscoveryLedgerEntry>();
  const readers = new Map<number, number>();
  let lookupVersion = 0;
  let historyIndex: JobIdentityIndex<DiscoveryLedgerEntry> | null = null;
  const observe = (entry: DiscoveryLedgerEntry) => {
    if (!historyIndex) return;
    const old = historyCurrent.get(entry.id);
    if (old === entry) return;
    if (old) {
      ranges.get(old)!.at(-1)!.to = sequence;
      retired.add(old);
    }
    const intervals = ranges.get(entry) ?? [];
    intervals.push({ from: sequence, to: Infinity });
    ranges.set(entry, intervals);
    historyCurrent.set(entry.id, entry);
    historyIndex.add(entry);
  };
  const prune = () => {
    const oldest = readers.size > 0 ? Math.min(...readers.keys()) : sequence;
    for (const entry of retired) {
      const remaining = ranges.get(entry)!.filter((range) => range.to > oldest);
      if (remaining.length === 0) historyIndex?.remove(entry);
      ranges.set(entry, remaining);
      if (
        remaining.length === 0 ||
        remaining.every((range) => range.to === Infinity)
      )
        retired.delete(entry);
    }
  };
  const noteChange = (entry: DiscoveryLedgerEntry) => {
    dirty.set(entry.id, { sequence: ++sequence, entry });
    observe(entry);
  };

  const entries = (): readonly DiscoveryLedgerEntry[] =>
    (snapshot ??= [...byId.values()]);
  const createHistoryIndex = () =>
    createJobIdentityIndex(
      [],
      (entry: DiscoveryLedgerEntry) => entry,
      (entry) =>
        ranges
          .get(entry)
          ?.some(
            (range) => range.from <= lookupVersion && lookupVersion < range.to,
          ) === true,
      storage,
    );
  const currentIndex = () => {
    if (!historyIndex) {
      historyIndex = createHistoryIndex();
      for (const entry of byId.values()) observe(entry);
    }
    lookupVersion = sequence;
    return historyIndex;
  };
  const changed = () => {
    snapshot = null;
    version += 1;
  };

  return {
    /** The ledger as it stands; an array handed out is never changed later. */
    entries,
    async warm() {
      if (historyIndex) return;
      historyIndex = createHistoryIndex();
      const rows = entries();
      for (let start = 0; start < rows.length; start += 100) {
        const add = () => rows.slice(start, start + 100).forEach(observe);
        if (storage) storage.batch(add);
        else add();
        await yieldToEventLoop();
      }
    },
    captureSnapshot() {
      if (!historyIndex)
        throw new Error("Warm the run ledger before capturing its baseline.");
      const at = sequence;
      readers.set(at, (readers.get(at) ?? 0) + 1);
      let released = false;
      return {
        find(posting: Parameters<DiscoveryLedgerIndex["find"]>[0]) {
          if (released)
            throw new Error("The source ledger baseline was released.");
          lookupVersion = at;
          return historyIndex!.find(posting);
        },
        release() {
          if (released) return;
          released = true;
          const count = readers.get(at)! - 1;
          if (count === 0) readers.delete(at);
          else readers.set(at, count);
          prune();
        },
      };
    },
    captureChanges() {
      const through = sequence;
      return {
        entries: [...dirty.values()]
          .filter((change) => change.sequence > acknowledged)
          .map((change) => change.entry),
        committed: () => {
          acknowledged = Math.max(acknowledged, through);
          for (const [id, change] of dirty)
            if (change.sequence <= acknowledged) dirty.delete(id);
        },
      };
    },
    /** Grows with every change, so a reader can tell nothing moved. */
    get version() {
      return version;
    },
    find(posting: Parameters<DiscoveryLedgerIndex["find"]>[0]) {
      return currentIndex().find(posting);
    },
    record(sighting: DiscoveryLedgerSighting): DiscoveryLedgerEntry {
      const existing = currentIndex().find(sighting.posting);
      const next = buildDiscoveryLedgerEntry(sighting, existing);
      if (existing) {
        byId.delete(existing.id);
        if (existing.targetId !== next.targetId)
          byTarget.get(existing.targetId)?.delete(existing.id);
      }
      byId.set(next.id, next);
      addTarget(next);
      dirty.delete(next.id);
      noteChange(next);
      changed();
      return next;
    },
    /** Marks a source's entries it no longer lists; returns how many. */
    markInactive(
      input: Omit<Parameters<typeof applyInactiveLedgerMarks>[0], "ledger">,
    ): number {
      if (!input.allowInactiveMarking) return 0;
      const before = [...(byTarget.get(input.targetId) ?? [])].map(
        (id) => byId.get(id)!,
      );
      const after = applyInactiveLedgerMarks({ ...input, ledger: before });
      let newlyInactive = 0;
      let moved = false;
      after.forEach((entry, position) => {
        const previous = before[position];
        if (!previous || previous === entry) return;
        moved = true;
        if (previous.latestStatus !== "inactive") newlyInactive += 1;
        byId.set(entry.id, entry);
        noteChange(entry);
      });
      if (moved) changed();
      return newlyInactive;
    },
    /** Puts back an array `entries()` handed out earlier (a rolled-back attempt). */
    restore(previous: readonly DiscoveryLedgerEntry[]): void {
      if (previous === snapshot) return;
      byId = new Map(previous.map((entry) => [entry.id, entry]));
      for (const [id, entry] of historyCurrent)
        if (!byId.has(id)) {
          ranges.get(entry)!.at(-1)!.to = ++sequence;
          retired.add(entry);
          historyCurrent.delete(id);
        }
      byTarget = new Map();
      previous.forEach(addTarget);
      for (const id of dirty.keys()) if (!byId.has(id)) dirty.delete(id);
      // A failed speculative attempt can have changed rows already captured
      // by a queued save. Re-publish the restored values on the next save.
      for (const entry of previous) noteChange(entry);
      snapshot = previous;
      version += 1;
    },
  };
}

export type RunDiscoveryLedger = ReturnType<typeof createRunDiscoveryLedger>;
