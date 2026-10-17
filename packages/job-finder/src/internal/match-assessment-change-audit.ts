import {
  MatchAssessmentChangeAuditSchema,
  MatchAssessmentSchema,
  type JobRequirementAssessment,
  type MatchAssessment,
  type MatchAssessmentChangeAudit,
  type MatchAssessmentChangeAuditStatus,
  type MatchAssessmentChangeCauseConfidence,
  type MatchAssessmentInputChange,
  type MatchAssessmentOutputChange,
  type MatchAssessmentOutputChangeCode,
} from "@nestor/contracts";

export type MatchAssessmentChangeAuditInput = {
  previous: MatchAssessment;
  current: MatchAssessment;
  previousRank?: number | null;
  currentRank?: number | null;
  recordedAt?: string | null;
};

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function sortByStableValue<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    compareStrings(stableSerialize(left), stableSerialize(right)),
  );
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function describeRatingChange(input: {
  label: string;
  previousRating: string;
  currentRating: string;
}): string {
  if (input.previousRating === input.currentRating) {
    return `${input.label} evidence or explanation changed while its ${humanize(input.currentRating)} rating stayed the same.`;
  }
  return `${input.label} changed from ${humanize(input.previousRating)} to ${humanize(input.currentRating)}.`;
}

function normalizeDimension<T extends { evidence: readonly unknown[] }>(
  dimension: T,
) {
  return {
    ...dimension,
    evidence: sortByStableValue(dimension.evidence),
  };
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function requirementBaseKey(requirement: JobRequirementAssessment): string {
  return `${requirement.category}:${normalizeText(requirement.label)}`;
}

function normalizeRequirementEvidence(
  requirement: JobRequirementAssessment,
): unknown {
  return {
    jobEvidence: requirement.jobEvidence,
    resumeEvidence: sortByStableValue(requirement.resumeEvidence),
    explanation: requirement.explanation,
  };
}

type IndexedRequirement = {
  key: string;
  requirement: JobRequirementAssessment;
};

function indexRequirements(
  requirements: readonly JobRequirementAssessment[],
): IndexedRequirement[] {
  const grouped = new Map<string, JobRequirementAssessment[]>();
  for (const requirement of requirements) {
    const key = requirementBaseKey(requirement);
    const group = grouped.get(key) ?? [];
    group.push(requirement);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .flatMap(([baseKey, group]) =>
      sortByStableValue(group).map((requirement, index) => ({
        key: group.length === 1 ? baseKey : `${baseKey}#${index + 1}`,
        requirement,
      })),
    );
}

function buildInputChanges(
  previous: MatchAssessment,
  current: MatchAssessment,
): MatchAssessmentInputChange[] {
  const changes: MatchAssessmentInputChange[] = [];

  if (previous.scorerVersion !== current.scorerVersion) {
    changes.push({
      code: "scorer_version_changed",
      scope: "scorer",
      certainty: "known",
      title: "Scoring model changed",
      detail: `The assessment was recalculated with scorer version ${current.scorerVersion} instead of version ${previous.scorerVersion}.`,
      previousValue: previous.scorerVersion,
      currentValue: current.scorerVersion,
    });
  }

  if (
    previous.contextFingerprint === null ||
    current.contextFingerprint === null
  ) {
    changes.push({
      code: "candidate_context_metadata_unknown",
      scope: "candidate_context",
      certainty: "unknown",
      title: "Candidate context history is incomplete",
      detail:
        "A candidate-context fingerprint is missing, so this audit cannot prove whether the saved profile and/or search preferences changed.",
      previousValue: previous.contextFingerprint,
      currentValue: current.contextFingerprint,
    });
  } else if (previous.contextFingerprint !== current.contextFingerprint) {
    changes.push({
      code: "candidate_context_changed",
      scope: "candidate_context",
      certainty: "known",
      title: "Candidate context changed",
      detail:
        "The saved candidate profile and/or search preferences changed. The combined fingerprint does not identify which one changed.",
      previousValue: previous.contextFingerprint,
      currentValue: current.contextFingerprint,
    });
  }

  if (
    previous.postingFingerprint === null ||
    current.postingFingerprint === null
  ) {
    changes.push({
      code: "listing_evidence_metadata_unknown",
      scope: "listing_evidence",
      certainty: "unknown",
      title: "Listing evidence history is incomplete",
      detail:
        "A posting fingerprint is missing, so this audit cannot prove whether the listing evidence changed.",
      previousValue: previous.postingFingerprint,
      currentValue: current.postingFingerprint,
    });
  } else if (previous.postingFingerprint !== current.postingFingerprint) {
    changes.push({
      code: "listing_evidence_changed",
      scope: "listing_evidence",
      certainty: "known",
      title: "Listing evidence changed",
      detail:
        "The posting fingerprint changed, which means ranking-relevant listing evidence was added, removed, or edited.",
      previousValue: previous.postingFingerprint,
      currentValue: current.postingFingerprint,
    });
  }

  return changes;
}

function appendAssessmentChange(
  changes: MatchAssessmentOutputChange[],
  input: {
    code: MatchAssessmentOutputChangeCode;
    subject: string;
    label: string;
    previousRating: string;
    currentRating: string;
    previousAssessment: unknown;
    currentAssessment: unknown;
  },
): void {
  if (
    stableSerialize(input.previousAssessment) ===
    stableSerialize(input.currentAssessment)
  ) {
    return;
  }

  changes.push({
    code: input.code,
    subject: input.subject,
    title: `${input.label} changed`,
    detail: describeRatingChange(input),
    previousValue: humanize(input.previousRating),
    currentValue: humanize(input.currentRating),
  });
}

function buildRequirementChanges(
  previous: MatchAssessment,
  current: MatchAssessment,
): MatchAssessmentOutputChange[] {
  const changes: MatchAssessmentOutputChange[] = [];
  const previousByKey = new Map(
    indexRequirements(previous.requirements).map((entry) => [
      entry.key,
      entry.requirement,
    ]),
  );
  const currentByKey = new Map(
    indexRequirements(current.requirements).map((entry) => [
      entry.key,
      entry.requirement,
    ]),
  );
  const keys = [
    ...new Set([...previousByKey.keys(), ...currentByKey.keys()]),
  ].sort(compareStrings);

  for (const key of keys) {
    const previousRequirement = previousByKey.get(key);
    const currentRequirement = currentByKey.get(key);

    if (!previousRequirement && currentRequirement) {
      changes.push({
        code: "requirement_added",
        subject: key,
        title: `${currentRequirement.label} requirement added`,
        detail: `The ${humanize(currentRequirement.importance)} ${humanize(currentRequirement.category)} requirement “${currentRequirement.label}” was added with ${humanize(currentRequirement.status)} candidate evidence.`,
        previousValue: null,
        currentValue: humanize(currentRequirement.status),
      });
      continue;
    }

    if (previousRequirement && !currentRequirement) {
      changes.push({
        code: "requirement_removed",
        subject: key,
        title: `${previousRequirement.label} requirement removed`,
        detail: `The ${humanize(previousRequirement.importance)} ${humanize(previousRequirement.category)} requirement “${previousRequirement.label}” was removed from the assessment.`,
        previousValue: humanize(previousRequirement.status),
        currentValue: null,
      });
      continue;
    }

    if (!previousRequirement || !currentRequirement) {
      continue;
    }

    if (previousRequirement.importance !== currentRequirement.importance) {
      changes.push({
        code: "requirement_importance_changed",
        subject: key,
        title: `${currentRequirement.label} importance changed`,
        detail: `The “${currentRequirement.label}” requirement changed from ${humanize(previousRequirement.importance)} to ${humanize(currentRequirement.importance)}.`,
        previousValue: humanize(previousRequirement.importance),
        currentValue: humanize(currentRequirement.importance),
      });
    }

    if (previousRequirement.status !== currentRequirement.status) {
      changes.push({
        code: "requirement_status_changed",
        subject: key,
        title: `${currentRequirement.label} evidence changed`,
        detail: `Candidate evidence for “${currentRequirement.label}” changed from ${humanize(previousRequirement.status)} to ${humanize(currentRequirement.status)}.`,
        previousValue: humanize(previousRequirement.status),
        currentValue: humanize(currentRequirement.status),
      });
    }

    if (
      stableSerialize(normalizeRequirementEvidence(previousRequirement)) !==
      stableSerialize(normalizeRequirementEvidence(currentRequirement))
    ) {
      changes.push({
        code: "requirement_evidence_changed",
        subject: key,
        title: `${currentRequirement.label} supporting evidence changed`,
        detail: `The listing or candidate evidence recorded for “${currentRequirement.label}” changed.`,
        previousValue: humanize(previousRequirement.status),
        currentValue: humanize(currentRequirement.status),
      });
    }
  }

  return changes;
}

function normalizeRank(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer when provided.`);
  }
  return value;
}

function buildOutputChanges(
  previous: MatchAssessment,
  current: MatchAssessment,
  previousRank: number | null,
  currentRank: number | null,
): MatchAssessmentOutputChange[] {
  const changes: MatchAssessmentOutputChange[] = [];

  if (previous.score !== current.score) {
    changes.push({
      code: "score_changed",
      subject: "score",
      title: "Fit score changed",
      detail: `The fit score changed from ${previous.score} to ${current.score}.`,
      previousValue: String(previous.score),
      currentValue: String(current.score),
    });
  }

  if (previous.recommendation !== current.recommendation) {
    changes.push({
      code: "recommendation_changed",
      subject: "recommendation",
      title: "Recommendation changed",
      detail: `The recommendation changed from ${humanize(previous.recommendation)} to ${humanize(current.recommendation)}.`,
      previousValue: humanize(previous.recommendation),
      currentValue: humanize(current.recommendation),
    });
  }
  if (previousRank !== currentRank) {
    changes.push({
      code: "rank_position_changed",
      subject: "rank_position",
      title: "Queue rank changed",
      detail: `The queue rank changed from ${previousRank === null ? "unranked" : `#${previousRank}`} to ${currentRank === null ? "unranked" : `#${currentRank}`}. This job's assessment may be unchanged when other jobs enter, leave, or change around it.`,
      previousValue: previousRank === null ? null : String(previousRank),
      currentValue: currentRank === null ? null : String(currentRank),
    });
  }

  appendAssessmentChange(changes, {
    code: "compensation_fit_changed",
    subject: "compensation_fit",
    label: "Compensation fit",
    previousRating: previous.compensationFit.state,
    currentRating: current.compensationFit.state,
    previousAssessment: previous.compensationFit,
    currentAssessment: current.compensationFit,
  });
  appendAssessmentChange(changes, {
    code: "role_suitability_changed",
    subject: "role_suitability",
    label: "Role suitability",
    previousRating: previous.dimensions.roleSuitability.state,
    currentRating: current.dimensions.roleSuitability.state,
    previousAssessment: normalizeDimension(previous.dimensions.roleSuitability),
    currentAssessment: normalizeDimension(current.dimensions.roleSuitability),
  });
  appendAssessmentChange(changes, {
    code: "preference_alignment_changed",
    subject: "preference_alignment",
    label: "Preference alignment",
    previousRating: previous.dimensions.preferenceAlignment.state,
    currentRating: current.dimensions.preferenceAlignment.state,
    previousAssessment: normalizeDimension(
      previous.dimensions.preferenceAlignment,
    ),
    currentAssessment: normalizeDimension(
      current.dimensions.preferenceAlignment,
    ),
  });
  appendAssessmentChange(changes, {
    code: "application_effort_changed",
    subject: "application_effort",
    label: "Application effort",
    previousRating: previous.dimensions.applicationEffort.level,
    currentRating: current.dimensions.applicationEffort.level,
    previousAssessment: normalizeDimension(
      previous.dimensions.applicationEffort,
    ),
    currentAssessment: normalizeDimension(current.dimensions.applicationEffort),
  });
  appendAssessmentChange(changes, {
    code: "evidence_confidence_changed",
    subject: "evidence_confidence",
    label: "Evidence confidence",
    previousRating: previous.dimensions.evidenceConfidence.level,
    currentRating: current.dimensions.evidenceConfidence.level,
    previousAssessment: normalizeDimension(
      previous.dimensions.evidenceConfidence,
    ),
    currentAssessment: normalizeDimension(
      current.dimensions.evidenceConfidence,
    ),
  });

  changes.push(...buildRequirementChanges(previous, current));

  const previousExplanation = {
    reasons: [...previous.reasons].sort(compareStrings),
    gaps: [...previous.gaps].sort(compareStrings),
    recommendationRationale: previous.recommendationRationale,
  };
  const currentExplanation = {
    reasons: [...current.reasons].sort(compareStrings),
    gaps: [...current.gaps].sort(compareStrings),
    recommendationRationale: current.recommendationRationale,
  };
  if (
    stableSerialize(previousExplanation) !== stableSerialize(currentExplanation)
  ) {
    changes.push({
      code: "assessment_explanation_changed",
      subject: "assessment_explanation",
      title: "Assessment explanation changed",
      detail:
        "The recorded fit reasons, gaps, or recommendation rationale changed.",
      previousValue: null,
      currentValue: null,
    });
  }

  return changes;
}

