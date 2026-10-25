
import {
  createJobIdentityIndex,
  type JobIdentityIndex,
  type JobIdentityInput,
  type JobIdentityResolution,
} from "./job-identity";

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
): {
  sync(values: readonly T[]): JobIdentityIndex<T>;
  warm(values: readonly T[]): Promise<void>;
  accept(values: readonly T[]): JobIdentityIndex<T>;
} {
  const inner = createJobIdentityIndex<T>([], selectIdentity);
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
      let turnStarted = performance.now();
      for (const value of values) {
        if (!members.has(value)) {
          members.add(value);
          inner.add(value);
        }
        if (performance.now() - turnStarted >= 8) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          turnStarted = performance.now();
        }
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
