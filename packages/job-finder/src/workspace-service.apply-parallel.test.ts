import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { JobFinderRepositorySeed } from "@nestor/db";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  createSeed,
  createSavedJob,
  createBrowserRuntime,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function stageReadyTailoredJob(
  seed: JobFinderRepositorySeed,
  jobId: string,
  sourceJobId: string,
  options?: {
    savedJob?: Partial<Parameters<typeof createSavedJob>[0]>;
    filePath?: string;
  },
): void {
  const filePath = options?.filePath ?? `/tmp/${jobId}-resume.pdf`;
  seed.savedJobs = [
    ...seed.savedJobs,
    createSavedJob({
      ...seed.savedJobs[0]!,
      id: jobId,
      sourceJobId,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${sourceJobId}`,
      applicationUrl: `https://www.linkedin.com/jobs/view/${sourceJobId}/apply`,
      title: `Role ${jobId}`,
      status: "ready_for_review",
      ...options?.savedJob,
    }),
  ];
  seed.tailoredAssets = [
    ...seed.tailoredAssets,
    {
      ...seed.tailoredAssets[0]!,
      id: `asset_${jobId}`,
      jobId,
      storagePath: filePath,
    },
  ];
  seed.resumeDrafts = [
    ...seed.resumeDrafts,
    {
      id: `resume_draft_${jobId}`,
      jobId,
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "deterministic",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-03-20T10:04:00.000Z",
      approvedExportId: `resume_export_${jobId}`,
      staleReason: null,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:04:00.000Z",
    },
  ];
  seed.resumeExportArtifacts = [
    ...seed.resumeExportArtifacts,
    {
      id: `resume_export_${jobId}`,
      draftId: `resume_draft_${jobId}`,
      jobId,
      format: "pdf",
      filePath,
      pageCount: 2,
      templateId: "classic_ats",
      exportedAt: "2026-03-20T10:04:00.000Z",
      isApproved: true,
    },
  ];
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createParallelHarness(
  count: number,
  hostFor: (id: string) => string = (id) => id.replaceAll("_", "-"),
) {
  const seed = createSeed();
  const ids = Array.from({ length: count }, (_, index) => `parallel_${index}`);
  for (const id of ids)
    stageReadyTailoredJob(seed, id, id, {
      savedJob: {
        description: "Design the workflow system.",
        canonicalUrl: `https://${hostFor(id)}.example/jobs/${id}`,
        applicationUrl: `https://${hostFor(id)}.example/apply/${id}`,
      },
    });
  const runtime = createBrowserRuntime();
  const gates = new Map(ids.map((id) => [id, gate()]));
  const started: string[] = [];
  const finished: string[] = [];
  let active = 0;
  let peak = 0;
  let failId: string | null = null;
  const close = vi.fn(runtime.closeSession.bind(runtime));
  const executeApplicationFlow: BrowserSessionRuntime["executeApplicationFlow"] =
    async (source, input, options) => {
      expect(input.mode).toBe("prepare_only");
      expect(input.submitAuthorized).toBe(false);
      started.push(input.job.id);
      active += 1;
      peak = Math.max(peak, active);
      try {
        await Promise.race([
          gates.get(input.job.id)!.promise,
          new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (options?.signal?.aborted)
          throw new DOMException("Stopped", "AbortError");
        if (input.job.id === failId) throw new Error("Fixture form failed");
        return await runtime.executeApplicationFlow(source, input, options);
      } finally {
        active -= 1;
        finished.push(input.job.id);
      }
    };
  return {
    ...createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...runtime,
        executeApplicationFlow,
        closeSession: close,
      },
    }),
    ids,
    gates,
    started,
    finished,
    close,
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    fail(id: string) {
      failId = id;
    },
  };
}

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("NESTOR_APPLICATION_PREPARATION_CONCURRENCY", "2"));

