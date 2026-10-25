import { useEffect, useMemo, useState } from "react";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

import { Button } from "@renderer/components/ui/button";
import {
  describeRecentChange,
  getRecentChangeUndo,
  useRecentChanges,
  type RecentChange,
} from "../../lib/recent-changes";
import { collectPreparedApplicationJobIds } from "../../screens/review-queue/review-queue-status";
import { formatRelativeTimestamp } from "../../screens/review-queue/resume-workspace-time";
import { readFullWorkspaceIfBehind } from "../../lib/workspace-view-refresh";

/**
 * The person's last moves of jobs between lists, each with Undo while it can
 * still be put back, or one plain sentence saying why not.
 */
export function RecentChangesSection(props: {
  workspace: JobFinderRendererWorkspaceSnapshot;
  onUndo: (change: RecentChange) => Promise<boolean>;
}) {
  const changes = useRecentChanges();
  // Undo checks where each job is now among every job.
  useEffect(readFullWorkspaceIfBehind, []);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const { workspace } = props;
  const state = useMemo(
    () => ({
      discoveryJobs: workspace.discoveryJobs,
      dismissedDiscoveryJobs: workspace.dismissedDiscoveryJobs,
      reviewQueue: workspace.reviewQueue,
      applicationJobIds: collectPreparedApplicationJobIds(
        workspace.applicationRecords,
      ),
    }),
    [
      workspace.discoveryJobs,
      workspace.dismissedDiscoveryJobs,
      workspace.reviewQueue,
      workspace.applicationRecords,
    ],
  );
  if (changes.length === 0) return null;
  const now = new Date();

  return (
    <section aria-label="Recent changes" className="grid gap-2">
      <h3 className="font-semibold text-foreground">Recent changes</h3>
      <ul className="grid gap-1">
        {changes.map((change) => {
          const undo = getRecentChangeUndo(change, state, changes);
          const when = formatRelativeTimestamp(change.at, now);
          return (
            <li
              className="flex min-w-0 items-start justify-between gap-3 rounded-(--radius-field) px-1 py-1.5 text-(length:--text-small) leading-5"
              data-recent-change={change.kind}
              key={change.id}
            >
              <span className="grid min-w-0 gap-0.5">
                <span className="break-words text-foreground">
                  {describeRecentChange(change)}
                </span>
                <span className="text-foreground-muted">
                  <time dateTime={change.at} title={when.absolute ?? undefined}>
                    {when.label}
                  </time>
                  {undo.possible ? null : ` · ${undo.reason}`}
                </span>
              </span>
              {undo.possible ? (
                <Button
                  className="shrink-0"
                  disabled={undoingId !== null}
                  onClick={() => {
                    setUndoingId(change.id);
                    void props
                      .onUndo(change)
                      .catch(() => false)
                      .finally(() => setUndoingId(null));
                  }}
                  pending={undoingId === change.id}
                  size="compact"
                  type="button"
                  variant="outline"
                >
                  Undo
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
