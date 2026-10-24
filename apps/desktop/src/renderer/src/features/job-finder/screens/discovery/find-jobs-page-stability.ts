import type { WorkspaceJobListRow } from "@nestor/contracts";

/**
 * Keeps the page still while the person reads it (ADR 0075).
 *
 * - While a search runs, rows stay where they were first shown and newly
 *   found jobs join the end of the page, instead of every refresh re-ranking
 *   the page under the pointer. A row leaves only when it left the list (the
 *   person decided it, or it was hidden). When the search ends, the list
 *   takes its ranked order once.
 * - The open job stays in its place when it is decided here, until another
 *   job opens, so the list does not jump back to its first row.
 */
export interface PageStability {
  /** Run and request the pinned order belongs to. */
  key: string;
  rows: readonly WorkspaceJobListRow[];
}

export function stabilizeFindJobsPage(input: {
  previous: PageStability | null;
  rows: readonly WorkspaceJobListRow[];
  /** Every id in the list, in order, so a moved row is told from a gone one. */
  listIds: ReadonlySet<string>;
  /** The run in progress, or null. Pinning only happens during a run. */
  runId: string | null;
  /** The request without its revision: a new filter or page starts over. */
  requestKey: string;
  heldJobId: string | null;
  pageSize: number;
}): PageStability {
  const key = `${input.runId ?? ""}\u0000${input.requestKey}`;
  const previous = input.previous?.key === key ? input.previous : null;
  let rows: WorkspaceJobListRow[] = [...input.rows];
  if (input.runId && previous) {
    const latest = new Map(input.rows.map((row) => [row.id, row]));
    const kept = previous.rows.flatMap((row) => {
      const current = latest.get(row.id);
      if (current) return [current];
      return input.listIds.has(row.id) ? [row] : [];
    });
    const keptIds = new Set(kept.map((row) => row.id));
    const added = input.rows.filter((row) => !keptIds.has(row.id));
    rows = [...kept, ...added].slice(
      0,
      Math.max(input.pageSize, kept.length),
    );
  }
  const held = input.heldJobId;
  if (held && previous && !rows.some((row) => row.id === held)) {
    const index = previous.rows.findIndex((row) => row.id === held);
    if (index >= 0)
      rows.splice(Math.min(index, rows.length), 0, previous.rows[index]!);
  }
  return { key, rows };
}
