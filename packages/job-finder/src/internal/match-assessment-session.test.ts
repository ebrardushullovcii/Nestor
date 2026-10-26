import {
  FitJudgmentSchema,
  readPreparedMatchAssessmentPostingFingerprint,
  type JobPosting,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { createSeed } from "../test-fixtures";
import {
  MATCH_ASSESSMENT_POSTING_INPUT_FIELDS,
  type MatchAssessmentPostingInput,
} from "./match-assessment-posting-input";
import { createMatchAssessment } from "./matching";
import { prepareDiscoveryPosting } from "./discovery-posting-preparation";
import {
  MATCH_ASSESSMENT_SCORER_VERSION,
  createMatchAssessmentPostingFingerprint,
  createMatchAssessmentSession,
} from "./match-assessment-session";

type PostingMutation = (posting: JobPosting) => JobPosting;

const postingInputMutations = {
  title: (posting) => ({ ...posting, title: `${posting.title} changed` }),
  company: (posting) => ({
    ...posting,
    company: `${posting.company} changed`,
  }),
  location: (posting) => ({
    ...posting,
    location: `${posting.location} changed`,
  }),
  workMode: (posting) => ({
    ...posting,
    workMode: posting.workMode.includes("onsite") ? ["remote"] : ["onsite"],
  }),
  seniority: (posting) => ({
    ...posting,
    seniority: posting.seniority === "Staff" ? "Senior" : "Staff",
  }),
  employmentType: (posting) => ({
    ...posting,
    employmentType:
      posting.employmentType === "Contract" ? "Full-time" : "Contract",
  }),
  applyPath: (posting) => ({
    ...posting,
    applyPath:
      posting.applyPath === "external_redirect"
        ? "easy_apply"
        : "external_redirect",
  }),
  easyApplyEligible: (posting) => ({
    ...posting,
    easyApplyEligible: !posting.easyApplyEligible,
  }),
  salaryText: (posting) => ({
    ...posting,
    salaryText: posting.salaryText ? null : "$120,000",
  }),
  detailQuality: (posting) => ({
    ...posting,
    detailQuality:
      posting.detailQuality === "detail_enriched"
        ? "card_only"
        : "detail_enriched",
  }),
  screeningHints: (posting) => ({
    ...posting,
    screeningHints: {
      ...posting.screeningHints,
      remoteGeographies: [
        ...posting.screeningHints.remoteGeographies,
        "Changed geography",
      ],
    },
  }),
  summary: (posting) => ({
    ...posting,
    summary: posting.summary
      ? `${posting.summary} Changed.`
      : "Changed summary.",
  }),
  description: (posting) => ({
    ...posting,
    description: `${posting.description} Changed.`,
  }),
  keySkills: (posting) => ({
    ...posting,
    keySkills: [...posting.keySkills, "Changed skill"],
  }),
  keywordSignals: (posting) => ({
    ...posting,
    keywordSignals: [
      ...posting.keywordSignals,
      {
        id: "changed_keyword_signal",
        label: "Changed keyword signal",
        kind: "domain",
        weight: 3,
      },
    ],
  }),
  responsibilities: (posting) => ({
    ...posting,
    responsibilities: [...posting.responsibilities, "Changed responsibility"],
  }),
  minimumQualifications: (posting) => ({
    ...posting,
    minimumQualifications: [
      ...posting.minimumQualifications,
      "Changed minimum qualification",
    ],
  }),
  preferredQualifications: (posting) => ({
    ...posting,
    preferredQualifications: [
      ...posting.preferredQualifications,
      "Changed preferred qualification",
    ],
  }),
  department: (posting) => ({
    ...posting,
    department:
      posting.department === "Changed department"
        ? "Other department"
        : "Changed department",
  }),
  team: (posting) => ({
    ...posting,
    team: posting.team === "Changed team" ? "Other team" : "Changed team",
  }),
  benefits: (posting) => ({
    ...posting,
    benefits: [...posting.benefits, "Changed benefit"],
  }),
  atsProvider: (posting) => ({
    ...posting,
    atsProvider:
      posting.atsProvider === "Changed ATS" ? "Other ATS" : "Changed ATS",
  }),
} satisfies Record<keyof MatchAssessmentPostingInput, PostingMutation>;

describe("match assessment session", () => {
  test("a lost symbol carrier recomputes the same fit fingerprint from the full body", () => {
    const posting = prepareDiscoveryPosting(createSeed().savedJobs[0]!);
    const expected = createMatchAssessmentPostingFingerprint(posting);
    const cloned = structuredClone(posting);
    expect(readPreparedMatchAssessmentPostingFingerprint(cloned)).toBeNull();
    const readBody = vi.fn(() => posting.description);
    Object.defineProperty(cloned, "description", {
      enumerable: true,
      get: readBody,
    });
    expect(createMatchAssessmentPostingFingerprint(cloned)).toBe(expected);
    expect(readBody).toHaveBeenCalledOnce();
  });

  test("nested edits cannot keep a stale carried fit fingerprint", () => {
    const posting = prepareDiscoveryPosting(createSeed().savedJobs[0]!);
    const before = createMatchAssessmentPostingFingerprint(posting);
    posting.screeningHints.remoteGeographies.push("Changed geography");
    expect(readPreparedMatchAssessmentPostingFingerprint(posting)).toBeNull();
    expect(createMatchAssessmentPostingFingerprint(posting)).not.toBe(before);
  });

  test("computes one assessment for repeated budget and merge reads", () => {
    const seed = createSeed();
    const calculate = vi.fn(createMatchAssessment);
    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate,
    });
    const posting = seed.savedJobs[0]!;

    const first = session.assess(posting);
    const second = session.assess({ ...posting });

    expect(second).toBe(first);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(session.getComputationCount()).toBe(1);
    expect(first).toMatchObject({
      scorerVersion: MATCH_ASSESSMENT_SCORER_VERSION,
      contextFingerprint: session.contextFingerprint,
    });
    expect(first.postingFingerprint).toMatch(/^match_posting_v4_logic16_/u);
    expect(session.contextFingerprint).toMatch(/^match_context_v4_logic16_/u);
  });

  test("does not reuse an assessment persisted under the previous scoring logic", () => {
    // The fingerprints hash the profile and preferences, never the scorer, so
    // the revision in the prefix is the only thing that retires a persisted
    // assessment. Revision 7 scored a placeholder-only saved location as a
    // verified geographic match (68 for the case below); revision 8 reads it as
    // no constraint (71). If the revision were left at 7 the stale 68 would be
    // reused on every returning workspace, which is exactly the state this
    // pins against.
    const seed = createSeed();
    const searchPreferences = {
      ...seed.searchPreferences,
      locations: ["Location not stated"],
    };
    const posting = seed.savedJobs[0]!;

    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences,
      calculate: createMatchAssessment,
    });
    const assessment = session.assess(posting);

    for (const retiredRevision of [7]) {
      expect(session.contextFingerprint).not.toMatch(
        new RegExp(`^match_context_v4_logic${retiredRevision}_`, "u"),
      );
      expect(assessment.postingFingerprint).not.toMatch(
        new RegExp(`^match_posting_v4_logic${retiredRevision}_`, "u"),
      );
    }

    // The version travels with the fingerprints, so a persisted row can also be
    // retired by comparing the recorded scorer version alone.
    expect(assessment.scorerVersion).toBe(MATCH_ASSESSMENT_SCORER_VERSION);
    expect(MATCH_ASSESSMENT_SCORER_VERSION).toBeGreaterThan(8);
  });

  test.each(
    Object.entries(postingInputMutations) as Array<
      [keyof MatchAssessmentPostingInput, PostingMutation]
    >,
  )("invalidates persisted assessments when %s changes", (_field, mutate) => {
    const seed = createSeed();
    const posting = prepareDiscoveryPosting(seed.savedJobs[0]!);
    const baselineSession = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate: createMatchAssessment,
    });
    const persisted = baselineSession.assess(posting);
    const changedPosting = mutate(posting);
    expect(
      readPreparedMatchAssessmentPostingFingerprint(changedPosting),
    ).toBeNull();
    const calculate = vi.fn(createMatchAssessment);
    const resumedSession = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate,
    });

    expect(createMatchAssessmentPostingFingerprint(changedPosting)).not.toBe(
      persisted.postingFingerprint,
    );
    expect(resumedSession.assessPersisted(changedPosting, persisted)).not.toBe(
      persisted,
    );
    expect(calculate).toHaveBeenCalledTimes(1);
  });

  test("keeps non-scoring identity and discovery metadata out of the cache key", () => {
    const seed = createSeed();
    const posting = seed.savedJobs[0]!;
    const changedIdentity = {
      ...posting,
      sourceJobId: `${posting.sourceJobId}_duplicate`,
      canonicalUrl: `${posting.canonicalUrl}?duplicate=true`,
      discoveredAt: "2026-04-01T00:00:00.000Z",
    };

    expect(createMatchAssessmentPostingFingerprint(changedIdentity)).toBe(
      createMatchAssessmentPostingFingerprint(posting),
    );
    expect(Object.keys(postingInputMutations).sort()).toEqual(
      [...MATCH_ASSESSMENT_POSTING_INPUT_FIELDS].sort(),
    );
  });

  test("reuses a persisted assessment only for exact scorer, context, and posting inputs", () => {
    const seed = createSeed();
    const firstSession = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate: createMatchAssessment,
    });
    const posting = seed.savedJobs[0]!;
    const persisted = firstSession.assess(posting);
    const calculate = vi.fn(createMatchAssessment);
    const resumedSession = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate,
    });

    const persistedPosting = { ...posting, matchAssessment: persisted };
    expect(resumedSession.assessPersisted(persistedPosting, persisted)).toBe(
      persisted,
    );
    expect(calculate).not.toHaveBeenCalled();

    resumedSession.assessPersisted(
      { ...posting, description: `${posting.description} Changed.` },
      persisted,
    );
    expect(calculate).toHaveBeenCalledTimes(1);

    resumedSession.assessPersisted(
      { ...posting, detailQuality: "detail_enriched" },
      persisted,
    );
    resumedSession.assessPersisted(
      {
        ...posting,
        applyPath: "external_redirect",
        easyApplyEligible: false,
      },
      persisted,
    );
    resumedSession.assessPersisted(
      {
        ...posting,
        seniority: "Staff",
        employmentType: "Contract",
      },
      persisted,
    );
    expect(calculate).toHaveBeenCalledTimes(4);
  });

  test("invalidates when profile, preferences, or scorer metadata changes", () => {
    const seed = createSeed();
    const posting = seed.savedJobs[0]!;
    const baselineSession = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate: createMatchAssessment,
    });
    const persisted = baselineSession.assess(posting);

    const changedProfile = createMatchAssessmentSession({
      profile: { ...seed.profile, headline: "Changed headline" },
      searchPreferences: seed.searchPreferences,
      calculate: createMatchAssessment,
    });
    const changedPreferences = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: {
        ...seed.searchPreferences,
        minimumSalaryUsd: 140_000,
      },
      calculate: createMatchAssessment,
    });
    const legacy = {
      ...persisted,
      scorerVersion: 1,
      contextFingerprint: null,
      postingFingerprint: null,
    };

    expect(changedProfile.assessPersisted(posting, persisted)).not.toBe(
      persisted,
    );
    expect(changedPreferences.assessPersisted(posting, persisted)).not.toBe(
      persisted,
    );
    expect(baselineSession.assessPersisted(posting, legacy)).not.toBe(legacy);
  });

  test("rescales a persisted version-10 result through the current scorer", () => {
    const seed = createSeed();
    const calculate = vi.fn(createMatchAssessment);
    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate,
    });
    const stale = {
      ...seed.savedJobs[0]!.matchAssessment,
      scorerVersion: 10,
      score: 99,
      contextFingerprint: session.contextFingerprint,
      postingFingerprint: createMatchAssessmentPostingFingerprint(
        seed.savedJobs[0]!,
      ),
    };

    const current = session.assessPersisted(seed.savedJobs[0]!, stale);

    expect(current).not.toBe(stale);
    expect(current.scorerVersion).toBe(MATCH_ASSESSMENT_SCORER_VERSION);
    expect(calculate).toHaveBeenCalledTimes(1);
  });

  test("computes exactly once per unique scoring input across a 500-posting replay", () => {
    const seed = createSeed();
    const calculate = vi.fn(createMatchAssessment);
    const session = createMatchAssessmentSession({
      profile: seed.profile,
      searchPreferences: seed.searchPreferences,
      calculate,
    });
    const postings = Array.from({ length: 500 }, (_, index) => ({
      ...seed.savedJobs[0]!,
      sourceJobId: `session_${index}`,
      canonicalUrl: `https://example.com/jobs/session-${index}`,
      title: `Software Engineer ${index}`,
      description: `${seed.savedJobs[0]!.description} Unique role ${index}.`,
    }));

    for (const posting of postings) {
      session.assess(posting);
    }
    for (const posting of postings) {
      session.assess({ ...posting });
    }

    expect(calculate).toHaveBeenCalledTimes(500);
    expect(session.getComputationCount()).toBe(500);
  });
});

