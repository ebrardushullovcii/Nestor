import { describe, expect, test } from "vitest";

import { buildDiscoveryJobs, } from "./matching";
import { createSeed } from "../workspace-service.test-fixtures";

describe("matching helpers", () => {
  test("orders equal-score discovery jobs by detail quality and recency", () => {
    const seed = createSeed();
    const base = seed.savedJobs[0]!;
    const jobs = buildDiscoveryJobs([
      {
        ...base,
        id: "older_enriched",
        sourceJobId: "older_enriched",
        detailQuality: "detail_enriched",
        postedAt: "2026-01-01T00:00:00.000Z",
        matchAssessment: {
          ...base.matchAssessment,
          score: 80,
          recommendation: "strong_fit",
        },
      },
      {
        ...base,
        id: "newer_enriched",
        sourceJobId: "newer_enriched",
        detailQuality: "detail_enriched",
        postedAt: "2026-02-01T00:00:00.000Z",
        matchAssessment: {
          ...base.matchAssessment,
          score: 80,
          recommendation: "strong_fit",
        },
      },
      {
        ...base,
        id: "newer_card",
        sourceJobId: "newer_card",
        detailQuality: "card_only",
        postedAt: "2026-03-01T00:00:00.000Z",
        matchAssessment: {
          ...base.matchAssessment,
          score: 80,
          recommendation: "strong_fit",
        },
      },
      {
        ...base,
        id: "review_first",
        sourceJobId: "review_first",
        detailQuality: "detail_enriched",
        postedAt: "2026-04-01T00:00:00.000Z",
        matchAssessment: {
          ...base.matchAssessment,
          score: 80,
          recommendation: "review_before_applying",
        },
      },
    ]);

    expect(jobs.map((job) => job.id)).toEqual([
      "review_first",
      "newer_card",
      "newer_enriched",
      "older_enriched",
    ]);
  });

  test("orders a lower-scoring strong fit ahead of a higher-scoring skip", () => {
    const seed = createSeed();
    const base = seed.savedJobs[0]!;
    const jobs = buildDiscoveryJobs([
      {
        ...base,
        id: "hard_skip_94",
        sourceJobId: "hard_skip_94",
        matchAssessment: {
          ...base.matchAssessment,
          score: 94,
          recommendation: "skip",
        },
      },
      {
        ...base,
        id: "strong_fit_86",
        sourceJobId: "strong_fit_86",
        matchAssessment: {
          ...base.matchAssessment,
          score: 86,
          recommendation: "strong_fit",
        },
      },
    ]);

    expect(jobs.map((job) => job.id)).toEqual([
      "strong_fit_86",
      "hard_skip_94",
    ]);
  });
});
