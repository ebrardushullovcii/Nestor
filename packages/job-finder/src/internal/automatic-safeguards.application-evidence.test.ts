import { ApplyJobResultSchema, ApplyRunSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { deriveApplicationFailureEvidence } from "./automatic-safeguards";

const at = "2026-09-24T09:00:00.000Z";

function result(
  id: string,
  state: string,
  blockerReason: string | null = null,
) {
  return ApplyJobResultSchema.parse({
    id,
    runId: "run_batch",
    jobId: `job_${id}`,
    state,
    summary: state,
    detail: state,
    startedAt: at,
    updatedAt: at,
    completedAt: at,
    blockerReason,
  });
}

describe("application failure-rate evidence", () => {
  test("counts sent applications in the sample, so two failures among five sends is not 100%", () => {
    const evidence = deriveApplicationFailureEvidence({
      runs: [
        ApplyRunSchema.parse({
          id: "run_batch",
          campaignId: "campaign_default",
          mode: "queue_auto",
          state: "completed",
          jobIds: ["job_a"],
          createdAt: at,
          updatedAt: at,
          completedAt: at,
          summary: "done",
          detail: "done",
          totalJobs: 7,
          pendingJobs: 0,
        }),
      ],
      results: [
        result("a", "submitted"),
        result("b", "submitted"),
        result("c", "submitted"),
        result("d", "awaiting_review"),
        result("e", "submitted"),
        result("f", "failed", "application_page_unreachable"),
        result("g", "failed", "application_page_unreachable"),
        // Waiting on the person's answer is neither a success nor a failure.
        result("h", "awaiting_review", "required_human_input"),
        // A filled form whose page closed on restart did not fail on a site.
        ApplyJobResultSchema.parse({
          ...result("i", "failed", "unexpected_navigation"),
          blockerSummary: "The prepared application page is no longer open.",
        }),
        // Nor did an application the person stepped into.
        ApplyJobResultSchema.parse({
          ...result("j", "failed"),
          summary: "You took over this application.",
        }),
      ],
      campaignId: "campaign_default",
    });

    expect(evidence).toHaveLength(7);
    expect(evidence.filter((entry) => entry.failed)).toHaveLength(2);
  });

  test("drops a failure once the same job was sent later, a send the site refused, and work the app closing cut short", () => {
    const later = "2026-09-24T10:00:00.000Z";
    const evidence = deriveApplicationFailureEvidence({
      results: [
        result("a", "blocked", "submission_outcome_uncertain"),
        ApplyJobResultSchema.parse({
          ...result("a2", "submitted"),
          jobId: "job_a",
          completedAt: later,
          updatedAt: later,
        }),
        ApplyJobResultSchema.parse({
          ...result("b", "failed", "application_page_unreachable"),
          blockerSummary:
            "The site could not be reached when the application was sent.",
        }),
        result("c", "failed", "application_page_unreachable"),
        // Cut short by the app closing, not by a site.
        ApplyJobResultSchema.parse({
          ...result("d", "failed"),
          summary: "Application preparation stopped when the app closed.",
          detail:
            "The app closed while this job's application preparation was underway, so it never reached its review checkpoint. No final submit action occurred.",
        }),
        ApplyJobResultSchema.parse({
          ...result("e", "failed"),
          summary: "Application retry stopped safely",
          detail: "The exact prepared application page is no longer open.",
        }),
      ],
    });

    expect(evidence.map((entry) => [entry.attemptId, entry.failed])).toEqual([
      ["apply:a2", false],
      ["apply:c", true],
    ]);
  });
});
