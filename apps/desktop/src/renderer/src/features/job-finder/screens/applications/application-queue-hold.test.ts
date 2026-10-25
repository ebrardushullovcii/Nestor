import { describe, expect, it } from "vitest";
import { ApplyQueueSchema } from "@nestor/contracts";
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
  createdAt: at,
  updatedAt: at,
});

describe("a job the Apply queue set aside (STAB-005)", () => {
  it("offers to start it once the person allowed the pair", () => {
    const hold = buildApplicationQueueHolds({
      applyQueue: queue,
    }).get("job_held")!;
    expect(hold.waitingForChoice).toBe(false);
    expect(describeApplicationQueueHold(hold, "Spool Workshop")).toBe(
      "Not started",
    );
    const detail = resolveApplicationRecoveryPresentation({
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
      buildApplicationQueueHolds({ applyQueue: null }).size).toBe(0);
  });
});