describe("parallel application preparation", () => {
  // A run holds at most ten jobs, so nine workers plus one waiting job is the
  // widest case a run can reach.
  test.each([2, 4, 9])(
    "bounds %i workers and counts out-of-order results without closing active forms",
    async (concurrency) => {
      vi.stubEnv(
        "NESTOR_APPLICATION_PREPARATION_CONCURRENCY",
        String(concurrency),
      );
      const h = createParallelHarness(concurrency + 1);
      const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
      const runId = staged.applyRuns[0]!.id;
      const running = h.workspaceService.approveApplyRun(runId);
      try {
        await vi.waitFor(() => expect(h.started).toHaveLength(concurrency));
        expect(h.peak).toBe(concurrency);
        expect(h.close).not.toHaveBeenCalled();
        h.gates.get(h.ids[concurrency - 1]!)!.release();
        await vi.waitFor(async () => {
          const run = (await h.repository.listApplyRuns()).find(
            (candidate) => candidate.id === runId,
          )!;
          expect(run.state).toBe("running");
          expect(run.pendingJobs).toBe(concurrency);
          expect(run.summary).toContain(`processed 1 of ${concurrency + 1}`);
          expect(h.started).toHaveLength(concurrency + 1);
        });
        expect(h.close).not.toHaveBeenCalled();
      } finally {
        for (const g of h.gates.values()) g.release();
        await running;
      }
      expect(h.peak).toBe(concurrency);
      expect(new Set(h.started).size).toBe(h.ids.length);
      const results = await h.repository.listApplyJobResults({ runId });
      expect(results).toHaveLength(h.ids.length);
      expect(
        results.every((result) => result.state === "awaiting_review"),
      ).toBe(true);
      const run = (await h.repository.listApplyRuns()).find(
        (candidate) => candidate.id === runId,
      )!;
      expect(run.pendingJobs).toBe(0);
      expect(run.summary).toContain(
        `processed ${h.ids.length} of ${h.ids.length}`,
      );
      expect(h.active).toBe(0);
      expect(h.close).toHaveBeenCalledTimes(1);
    },
  );

  test("a free worker takes a job on another site before a second job on a busy site", async () => {
    // Jobs 0 and 1 share one employer site; job 2 is on another site.
    const h = createParallelHarness(3, (id) =>
      id === "parallel_2" ? "other-site" : "shared-site",
    );
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const running = h.workspaceService.approveApplyRun(runId);
    try {
      await vi.waitFor(() => expect(h.started).toHaveLength(2));
      expect(h.started).toEqual(["parallel_0", "parallel_2"]);
    } finally {
      for (const g of h.gates.values()) g.release();
      await running;
    }
    expect(new Set(h.started)).toEqual(new Set(h.ids));
  });

  test("one failure releases its worker and keeps other applications and counts intact", async () => {
    const h = createParallelHarness(4);
    h.fail(h.ids[1]!);
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const running = h.workspaceService.approveApplyRun(runId);
    try {
      await vi.waitFor(() => expect(h.started).toHaveLength(2));
      h.gates.get(h.ids[1]!)!.release();
      await vi.waitFor(() => expect(h.started).toHaveLength(3));
      expect(h.finished).not.toContain(h.ids[0]);
    } finally {
      for (const g of h.gates.values()) g.release();
      await running;
    }
    const run = (await h.repository.listApplyRuns()).find(
      (candidate) => candidate.id === runId,
    )!;
    expect(run).toMatchObject({
      failedJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
    });
    expect(run.summary).toContain("processed 4 of 4");
    const failedRecord = (await h.repository.listApplicationRecords()).find(
      (record) => record.jobId === h.ids[1],
    );
    expect(failedRecord).toMatchObject({
      lastAttemptState: "failed",
      nextActionLabel: "Try again",
    });
    expect(
      (await h.repository.listApplyJobResults({ runId })).filter(
        (result) => result.state === "awaiting_review",
      ),
    ).toHaveLength(3);
  });

  test("Stop cancels both active applications and leaves queued jobs unstarted", async () => {
    const h = createParallelHarness(5);
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const running = h.workspaceService.approveApplyRun(runId);
    await vi.waitFor(() => expect(h.started).toHaveLength(2));
    await h.workspaceService.cancelApplyRun(runId);
    await running;
    expect(h.started).toHaveLength(2);
    expect(h.active).toBe(0);
    const run = (await h.repository.listApplyRuns()).find(
      (candidate) => candidate.id === runId,
    )!;
    expect(run.state).toBe("cancelled");
    // A stopped job never reads as still in progress; Applications shows
    // it as cancelled from its run result.
    expect(
      (await h.repository.listApplicationRecords())
        .filter((record) => h.ids.includes(record.jobId))
        .every((record) => record.lastAttemptState !== "in_progress"),
    ).toBe(true);
    expect(run.completedAt).not.toBeNull();
    expect(
      (await h.repository.listApplyJobResults({ runId })).every(
        (result) =>
          !["planned", "filling", "question_capture"].includes(result.state),
      ),
    ).toBe(true);
  });

  test("Finish current pauses new starts, drains both workers, then resumes remaining jobs", async () => {
    const h = createParallelHarness(4);
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const running = h.workspaceService.approveApplyRun(runId);
    try {
      await vi.waitFor(() => expect(h.started).toHaveLength(2));
      await h.workspaceService.setActivityControl({
        paused: true,
        pauseBehavior: "finish_current",
      });
      h.gates.get(h.ids[0]!)!.release();
      h.gates.get(h.ids[1]!)!.release();
      await vi.waitFor(async () => {
        expect(h.finished).toHaveLength(2);
        expect(
          (await h.repository.listApplyRuns()).find(
            (candidate) => candidate.id === runId,
          )?.pendingJobs,
        ).toBe(2);
      });
      expect(h.started).toHaveLength(2);
      expect(h.close).not.toHaveBeenCalled();
      await h.workspaceService.setActivityControl({ paused: false });
      await vi.waitFor(() => expect(h.started).toHaveLength(4));
    } finally {
      await h.workspaceService.setActivityControl({ paused: false });
      for (const g of h.gates.values()) g.release();
      await running;
    }
    expect(h.peak).toBe(2);
  });
  test("shutdown preserves both completed preparations and the untouched paused queue", async () => {
    const h = createParallelHarness(5);
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const running = h.workspaceService.approveApplyRun(runId);
    await vi.waitFor(() => expect(h.started).toHaveLength(2));
    await h.workspaceService.setActivityControl({
      paused: true,
      pauseBehavior: "finish_current",
    });
    h.gates.get(h.ids[0]!)!.release();
    h.gates.get(h.ids[1]!)!.release();
    await vi.waitFor(async () =>
      expect(
        (await h.repository.listApplyJobResults({ runId })).filter(
          (result) => result.state === "awaiting_review",
        ),
      ).toHaveLength(2),
    );
    await h.workspaceService.shutdown();
    await running;
    expect(h.started).toHaveLength(2);
    expect(
      (await h.repository.listApplyRuns()).find(
        (candidate) => candidate.id === runId,
      ),
    ).toMatchObject({ state: "running", pendingJobs: 3 });
    const results = await h.repository.listApplyJobResults({ runId });
    expect(
      results.filter((result) => result.state === "awaiting_review"),
    ).toHaveLength(2);
    expect(results.filter((result) => result.state === "planned")).toHaveLength(
      3,
    );
    expect(h.active).toBe(0);
  });
  test("Pause during prerequisites holds those jobs before browser work starts", async () => {
    const h = createParallelHarness(3);
    const staged = await h.workspaceService.startAutoApplyQueueRun(h.ids);
    const runId = staged.applyRuns[0]!.id;
    const prerequisites = gate();
    let reads = 0;
    h.exportFileVerifier.exists = async () => {
      reads += 1;
      await prerequisites.promise;
      return true;
    };
    const running = h.workspaceService.approveApplyRun(runId);
    try {
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
      await h.workspaceService.setActivityControl({
        paused: true,
        pauseBehavior: "finish_current",
      });
      prerequisites.release();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(h.started).toHaveLength(0);
      await h.workspaceService.setActivityControl({ paused: false });
      await vi.waitFor(() => expect(h.started).toHaveLength(2));
    } finally {
      prerequisites.release();
      await h.workspaceService.setActivityControl({ paused: false });
      for (const g of h.gates.values()) g.release();
      await running;
    }
    expect(new Set(h.started).size).toBe(3);
  });
});
