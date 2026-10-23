import { buildFitVerdictContext } from "@nestor/ai-providers";
import { fnv1a64 } from "@nestor/core";
import type {
  CandidateProfile,
  FitJudgment,
  JobPosting,
  JobSearchPreferences,
  MatchAssessment,
} from "@nestor/contracts";
import {
  applyFitJudgment,
  readCarriedJudgment,
  preserveCompletedAssessment,
} from "./fit-judgment-apply";
import {
  createMatchAssessmentPostingInput,
  type MatchAssessmentPostingInput,
} from "./match-assessment-posting-input";

/**
 * Bump both values together whenever scoring OUTPUT changes, not only when the
 * scorer's shape changes. The fingerprints below are computed over the profile
 * and preferences alone, so an assessment persisted by an earlier build hashes
 * identically under a later one and is reused verbatim: a returning workspace
 * would keep stale scores forever. The revision inside each fingerprint prefix
 * is the only thing that forces a recalculation.
 *
 * Revision 8 (scorer version 9): a saved location that is only an absence
 * placeholder ("Location not stated", "N/A") stopped counting as a geographic
 * constraint, so `hasLocationPreferences`, the preference facet's existence and
 * evidence line, the location requirement, and `getBroadLocationCompatibility`
 * all changed answers for those profiles. Measured against the previous build,
 * an identical placeholder-only input scored 68 before and 71 after.
 *
 * Revision 9 (scorer version 10): the assessment now records `locationReach`,
 * the listing's standing against the saved areas, so Best-match ordering can
 * keep an on-site role outside every saved area below in-area and remote roles
 * of the same title fit. Scores are unchanged; assessments written before this
 * revision carry no reach and must be recalculated to gain one.
 *
 * Revision 10 (scorer version 11): occupation, career-stage, explicit hours,
 * and travel-evidence scoring changed. Returning workspaces must not reuse a
 * version-10 score just because the profile and posting text are unchanged.
 *
 * Revision 11 (scorer version 12): US country aliases now compare as the same
 * place, and explicit occupations take precedence over a shared head noun.
 * Retire cached location conflicts and wrong-family recommendations.
 *
 * Revision 12 (scorer version 13): explicit summary language evidence and
 * customer implementation requirements now participate in assessment.
 */
// Revision 13: country codes, discipline and title-level evidence, and model
// requirement comparisons replace scores written by the previous logic.
// Revision 14 (scorer version 15): the model decides fit (ADR 0041). Rule
// scores written before are retired; a stored model verdict is kept.
// Revision 15 (version 16): country eligibility, availability and full
// listing evidence are explicit inputs; prior verdicts stay until replacement.
export const MATCH_ASSESSMENT_SCORER_VERSION = 16;
const MATCH_ASSESSMENT_LOGIC_REVISION = 15;

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function createFingerprint(prefix: string, value: unknown): string {
  const serialized = stableSerialize(value);
  return `${prefix}_${fnv1a64(serialized)}`;
}

/**
 * Everything the assessment's arithmetic reads: the whole profile and goals.
 * Fit verdicts were stamped with it until they got their own fingerprint
 * (below), so it also identifies a verdict stored by an earlier build.
 */
export function createMatchAssessmentContextFingerprint(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
): string {
  return createFingerprint(
    `match_context_v4_logic${MATCH_ASSESSMENT_LOGIC_REVISION}`,
    {
      profile,
      searchPreferences: {
        ...searchPreferences,
        discovery: {
          remoteCountsAsAnyLocation:
            searchPreferences.discovery.remoteCountsAsAnyLocation !== false,
        },
      },
    },
  );
}

/**
 * What a fit verdict was given on: the person's facts and goals the model
 * reads (buildFitVerdictContext), nothing else. A changed phone number,
 * link, saved answer or source list leaves every verdict current.
 */
export function createFitVerdictFingerprint(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
): string {
  return createFingerprint(
    `fit_verdict_v1_logic${MATCH_ASSESSMENT_LOGIC_REVISION}`,
    buildFitVerdictContext(profile, searchPreferences),
  );
}

/**
 * The assessment with a verdict stamped by an earlier build re-stamped: a
 * verdict whose stamp is the whole-input fingerprint of these same inputs
 * was current, and stays current under the verdict fingerprint. Changing
 * the fingerprint function therefore never asks the model again.
 */
export function rebindLegacyVerdict<
  T extends Pick<MatchAssessment, "judgment">,
>(
  assessment: T,
  fingerprints: {
    verdictFingerprint: string;
    legacyVerdictFingerprint: string;
  },
): T {
  const judgment = assessment.judgment;
  if (judgment?.contextFingerprint !== fingerprints.legacyVerdictFingerprint)
    return assessment;
  return {
    ...assessment,
    judgment: {
      ...judgment,
      contextFingerprint: fingerprints.verdictFingerprint,
    },
  };
}

export function createMatchAssessmentPostingFingerprint(
  posting: MatchAssessmentPostingInput,
): string {
  return createFingerprint(
    `match_posting_v4_logic${MATCH_ASSESSMENT_LOGIC_REVISION}`,
    createMatchAssessmentPostingInput(posting),
  );
}

