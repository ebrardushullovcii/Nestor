import type {
  JobFinderPerformanceSnapshot,
  JobFinderWorkspaceSnapshot,
  WaitingFormMemory,
} from "@nestor/contracts";
import {
  buildJobFinderPerformanceSnapshot,
  type JobFinderWorkspaceService,
} from "@nestor/job-finder";

type PerformanceWorkspaceService = Pick<
  JobFinderWorkspaceService,
  "getSourceDebugRunDetails" | "getWorkspaceSnapshot"
>;

export async function collectJobFinderPerformanceSnapshot(input: {
  service: PerformanceWorkspaceService;
  generatedAt?: string;
  nowMs?: () => number;
  waitingFormMemory?: () => Promise<WaitingFormMemory>;
}): Promise<{
  workspace: JobFinderWorkspaceSnapshot;
  performance: JobFinderPerformanceSnapshot;
}> {
  const nowMs = input.nowMs ?? performance.now.bind(performance);
  const snapshotReadStartedAtMs = nowMs();
  const workspace = await input.service.getWorkspaceSnapshot();
  const snapshotReadDurationMs = Math.max(0, nowMs() - snapshotReadStartedAtMs);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const latestSourceDebugSummary =
    workspace.activeSourceDebugRun ??
    workspace.recentSourceDebugRuns[0] ??
    null;
  const latestSourceDebugRun = latestSourceDebugSummary
    ? await input.service.getSourceDebugRunDetails(latestSourceDebugSummary.id)
    : null;

  const waitingFormMemory = await input.waitingFormMemory?.();
  return {
    workspace,
    performance: {
      ...buildJobFinderPerformanceSnapshot({
        workspace,
        latestSourceDebugRun,
        generatedAt,
        runtimeObservations: [
          {
            area: "persistence",
            durationMs: snapshotReadDurationMs,
            recordedAt: generatedAt,
            stageDurations: [
              {
                id: "persistence.workspace_snapshot_read",
                durationMs: snapshotReadDurationMs,
              },
            ],
          },
        ],
      }),
      ...(waitingFormMemory ? { waitingFormMemory } : {}),
    },
  };
}