function determineStatus(input: {
  inputChanges: readonly MatchAssessmentInputChange[];
  outputChanges: readonly MatchAssessmentOutputChange[];
}): MatchAssessmentChangeAuditStatus {
  const hasKnownInputChange = input.inputChanges.some(
    (change) => change.certainty === "known",
  );
  const hasUnknownMetadata = input.inputChanges.some(
    (change) => change.certainty === "unknown",
  );

  if (input.outputChanges.length === 0) {
    if (hasKnownInputChange) {
      return "inputs_changed_assessment_stable";
    }
    return hasUnknownMetadata ? "metadata_incomplete" : "unchanged";
  }

  return hasKnownInputChange
    ? "assessment_changed"
    : "assessment_changed_with_unknown_cause";
}

function determineCauseConfidence(input: {
  status: MatchAssessmentChangeAuditStatus;
  inputChanges: readonly MatchAssessmentInputChange[];
}): MatchAssessmentChangeCauseConfidence {
  if (input.status === "unchanged") {
    return "not_applicable";
  }

  const hasKnownInputChange = input.inputChanges.some(
    (change) => change.certainty === "known",
  );
  const hasUnknownMetadata = input.inputChanges.some(
    (change) => change.certainty === "unknown",
  );
  if (hasKnownInputChange && hasUnknownMetadata) {
    return "partial";
  }
  return hasKnownInputChange ? "known" : "unknown";
}

