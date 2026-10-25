import {
  isInterruptedResumeImportRun,
  isResumeImportRunInProgress,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import type { AssistantHostPorts } from "./ports";

export function readAssistantWorkState(
  ports: AssistantHostPorts,
  snapshot: JobFinderWorkspaceSnapshot,
) {
  const latest = snapshot.latestResumeImportRun;
  const importing =
    ports.isResumeImportActive?.() === true ||
    snapshot.resumeImportActive ||
    (latest !== null && isResumeImportRunInProgress(latest));
  return {
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

