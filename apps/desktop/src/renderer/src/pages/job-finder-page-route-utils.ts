import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

export function buildSourceDebugOutcomeMessage(
  workspace: JobFinderRendererWorkspaceSnapshot,
  targetId: string,
): string {
  const target = workspace.searchPreferences.discovery.targets.find(
    (entry) => entry.id === targetId,
  );
  const latestRun = target?.lastDebugRunId
    ? workspace.activeSourceDebugRun?.id === target.lastDebugRunId
      ? workspace.activeSourceDebugRun
      : (workspace.recentSourceDebugRuns.find(
          (run) => run.id === target.lastDebugRunId,
        ) ?? null)
    : null;
  const activeRunIsLatest = Boolean(
    latestRun &&
    workspace.activeSourceDebugRun?.id === latestRun.id &&
    latestRun.state !== "paused_manual" &&
    latestRun.state !== "failed" &&
    latestRun.state !== "interrupted" &&
    latestRun.state !== "cancelled",
  );

  if (activeRunIsLatest) {
    return latestRun?.state === "idle"
      ? "Checking this source now."
      : "Still checking this source.";
  }

  if (latestRun?.state === "paused_manual") {
    return (
      latestRun.manualPrerequisiteSummary ??
      latestRun.finalSummary ??
      "Source check paused until a manual step is completed."
    );
  }

  if (latestRun?.state === "failed") {
    return latestRun.finalSummary ?? "The source check failed.";
  }

  if (latestRun?.state === "interrupted") {
    return (
      latestRun.finalSummary ??
      "The source check was interrupted before it could finish."
    );
  }

  if (latestRun?.state === "cancelled") {
    return (
      latestRun.finalSummary ??
      "The source check was cancelled before it could finish."
    );
  }

  if (target?.instructionStatus === "validated") {
    return "This source is ready to use.";
  }

  if (target?.instructionStatus === "draft") {
    return "The source check saved draft guidance. Review it before relying on this source.";
  }

  if (target?.instructionStatus === "unsupported") {
    return "This source is not supported yet.";
  }

  return (
    latestRun?.finalSummary ??
    "The source check finished without saving reusable guidance."
  );
}
