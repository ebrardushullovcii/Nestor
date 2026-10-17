import type {
  FitJudgment,
  FitJudgmentProgress,
  SavedJob,
} from "@nestor/contracts";

import { searchPreferencesForCampaignRun } from "./campaign-dashboard";
import {
  compareFitJudgingPromise,
  jobNeedsFitJudgment,
  judgeJobFitsInBatches,
} from "./fit-judgment";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import {
  createMatchAssessmentPostingFingerprint,
  createMatchAssessmentSession,
} from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import {
  personPickedJob,
  readPlanAssessment,
  withPlanAssessment,
} from "./plan-assessment";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/** Jobs sent per round: three model calls of twenty, saved as each finishes. */
const JOBS_PER_ROUND = 60;

/**
 * Judges every job of the active plan that has no current verdict, the same
 * way a search judges what it finds (ADR 0041), without searching any site.
 * A search judges the jobs it keeps, so jobs saved by a search that was
 * stopped, or before fit was judged during a search, stayed "Not judged yet".
 * Verdicts are saved after each batch, so stopping keeps what was judged.
 */
export async function judgeUnjudgedPlanJobs(input: {
  ctx: Pick<
    WorkspaceServiceContext,
    "repository" | "aiClient" | "getActiveCampaignId" | "persistDiscoveryState"
  >;
  signal?: AbortSignal;
  onRoundSaved?: (progress: { judged: number; total: number }) => void;
  onProgress?: (
    progress: Pick<
      FitJudgmentProgress,
      "planId" | "phase" | "judged" | "processed" | "total"
    >,
  ) => void;
}): Promise<{ judged: number; total: number }> {
  const { ctx } = input;
  if (!ctx.aiClient.judgeJobFits)
    throw new Error("Fit judging is unavailable right now.");
  const [
    profile,
    searchPreferences,
    settings,
    campaignState,
    savedJobs,
    discovery,
  ] = await Promise.all([
    ctx.repository.getProfile(),
    ctx.repository.getSearchPreferences(),
    ctx.repository.getSettings(),
    ctx.repository.getCampaignState(),
    ctx.repository.readSavedJobsProjection(),
    ctx.repository.readDiscoveryDisplayProjection(),
  ]);
  const planId = await ctx.getActiveCampaignId();
  const plan = campaignState?.campaigns.find((entry) => entry.id === planId);
  const preferences = withSavedJobSearchBehavior(
    enrichSearchPreferencesFromProfile(
      plan ? searchPreferencesForCampaignRun(plan) : searchPreferences,
      profile,
    ),
    settings,
  );
  const session = createMatchAssessmentSession({
    profile,
    searchPreferences: preferences,
    calculate: createMatchAssessment,
  });
  const planJobIds = new Set(plan?.jobIds ?? []);
  const belongsToPlan = (job: SavedJob) =>
    !planId ||
    planJobIds.has(job.id) ||
    job.campaignIds?.includes(planId) === true;
  const toJudge = [...savedJobs, ...discovery.pendingDiscoveryJobs]
    .filter(belongsToPlan)
    .map((job) => readPlanAssessment(job, planId))
    .filter(
      (job) =>
        job.matchAssessment.judgment?.source !== "full" &&
        jobNeedsFitJudgment(job, session.contextFingerprint),
    )
    // The person's own picks first, then the likeliest fits, so stopping
    // part way leaves the calls spent where they mattered most.
    .sort(
      (left, right) =>
        Number(personPickedJob(right)) - Number(personPickedJob(left)) ||
        compareFitJudgingPromise(left, right),
    );
  const jobsAtRequest = new Map(toJudge.map((job) => [job.id, job]));

  let judged = 0;
  let processed = 0;
  let saveTail = Promise.resolve();
  const report = (phase: FitJudgmentProgress["phase"]) =>
    input.onProgress?.({
      planId,
      phase,
      judged,
      processed,
      total: toJudge.length,
    });
  report("judging");
  for (let start = 0; start < toJudge.length; start += JOBS_PER_ROUND) {
    input.signal?.throwIfAborted();
    const round = toJudge.slice(start, start + JOBS_PER_ROUND);
    await judgeJobFitsInBatches({
      aiClient: ctx.aiClient,
      profile,
      searchPreferences: preferences,
      jobs: round,
      contextFingerprint: session.contextFingerprint,
      ...(input.signal ? { signal: input.signal } : {}),
      concurrency: 3,
      onProgress: (completed) => {
        processed = start + completed;
        report("judging");
      },
      onBatchJudged: (judgments) => {
        const save = saveTail.then(async () => {
          input.signal?.throwIfAborted();
          if (judgments.size === 0) return;
          report("saving");
          const appliedIds = new Set<string>();
          const applyVerdict = <T extends SavedJob>(job: T): T => {
            const judgment: FitJudgment | undefined = judgments.get(job.id);
            if (!judgment) return job;
            const current = readPlanAssessment(job, planId);
            const previous = jobsAtRequest.get(job.id);
            // A full read or changed posting can finish while this old card
            // verdict is in flight. Keep the newer evidence and verdict.
            if (
              current.matchAssessment.judgment?.source === "full" ||
              createMatchAssessmentPostingFingerprint(current) !==
                judgment.postingFingerprint ||
              (current.matchAssessment.contextFingerprint !==
                previous?.matchAssessment.contextFingerprint &&
                current.matchAssessment.contextFingerprint !==
                  session.contextFingerprint)
            )
              return job;
            appliedIds.add(job.id);
            return withPlanAssessment(
              job,
              planId,
              session.assess(readPlanAssessment(job, planId), judgment),
            );
          };
          // A pending job can be shortlisted while the model is judging it.
          // Resolve both storage locations in the same transaction using the
          // current rows, rather than the membership captured before the call.
          await ctx.repository.commitSavedJobDelta({
            updateJobIds: [...judgments.keys()],
            update: applyVerdict,
            updateDiscoveryState: (current) => ({
              ...current,
              pendingDiscoveryJobs:
                current.pendingDiscoveryJobs.map(applyVerdict),
            }),
          });
          judged += appliedIds.size;
          input.onRoundSaved?.({ judged, total: toJudge.length });
          report("judging");
        });
        saveTail = save;
        return save;
      },
    });
  }
  report("completed");
  return { judged, total: toJudge.length };
}
