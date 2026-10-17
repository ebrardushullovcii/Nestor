import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyPausedApplyRun,
  listApplyRunsStoppedBySafeguard,
} from "./apply-run-pause-state";

function workspace(
  resultStates: readonly string[],
): JobFinderRendererWorkspaceSnapshot {
  const jobIds = resultStates.map((_state, index) => `job_${index}`);
  return {
    applyRuns: [
      {
        id: "run-1",
        mode: "queue_auto",
        state: "paused_for_user_review",
        jobIds,
      },
    ],
    applyJobResults: resultStates.map((state, index) => ({
      id: `result-${index}`,
      runId: "run-1",
      jobId: `job_${index}`,
      applicationRecordId: `record-${index}`,
      state,
      blockerReason: null,
      latestQuestionCount: 0,
      pendingConsentRequestCount: 0,
      reviewCard: { waitingOnYou: [] },
      updatedAt: "2026-09-24T11:00:00.000Z",
    })),
    applicationRecords: [],
    userActionRequests: [],
    intelligence: {
      safeguards: {
        preparedBatchSampleReviews: [
          { id: "sample-1", batchId: "run-1", reviewCompleted: false },
        ],
      },
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("classifyPausedApplyRun", () => {
  it("does not call a batch whose every form is filled in a safety pause while its sample waits", () => {
    const ws = workspace([
      "awaiting_review",
      "awaiting_review",
      "awaiting_review",
    ]);
    expect(classifyPausedApplyRun(ws, ws.applyRuns[0]!)).toBe(
      "ready_for_final_review",
    );
    expect(listApplyRunsStoppedBySafeguard(ws)).toEqual([]);
  });

  it("still calls it a safety pause when the sample held jobs it did not get to", () => {
    const ws = workspace(["awaiting_review", "planned"]);
    expect(classifyPausedApplyRun(ws, ws.applyRuns[0]!)).toBe(
      "stopped_by_safeguard",
    );
  });
});
