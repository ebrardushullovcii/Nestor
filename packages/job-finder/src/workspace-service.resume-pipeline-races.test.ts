import { RESUME_AI_CONCURRENCY } from "@nordri/contracts";
import type {
  JobFinderIntelligenceState,
  ResumeBatchCheckpoint,
  ResumeBatchGenerationResult,
} from "@nordri/contracts";
import { expect, test, vi } from "vitest";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function fixture(count = 1) {
  const seed = createSeed();
  const base = seed.savedJobs.find((job) => job.id === "job_ready")!;
  seed.savedJobs = Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `race_${index}`,
    canonicalUrl: `https://example.test/resume-race/${index}`,
    resumeApplicationMode: "tailored_per_job" as const,
    resumeTailoringMode: "balanced" as const,
    planAssessments: {},
  }));
  seed.tailoredAssets = [];
  seed.resumeDrafts = [];
  return seed;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function checkpoint(id: string): ResumeBatchCheckpoint {
  return {
    id,
    jobIds: ["race_0"],
    activeJobIds: ["race_0"],
    completedJobIds: [],
    done: false,
    stopRequested: false,
    running: true,
  };
}

test.each(["original", "aggressive"] as const)(
  "a queued job uses the current %s choice when a writer slot opens",
  async (choice) => {
    const seed = fixture(RESUME_AI_CONCURRENCY + 1);
    const queuedId = `race_${RESUME_AI_CONCURRENCY}`;
    const queuedUrl = seed.savedJobs[RESUME_AI_CONCURRENCY]!.canonicalUrl;
    const writerGate = deferred<void>();
    const aiClient = createAiClient();
    const createDraft = aiClient.createResumeDraft.bind(aiClient);
    const modelInputs: Parameters<typeof createDraft>[0][] = [];
    aiClient.createResumeDraft = async (input) => {
      modelInputs.push(input);
      await writerGate.promise;
      return createDraft(input);
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient,
    });
    const writers = seed.savedJobs.slice(0, RESUME_AI_CONCURRENCY).map((job) =>
      workspaceService.generateResumeForBatch(job.id, {
        shouldStop: () => false,
      }),
    );
    let queued: Promise<ResumeBatchGenerationResult> | undefined;
    try {
      await vi.waitFor(() =>
        expect(modelInputs).toHaveLength(RESUME_AI_CONCURRENCY),
      );
      queued = workspaceService.generateResumeForBatch(queuedId, {
        shouldStop: () => false,
      });
      // Drain the selected job's ordinary repository/listing work while all
      // fifty model slots stay parked; it cannot enter the writer yet.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(
        modelInputs.some((input) => input.job.canonicalUrl === queuedUrl),
      ).toBe(false);
      await workspaceService.setJobResumeApplicationMode(
        queuedId,
        choice === "original" ? "original_resume" : "tailored_per_job",
        choice === "original" ? "balanced" : "aggressive",
      );
      writerGate.resolve();
      const receipt = await queued;
      if (choice === "original") {
        expect(receipt).toEqual({ jobId: queuedId, outcome: "original" });
        expect(
          modelInputs.some((input) => input.job.canonicalUrl === queuedUrl),
        ).toBe(false);
        expect(await repository.getResumeDraftByJobId(queuedId)).toBeNull();
        expect(await repository.getTailoredAssetByJobId(queuedId)).toBeNull();
      } else {
        expect(["written", "fallback"]).toContain(receipt.outcome);
        const input = modelInputs.find(
          (entry) => entry.job.canonicalUrl === queuedUrl,
        );
        expect(input?.searchPreferences.tailoringMode).toBe("aggressive");
      }
    } finally {
      writerGate.resolve();
      await Promise.allSettled([...writers, ...(queued ? [queued] : [])]);
      await workspaceService.shutdown();
    }
  },
  30_000,
);

test("an Original choice returns an original receipt without generating or persisting a tailored draft", async () => {
  const seed = fixture();
  seed.savedJobs[0]!.resumeApplicationMode = "original_resume";
  const aiClient = createAiClient();
  const generate = vi.spyOn(aiClient, "createResumeDraft");
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  try {
    expect(
      await workspaceService.generateResumeForBatch("race_0", {
        shouldStop: () => false,
      }),
    ).toEqual({ jobId: "race_0", outcome: "original" });
    expect(generate).not.toHaveBeenCalled();
    expect(await repository.getResumeDraftByJobId("race_0")).toBeNull();
    expect(await repository.getTailoredAssetByJobId("race_0")).toBeNull();
  } finally {
    await workspaceService.shutdown();
  }
});

