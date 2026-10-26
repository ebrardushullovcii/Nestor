import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

export function buildSourceDebugOutcomeMessage(
  workspace: JobFinderRendererWorkspaceSnapshot,
  targetId: string,
): string {
  const latestRun =
    [workspace.activeSourceDebugRun, ...workspace.recentSourceDebugRuns]
      .filter((run) => run?.targetId === targetId)
      .sort((a, b) =>
        (b?.updatedAt ?? "").localeCompare(a?.updatedAt ?? ""),
      )[0] ?? null;
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

  return (
    latestRun?.finalSummary ??
    "The source check finished without saving reusable guidance."
  );
}