function buildSummary(input: {
  status: MatchAssessmentChangeAuditStatus;
  rankingSignalChanged: boolean;
}): string {
  switch (input.status) {
    case "unchanged":
      return "No recorded ranking input or assessment output changed.";
    case "metadata_incomplete":
      return "The assessment output is stable, but missing legacy fingerprints mean input stability cannot be proven.";
    case "inputs_changed_assessment_stable":
      return "Recorded ranking inputs changed, but the score, recommendation, and supporting assessment stayed stable.";
    case "assessment_changed":
      return input.rankingSignalChanged
        ? "Recorded ranking inputs and ranking signals changed; inspect the reasons below."
        : "Recorded ranking inputs and supporting assessment details changed, while the ranking signals stayed stable.";
    case "assessment_changed_with_unknown_cause":
      return input.rankingSignalChanged
        ? "Ranking signals changed without a recorded scorer, candidate-context, or listing-evidence change; the exact cause is unknown."
        : "Assessment details changed without a recorded input change; the exact cause is unknown.";
  }
}

export function createMatchAssessmentChangeAudit(
  input: MatchAssessmentChangeAuditInput,
): MatchAssessmentChangeAudit {
  const previous = MatchAssessmentSchema.parse(input.previous);
  const current = MatchAssessmentSchema.parse(input.current);
  const previousRank = normalizeRank(input.previousRank, "previousRank");
  const currentRank = normalizeRank(input.currentRank, "currentRank");
  const inputChanges = buildInputChanges(previous, current);
  const outputChanges = buildOutputChanges(
    previous,
    current,
    previousRank,
    currentRank,
  );
  const rankingSignalChanged = outputChanges.some(
    (change) =>
      change.code === "score_changed" ||
      change.code === "recommendation_changed" ||
      change.code === "rank_position_changed",
  );
  const status = determineStatus({ inputChanges, outputChanges });
  const causeConfidence = determineCauseConfidence({
    status,
    inputChanges,
  });

  return MatchAssessmentChangeAuditSchema.parse({
    version: 1,
    recordedAt: input.recordedAt ?? null,
    status,
    causeConfidence,
    rankingSignalChanged,
    summary: buildSummary({ status, rankingSignalChanged }),
    reasons: [
      ...inputChanges.map((change) => change.detail),
      ...outputChanges.map((change) => change.detail),
    ],
    previousMetadata: {
      scorerVersion: previous.scorerVersion,
      contextFingerprint: previous.contextFingerprint,
      postingFingerprint: previous.postingFingerprint,
    },
    currentMetadata: {
      scorerVersion: current.scorerVersion,
      contextFingerprint: current.contextFingerprint,
      postingFingerprint: current.postingFingerprint,
    },
    previousRank,
    currentRank,
    inputChanges,
    outputChanges,
  });
}
