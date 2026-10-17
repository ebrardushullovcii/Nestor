import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApplyJobResultSchema, type ApplyRun } from "@nestor/contracts";

import { listJobsNotInProgress, startApplyBatch } from "./start-apply-batch";

function run(
  id: string,
  state: ApplyRun["state"],
  jobIds: string[],
  createdAt = "2026-09-23T10:00:00.000Z",
): ApplyRun {
  return { id, mode: "queue_auto", state, jobIds, createdAt } as ApplyRun;
}

function harness(options: {
  existing?: ApplyRun[];
  approve?: (runs: ApplyRun[]) => Promise<void>;
  stage?: (runs: ApplyRun[]) => Promise<void>;
}) {
  const runs: ApplyRun[] = [...(options.existing ?? [])];
  const service = {
    startAutoApplyQueueRun: vi.fn(async (jobIds: string[]) => {
      if (options.stage) {
        await options.stage(runs);
      } else {
        runs.push(
          run(
            "staged",
            "awaiting_submit_approval",
            jobIds,
            "2026-09-23T11:00:00.000Z",
          ),
        );
      }
      return {} as never;
    }),
    approveApplyRun: vi.fn(async () => {
      await options.approve?.(runs);
      return {} as never;
    }),
    cancelApplyRun: vi.fn((runId: string) => {
      const found = runs.find((candidate) => candidate.id === runId);
      if (found) found.state = "cancelled";
      return Promise.resolve({} as never);
    }),
  };
  return {
    runs,
    service,
    reader: { listApplyRuns: () => Promise.resolve([...runs]) },
  };
}

