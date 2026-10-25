import { useEffect, useState } from "react";
import type { JobListRow, WorkspaceJobListRow } from "@nestor/contracts";
import type { DiscoveryListSnapshot } from "./discovery-results-panel";
import { countPoolBands } from "./use-find-jobs-list";

const ALL_BANDS = ["matches", "unchecked", "weaker", "mismatches"] as const;

/**
 * Test support for screen tests that stub the results panel: reports the
 * query fixture's first page to the screen the way the real panel does.
 */
export function useFixtureListReport(props: {
  onListChange?: (list: DiscoveryListSnapshot) => void;
  areAlsoFoundShown?: boolean;
}): readonly WorkspaceJobListRow[] {
  const [version, setVersion] = useState(0);
  const [rows, setRows] = useState<readonly WorkspaceJobListRow[]>([]);
  const { onListChange, areAlsoFoundShown } = props;
  useEffect(() => {
    const queries = window.nestor?.jobFinder?.queries;
    if (typeof queries?.onChanges !== "function") return undefined;
    return queries.onChanges(() => setVersion((value) => value + 1));
  }, []);
  useEffect(() => {
    const queries = window.nestor?.jobFinder?.queries;
    if (!queries || !onListChange) return undefined;
    let current = true;
    void Promise.all([
      queries.queryJobList({
        list: "discovery",
        filters: areAlsoFoundShown ? { discoveryBands: [...ALL_BANDS] } : {},
        include: { ids: true, outline: true },
      }),
      queries.queryJobList({
        list: "discovery",
        filters: { discoveryBands: [...ALL_BANDS] },
        page: { offset: 0, limit: 1 },
        include: { outline: true },
      }),
    ]).then(([result, pool]) => {
      if (!current) return;
      const ids = result.ids ?? [];
      const groups = (result.outline ?? []).flatMap((run) =>
        Array.from({ length: run.count }, () => run.group),
      );
      const byId = new Map(ids.map((id, index) => [id, groups[index]]));
      setRows(result.rows);
      onListChange({
        ready: true,
        rows: result.rows,
        orderedJobIds: ids,
        groupOf: (jobId) => byId.get(jobId),
        planJobCount: result.counts.all,
        pool: countPoolBands(pool.outline),
        detailRevision: () => "0",
      });
    });
    return () => {
      current = false;
    };
  }, [areAlsoFoundShown, onListChange, version]);
  return rows;
}

export interface FixtureWindow {
  __findJobsFixtureJob?: (jobId: string) => JobListRow | null;
}

/** The query fixture's current row for a job, for tests that stub detail reads. */
export function readFixtureJob(jobId: string): JobListRow | null {
  return (
    (window as unknown as FixtureWindow).__findJobsFixtureJob?.(jobId) ?? null
  );
}
