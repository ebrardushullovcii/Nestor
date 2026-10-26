import { expect, test } from "vitest";
import {
  SavedJobSchema,
  type CandidateProfile,
  type FitJudgment,
  type JobSearchPreferences,
  type SavedJob,
} from "@nestor/contracts";

import { createSeed } from "../workspace-service.test-support";
import { fitPostingFingerprint, jobNeedsFitJudgment } from "./fit-judgment";
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
  return enrichSearchPreferencesFromProfile(seed.searchPreferences, profile);
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
  const relevant = {
    ...seed.profile,
    skills: [...seed.profile.skills, "Rust"],
  };
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
    /^fit_verdict_v1_logic16_/u,
  );
});

test.each([15, 16])(
  "rubric revision %s stays current automatically and can be selected for a search refresh",
  (revision) => {
    const seed = createSeed();
    const goals = judgingGoals(seed, seed.profile);
    const stored = legacyJudgedJob(
      seed,
      seed.savedJobs[0]!,
      "older_rubric",
      goals,
    );
    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: goals,
      calculate: createMatchAssessment,
    });
    const judgment = stored.matchAssessment.judgment!;
    stored.matchAssessment.judgment = {
      ...judgment,
      contextFingerprint: session.verdictFingerprint.replace(
        "_logic16_",
        `_logic${revision}_`,
      ),
      postingFingerprint: judgment.postingFingerprint!.replace(
        "_logic16_",
        `_logic${revision}_`,
      ),
    };
    stored.matchAssessment.scorerVersion = 17;
    expect(
      jobNeedsFitJudgment(
        stored,
        session.verdictFingerprint,
        session.contextFingerprint,
      ),
    ).toBe(false);
    expect(
      jobNeedsFitJudgment(
        stored,
        session.verdictFingerprint,
        session.contextFingerprint,
        { refreshRubric: true },
      ),
    ).toBe(true);
    expect(
      jobNeedsFitJudgment(
        { ...stored, description: "Changed listing" },
        session.verdictFingerprint,
        session.contextFingerprint,
      ),
    ).toBe(true);
    const changedProfile = {
      ...seed.profile,
      skills: [...seed.profile.skills, "Rust"],
    };
    expect(
      jobNeedsFitJudgment(
        stored,
        createFitVerdictFingerprint(changedProfile, goals),
        createMatchAssessmentContextFingerprint(changedProfile, goals),
      ),
    ).toBe(true);
    const changedGoals = { ...goals, targetRoles: ["Different work"] };
    expect(
      jobNeedsFitJudgment(
        stored,
        createFitVerdictFingerprint(seed.profile, changedGoals),
        createMatchAssessmentContextFingerprint(seed.profile, changedGoals),
      ),
    ).toBe(true);
    expect(
      session.assessPersisted(stored, stored.matchAssessment).judgment,
    ).toEqual(stored.matchAssessment.judgment);
  },
);
