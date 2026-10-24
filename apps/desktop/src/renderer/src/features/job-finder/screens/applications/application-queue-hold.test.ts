import { describe, expect, it } from "vitest";
import {
  ApplyQueueSchema,
  JobFinderIntelligenceSafeguardsSchema,
} from "@nestor/contracts";
import {
  buildApplicationQueueHolds,
  describeApplicationQueueHold,
} from "./application-queue-hold";
import { resolveApplicationRecoveryPresentation } from "./applications-recovery-state";

const at = "2026-10-24T18:52:10.889Z";
const reason =
  "Senior Analyst at Spool Workshop overlaps with Lead Planner. Review this pair in Safeguards before sending.";
const queue = ApplyQueueSchema.parse({
  id: "queue",
  mode: "autonomous_submit",
  state: "done",
  jobIds: ["job_held"],
  startedJobIds: [],
  skipped: [{ jobId: "job_held", reason }],
  activeRunId: null,
  pausedReason: null,
  resumesAt: null,
  createdAt: at,
  updatedAt: at,
});
const conflicts = (allowed: boolean) =>
  JobFinderIntelligenceSafeguardsSchema.parse({
    simultaneousApplicationConflicts: [
      {
        id: "conflict",
        applicationRecordId: "application_held",
        conflictingApplicationRecordId: "application_sent",
        companyKey: "spool",
        companyName: "Spool Workshop",
        jobIds: ["job_sent", "job_held"],
        allowedPairs: allowed
          ? [
              {
                jobIds: ["job_held", "job_sent"],
                decidedAt: at,
                revokedAt: null,
              },
            ]
          : [],
        status: "detected",
        explanation: "Two roles at the same employer.",
        recoveryGuidance: "Choose in Safeguards.",
      },
    ],
  }).simultaneousApplicationConflicts;

describe("a job the Apply queue set aside (STAB-005)", () => {
  it("reads as not started and waiting for the person's choice, never as preparing", () => {
    const hold = buildApplicationQueueHolds({
      applyQueue: queue,
      conflicts: conflicts(false),
    }).get("job_held")!;
    expect(hold.waitingForChoice).toBe(true);
    expect(describeApplicationQueueHold(hold, "Spool Workshop")).toBe(
      "Not started: waiting for your choice on Spool Workshop",
    );
    const detail = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      queueHold: hold,
      company: "Spool Workshop",
      visibleApplyResult: null,
    });
    expect(detail.statusLine).toBe(
      "Not started: waiting for your choice on Spool Workshop",
    );
    expect(detail.statusLine).not.toMatch(/stopped before finishing/u);
    expect(detail.reasonSentence).toContain(reason);
    expect(detail.primaryAction).toBe("open_safeguards");
  });

  it("offers to start it once the person allowed the pair", () => {
    const hold = buildApplicationQueueHolds({
      applyQueue: queue,
      conflicts: conflicts(true),
    }).get("job_held")!;
    expect(hold.waitingForChoice).toBe(false);
    expect(describeApplicationQueueHold(hold, "Spool Workshop")).toBe(
      "Not started",
    );
    const detail = resolveApplicationRecoveryPresentation({
      canOpenSafeguards: true,
      isApplyPending: false,
      queueHold: hold,
      company: "Spool Workshop",
      visibleApplyResult: null,
    });
    expect(detail.statusLine).toBe("Not started");
    expect(detail.primaryAction).toBe("try_again");
  });

  it("leaves jobs the queue did not set aside alone", () => {
    expect(
      buildApplicationQueueHolds({ applyQueue: null, conflicts: [] }).size,
    ).toBe(0);
  });
});
