import { expect, test, vi } from "vitest";
import type {
  JudgeJobFitsInput,
  JobFitJudgmentResult,
} from "@nestor/ai-providers";
import { SavedJobSchema } from "@nestor/contracts";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function verdict(jobId: string, score: number) {
  return {
    jobId,
    score,
    recommendation: "strong_fit" as const,
    role: "exact" as const,
    roleExplanation: null,
    preferences: "aligned" as const,
    preferencesExplanation: null,
    locationReach: "in_area" as const,
    reasons: [],
    gaps: [],
    listingClosed: false,
    listingClosedEvidence: null,
  };
}

test("judges every job of the plan that has no verdict, without searching", async () => {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 45 }, (_, index) =>
    SavedJobSchema.parse({
      ...base,
      id: `backlog_${index}`,
      sourceJobId: `backlog_${index}`,
      canonicalUrl: `https://jobs.example.test/backlog/${index}`,
      title: `Product designer ${index}`,
      status: "discovered",
      matchAssessment: { ...base.matchAssessment, judgment: null },
      planAssessments: {},
    }),
  );
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(input.jobs.map(({ jobId }) => verdict(jobId, 66))),
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });

  const snapshot = await workspaceService.judgeUnjudgedJobs();
  const projection = await workspaceService.getWorkspaceProjection!();
  expect(projection.discoveryJobs).toEqual(snapshot.discoveryJobs);
  expect(projection.fitJudgmentProgress).toEqual(snapshot.fitJudgmentProgress);

  // Batches of twenty: 45 jobs take three calls.
  expect(judgeJobFits).toHaveBeenCalledTimes(3);
  const judged = snapshot.discoveryJobs.filter(
    (job) => job.matchAssessment.judgment?.score === 66,
  );
  expect(judged).toHaveLength(45);

  // Nothing is left to judge, so a second pass asks nothing.
  await workspaceService.judgeUnjudgedJobs();
  expect(judgeJobFits).toHaveBeenCalledTimes(3);
}, 30_000);

test("publishes saved scores while another model batch is still waiting", async () => {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 45 }, (_, index) =>
    SavedJobSchema.parse({
      ...base,
      id: `progress_${index}`,
      sourceJobId: `progress_${index}`,
      canonicalUrl: `https://jobs.example.test/progress/${index}`,
      status: "discovered",
      matchAssessment: { ...base.matchAssessment, judgment: null },
      planAssessments: {},
    }),
  );
  let release!: () => void;
  let calls = 0;
  const judgeJobFits = vi.fn(
    (input: JudgeJobFitsInput): Promise<JobFitJudgmentResult[]> => {
      calls += 1;
      const results = input.jobs.map(({ jobId }) => verdict(jobId, 66));
      return calls === 2
        ? new Promise((resolve) => {
            release = () => resolve(results);
          })
        : Promise.resolve(results);
    },
  );
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });
  const running = workspaceService.judgeUnjudgedJobs();
  await vi.waitFor(
    async () => {
      const snapshot = await workspaceService.getWorkspaceProjection!();
      expect(snapshot.fitJudgmentProgress?.judged).toBe(25);
      expect(snapshot.fitJudgmentProgress?.phase).toBe("judging");
      expect(
        snapshot.discoveryJobs.filter(
          (job) => job.matchAssessment.judgment?.score === 66,
        ),
      ).toHaveLength(25);
    },
    { timeout: 5_000 },
  );
  release();
  const complete = await running;
  expect(complete.fitJudgmentProgress).toMatchObject({
    phase: "completed",
    judged: 45,
    processed: 45,
    total: 45,
  });
}, 10_000);

test("saves a verdict when a pending job is shortlisted during model work", async () => {
  const seed = createSeed();
  const pending = SavedJobSchema.parse({
    ...seed.savedJobs[0]!,
    id: "pending_promoted_during_judgment",
    status: "discovered",
    matchAssessment: { score: 0, judgment: null },
    planAssessments: {},
  });
  seed.savedJobs = [];
  seed.discovery.pendingDiscoveryJobs = [pending];
  let finish!: () => void;
  const judgeJobFits = vi.fn(
    (input: JudgeJobFitsInput) =>
      new Promise<JobFitJudgmentResult[]>((resolve) => {
        finish = () =>
          resolve(input.jobs.map(({ jobId }) => verdict(jobId, 93)));
      }),
  );
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });
  const running = workspaceService.judgeUnjudgedJobs();
  await vi.waitFor(() => expect(judgeJobFits).toHaveBeenCalledOnce());
  await workspaceService.queueJobsForReview!([pending.id]);
  expect(
    (await repository.getDiscoveryState()).pendingDiscoveryJobs,
  ).toHaveLength(0);
  const commit = vi.spyOn(repository, "commitSavedJobDelta");
  finish();
  const complete = await running;
  expect(complete.fitJudgmentProgress?.judged).toBe(1);
  expect(
    complete.discoveryJobs.find((job) => job.id === pending.id)?.matchAssessment
      .judgment?.score,
  ).toBe(93);
  expect(
    commit.mock.calls.some(
      ([input]) =>
        input.updateJobIds?.includes(pending.id) && input.updateDiscoveryState,
    ),
  ).toBe(true);
  // The score is durable repository state, rather than a success-only display.
  const stored = (await repository.listSavedJobsByIds([pending.id]))[0]!;
  expect(
    [
      stored.matchAssessment,
      ...Object.values(stored.planAssessments ?? {}),
    ].some((assessment) => assessment.judgment?.score === 93),
  ).toBe(true);
});

test.each([false, true])(
  "does not apply an old card verdict after listing enrichment (full assessment: %s)",
  async (fullyAssessed) => {
    const seed = createSeed();
    const card = SavedJobSchema.parse({
      ...seed.savedJobs[0]!,
      id: "card_enriched_while_judging",
      status: "discovered",
      description: "Short listing card",
      matchAssessment: { score: 0, judgment: null },
      planAssessments: {},
    });
    seed.savedJobs = [card];
    let finish!: () => void;
    const judgeJobFits = vi.fn(
      (input: JudgeJobFitsInput) =>
        new Promise<JobFitJudgmentResult[]>((resolve) => {
          finish = () =>
            resolve(input.jobs.map(({ jobId }) => verdict(jobId, 20)));
        }),
    );
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: { ...createAiClient(), judgeJobFits },
    });
    const running = workspaceService.judgeUnjudgedJobs();
    await vi.waitFor(() => expect(judgeJobFits).toHaveBeenCalledOnce());
    await repository.commitSavedJobDelta({
      updateJobIds: [card.id],
      update: (job) => ({
        ...job,
        description:
          "Complete listing with requirements that the card did not contain.",
        matchAssessment: fullyAssessed
          ? {
              ...job.matchAssessment,
              score: 92,
              requirementsSource: "model",
              judgment: {
                ...verdict(job.id, 92),
                source: "full",
                judgedAt: "2026-10-13T16:00:00.000Z",
                contextFingerprint: "current-context",
                postingFingerprint: "full-posting",
              },
            }
          : job.matchAssessment,
      }),
    });
    finish();
    const result = await running;
    expect(result.fitJudgmentProgress?.judged).toBe(0);
    const saved = (await repository.listSavedJobsByIds([card.id]))[0]!;
    expect(saved.description).toContain("Complete listing");
    expect(saved.matchAssessment.score).toBe(fullyAssessed ? 92 : 0);
    expect(saved.matchAssessment.judgment?.source ?? null).toBe(
      fullyAssessed ? "full" : null,
    );
    if (fullyAssessed)
      expect(saved.matchAssessment.requirementsSource).toBe("model");
  },
);
