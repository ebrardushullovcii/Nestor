import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { readRunStatus } from "./run-watch";

function snapshot(stepState: string) {
  return {
    applyRuns: [{ id: "run_1", state: "paused_for_user_review" }],
    applyJobResults: [
      {
        id: "result_1",
        runId: "run_1",
        jobId: "job_1",
        state: "awaiting_review",
        updatedAt: "2026-09-28T03:10:00.000Z",
        blockerSummary: null,
      },
    ],
    userActionRequests: [
      {
        id: "step_1",
        state: stepState,
        scope: { type: "application", runId: "run_1", jobId: "job_1" },
      },
    ],
    discoveryJobs: [],
    companyJobs: [],
    dismissedDiscoveryJobs: [],
  } as unknown as JobFinderWorkspaceSnapshot;
}

const run = {
  kind: "apply_run" as const,
  id: "run_1",
  jobIds: ["job_1"],
};

describe("following an application while an answer is put on the form", () => {
  it("does not report the run as ended while the answer is still verifying", () => {
    expect(readRunStatus(snapshot("verifying"), run).done).toBe(false);
  });

  it("reports it once the step is settled", () => {
    const status = readRunStatus(snapshot("resolved"), run);
    expect(status.done).toBe(true);
    expect(status.summary).toContain("1 awaiting review");
  });

  it("keeps a terminal run watched while its answer is still being applied", () => {
    const verifying = snapshot("verifying");
    verifying.applyRuns[0]!.state = "completed";
    expect(readRunStatus(verifying, run).done).toBe(false);
    verifying.userActionRequests[0]!.state = "resolved";
    expect(readRunStatus(verifying, run).done).toBe(true);
  });

  it("names a pending person-owned handoff without treating it as submission", () => {
    const waiting = snapshot("awaiting_user");
    waiting.applyRuns[0]!.state = "completed";
    const status = readRunStatus(waiting, run);
    expect(status.done).toBe(true);
    expect(status.pendingHandoffKey).toBe("step_1");
    expect(status.summary).toContain("waiting on the person");
    expect(status.summary).toContain("awaiting review");
  });

  it("does not retain a stale handoff after the same job is submitted", () => {
    const submitted = snapshot("awaiting_user");
    submitted.applyRuns[0]!.state = "completed";
    submitted.applyJobResults[0]!.state = "submitted";
    const status = readRunStatus(submitted, run);
    expect(status.done).toBe(true);
    expect(status.pendingHandoffKey).toBeUndefined();
    expect(status.summary).toContain("1 not confirmed");
  });
});

it("names a cancelled item and leaves the other item waiting on its own step", () => {
  const workspace = snapshot("awaiting_user");
  workspace.applyJobResults.push({
    ...workspace.applyJobResults[0]!,
    id: "result_cancelled",
    jobId: "job_cancelled",
    state: "cancelled",
    summary: "Cancelled by you",
    blockerSummary: null,
  });
  const status = readRunStatus(workspace, run);
  expect(status.summary).toContain("1 cancelled");
  expect(status.summary).toContain("1 awaiting review");
  expect(status.summary).not.toContain("failed");
  expect(status.pendingHandoffKey).toBe("step_1");
  expect(status.details).toMatchObject({
    results: [
      {},
      {
        jobId: "job_cancelled",
        state: "cancelled",
        summary: "Cancelled by you",
        blocker: null,
      },
    ],
  });
});

it("continues an automatic-send timeout with recovery and no permission to resend", () => {
  const workspace = snapshot("resolved");
  workspace.applyRuns[0]!.state = "completed";
  workspace.applyJobResults[0]!.summary =
    "Send attempted; confirmation timed out";
  workspace.applyJobResults[0]!.privacyReceipt = {
    finalSubmitOccurred: false,
    submissionOutcome: {
      outcome: "outcome_uncertain",
      browserAction: { reason: "confirmation_timeout" },
    },
  } as unknown as NonNullable<
    (typeof workspace.applyJobResults)[0]
  >["privacyReceipt"];
  const status = readRunStatus(workspace, run);
  expect(status.done).toBe(true);
  expect(status.summary).toContain("send unconfirmed");
  expect(status.details).toMatchObject({
    results: [
      {
        recovery: expect.stringContaining("Do not send again") as unknown,
        sendPermission: "blocked_until_person_checks_outcome",
      },
    ],
  });
});
