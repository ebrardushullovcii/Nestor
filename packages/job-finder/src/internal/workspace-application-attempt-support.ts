import {
  ApplicationAttemptBlockerSchema,
  type ApplyExecutionResult,
  type ApplicationAttempt,
  type ApplicationAttemptBlocker,
  type ApplicationAttemptConsentDecision,
  type ApplicationAttemptQuestion,
  type BrowserVisualEvidenceSummary,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import { uniqueStrings } from "./shared";

export function buildQuestionSummary(
  questions: readonly ApplicationAttemptQuestion[],
) {
  const required = questions.filter((question) => question.isRequired).length;
  const answered = questions.filter(
    (question) =>
      question.status === "answered" || question.status === "submitted",
  ).length;
  // What the person is waiting on is every question the run handed back, not
  // only the ones the site marked with a star: an optional field Job Finder
  // could not answer is still a field they have to answer. The screens count
  // this, so it has to be the same list they are shown.
  const unansweredRequired = questions.filter(
    (question) =>
      question.status !== "answered" && question.status !== "submitted",
  ).length;

  return {
    total: questions.length,
    required,
    answered,
    unansweredRequired,
  };
}

export function buildConsentSummary(
  consentDecisions: readonly ApplicationAttemptConsentDecision[],
) {
  const pendingCount = consentDecisions.filter(
    (decision) => decision.status === "requested",
  ).length;

  if (pendingCount > 0) {
    return {
      status: "requested" as const,
      pendingCount,
    };
  }

  if (consentDecisions.some((decision) => decision.status === "declined")) {
    return {
      status: "declined" as const,
      pendingCount: 0,
    };
  }

  if (consentDecisions.some((decision) => decision.status === "approved")) {
    return {
      status: "approved" as const,
      pendingCount: 0,
    };
  }

  return {
    status: "none" as const,
    pendingCount: 0,
  };
}

export function buildReplaySummary(
  replay: ApplicationAttempt["replay"],
  visualEvidence: readonly BrowserVisualEvidenceSummary[] = [],
) {
  const retainedVisualEvidenceCount = visualEvidence.filter(
    (evidence) => evidence.retention !== "temporary",
  ).length;

  return {
    lastUrl: replay.lastUrl,
    checkpointCount: replay.checkpointUrls.length,
    evidenceCount:
      replay.sourceDebugEvidenceRefIds.length + retainedVisualEvidenceCount,
    sourceInstructionArtifactId: replay.sourceInstructionArtifactId,
  };
}

export function buildEvidenceRefIdsFromInstruction(input: {
  activeInstruction: SourceInstructionArtifact | null;
  sourceDebugAttempts: readonly SourceDebugWorkerAttempt[];
}): string[] {
  if (!input.activeInstruction) {
    return [];
  }

  const attemptIds = new Set(input.activeInstruction.basedOnAttemptIds);

  return uniqueStrings(
    input.sourceDebugAttempts.flatMap((attempt) =>
      attemptIds.has(attempt.id) ? attempt.evidenceRefIds : [],
    ),
  );
}

export function mergeAttemptBlocker(input: {
  blocker: ApplyExecutionResult["blocker"];
  sourceDebugEvidenceRefIds: readonly string[];
  defaultUrl: string | null;
}): ApplicationAttemptBlocker | null {
  if (!input.blocker) {
    return null;
  }

  return ApplicationAttemptBlockerSchema.parse({
    ...input.blocker,
    sourceDebugEvidenceRefIds: uniqueStrings([
      ...input.sourceDebugEvidenceRefIds,
      ...input.blocker.sourceDebugEvidenceRefIds,
    ]),
    url: input.blocker.url ?? input.defaultUrl,
  });
}

export function mergeAttemptReplay(input: {
  replay: ApplyExecutionResult["replay"];
  activeInstruction: SourceInstructionArtifact | null;
  sourceDebugEvidenceRefIds: readonly string[];
  fallbackUrl: string | null;
}) {
  return {
    sourceInstructionArtifactId:
      input.replay.sourceInstructionArtifactId ?? input.activeInstruction?.id ?? null,
    sourceDebugEvidenceRefIds: uniqueStrings([
      ...input.sourceDebugEvidenceRefIds,
      ...input.replay.sourceDebugEvidenceRefIds,
    ]),
    lastUrl: input.replay.lastUrl ?? input.fallbackUrl,
    checkpointUrls: uniqueStrings(input.replay.checkpointUrls),
  };
}

export function buildLatestBlockerSummary(
  blocker: ApplicationAttemptBlocker | null,
): { code: ApplicationAttemptBlocker["code"]; summary: string } | null {
  if (!blocker) {
    return null;
  }

  return {
    code: blocker.code,
    summary: blocker.summary,
  };
}