test("a changed-goals batch replaces a carried full assessment in the session", () => {
  const seed = createSeed();
  const posting = seed.savedJobs[0]!;
  const full = {
    ...posting.matchAssessment,
    judgment: FitJudgmentSchema.parse({
      source: "full",
      judgedAt: "2026-10-03T10:00:00Z",
      contextFingerprint: "goals-A",
      postingFingerprint: "listing-A",
      score: 80,
      recommendation: "strong_fit",
      role: "exact",
      preferences: "aligned",
      locationReach: "in_area",
    }),
  };
  const batch = FitJudgmentSchema.parse({
    ...full.judgment,
    source: "batch",
    contextFingerprint: "goals-B",
    score: 30,
    recommendation: "skip",
  });
  const session = createMatchAssessmentSession({
    profile: seed.profile,
    searchPreferences: seed.searchPreferences,
    calculate: createMatchAssessment,
  });
  session.assess({ ...posting, matchAssessment: full });
  expect(
    session.assess({ ...posting, matchAssessment: full }, batch).judgment,
  ).toEqual(batch);
  const nextBatch = { ...batch, contextFingerprint: "goals-C", score: 20 };
  expect(
    session.assess({ ...posting, matchAssessment: full }, nextBatch).judgment,
  ).toEqual(nextBatch);
});
