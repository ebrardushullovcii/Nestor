import { expect, test, vi } from "vitest";
import type { JudgeJobFitsInput } from "@nestor/ai-providers";
import {
  SavedJobSchema,
  type CandidateProfile,
  type FitJudgment,
  type JobSearchPreferences,
  type SavedJob,
} from "@nestor/contracts";

import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import { fitPostingFingerprint, jobNeedsFitJudgment } from "./fit-judgment";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import {
  buildLegacyVerdictFingerprintMap,
  rebindJobLegacyVerdicts,
} from "./legacy-fit-fingerprints";
import {
  createFitVerdictFingerprint,
  createMatchAssessmentContextFingerprint,
  createMatchAssessmentSession,
} from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";

type Seed = ReturnType<typeof createSeed>;

/** The goals a search and the backlog judge give the model. */
function judgingGoals(seed: Seed, profile: CandidateProfile) {
  return withSavedJobSearchBehavior(
    enrichSearchPreferencesFromProfile(seed.searchPreferences, profile),
    seed.settings,
  );
}

/** A verdict as an earlier build stored it: stamped with the whole-input fingerprint. */
function legacyJudgedJob(
  seed: Seed,
  base: SavedJob,
  id: string,
  goals: JobSearchPreferences,
): SavedJob {
  const job = SavedJobSchema.parse({
    ...base,
    id,
    sourceJobId: id,
    canonicalUrl: `https://jobs.example.test/legacy/${id}`,
    status: "discovered",
    planAssessments: {},
  });
  const judgment: FitJudgment = {
    source: "batch",
    judgedAt: "2026-10-20T10:00:00.000Z",
    contextFingerprint: createMatchAssessmentContextFingerprint(
      seed.profile,
      goals,
    ),
    postingFingerprint: fitPostingFingerprint(job),
    score: 77,
    recommendation: "strong_fit",
    role: "exact",
    roleExplanation: null,
    preferences: "aligned",
    preferencesExplanation: null,
    locationReach: "in_area",
    reasons: ["Synthetic stored reason"],
    gaps: [],
    summary: null,
    listingClosed: false,
    listingClosedEvidence: null,
  };
  return { ...job, matchAssessment: { ...job.matchAssessment, judgment } };
}

/** Edits no fit verdict reads: contact details and a saved answer. */
function unrelatedEdit(profile: CandidateProfile): CandidateProfile {
  return {
    ...profile,
    phone: "+44 7700 900999",
    email: "changed@example.test",
    answerBank: {
      ...profile.answerBank,
      customAnswers: [
        ...profile.answerBank.customAnswers,
        {
          id: "answer_new",
          kind: "other",
          label: "Why us",
          question: "Why do you want to work here?",
          answer: "A synthetic saved answer.",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ],
    },
  };
}

test("a stored verdict stays current through the fingerprint change and a later unrelated edit", () => {
  const seed = createSeed();
  const goals = judgingGoals(seed, seed.profile);
  const stored = legacyJudgedJob(seed, seed.savedJobs[0]!, "legacy_1", goals);
  const session = createMatchAssessmentSession({
    profile: seed.profile,
    searchPreferences: goals,
    calculate: createMatchAssessment,
  });

  // The upgrade alone: the old stamp of the current inputs counts as current.
  expect(stored.matchAssessment.judgment?.contextFingerprint).toBe(
    session.contextFingerprint,
  );
  expect(
    jobNeedsFitJudgment(
      stored,
      session.verdictFingerprint,
      session.contextFingerprint,
    ),
  ).toBe(false);
  const reassessed = session.assessPersisted(stored, stored.matchAssessment);
  expect(reassessed.judgment).toMatchObject({
    score: 77,
    contextFingerprint: session.verdictFingerprint,
  });

  // Re-stamped once, it survives a phone, email and saved-answer edit.
  const map = buildLegacyVerdictFingerprintMap({
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    settings: seed.settings,
    campaignState: null,
  });
  const migrated = rebindJobLegacyVerdicts(stored, map);
  expect(migrated.matchAssessment.judgment).toMatchObject({
    score: 77,
    judgedAt: "2026-10-20T10:00:00.000Z",
    contextFingerprint: session.verdictFingerprint,
  });
  expect(rebindJobLegacyVerdicts(migrated, map)).toBe(migrated);
  const edited = unrelatedEdit(seed.profile);
  const editedGoals = judgingGoals(seed, edited);
  const afterEdit = createMatchAssessmentSession({
    profile: edited,
    searchPreferences: editedGoals,
    calculate: createMatchAssessment,
  });
  expect(afterEdit.verdictFingerprint).toBe(session.verdictFingerprint);
  expect(
    jobNeedsFitJudgment(
      migrated,
      afterEdit.verdictFingerprint,
      afterEdit.contextFingerprint,
    ),
  ).toBe(false);
  // Without the re-stamp the same edit would have stranded the verdict.
  expect(
    jobNeedsFitJudgment(
      stored,
      afterEdit.verdictFingerprint,
      afterEdit.contextFingerprint,
    ),
  ).toBe(true);

  // A change the model does read still asks again.
  const relevant = { ...seed.profile, skills: [...seed.profile.skills, "Rust"] };
  const afterRelevantEdit = createMatchAssessmentSession({
    profile: relevant,
    searchPreferences: judgingGoals(seed, relevant),
    calculate: createMatchAssessment,
  });
  expect(
    jobNeedsFitJudgment(
      migrated,
      afterRelevantEdit.verdictFingerprint,
      afterRelevantEdit.contextFingerprint,
    ),
  ).toBe(true);
  expect(createFitVerdictFingerprint(seed.profile, goals)).toMatch(
    /^fit_verdict_v1_logic15_/u,
  );
});

test("opening the workspace re-stamps stored verdicts, so Judge all asks nothing after an unrelated edit", async () => {
  const seed = createSeed();
  const goals = judgingGoals(seed, seed.profile);
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 30 }, (_, index) =>
    legacyJudgedJob(seed, base, `legacy_${index}`, goals),
  );
  const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
    Promise.resolve(
      input.jobs.map(({ jobId }) => ({
        jobId,
        score: 10,
        recommendation: "skip" as const,
        role: "conflict" as const,
        roleExplanation: null,
        preferences: "conflict" as const,
        preferencesExplanation: null,
        locationReach: "unknown" as const,
        reasons: [],
        gaps: [],
        listingClosed: false,
        listingClosedEvidence: null,
      })),
    ),
  );
  const { workspaceService, repository } = createWorkspaceServiceHarness({
    seed,
    aiClient: { ...createAiClient(), judgeJobFits },
  });
  const verdictFingerprint = createFitVerdictFingerprint(seed.profile, goals);

  await workspaceService.getWorkspaceSnapshot();
  await vi.waitFor(async () => {
    const saved = await repository.readSavedJobsProjection();
    expect(
      saved.map((job) => job.matchAssessment.judgment?.contextFingerprint),
    ).toEqual(Array.from({ length: 30 }, () => verdictFingerprint));
  });

  await workspaceService.saveProfile(unrelatedEdit(seed.profile));
  const snapshot = await workspaceService.judgeUnjudgedJobs();

  expect(judgeJobFits).not.toHaveBeenCalled();
  expect(
    snapshot.discoveryJobs
      .filter((job) => job.id.startsWith("legacy_"))
      .map((job) => job.matchAssessment.judgment?.score),
  ).toEqual(Array.from({ length: 30 }, () => 77));
}, 30_000);
