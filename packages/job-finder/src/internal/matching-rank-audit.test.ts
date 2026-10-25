import {
  JobPostingSchema,
  MatchAssessmentSchema,
  SavedJobSchema,
  type MatchAssessment,
  type SavedJob,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
import { createMatchAssessmentChangeAudit } from "./match-assessment-change-audit";
import { mergeDiscoveredPostings } from "./matching";

function createAssessment(
  base: MatchAssessment,
  score: number,
  fingerprint: string,
): MatchAssessment {
  return MatchAssessmentSchema.parse({
    ...base,
    scorerVersion: 4,
    contextFingerprint: "match_context_v4_candidate",
    postingFingerprint: fingerprint,
    score,
  });
}

function createSavedJob(
  id: string,
  score: number,
  overrides: Partial<SavedJob> = {},
): SavedJob {
  const base = createSeed().savedJobs[0]!;
  return SavedJobSchema.parse({
    ...base,
    id,
    sourceJobId: id,
    // These rows carry synthetic bound assessment fingerprints and represent
    // a completed listing-route discovery, not an offline catalog seed.
    discoveryMethod: "browser_agent",
    collectionMethod: "listing_route",
    canonicalUrl: `https://careers.example.test/jobs/${id}`,
    applicationUrl: `https://careers.example.test/jobs/${id}/apply`,
    title: `Software Engineer ${id}`,
    company: "Example",
    status: "discovered",
    matchAssessment: createAssessment(
      base.matchAssessment,
      score,
      `match_posting_v4_${id}`,
    ),
    ...overrides,
  });
}

function merge(
  savedJobs: readonly SavedJob[],
  postings: Parameters<typeof mergeDiscoveredPostings>[3],
  assessPosting: Parameters<typeof mergeDiscoveredPostings>[6],
) {
  const seed = createSeed();
  return mergeDiscoveredPostings(
    seed.profile,
    seed.searchPreferences,
    savedJobs,
    postings,
    (posting) => ({
      targetId: "target_rank_audit",
      adapterKind: "auto",
      resolvedAdapterKind: "target_site",
      startingUrl: posting.canonicalUrl,
      discoveredAt: posting.discoveredAt,
      collectionMethod: posting.collectionMethod,
      providerKey: posting.providerKey,
      providerBoardToken: posting.providerBoardToken,
      titleTriageOutcome: posting.titleTriageOutcome,
    }),
    undefined,
    assessPosting,
  );
}

describe("discovery match-assessment audit persistence", () => {
  it("records actual visible rank movement when a stronger result enters", () => {
    const first = createSavedJob("existing-first", 80);
    const second = createSavedJob("existing-second", 70);
    const discoveredAt = "2026-08-09T10:05:00.000Z";
    const incomingSaved = createSavedJob("new-best", 95);
    const incoming = JobPostingSchema.parse({
      ...incomingSaved,
      discoveredAt,
      lastSeenAt: discoveredAt,
    });

    const result = merge([first, second], [incoming], () =>
      createAssessment(
        incomingSaved.matchAssessment,
        95,
        "match_posting_v4_new_best",
      ),
    );

    expect(
      result.mergedJobs.find((job) => job.id === first.id)
        ?.latestMatchAssessmentAudit,
    ).toMatchObject({
      recordedAt: discoveredAt,
      previousRank: 1,
      currentRank: 2,
      rankingSignalChanged: true,
      outputChanges: [
        expect.objectContaining({ code: "rank_position_changed" }),
      ],
    });
    expect(
      result.mergedJobs.find((job) => job.id === second.id)
        ?.latestMatchAssessmentAudit,
    ).toMatchObject({ previousRank: 2, currentRank: 3 });
    expect(result.newJobs[0]?.latestMatchAssessmentAudit).toBeNull();
  });

  it("records no queue-rank-only audit for a search's re-read job, but still audits a changed assessment", () => {
    const first = createSavedJob("existing-first", 80);
    const stable = createSavedJob("existing-second", 70);
    const discoveredAt = "2026-08-09T10:05:00.000Z";
    const incomingSaved = createSavedJob("new-best", 95);
    const seed = createSeed();
    const provenance = (
      posting: Parameters<typeof mergeDiscoveredPostings>[3][number],
    ) => ({
      targetId: "target_rank_audit",
      adapterKind: "auto" as const,
      resolvedAdapterKind: "target_site" as const,
      startingUrl: posting.canonicalUrl,
      discoveredAt: posting.discoveredAt,
      collectionMethod: posting.collectionMethod,
      providerKey: posting.providerKey,
      providerBoardToken: posting.providerBoardToken,
      titleTriageOutcome: posting.titleTriageOutcome,
    });
    const reread = JobPostingSchema.parse({
      ...stable,
      lastSeenAt: discoveredAt,
    });
    const quiet = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [first, stable],
      [JobPostingSchema.parse({ ...incomingSaved, discoveredAt }), reread],
      provenance,
      undefined,
      (posting) =>
        posting.sourceJobId === "new-best"
          ? incomingSaved.matchAssessment
          : stable.matchAssessment,
      new Set([stable.id]),
      { recordRankOnlyAudits: false },
    );
    expect(
      quiet.mergedJobs.find((job) => job.id === stable.id)
        ?.latestMatchAssessmentAudit,
    ).toBeNull();

    const rescored = createAssessment(
      stable.matchAssessment,
      55,
      "match_posting_v4_existing_second_updated",
    );
    const changed = mergeDiscoveredPostings(
      seed.profile,
      seed.searchPreferences,
      [first, stable],
      [reread],
      provenance,
      undefined,
      () => rescored,
      new Set([stable.id]),
      { recordRankOnlyAudits: false },
    );
    expect(
      changed.mergedJobs
        .find((job) => job.id === stable.id)
        ?.latestMatchAssessmentAudit?.outputChanges.map(
          (change) => change.code,
        ),
    ).toContain("score_changed");
  });

  it("keeps the prior meaningful audit when a refresh changes nothing", () => {
    const current = createSavedJob("stable", 80);
    const priorAudit = createMatchAssessmentChangeAudit({
      previous: createAssessment(
        current.matchAssessment,
        72,
        "match_posting_v4_stable_before",
      ),
      current: current.matchAssessment,
      previousRank: 2,
      currentRank: 1,
      recordedAt: "2026-08-08T09:00:00.000Z",
    });
    const saved = SavedJobSchema.parse({
      ...current,
      latestMatchAssessmentAudit: priorAudit,
    });
    const refresh = JobPostingSchema.parse({
      ...saved,
      lastSeenAt: "2026-08-09T10:05:00.000Z",
    });

    const result = merge([saved], [refresh], () =>
      structuredClone(saved.matchAssessment),
    );

    expect(result.mergedJobs[0]?.latestMatchAssessmentAudit).toEqual(
      priorAudit,
    );
  });

  it("replaces the audit after a meaningful reassessment and preserves the per-job resume choice", () => {
    const current = createSavedJob("rescored", 80, {
      resumeApplicationMode: "original_resume",
    });
    const refresh = JobPostingSchema.parse({
      ...current,
      lastSeenAt: "2026-08-09T11:00:00.000Z",
    });
    const nextAssessment = createAssessment(
      current.matchAssessment,
      63,
      "match_posting_v4_rescored_updated",
    );

    const result = merge([current], [refresh], () => nextAssessment);
    const merged = result.mergedJobs[0];

    expect(merged?.resumeApplicationMode).toBe("original_resume");
    expect(merged?.latestMatchAssessmentAudit).toMatchObject({
      status: "assessment_changed",
      previousRank: 1,
      currentRank: 1,
    });
    expect(
      merged?.latestMatchAssessmentAudit?.outputChanges.map(
        (change) => change.code,
      ),
    ).toContain("score_changed");
  });
});
