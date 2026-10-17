import type { JobFinderWorkspaceSnapshot } from "./workspace";

export type DiscoveryFeedbackBatchOutcome = { jobId: string } & (
  | { status: "hidden" | "restored" }
  | { status: "held" | "failed"; message: string }
  | { status: "stopped" }
);

export interface DiscoveryFeedbackBatchResult {
  outcomes: DiscoveryFeedbackBatchOutcome[];
  /** No display is built after the workspace closes or changes generation. */
  workspace: JobFinderWorkspaceSnapshot | null;
}
