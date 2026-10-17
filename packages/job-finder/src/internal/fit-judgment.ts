import {
  JOB_FIT_JUDGING_BATCH_SIZE,
  type JobFinderAiClient,
  type JobFitJudgmentResult,
} from "@nordri/ai-providers";
import type {
  CandidateProfile,
  FitJudgment,
  JobPosting,
  JobSearchPreferences,
  MatchAssessment,
} from "@nordri/contracts";

import { createMatchAssessmentPostingInput } from "./match-assessment-posting-input";
import { createMatchAssessmentPostingFingerprint } from "./match-assessment-session";

export { applyFitJudgment, readCarriedJudgment } from "./fit-judgment-apply";

/**
 * Batch fit judging: the model judges many jobs per call against the
 * person's profile and goals (ADR 0041). See fit-judgment-apply for how a
 * verdict replaces the rule scorer's.
 */

export function toFitJudgment(
  result: Omit<JobFitJudgmentResult, "jobId">,
  input: {
    source: FitJudgment["source"];
    judgedAt: string;
    contextFingerprint: string | null;
    postingFingerprint: string | null;
  },
): FitJudgment {
  return {
    source: input.source,
    judgedAt: input.judgedAt,
    contextFingerprint: input.contextFingerprint,
    postingFingerprint: input.postingFingerprint,
    score: result.score,
    recommendation: result.recommendation,
    role: result.role,
    roleExplanation: result.roleExplanation,
    preferences: result.preferences,
    preferencesExplanation: result.preferencesExplanation,
    locationReach: result.locationReach,
    reasons: result.reasons.slice(0, 4),
    gaps: result.gaps.slice(0, 4),
    summary: result.summary ?? null,
    listingClosed: result.listingClosed,
    listingClosedEvidence: result.listingClosedEvidence,
  };
}

/**
 * Whether the model should judge this job (again): never judged, or judged
 * before the profile, the goals or the listing changed.
 */
export function jobNeedsFitJudgment(
  job: JobPosting & { matchAssessment: MatchAssessment },
  contextFingerprint: string,
): boolean {
  const judgment = job.matchAssessment.judgment;
  if (!judgment) {
    return true;
  }
  return (
    judgment.contextFingerprint !== contextFingerprint ||
    judgment.postingFingerprint !== fitPostingFingerprint(job)
  );
}

/**
 * How worth a model call a job is when not every unjudged job will get one.
 * An out-of-date verdict's score is the best guess there is; a job never
 * judged sits in the middle; one the model already called a skip or an
 * unrelated role goes last, so a capped or stopped pass spends its calls on
 * the likeliest fits.
 */
function fitJudgingPromise(job: { matchAssessment: MatchAssessment }): number {
  const assessment = job.matchAssessment;
  if (
    assessment.recommendation === "skip" ||
    assessment.titleFamilyMatch === "unrelated"
  ) {
    return 0;
  }
  return assessment.judgment ? 1 + assessment.score / 100 : 1.5;
}

/** Most promising first, then the newest find. */
export function compareFitJudgingPromise(
  left: { matchAssessment: MatchAssessment; discoveredAt?: string | null },
  right: { matchAssessment: MatchAssessment; discoveredAt?: string | null },
): number {
  return (
    fitJudgingPromise(right) - fitJudgingPromise(left) ||
    (right.discoveredAt ?? "").localeCompare(left.discoveredAt ?? "")
  );
}

/** What a verdict was given on: it changes when the listing does. */
export function fitPostingFingerprint(job: JobPosting): string {
  return createMatchAssessmentPostingFingerprint(
    createMatchAssessmentPostingInput(job),
  );
}

/** Batches sent to the model at once; the work happens on its servers. */
const JUDGING_CONCURRENCY = 5;
/** One pause before asking a failed batch again (an overloaded provider). */
const JUDGING_RETRY_DELAY_MS = 3_000;

/**
 * Asks the model to judge jobs, a batch per call, several batches at once.
 * A batch that fails is asked once more after a short pause. Returns the
 * verdicts it gave; a job missing from the result stays as it was and is
 * asked about on the next pass. A failed batch does not stop the others.
 */
export async function judgeJobFitsInBatches<
  TJob extends JobPosting & { id: string },
>(input: {
  aiClient: Pick<JobFinderAiClient, "judgeJobFits">;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  jobs: readonly TJob[];
  contextFingerprint: string;
  now?: () => string;
  signal?: AbortSignal;
  batchSize?: number;
  concurrency?: number;
  retryDelayMs?: number;
  onProgress?: (completed: number, total: number) => void;
  onBatchJudged?: (
    judgments: ReadonlyMap<string, FitJudgment>,
  ) => Promise<void>;
}): Promise<Map<string, FitJudgment>> {
  const judgments = new Map<string, FitJudgment>();
  const judgeJobFits = input.aiClient.judgeJobFits?.bind(input.aiClient);
  if (!judgeJobFits || input.jobs.length === 0) {
    return judgments;
  }
  const now = input.now ?? (() => new Date().toISOString());
  const batchSize = Math.max(1, input.batchSize ?? JOB_FIT_JUDGING_BATCH_SIZE);
  const retryDelayMs = input.retryDelayMs ?? JUDGING_RETRY_DELAY_MS;
  const batches: TJob[][] = [];
  for (let start = 0; start < input.jobs.length; start += batchSize) {
    batches.push(input.jobs.slice(start, start + batchSize));
  }

  const judgeBatch = async (batch: readonly TJob[]): Promise<void> => {
    const ask = () =>
      judgeJobFits({
        ...(input.signal ? { signal: input.signal } : {}),
        assessmentDate: now().slice(0, 10),
        profile: input.profile,
        searchPreferences: input.searchPreferences,
        jobs: batch.map((job) => ({ jobId: job.id, posting: job })),
      });
    let results: JobFitJudgmentResult[];
    try {
      results = await ask();
    } catch (error) {
      if (input.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      input.signal?.throwIfAborted();
      try {
        results = await ask();
      } catch (retryError) {
        if (input.signal?.aborted) throw retryError;
        return;
      }
    }
    const byId = new Map(batch.map((job) => [job.id, job]));
    const judgedAt = now();
    for (const result of results) {
      const job = byId.get(result.jobId);
      if (!job) continue;
      judgments.set(
        job.id,
        toFitJudgment(result, {
          source: "batch",
          judgedAt,
          contextFingerprint: input.contextFingerprint,
          postingFingerprint: createMatchAssessmentPostingFingerprint(
            createMatchAssessmentPostingInput(job),
          ),
        }),
      );
    }
    await input.onBatchJudged?.(
      new Map(
        batch.flatMap((job) => {
          const judgment = judgments.get(job.id);
          return judgment ? [[job.id, judgment] as const] : [];
        }),
      ),
    );
  };

  let completed = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      input.signal?.throwIfAborted();
      const batch = batches[next];
      next += 1;
      if (batch) {
        await judgeBatch(batch);
        completed += batch.length;
        input.onProgress?.(completed, input.jobs.length);
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          Math.max(1, input.concurrency ?? JUDGING_CONCURRENCY),
          batches.length,
        ),
      },
      () => worker(),
    ),
  );
  return judgments;
}
