import type { JobChange, JobStageCounts } from "@nestor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEffectWhileKeptRouteShown } from "@renderer/features/job-finder/lib/kept-route-visibility";

/** One page of any store-backed list: `list_jobs`, `list_shortlisted`, … */
export interface StoreListPage<Row, Counts = JobStageCounts> {
  rows: Row[];
  nextCursor: string | null;
  total: number;
  totalCapped: boolean;
  counts: Counts;
}

export type StoreListState<
  Row,
  Counts = JobStageCounts,
  Extra extends object = object,
> = StoreListPage<Row, Counts> &
  Partial<Extra> & {
    /** True until the first page of this list arrives. */
    loading: boolean;
    error: string | null;
  };

export const LIST_PAGE_SIZE = 50;
/** The most rows one read asks for; a refresh of more reads in turns. */
const REFRESH_MAX = 200;
/** Changes arrive in bursts during a search; refetch at most this often. */
const REFRESH_GAP_MS = 400;

const EMPTY_COUNTS: JobStageCounts = {
  found: 0,
  hidden: 0,
  shortlisted: 0,
  resume: 0,
  applied: 0,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load the list.";
}

/** Deep equality of plain data read over IPC: rows, counts. */
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => same(a[key], b[key]))
  );
}

/**
 * The new rows, keeping each unchanged row's old object (and the old array
 * when nothing changed), so memoized rows skip the render.
 */
function reuseRows<Row extends { id: number }>(
  before: readonly Row[],
  after: Row[],
): Row[] {
  const old = new Map(before.map((row) => [row.id, row]));
  let changed = before.length !== after.length;
  const rows = after.map((row, index) => {
    const kept = old.get(row.id);
    if (kept && same(kept, row)) {
      if (before[index] !== kept) changed = true;
      return kept;
    }
    changed = true;
    return row;
  });
  return changed ? rows : (before as Row[]);
}

/**
 * Any list read from the job store: the first page, more pages as the person
 * scrolls, and a quiet refetch of what is on screen when a `jobs:changed`
 * event touches it. Rows a move takes away leave at once (`removeRows`).
 *
 * `key` names the list's query; a new key starts the list over. `load`
 * fetches one page from a cursor. `refreshOn` decides which changes matter
 * (default: any change that names a stage, since the counts move too).
 */
export function useStoreList<
  Row extends { id: number },
  Counts = JobStageCounts,
  /** Whatever else a page carries, e.g. `belowFloor`; kept from the last page. */
  Extra extends object = object,
