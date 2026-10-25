import {
  ApplySubmitApprovalSchema,
  ApplyRunSchema,
  ApplyJobResultSchema,
  JobFinderActivityControlSchema,
  type ApplySubmitApproval,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  APPLY_BATCH_APPROVAL_REUSE_WINDOW_MS,
  describeRemainingBatchPreparation,
  describeUnstartedBatchReason,
  selectReusableBatchApproval,
  isSafelyParkedApplyQueue,
} from "./workspace-apply-run-recovery";

const now = "2026-08-15T10:00:00.000Z";

describe("parked Home apply queue recovery", () => {
  it("preserves only a paused queue between jobs, never an in-flight or uncertain send", () => {
    const run = ApplyRunSchema.parse({
      id: "run_parked",
      mode: "queue_auto",
      state: "running",
      jobIds: ["job_1", "job_2"],
      createdAt: now,
      updatedAt: now,
      totalJobs: 2,
      pendingJobs: 1,
      summary: "Applying",
      detail: "Waiting between jobs.",
    });
    const settled = ApplyJobResultSchema.parse({
      id: "result_1",
      runId: run.id,
      jobId: "job_1",
      state: "awaiting_review",
      summary: "Prepared",
      detail: "Review the form.",
      startedAt: now,
      updatedAt: now,
    });
    const planned = ApplyJobResultSchema.parse({
      id: "result_2",
      runId: run.id,
      jobId: "job_2",
      state: "planned",
      summary: "Waiting",
      detail: "Not started.",
      startedAt: now,
      updatedAt: now,
    });
    const control = JobFinderActivityControlSchema.parse({
      paused: true,
      pausedAt: now,
      reason: "Paused by you.",
      pauseBehavior: "finish_current",
    });
    expect(
      isSafelyParkedApplyQueue({ run, results: [settled, planned], control }),
    ).toBe(true);
    expect(
      isSafelyParkedApplyQueue({
        run,
        results: [{ ...settled, state: "filling" }, planned],
        control,
      }),
    ).toBe(false);
    expect(
      isSafelyParkedApplyQueue({
        run,
        results: [
          settled,
          {
            ...planned,
            applicationPreparationStartedAt: now,
            applicationPreparationStartedLocalDate: "2026-08-15",
          },
        ],
        control,
      }),
    ).toBe(false);
    expect(
      isSafelyParkedApplyQueue({
        run,
        results: [settled, planned],
        control: { ...control, paused: false },
      }),
    ).toBe(false);
    expect(
      isSafelyParkedApplyQueue({
        run,
        results: [
          {
            ...settled,
            privacyReceipt: {
              submissionOutcome: { outcome: "outcome_uncertain" },
            },
          } as typeof settled,
          planned,
        ],
        control,
      }),
    ).toBe(false);
  });
});

function approval(
  overrides: Partial<ApplySubmitApproval> = {},
): ApplySubmitApproval {
  return ApplySubmitApprovalSchema.parse({
    id: "approval_1",
    runId: "run_1",
    mode: "queue_auto",
    jobIds: ["job_1", "job_2", "job_3"],
    status: "approved",
    createdAt: "2026-08-15T09:00:00.000Z",
    approvedAt: "2026-08-15T09:01:00.000Z",
    batchId: "batch_1",
    batchCampaignId: "campaign_1",
    ...overrides,
  });
}

function select(
  approvals: readonly ApplySubmitApproval[],
  jobIds: readonly string[],
  options: { campaignId?: string | null; unfinished?: readonly string[] } = {},
) {
  return selectReusableBatchApproval({
    approvals,
    jobIds,
    campaignId:
      options.campaignId === undefined ? "campaign_1" : options.campaignId,
    unfinishedApprovalRunIds: new Set(options.unfinished ?? ["run_1"]),
    now,
  });
}

