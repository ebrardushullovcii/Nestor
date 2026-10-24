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
  createAgentBrowserRuntime,
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
import { readPlanAssessment } from "./plan-assessment";
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

test("opening the workspace re-stamps stored verdicts, so Judge all asks nothing after an unrelated edit", async () => {
  const seed = createSeed();
  const goals = judgingGoals(seed, seed.profile);
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: 30 }, (_, index) => {
    const job = legacyJudgedJob(seed, base, `legacy_${index}`, goals);
    job.matchAssessment.scorerVersion = 16;
    job.matchAssessment.judgment!.contextFingerprint =
      job.matchAssessment.judgment!.contextFingerprint!.replace(
        "_logic16_",
        "_logic15_",
      );
    job.matchAssessment.judgment!.postingFingerprint =
      job.matchAssessment.judgment!.postingFingerprint!.replace(
        "_logic16_",
        "_logic15_",
      );
    return job;
  });
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

test.each(["rubric", "missing verdict", "profile", "posting"] as const)(
  "a full assessment refresh after a %s change preserves only still-current evidence",
  async (change) => {
    const seed = createSeed();
    const goals = judgingGoals(seed, seed.profile);
    const job = legacyJudgedJob(seed, seed.savedJobs[0]!, "full_rubric", goals);
    job.matchAssessment.scorerVersion = 17;
    job.matchAssessment.judgment!.source = "full";
    job.matchAssessment.requirements = [
      {
        id: "design-evidence",
        label: "Design systems",
        status: "supported",
        category: "skill",
        importance: "required",
        jobEvidence: "Own the design system",
        resumeEvidence: [],
        explanation: "Previously checked against unchanged synthetic evidence",
      },
    ];
    if (change === "profile")
      job.matchAssessment.judgment!.contextFingerprint = "changed-profile";
    if (change === "posting")
      job.matchAssessment.judgment!.postingFingerprint = "changed-posting";
    const evidence = structuredClone(job.matchAssessment.requirements);
    seed.savedJobs = [job];
    const client = createAiClient();
    const assessJobFit = vi.fn(client.assessJobFit.bind(client));
    const judgeJobFits = vi.fn((input: JudgeJobFitsInput) =>
      Promise.resolve(
        (change === "missing verdict" ? [] : input.jobs).map(({ jobId }) => ({
          jobId,
          score: 70,
          recommendation: "apply_with_original" as const,
          role: "exact" as const,
          roleExplanation: "Synthetic role match",
          preferences: "aligned" as const,
          preferencesExplanation: null,
          locationReach: "in_area" as const,
          reasons: ["Synthetic refreshed verdict"],
          gaps: [],
          listingClosed: false,
          listingClosedEvidence: null,
        })),
      ),
    );
    const { workspaceService, repository } = createWorkspaceServiceHarness({
      seed,
      aiClient: { ...client, assessJobFit, judgeJobFits },
      browserRuntime: createAgentBrowserRuntime([]),
    });
    const initial = await workspaceService.getWorkspaceSnapshot();
    const plan = initial.campaigns[0]!;
    await repository.saveCampaignState({
      activeCampaignId: plan.id,
      notifications: [],
      campaigns: initial.campaigns.map((row) =>
        row.id === plan.id ? { ...row, jobIds: [job.id] } : row,
      ),
    });
    await repository.commitSavedJobDelta({
      update: (row) =>
        row.id === job.id
          ? {
              ...row,
              campaignIds: [plan.id],
              planAssessments: { [plan.id]: row.matchAssessment },
            }
          : row,
    });
    await workspaceService.runAgentDiscovery();
    const fullCalls = assessJobFit.mock.calls.filter(
      ([input]) => input.job.canonicalUrl === job.canonicalUrl,
    );
    expect(fullCalls).toHaveLength(
      change === "profile" || change === "posting" ? 1 : 0,
    );
    if (change === "missing verdict") {
      const unchanged = readPlanAssessment(
        (await repository.listSavedJobs()).find((row) => row.id === job.id)!,
        plan.id,
      );
      expect(unchanged.matchAssessment.requirements).toEqual(evidence);
      expect(unchanged.matchAssessment.judgment).toMatchObject({
        source: "full",
        score: 77,
      });
      expect(unchanged.matchAssessment.scorerVersion).toBe(17);
    }
    if (change === "rubric") {
      const updated = readPlanAssessment(
        (await repository.listSavedJobs()).find((row) => row.id === job.id)!,
        plan.id,
      );
      expect(updated.matchAssessment.requirements).toEqual(evidence);
      expect(updated.matchAssessment.judgment).toMatchObject({
        source: "full",
        score: 70,
      });
      expect(updated.matchAssessment.scorerVersion).toBe(18);
      await workspaceService.runAgentDiscovery();
      expect(
        assessJobFit.mock.calls.filter(
          ([input]) => input.job.canonicalUrl === job.canonicalUrl,
        ),
      ).toHaveLength(0);
      expect(
        judgeJobFits.mock.calls.flatMap(([input]) =>
          input.jobs.filter((row) => row.jobId === job.id),
        ),
      ).toHaveLength(1);
    }
  },
  30_000,
);