>(options: {
  key: string;
  load: (page: {
    cursor: string | null;
    limit: number;
  }) => Promise<StoreListPage<Row, Counts> & Extra>;
  refreshOn?: (change: JobChange) => boolean;
  /** Counts before the first page arrives; job stage counts by default. */
  emptyCounts?: Counts;
  /** Keep the visible rows still while a person edits a detail form. */
  pauseUpdates?: boolean;
}) {
  const { key } = options;
  const loadRef = useRef(options.load);
  loadRef.current = options.load;
  const refreshOnRef = useRef(options.refreshOn);
  refreshOnRef.current = options.refreshOn;
  const paused = useRef(options.pauseUpdates ?? false);
  paused.current = options.pauseUpdates ?? false;
  const pendingRefresh = useRef(false);

  const [state, setState] = useState<StoreListState<Row, Counts, Extra>>(() => {
    // No page yet, so none of its extra fields.
    const empty: StoreListState<Row, Counts> = {
      rows: [],
      nextCursor: null,
      total: 0,
      totalCapped: false,
      counts: options.emptyCounts ?? (EMPTY_COUNTS as Counts),
      loading: true,
      error: null,
    };
    return empty as StoreListState<Row, Counts, Extra>;
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const loadingMore = useRef(false);

  const apply = useCallback(
    (page: StoreListPage<Row, Counts> & Extra, rows: Row[]) =>
      setState((current): StoreListState<Row, Counts, Extra> => {
        const next = {
          ...page,
          rows: reuseRows(current.rows, rows),
          counts: same(current.counts, page.counts)
            ? current.counts
            : page.counts,
          loading: false,
          error: null,
        };
        // A refresh that changed nothing renders nothing.
        return Object.keys(next).every((key) =>
          Object.is(
            next[key as keyof typeof next],
            current[key as keyof typeof current],
          ),
        )
          ? current
          : next;
      }),
    [],
  );

  const refresh = useCallback(async () => {
    if (paused.current) {
      pendingRefresh.current = true;
      return;
    }
    const current = generation.current;
    // Everything the person has loaded comes back, in place: a person far
    // down a long list keeps their rows and their scroll position.
    const want = Math.max(LIST_PAGE_SIZE, stateRef.current.rows.length);
    try {
      const rows: Row[] = [];
      const seen = new Set<number>();
      let page: (StoreListPage<Row, Counts> & Extra) | null = null;
      let cursor: string | null = null;
      do {
        page = await loadRef.current({
          cursor,
          limit: Math.min(REFRESH_MAX, want - rows.length),
        });
        if (current !== generation.current) return;
        for (const row of page.rows)
          if (!seen.has(row.id)) {
            seen.add(row.id);
            rows.push(row);
          }
        cursor = page.rows.length > 0 ? page.nextCursor : null;
      } while (cursor && rows.length < want);
      if (paused.current) pendingRefresh.current = true;
      else apply(page, rows);
    } catch (error) {
      if (current === generation.current)
        setState((s) => ({ ...s, loading: false, error: describe(error) }));
    }
    // `key` restarts the list; the loader itself is read from a ref.
  }, [apply, key]);

  useEffect(() => {
    if (!options.pauseUpdates && pendingRefresh.current) {
      pendingRefresh.current = false;
      void refresh();
    }
  }, [options.pauseUpdates, refresh]);

  useEffect(() => {
    generation.current += 1;
    setState((s) => ({ ...s, rows: [], loading: true, error: null }));
    void refresh();
  }, [refresh]);

  // Listens only while the screen shows: a kept screen hidden behind another
  // one reads nothing, and reads once when it shows again.
  const shownWith = useRef<typeof refresh | null>(null);
  useEffectWhileKeptRouteShown(() => {
    // A new list (a new `refresh`) is loaded by the effect above.
    if (shownWith.current === refresh) void refresh();
    shownWith.current = refresh;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const schedule = () => {
      if (timer) return;
      const wait = Math.max(0, last + REFRESH_GAP_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        void refresh();
      }, wait);
    };
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      const matters = refreshOnRef.current ?? ((c) => c.stages.length > 0);
      if (matters(change)) schedule();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (paused.current) return;
    const { nextCursor } = stateRef.current;
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const current = generation.current;
    try {
      const page = await loadRef.current({
        cursor: nextCursor,
        limit: LIST_PAGE_SIZE,
      });
      if (current !== generation.current) return;
      if (paused.current) {
        pendingRefresh.current = true;
        return;
      }
      const seen = new Set(stateRef.current.rows.map((row) => row.id));
      apply(page, [
        ...stateRef.current.rows,
        ...page.rows.filter((row) => !seen.has(row.id)),
      ]);
    } catch (error) {
      if (current === generation.current)
        setState((s) => ({ ...s, error: describe(error) }));
    } finally {
      loadingMore.current = false;
    }
  }, [apply]);

  /** Takes rows out at once after a move; the next refetch confirms it. */
  const removeRows = useCallback((moved: (id: number) => boolean) => {
    setState((s) => {
      const rows = s.rows.filter((row) => !moved(row.id));
      return {
        ...s,
        rows,
        total: Math.max(0, s.total - (s.rows.length - rows.length)),
      };
    });
  }, []);

  return { ...state, loadMore, refresh, removeRows };
}

export type StoreList<Row extends { id: number }> = ReturnType<
  typeof useStoreList<Row>
>;
