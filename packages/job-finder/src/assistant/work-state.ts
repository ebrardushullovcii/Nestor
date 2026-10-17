import {
  isInterruptedResumeImportRun,
  isResumeImportRunInProgress,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import type { AssistantHostPorts } from "./ports";
import { listBackgroundResumeBatches } from "./tools/resume-tools";

export function readAssistantWorkState(
  ports: AssistantHostPorts,
  snapshot: JobFinderWorkspaceSnapshot,
) {
  const latest = snapshot.latestResumeImportRun;
  const importing =
    ports.isResumeImportActive?.() === true ||
    snapshot.resumeImportActive ||
    (latest !== null && isResumeImportRunInProgress(latest));
  const uiBatch = ports.readResumeBatch?.();
  return {
    resumeBatches: [
      ...listBackgroundResumeBatches(),
      ...(uiBatch ? [uiBatch] : []),
    ],
    uiResumeQueueVisible: ports.readResumeBatch !== undefined,
    resumeImport: {
      active: importing,
      runId: latest?.id ?? null,
      fileName: latest?.sourceResumeFileName ?? null,
      status:
        importing && !isResumeImportRunInProgress(latest)
          ? "reading"
          : (latest?.status ?? "none"),
      actions: importing
        ? ["wait", "open_profile"]
        : isInterruptedResumeImportRun(latest)
          ? ["retry_import", "open_profile"]
          : ["open_profile"],
      savedDetailCount: latest?.candidateCounts.autoApplied ?? 0,
      pendingDetailCount: latest?.candidateCounts.needsReview ?? 0,
      error: importing ? null : (latest?.errorMessage ?? null),
    },
  };
}

export type AssistantWorkState = Awaited<
  ReturnType<typeof readAssistantWorkState>
>;

/** Run scope comes from the run, never the currently selected plan. */
export function runningSearchState(snapshot: JobFinderWorkspaceSnapshot) {
  const run = snapshot.activeDiscoveryRun;
  if (!run || run.state !== "running") return null;
  const plan = snapshot.campaigns.find(
    (campaign) => campaign.id === run.campaignId,
  );
  return {
    runId: run.id,
    plan: run.campaignId
      ? { id: run.campaignId, name: plan?.name ?? null }
      : null,
    intent: run.searchIntent ?? null,
    breadth: run.searchBreadth ?? null,
    sources: run.targetIds.map((id) => {
      const source = (
        plan?.searchPreferences.discovery.targets ??
        snapshot.searchPreferences.discovery.targets
      ).find((target) => target.id === id);
      return {
        id,
        label: source?.label ?? null,
        url: source?.startingUrl ?? null,
      };
    }),
  };
}