describe("selectReusableBatchApproval", () => {
  it("covers a retry of part of a batch the person already approved", () => {
    // Each recovery used to stage another run demanding another approval.
    const decision = select([approval()], ["job_2", "job_3"]);

    expect(decision.refusal).toBeNull();
    expect(decision.approval?.id).toBe("approval_1");
  });

  it("never widens scope to a job the person did not name", () => {
    const decision = select([approval()], ["job_2", "job_9"]);

    expect(decision.approval).toBeNull();
    expect(decision.refusal).toBe("jobs_outside_batch");
  });

  it("asks again when the search plan changed", () => {
    const decision = select([approval()], ["job_1"], {
      campaignId: "campaign_2",
    });

    expect(decision.approval).toBeNull();
    expect(decision.refusal).toBe("different_plan");
  });

  it("asks again once the batch finished", () => {
    const decision = select([approval()], ["job_1"], { unfinished: [] });

    expect(decision.approval).toBeNull();
    expect(decision.refusal).toBe("batch_already_finished");
  });

  it("refuses a revoked, pending, or un-batched approval", () => {
    expect(
      select([approval({ status: "pending", approvedAt: null })], ["job_1"])
        .refusal,
    ).toBe("no_batch_approval");
    expect(
      select(
        [
          approval({
            status: "revoked",
            revokedAt: "2026-08-15T09:30:00.000Z",
          }),
        ],
        ["job_1"],
      ).refusal,
    ).toBe("no_batch_approval");
    expect(select([approval({ batchId: null })], ["job_1"]).refusal).toBe(
      "no_batch_approval",
    );
  });

  it("stops being standing permission after the reuse window", () => {
    const stale = new Date(
      Date.parse(now) - APPLY_BATCH_APPROVAL_REUSE_WINDOW_MS,
    ).toISOString();

    expect(
      select([approval({ approvedAt: stale, createdAt: stale })], ["job_1"])
        .refusal,
    ).toBe("no_batch_approval");
  });

  it("honours an explicit expiry", () => {
    expect(
      select([approval({ expiresAt: "2026-08-15T09:30:00.000Z" })], ["job_1"])
        .refusal,
    ).toBe("no_batch_approval");
  });

  it("measures a reused lineage from the original approval", () => {
    const original = approval({
      approvedAt: "2026-08-14T10:30:00.000Z",
      createdAt: "2026-08-14T10:29:00.000Z",
      expiresAt: "2026-08-15T10:30:00.000Z",
    });
    const retry = approval({
      id: "approval_retry",
      runId: "run_retry",
      createdAt: "2026-08-15T09:59:00.000Z",
      approvedAt: "2026-08-15T09:59:00.000Z",
      expiresAt: null,
      reusedFromApprovalId: original.id,
    });

    const nearDeadline = selectReusableBatchApproval({
      approvals: [original, retry],
      jobIds: ["job_1"],
      campaignId: "campaign_1",
      unfinishedApprovalRunIds: new Set([retry.runId]),
      now: "2026-08-15T10:29:59.999Z",
    });
    expect(nearDeadline.approval?.id).toBe(retry.id);
    expect(nearDeadline.authorityApproval?.id).toBe(original.id);

    const afterExpiry = selectReusableBatchApproval({
      approvals: [original, retry],
      jobIds: ["job_1"],
      campaignId: "campaign_1",
      unfinishedApprovalRunIds: new Set([retry.runId]),
      now: "2026-08-15T10:30:00.000Z",
    });
    expect(afterExpiry.approval).toBeNull();
    expect(afterExpiry.refusal).toBe("no_batch_approval");
  });

  it("asks again after a reused retry approval is revoked", () => {
    const original = approval();
    const revokedRetry = approval({
      id: "approval_retry_revoked",
      runId: "run_retry_revoked",
      createdAt: "2026-08-15T09:30:00.000Z",
      approvedAt: "2026-08-15T09:01:00.000Z",
      status: "revoked",
      revokedAt: "2026-08-15T09:45:00.000Z",
      reusedFromApprovalId: original.id,
    });

    const thirdStart = select([original, revokedRetry], ["job_1"], {
      unfinished: [original.runId, revokedRetry.runId],
    });

    expect(thirdStart.approval).toBeNull();
    expect(thirdStart.refusal).toBe("no_batch_approval");
  });

  it("prefers the most recent decision when several cover the jobs", () => {
    const older = approval({
      id: "approval_old",
      runId: "run_old",
      approvedAt: "2026-08-15T08:00:00.000Z",
    });
    const newer = approval({
      id: "approval_new",
      runId: "run_new",
      approvedAt: "2026-08-15T09:45:00.000Z",
    });

    const decision = select([older, newer], ["job_1"], {
      unfinished: ["run_old", "run_new"],
    });

    expect(decision.approval?.id).toBe("approval_new");
  });

  it("names the remaining work in the words the batch summary offers", () => {
    expect(describeRemainingBatchPreparation(1)).toBe(
      "Prepare the remaining job",
    );
    expect(describeRemainingBatchPreparation(4)).toBe(
      "Prepare the remaining 4",
    );
  });

  it("says in one plain sentence why a staged batch never started", () => {
    expect(
      describeUnstartedBatchReason(
        "Browser and application activity is paused. Press Resume background work on the Job Finder Home screen before starting new work.",
      ),
    ).toContain("all work is paused");
    expect(
      describeUnstartedBatchReason(
        "This application is already being prepared. Wait for it to finish before starting it again.",
      ),
    ).toContain("already being prepared");
    const fallback = describeUnstartedBatchReason(null);
    expect(fallback).toContain("nothing was opened or filled");
    // Never leave a person with a bare internal error string.
    expect(fallback).not.toContain("Error");
  });
});
