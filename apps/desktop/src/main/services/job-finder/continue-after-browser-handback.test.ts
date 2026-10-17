import { describe, expect, it, vi } from "vitest";
import type { ApplyJobResult, ApplyRun } from "@nestor/contracts";
import { PERSON_TOOK_OVER_SUMMARY } from "@nestor/job-finder";
import { continueApplicationsAfterHandback } from "./continue-after-browser-handback";

function result(
  overrides: Partial<ApplyJobResult> & Pick<ApplyJobResult, "id">,
): ApplyJobResult {
  return {
    runId: "run_1",
    jobId: "job_1",
    applicationRecordId: "record_1",
    state: "failed",
    summary: PERSON_TOOK_OVER_SUMMARY,
    updatedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  } as ApplyJobResult;
}

function run(overrides: Partial<ApplyRun>): ApplyRun {
  return {
    id: "run_1",
    state: "failed",
    jobIds: ["job_1"],
    ...overrides,
  } as ApplyRun;
}

describe("continueApplicationsAfterHandback", () => {
  it("carries on the application the person stepped into", async () => {
    const startBatch = vi.fn().mockResolvedValue(undefined);
    const started = await continueApplicationsAfterHandback({
      resultIds: ["result_1"],
      repository: {
        listApplyRuns: () => Promise.resolve([run({})]),
        listApplyJobResults: () =>
          Promise.resolve([result({ id: "result_1" })]),
      },
      startBatch,
      pollMs: 1,
    });
    expect(started).toEqual(["job_1"]);
    expect(startBatch).toHaveBeenCalledWith(["job_1"]);
  });

  it("waits for the batch still working through other jobs, then carries on", async () => {
    const startBatch = vi.fn().mockResolvedValue(undefined);
    let reads = 0;
    const started = await continueApplicationsAfterHandback({
      resultIds: ["result_1"],
      repository: {
        listApplyRuns: () =>
          Promise.resolve([
            run({
              state: reads++ < 2 ? "running" : "completed",
              jobIds: ["job_1", "job_2"],
            }),
          ]),
        listApplyJobResults: () =>
          Promise.resolve([result({ id: "result_1" })]),
      },
      startBatch,
      pollMs: 1,
    });
    expect(reads).toBeGreaterThan(2);
    expect(started).toEqual(["job_1"]);
  });

  it("leaves alone an application already tried again, or one that ended for another reason", async () => {
    const startBatch = vi.fn().mockResolvedValue(undefined);
    const started = await continueApplicationsAfterHandback({
      resultIds: ["result_1", "result_2"],
      repository: {
        listApplyRuns: () => Promise.resolve([run({})]),
        listApplyJobResults: () =>
          Promise.resolve([
            result({ id: "result_1" }),
            // The person pressed Try again themselves: a newer attempt exists.
            result({
              id: "result_1_retry",
              state: "awaiting_review",
              summary: "Ready",
              updatedAt: "2026-09-24T10:05:00.000Z",
            }),
            result({
              id: "result_2",
              jobId: "job_2",
              applicationRecordId: "record_2",
              summary: "Could not apply.",
            }),
          ]),
      },
      startBatch,
      pollMs: 1,
    });
    expect(started).toEqual([]);
    expect(startBatch).not.toHaveBeenCalled();
  });
});