test("reset ignores old checkpoint callbacks while a newly started batch can persist", async () => {
  const seed = fixture();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const old = checkpoint("before_reset");
  try {
    await workspaceService.saveResumeBatchCheckpoint(old);
    await workspaceService.resetWorkspace(seed);
    const restored = await repository.getIntelligenceState();
    const write = vi.spyOn(repository, "saveIntelligenceState");
    await workspaceService.saveResumeBatchCheckpoint({
      ...old,
      running: false,
      activeJobIds: [],
      completedJobIds: ["race_0"],
      done: true,
    });
    expect(write).not.toHaveBeenCalled();
    const afterReset = await repository.getIntelligenceState();
    expect(afterReset).toEqual(restored);
    expect(afterReset.resumeBatchCheckpoint ?? null).toBeNull();
    expect(afterReset.resumeBatchCheckpoints ?? []).toEqual([]);
    await workspaceService.saveResumeBatchCheckpoint(checkpoint("after_reset"));
    const current = await workspaceService.getWorkspaceSnapshot();
    expect(current.intelligence.resumeBatchCheckpoint).toMatchObject({
      id: "after_reset",
      running: true,
    });
    expect(
      current.intelligence.resumeBatchCheckpoints?.map((entry) => entry.id),
    ).toEqual(["after_reset"]);
  } finally {
    await workspaceService.shutdown();
  }
});

test("restoring an exported live checkpoint leaves it stopped and rejects the old scheduler's liveness", async () => {
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed: fixture(),
  });
  const old = checkpoint("live_checkpoint_before_restore");
  try {
    await workspaceService.saveResumeBatchCheckpoint(old);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).intelligence
        .resumeBatchCheckpoint,
    ).toMatchObject({
      id: old.id,
      running: true,
    });
    const exported = await repository.exportState();
    await workspaceService.resetWorkspace(exported);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).intelligence
        .resumeBatchCheckpoint,
    ).toMatchObject({
      id: old.id,
      running: false,
      done: false,
      completedJobIds: [],
    });
    const restored = await repository.getIntelligenceState();
    await workspaceService.saveResumeBatchCheckpoint({
      ...old,
      completedJobIds: ["race_0"],
      activeJobIds: [],
      done: true,
    });
    expect(await repository.getIntelligenceState()).toEqual(restored);
    expect(
      (await workspaceService.getWorkspaceSnapshot()).intelligence
        .resumeBatchCheckpoint?.running,
    ).toBe(false);
    await workspaceService.saveResumeBatchCheckpoint({
      ...checkpoint("continued_after_restore"),
      resumedBatchIds: [old.id],
    });
    const continued = await workspaceService.getWorkspaceSnapshot();
    expect(continued.intelligence.resumeBatchCheckpoint).toMatchObject({
      id: "continued_after_restore",
      running: true,
      completedJobIds: [],
    });
    expect(
      continued.intelligence.resumeBatchCheckpoints?.map((entry) => entry.id),
    ).toEqual(["continued_after_restore"]);
  } finally {
    await workspaceService.shutdown();
  }
});

test("reset fences both an entered checkpoint read and the checkpoint queued behind its intelligence transition", async () => {
  const seed = fixture();
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const before = await repository.getIntelligenceState();
  const enteredRead = deferred<JobFinderIntelligenceState>();
  const read = vi
    .spyOn(repository, "getIntelligenceState")
    .mockImplementationOnce(() => enteredRead.promise);
  const first = workspaceService.saveResumeBatchCheckpoint(
    checkpoint("entered_before_reset"),
  );
  const firstSettled = Promise.allSettled([first]);
  let secondSettled: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const queued = workspaceService.saveResumeBatchCheckpoint(
      checkpoint("queued_before_reset"),
    );
    secondSettled = Promise.allSettled([queued]);
    await workspaceService.resetWorkspace(seed);
    const restored = await repository.getIntelligenceState();
    const write = vi.spyOn(repository, "saveIntelligenceState");
    enteredRead.resolve(before);
    expect((await firstSettled)[0]?.status).toBe("fulfilled");
    expect((await secondSettled)[0]?.status).toBe("fulfilled");
    expect(write).not.toHaveBeenCalled();
    const intelligence = await repository.getIntelligenceState();
    expect(intelligence).toEqual(restored);
    expect(intelligence.resumeBatchCheckpoint ?? null).toBeNull();
    expect(intelligence.resumeBatchCheckpoints ?? []).toEqual([]);
    await workspaceService.saveResumeBatchCheckpoint(
      checkpoint("fresh_after_reset"),
    );
    expect(
      (await workspaceService.getWorkspaceSnapshot()).intelligence
        .resumeBatchCheckpoint,
    ).toMatchObject({
      id: "fresh_after_reset",
      running: true,
    });
  } finally {
    enteredRead.resolve(before);
    await firstSettled;
    await secondSettled;
    read.mockRestore();
    await workspaceService.shutdown();
  }
}, 15_000);
