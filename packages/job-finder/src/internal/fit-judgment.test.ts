import { describe, expect, test, vi } from "vitest";
import type { JudgeJobFitsInput } from "@nordri/ai-providers";

import { createSeed } from "../workspace-service.test-fixtures";
import {
  compareFitJudgingPromise,
  judgeJobFitsInBatches,
} from "./fit-judgment";

function jobs(count: number) {
  const base = createSeed().savedJobs[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `job_${index}`,
    sourceJobId: `source_${index}`,
  }));
}

function verdictFor(jobId: string) {
  return {
    jobId,
    score: 70,
    recommendation: "review_before_applying" as const,
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

describe("judgeJobFitsInBatches", () => {
  test("sends several batches at once instead of one after another", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const judgeJobFits = vi.fn(async (input: JudgeJobFitsInput) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return input.jobs.map(({ jobId }) => verdictFor(jobId));
    });
    const seed = createSeed();

    const judgments = await judgeJobFitsInBatches({
      aiClient: { judgeJobFits },
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      jobs: jobs(100),
      contextFingerprint: "ctx",
      batchSize: 20,
    });

    expect(judgeJobFits).toHaveBeenCalledTimes(5);
    expect(mostInFlight).toBe(5);
    expect(judgments.size).toBe(100);
  });

  test("asks a failed batch once more and keeps the others' verdicts", async () => {
    let calls = 0;
    const judgeJobFits = vi.fn((input: JudgeJobFitsInput) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new Error("The backend is temporarily overloaded."),
        );
      }
      return Promise.resolve(input.jobs.map(({ jobId }) => verdictFor(jobId)));
    });
    const seed = createSeed();

    const judgments = await judgeJobFitsInBatches({
      aiClient: { judgeJobFits },
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      jobs: jobs(3),
      contextFingerprint: "ctx",
      retryDelayMs: 1,
    });

    expect(judgeJobFits).toHaveBeenCalledTimes(2);
    expect(judgments.size).toBe(3);
  });

  test("leaves a batch unjudged when the retry fails too", async () => {
    const judgeJobFits = vi.fn(() =>
      Promise.reject(new Error("The backend is temporarily overloaded.")),
    );
    const seed = createSeed();

    const judgments = await judgeJobFitsInBatches({
      aiClient: { judgeJobFits },
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      jobs: jobs(3),
      contextFingerprint: "ctx",
      retryDelayMs: 1,
    });

    expect(judgeJobFits).toHaveBeenCalledTimes(2);
    expect(judgments.size).toBe(0);
  });
});

test("reports settled fit checks while other batches still wait", async () => {
  const seed = createSeed();
  const progress: number[] = [];
  await judgeJobFitsInBatches({
    aiClient: {
      judgeJobFits: (input) =>
        Promise.resolve(input.jobs.map(({ jobId }) => verdictFor(jobId))),
    },
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    jobs: jobs(42),
    contextFingerprint: "ctx",
    concurrency: 1,
    onProgress: (completed, total) => {
      expect(total).toBe(42);
      progress.push(completed);
    },
  });
  expect(progress).toEqual([20, 40, 42]);
});

describe("which unjudged jobs are asked about first", () => {
  test("likeliest fits first, never judged in the middle, skips and unrelated roles last", () => {
    const base = jobs(1)[0]!;
    const judgment = {
      source: "batch" as const,
      judgedAt: "2026-10-01T00:00:00.000Z",
      contextFingerprint: "old",
      postingFingerprint: "old",
      score: 50,
      recommendation: "review_before_applying" as const,
      role: "unknown" as const,
      roleExplanation: null,
      preferences: "unknown" as const,
      preferencesExplanation: null,
      locationReach: "unknown" as const,
      reasons: [],
      gaps: [],
      listingClosed: false,
      listingClosedEvidence: null,
    };
    const job = (
      id: string,
      assessment: Partial<typeof base.matchAssessment>,
      discoveredAt = "2026-10-01T00:00:00.000Z",
    ) => ({
      ...base,
      id,
      discoveredAt,
      matchAssessment: { ...base.matchAssessment, ...assessment },
    });
    const ordered = [
      job("skip", { recommendation: "skip", score: 90, judgment }),
      job("unrelated", { titleFamilyMatch: "unrelated", score: 85, judgment }),
      job("weak", { score: 20, judgment }),
      job("never", { judgment: null }),
      job("newer-never", { judgment: null }, "2026-10-10T00:00:00.000Z"),
      job("strong", { score: 90, judgment }),
    ].sort(compareFitJudgingPromise);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "strong",
      "newer-never",
      "never",
      "weak",
      "skip",
      "unrelated",
    ]);
  });
});