function assessmentCacheKey(
  postingFingerprint: string,
  judgment: FitJudgment | null | undefined,
): string {
  return judgment
    ? `${postingFingerprint}|${judgment.source}|${judgment.judgedAt}|${judgment.contextFingerprint}|${judgment.postingFingerprint}`
    : postingFingerprint;
}

export type MatchAssessmentCalculator = (
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  posting: MatchAssessmentPostingInput,
) => MatchAssessment;

export function createMatchAssessmentSession(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  calculate: MatchAssessmentCalculator;
}) {
  const contextFingerprint = createMatchAssessmentContextFingerprint(
    input.profile,
    input.searchPreferences,
  );
  const verdictFingerprint = createFitVerdictFingerprint(
    input.profile,
    input.searchPreferences,
  );
  const fingerprints = {
    verdictFingerprint,
    legacyVerdictFingerprint: contextFingerprint,
  };
  const rebind = <T extends MatchAssessment | null | undefined>(
    assessment: T,
  ): T =>
    assessment ? rebindLegacyVerdict(assessment, fingerprints) : assessment;
  const cache = new Map<string, MatchAssessment>();
  let computationCount = 0;

  /**
   * Scores a posting. A job the model already judged keeps that verdict
   * (ADR 0041), even when the listing or the goals changed since; the next
   * judging pass replaces a stale verdict, and until then it beats a rule
   * guess.
   */
  const assess = (
    posting: JobPosting & { matchAssessment?: MatchAssessment | null },
    carriedInput: FitJudgment | null = readCarriedJudgment(posting),
  ): MatchAssessment => {
    const carried =
      carriedInput?.contextFingerprint === fingerprints.legacyVerdictFingerprint
        ? { ...carriedInput, contextFingerprint: verdictFingerprint }
        : carriedInput;
    const previous = rebind(
      (posting as { matchAssessment?: MatchAssessment }).matchAssessment,
    );
    // Keep the requirements and evidence from the completed full read too,
    // rather than rebuilding empty requirements around its carried score.
    if (
      previous?.judgment &&
      (!carried ||
        (previous.judgment.source === "full" &&
          carried.source !== "full" &&
          previous.judgment.contextFingerprint === carried.contextFingerprint &&
          previous.judgment.postingFingerprint ===
            carried.postingFingerprint) ||
        (previous.judgment.source === carried.source &&
          previous.judgment.judgedAt === carried.judgedAt &&
          previous.judgment.contextFingerprint === carried.contextFingerprint &&
          previous.judgment.postingFingerprint === carried.postingFingerprint))
    )
      return previous;
    const postingInput = createMatchAssessmentPostingInput(posting);
    const postingFingerprint =
      createMatchAssessmentPostingFingerprint(postingInput);
    const cacheKey = assessmentCacheKey(postingFingerprint, carried);
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    computationCount += 1;
    const calculated = {
      ...input.calculate(input.profile, input.searchPreferences, postingInput),
      scorerVersion: MATCH_ASSESSMENT_SCORER_VERSION,
      contextFingerprint,
      postingFingerprint,
    };
    const assessment = carried
      ? applyFitJudgment(calculated, carried)
      : calculated;
    cache.set(cacheKey, assessment);
    return assessment;
  };

  const assessPersisted = (
    posting: JobPosting,
    storedAssessment: MatchAssessment | null | undefined,
  ): MatchAssessment => {
    const persistedAssessment = rebind(storedAssessment);
    // assess() carries a completed model verdict unchanged even when its
    // context is stale. Hashing the full listing first cannot change that
    // answer and allocated gigabytes during inventory revalidation.
    if (persistedAssessment?.judgment) return persistedAssessment;
    const postingFingerprint = createMatchAssessmentPostingFingerprint(
      createMatchAssessmentPostingInput(posting),
    );
    if (
      persistedAssessment?.scorerVersion === MATCH_ASSESSMENT_SCORER_VERSION &&
      persistedAssessment.contextFingerprint === contextFingerprint &&
      persistedAssessment.postingFingerprint === postingFingerprint
    ) {
      cache.set(
        assessmentCacheKey(postingFingerprint, persistedAssessment.judgment),
        persistedAssessment,
      );
      return persistedAssessment;
    }

    return preserveCompletedAssessment(
      persistedAssessment,
      assess(
        { ...posting, matchAssessment: persistedAssessment ?? null },
        persistedAssessment?.judgment ?? null,
      ),
    );
  };

  const remember = (
    posting: JobPosting,
    assessment: MatchAssessment,
  ): MatchAssessment => {
    const postingFingerprint = createMatchAssessmentPostingFingerprint(posting);
    const bound = {
      ...assessment,
      scorerVersion: MATCH_ASSESSMENT_SCORER_VERSION,
      contextFingerprint,
      postingFingerprint,
    };
    cache.set(assessmentCacheKey(postingFingerprint, bound.judgment), bound);
    return bound;
  };

  return {
    assess,
    assessPersisted,
    remember,
    contextFingerprint,
    /** What verdicts given in this session are stamped with and checked against. */
    verdictFingerprint,
    getComputationCount: () => computationCount,
  };
}

export type MatchAssessmentSession = ReturnType<
  typeof createMatchAssessmentSession
>;
