import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type {
  QueryJobListInput,
  QueryJobListResult,
  WorkspaceChanges,
} from "@nestor/contracts";
import { KeptRouteVisibilityContext } from "../../lib/kept-route-visibility";
import { describeFailure } from "../../lib/describe-failure";

/**
 * Find jobs reads what it shows from the database (ADR 0071): one page of
 * rows with the pool's facets, badge counts, band outline and ordered ids,
 * refetched when the change feed says a job list changed. Nothing here holds
 * a saved job beyond the rows on screen.
 */

/** While a search writes jobs, the visible page refreshes at most this often. */
export const FIND_JOBS_SEARCH_REFRESH_MS = 1_000;

const ALL_BANDS = ["matches", "unchecked", "weaker", "mismatches"] as const;

export type FindJobsListRequest = Omit<QueryJobListInput, "list" | "include">;

/** The plan's undecided jobs by band, before the panel's filters and search. */
export interface FindJobsPoolBands {
  matches: number;
  unchecked: number;
  weaker: number;
  mismatches: number;
}

export interface FindJobsList {
  /** The last reply, kept while a newer request is in flight. */
  result: QueryJobListResult | null;
  /** The request `result` answers. */
  request: FindJobsListRequest | null;
  pool: FindJobsPoolBands | null;
  /** A request for other inputs is in flight (a filter, sort or page change). */
  pending: boolean;
  error: string | null;
  /** Changes when a job's stored facts change, for the inspector's cache. */
  detailRevision: (jobId: string) => string;
  refresh: () => void;
}

type Queries = NonNullable<
  NonNullable<Window["nestor"]>["jobFinder"]
>["queries"];

function readQueries(): Queries | null {
  return typeof window === "undefined"
    ? null
    : (window.nestor?.jobFinder?.queries ?? null);
}

export function countPoolBands(
  outline: QueryJobListResult["outline"],
): FindJobsPoolBands {
  const bands: FindJobsPoolBands = {
    matches: 0,
    unchecked: 0,
    weaker: 0,
    mismatches: 0,
  };
  for (const run of outline ?? []) bands[run.group] += run.count;
  return bands;
}

/**
 * The visible page for `request`. `requestKey` must change exactly when the
 * request does. While Find jobs is kept hidden behind another screen, changes
 * are not fetched; the page catches up when it shows again.
 */
export function useFindJobsList(
  request: FindJobsListRequest,
  requestKey: string,
  options: { searchRunning: boolean },
): FindJobsList {
  const visibility = useContext(KeptRouteVisibilityContext);
  const [state, setState] = useState<{
    result: QueryJobListResult | null;
    request: FindJobsListRequest | null;
    pool: FindJobsPoolBands | null;
    pending: boolean;
    error: string | null;
  }>({ result: null, request: null, pool: null, pending: true, error: null });
  const requestRef = useRef(request);
  requestRef.current = request;
  const sequenceRef = useRef(0);
  const searchRunningRef = useRef(options.searchRunning);
  searchRunningRef.current = options.searchRunning;
  const [revisions, setRevisions] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const fetchPage = useCallback(async () => {
    const queries = readQueries();
    if (!queries) return;
    const sequence = ++sequenceRef.current;
    const current = requestRef.current;
    const planFilter =
      current.filters?.planId === undefined
        ? {}
        : { planId: current.filters.planId };
    try {
      const [result, pool] = await Promise.all([
        queries.queryJobList({
          ...current,
          list: "discovery",
          include: { outline: true, ids: true },
        }),
        queries.queryJobList({
          list: "discovery",
          filters: { ...planFilter, discoveryBands: [...ALL_BANDS] },
          page: { offset: 0, limit: 1 },
          include: { outline: true },
        }),
      ]);
      if (sequence !== sequenceRef.current) return;
      setState({
        result,
        request: current,
        pool: countPoolBands(pool.outline),
        pending: false,
        error: null,
      });
    } catch (error) {
      if (sequence !== sequenceRef.current) return;
      setState((previous) => ({
        ...previous,
        pending: false,
        error: describeFailure(error, { action: "read your jobs" }).userMessage,
      }));
    }
  }, []);

  const staleRef = useRef(false);
  // New inputs: ask at once and keep the last page meanwhile.
  useEffect(() => {
    staleRef.current = false;
    setState((previous) =>
      previous.pending ? previous : { ...previous, pending: true },
    );
    void fetchPage();
  }, [fetchPage, requestKey]);
  // Showing again after a change arrived while hidden.
  useEffect(
    () =>
      visibility.subscribe(() => {
        if (visibility.isHidden() || !staleRef.current) return;
        staleRef.current = false;
        void fetchPage();
      }),
    [fetchPage, visibility],
  );

  // The change feed: refetch the visible page when a job list changed. A
  // person's own shortlist or hide lands within a frame or two; a search's
  // stream of writes refreshes the page at most once a second.
  useEffect(() => {
    const queries = readQueries();
    if (typeof queries?.onChanges !== "function") return undefined;
    let timer: number | undefined;
    let lastAt = Number.NEGATIVE_INFINITY;
    const run = () => {
      timer = undefined;
      if (visibility.isHidden()) {
        staleRef.current = true;
        return;
      }
      lastAt = Date.now();
      void fetchPage();
    };
    const unsubscribe = queries.onChanges((changes: WorkspaceChanges) => {
      const changedJobs = changes.changes.filter(
        (change) => change.table === "saved_jobs",
      );
      if (changedJobs.length > 0)
        setRevisions((current) => {
          const next = new Map(current);
          for (const change of changedJobs)
            next.set(change.id, change.revision);
          return next;
        });
      if (!changes.lists.includes("discovery") || timer !== undefined) return;
      const wait = searchRunningRef.current
        ? Math.max(0, lastAt + FIND_JOBS_SEARCH_REFRESH_MS - Date.now())
        : 0;
      timer = window.setTimeout(run, wait);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [fetchPage, visibility]);

  const detailRevision = useCallback(
    (jobId: string) => String(revisions.get(jobId) ?? 0),
    [revisions],
  );

  return {
    ...state,
    detailRevision,
    refresh: () => void fetchPage(),
  };
}