describe("startApplyBatch", () => {
  it("returns once the approved batch is running and reports its end later", async () => {
    let finish!: () => void;
    const h = harness({
      approve: (runs) => {
        runs.find((candidate) => candidate.id === "staged")!.state = "running";
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const onBackgroundSettled = vi.fn();
    await expect(
      startApplyBatch({
        service: h.service,
        runs: h.reader,
        jobIds: ["job_1", "job_2"],
        onBackgroundSettled,
        pollMs: 5,
      }),
    ).resolves.toEqual({ startedJobIds: ["job_1", "job_2"] });
    expect(h.service.approveApplyRun).toHaveBeenCalledWith("staged");
    expect(onBackgroundSettled).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onBackgroundSettled).toHaveBeenCalled());
  });

  it("hands a refusal back and cancels the batch it staged", async () => {
    const h = harness({
      approve: () =>
        Promise.reject(
          new Error("A safeguard review is waiting for you in Safeguards."),
        ),
    });
    await expect(
      startApplyBatch({
        service: h.service,
        runs: h.reader,
        jobIds: ["job_1"],
        onBackgroundSettled: vi.fn(),
        pollMs: 5,
      }),
    ).rejects.toThrow("A safeguard review is waiting for you in Safeguards.");
    expect(h.service.cancelApplyRun).toHaveBeenCalledWith("staged");
    expect(h.runs.find((candidate) => candidate.id === "staged")?.state).toBe(
      "cancelled",
    );
  });

  it("does not wait for a batch that runs straight from staging", async () => {
    let finish!: () => void;
    const h = harness({
      stage: (runs) => {
        runs.push(
          run("retry", "running", ["job_1"], "2026-09-23T11:00:00.000Z"),
        );
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const onBackgroundSettled = vi.fn();
    await startApplyBatch({
      service: h.service,
      runs: h.reader,
      jobIds: ["job_1"],
      onBackgroundSettled,
      pollMs: 5,
    });
    expect(h.service.approveApplyRun).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onBackgroundSettled).toHaveBeenCalled());
  });

  it("still approves a batch when staging finishes after the foreground wait", async () => {
    let finishStaging!: () => void;
    const h = harness({
      stage: async (runs) => {
        await new Promise<void>((resolve) => {
          finishStaging = resolve;
        });
        runs.push(run("slow", "awaiting_submit_approval", ["job_1"]));
      },
      approve: (runs) => {
        runs.find((candidate) => candidate.id === "slow")!.state = "completed";
        return Promise.resolve();
      },
    });
    const onBackgroundSettled = vi.fn();
    await startApplyBatch({
      service: h.service,
      runs: h.reader,
      jobIds: ["job_1"],
      onBackgroundSettled,
      pollMs: 1,
      startTimeoutMs: 1,
    });
    expect(h.service.approveApplyRun).not.toHaveBeenCalled();
    finishStaging();
    await vi.waitFor(() => expect(onBackgroundSettled).toHaveBeenCalledOnce());
    expect(h.service.approveApplyRun).toHaveBeenCalledWith("slow");
    expect(h.runs[0]?.state).toBe("completed");
  });

  it("leaves out jobs a running batch already has, so a double press stages nothing", async () => {
    const h = harness({
      existing: [run("first", "running", ["job_1", "job_2"])],
    });
    await expect(
      listJobsNotInProgress(h.reader, ["job_1", "job_2", "job_3"]),
    ).resolves.toEqual(["job_3"]);
    await expect(
      startApplyBatch({
        service: h.service,
        runs: h.reader,
        jobIds: ["job_1", "job_2"],
        onBackgroundSettled: vi.fn(),
        pollMs: 5,
      }),
    ).resolves.toEqual({ startedJobIds: [] });
    expect(h.service.startAutoApplyQueueRun).not.toHaveBeenCalled();
  });

  it("does not approve a slow-staged batch cancelled before staging settles", async () => {
    let finishStaging!: () => void;
    const h = harness({
      stage: async (runs) => {
        runs.push(run("slow", "awaiting_submit_approval", ["job_1"]));
        await new Promise<void>((resolve) => {
          finishStaging = resolve;
        });
      },
    });
    const onBackgroundSettled = vi.fn();
    await startApplyBatch({
      service: h.service,
      runs: h.reader,
      jobIds: ["job_1"],
      onBackgroundSettled,
      pollMs: 1,
      startTimeoutMs: 1,
    });
    await h.service.cancelApplyRun("slow");
    finishStaging();
    await vi.waitFor(() => expect(onBackgroundSettled).toHaveBeenCalledOnce());
    expect(h.service.approveApplyRun).not.toHaveBeenCalled();
    expect(h.runs[0]?.state).toBe("cancelled");
  });

  it.each([
    "prepare_only",
    "confirm_before_submit",
    "autonomous_submit",
  ] as const)(
    "passes the selected %s mode into the batch start",
    async (applicationAutomationMode) => {
      const h = harness({
        approve: (runs) => {
          runs.find((candidate) => candidate.id === "staged")!.state =
            "completed";
          return Promise.resolve();
        },
      });
      await startApplyBatch({
        service: h.service,
        runs: h.reader,
        jobIds: ["job_1"],
        applicationAutomationMode,
        onBackgroundSettled: vi.fn(),
        pollMs: 5,
      });
      expect(h.service.startAutoApplyQueueRun).toHaveBeenCalledWith(
        ["job_1"],
        applicationAutomationMode,
      );
    },
  );
});

it("excludes a receipt-confirmed send before staging the remaining batch", async () => {
  const h = harness({});
  const receipt = {
    generatedAt: "2026-10-03T10:00:00.000Z",
    lineage: {
      runId: "sent",
      resultId: "sent_result",
      jobId: "job_1",
      applicationRecordId: "application_1",
    },
    destination: { origin: "http://127.0.0.1:47950", safePath: "/receipt" },
    resume: {
      source: "original_upload",
      sourceDocumentId: "synthetic",
      exportArtifactId: null,
      fileName: "synthetic.pdf",
      sha256: "a".repeat(64),
    },
    finalSubmitAuthorized: true,
    finalSubmitOccurred: true,
    submissionOutcome: null,
  };
  const result = ApplyJobResultSchema.parse({
    id: "sent_result",
    runId: "sent",
    jobId: "job_1",
    applicationRecordId: "application_1",
    state: "submitted",
    summary: "Application submitted",
    detail: "Confirmed",
    startedAt: receipt.generatedAt,
    updatedAt: receipt.generatedAt,
    privacyReceipt: receipt,
  });
  const reader = {
    ...h.reader,
    listApplyJobResults: () => Promise.resolve([result]),
  };
  expect(await listJobsNotInProgress(reader, ["job_1", "job_2"])).toEqual([
    "job_2",
  ]);
  await startApplyBatch({
    service: h.service,
    runs: reader,
    jobIds: ["job_1", "job_2"],
    onBackgroundSettled: vi.fn(),
  });
  expect(h.service.startAutoApplyQueueRun).toHaveBeenCalledWith(
    ["job_2"],
    undefined,
  );
  expect(h.service.approveApplyRun).toHaveBeenCalledWith("staged");
});

it("returns the shared service's overlap choice instead of applying a desktop-only veto", async () => {
  const h = harness({});
  h.service.startAutoApplyQueueRun.mockRejectedValueOnce(
    new Error(
      "Synthetic Company: Engineer (Denver) and Designer (London). Choose Send both anyway in Safeguards.",
    ),
  );
  await expect(
    startApplyBatch({
      service: h.service,
      runs: h.reader,
      jobIds: ["job_1", "job_2"],
      onBackgroundSettled: vi.fn(),
    }),
  ).rejects.toThrow(/Send both anyway/);
  expect(h.service.startAutoApplyQueueRun).toHaveBeenCalledOnce();
});

it("allows Ask before sending to prepare same-company jobs", async () => {
  const h = harness({});
  const service = {
    ...h.service,
    getWorkspaceSnapshot: () =>
      Promise.resolve({
        settings: { applicationAutomationMode: "confirm_before_submit" },
        discoveryJobs: [
          { id: "job_1", company: "Synthetic", title: "Engineer" },
          { id: "job_2", company: "Synthetic", title: "Engineer" },
        ],
      } as unknown as JobFinderWorkspaceSnapshot),
  };
  await startApplyBatch({
    service,
    runs: h.reader,
    jobIds: ["job_1", "job_2"],
    onBackgroundSettled: vi.fn(),
  });
  expect(h.service.startAutoApplyQueueRun).toHaveBeenCalled();
});
