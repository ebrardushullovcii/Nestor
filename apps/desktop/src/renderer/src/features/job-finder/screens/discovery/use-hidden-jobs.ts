import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedJob, WorkspaceChanges } from "@nestor/contracts";

/** One job the person marked Not interested, for Find jobs' Hidden list. */
export interface HiddenJobRow {
  id: string;
  title: string;
  /** Undefined until the job's own record has been read. */
  discoveryFeedback: SavedJob["discoveryFeedback"] | undefined;
}

/** As many as the Hidden list shows; a plan rarely hides more. */
const HIDDEN_JOBS_LIMIT = 200;

function readQueries() {
  return typeof window === "undefined"
    ? undefined
    : window.nestor?.jobFinder?.queries;
}

/**
 * The plan's hidden jobs, read from the database instead of the workspace's
 * full list (OPUS-QUEUE item 1): the "dismissed" list gives the rows in Best
 * match order, each job's record gives why it was hidden. Follows the change
 * feed, so Hide and Show again land at once.
 */
export function useHiddenJobs(planId: string | null): {
  total: number;
  rows: readonly HiddenJobRow[];
} {
  const [state, setState] = useState<{
    total: number;
    rows: readonly HiddenJobRow[];
  }>({ total: 0, rows: [] });
  const sequenceRef = useRef(0);

  const fetchHidden = useCallback(async () => {
    const queries = readQueries();
    if (!queries) return;
    const sequence = ++sequenceRef.current;
    try {
      const page = await queries.queryJobList({
        list: "dismissed",
        filters: planId ? { planId } : {},
        sort: "best_match",
        page: { offset: 0, limit: HIDDEN_JOBS_LIMIT },
      });
      if (sequence !== sequenceRef.current) return;
      const rows = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        discoveryFeedback: undefined,
      }));
      setState({ total: page.total, rows });
      const details = await Promise.all(
        rows.map((row) =>
          queries.getJobDetail(row.id, planId).catch(() => null),
        ),
      );
      if (sequence !== sequenceRef.current) return;
      setState({
        total: page.total,
        rows: rows.map((row, index) => ({
          ...row,
          discoveryFeedback: details[index]?.job.discoveryFeedback ?? null,
        })),
      });
    } catch {
      // The list stays as it was; the next change tries again.
    }
  }, [planId]);

  useEffect(() => {
    void fetchHidden();
  }, [fetchHidden]);

  useEffect(() => {
    const queries = readQueries();
    if (typeof queries?.onChanges !== "function") return undefined;
    return queries.onChanges((changes: WorkspaceChanges) => {
      if (changes.lists.includes("dismissed")) void fetchHidden();
    });
  }, [fetchHidden]);

  return state;
}
