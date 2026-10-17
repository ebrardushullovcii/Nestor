import {
  SourceInstructionArtifactSchema,
  type JobDiscoveryTarget,
  type JobSource,
  type SourceDebugRunRecord,
  type SourceDebugWorkerAttempt,
  type SourceInstructionArtifact,
} from "@nestor/contracts";
import {
  collectAttemptInstructionGuidance,
  filterSourceDebugWarnings,
  type SourceInstructionReviewOverride,
} from "./source-instructions";
import { normalizeText, uniqueStrings } from "./shared";
import { buildSourceInstructionVersionInfo } from "./workspace-helpers";
import { buildSourceIntelligenceArtifact } from "./workspace-source-intelligence";

/**
 * Files the check's own notes by the field the agent wrote them in. The
 * labels are the ones the source check put on its finish fields; nothing here
 * reads what a line says (ADR 0041). The final review re-files them.
 */
function fileCheckNotes(lines: readonly string[]): {
  navigation: string[];
  search: string[];
  detail: string[];
  apply: string[];
} {
  const filed = {
    navigation: [] as string[],
    search: [] as string[],
    detail: [] as string[],
    apply: [] as string[],
  };
  for (const line of lines) {
    if (/^(?:reliable control|filter note):/iu.test(line)) {
      filed.search.push(line);
    } else if (/^apply note:/iu.test(line)) {
      filed.apply.push(line);
    } else {
      filed.navigation.push(line);
    }
  }
  return filed;
}

function cleanLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => {
      const key = normalizeText(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * The instruction a source check leaves for future searches on its site.
 *
 * The model's final review organizes the check's notes: what to keep, what
 * contradicts what, which category a line belongs to, and whether a future
 * search can rely on them (ADR 0041). Its lists and its call stand. Without that review
 * the check's own notes are kept as a draft.
 */
export function synthesizeSourceInstructionArtifact(
  target: JobDiscoveryTarget,
  run: SourceDebugRunRecord,
  attempts: readonly SourceDebugWorkerAttempt[],
  adapterKind: JobSource,
  verification: SourceInstructionArtifact["verification"],
  reviewOverride?: SourceInstructionReviewOverride | null,
  currentArtifact?: SourceInstructionArtifact | null,
): SourceInstructionArtifact {
  const hasPartialTimeoutEvidence = attempts.some(
    (attempt) => attempt.completionMode === "timed_out_with_partial_evidence",
  );
  const hasUnstructuredFailure = attempts.some(
    (attempt) =>
      attempt.completionMode === "timed_out_without_evidence" ||
      attempt.completionMode === "runtime_failed" ||
      attempt.completionMode === "interrupted" ||
      attempt.completionMode === "stalled",
  );
  const checkNotes = fileCheckNotes(
    uniqueStrings(attempts.flatMap(collectAttemptInstructionGuidance)),
  );
  const pick = (
    reviewed: string[] | null | undefined,
    draft: readonly string[],
  ): string[] => cleanLines(reviewOverride ? (reviewed ?? draft) : draft);
  const navigationGuidance = pick(
    reviewOverride?.navigationGuidance,
    checkNotes.navigation,
  );
  const searchGuidance = pick(
    reviewOverride?.searchGuidance,
    checkNotes.search,
  );
  const detailGuidance = pick(
    reviewOverride?.detailGuidance,
    checkNotes.detail,
  );
  const applyGuidance = pick(reviewOverride?.applyGuidance, checkNotes.apply);
  const warnings = uniqueStrings([
    ...cleanLines(reviewOverride?.warnings ?? []),
    ...filterSourceDebugWarnings(
      attempts.flatMap((attempt) => [attempt.blockerSummary]),
    ),
    ...(hasPartialTimeoutEvidence
      ? [
          "The check ran out of time before it could finish its report, so this guidance is partial. Check the source again to complete it.",
        ]
      : []),
    ...(hasUnstructuredFailure
      ? [
          "The check ended before it could report what it learned, so this guidance is a draft. Check the source again to complete it.",
        ]
      : []),
  ]);
  const hasGuidance =
    navigationGuidance.length + searchGuidance.length + detailGuidance.length >
    0;
  const status =
    verification?.outcome === "passed" &&
    reviewOverride?.ready === true &&
    hasGuidance &&
    !hasPartialTimeoutEvidence &&
    !hasUnstructuredFailure
      ? "validated"
      : warnings.some((warning) =>
            warning.toLowerCase().includes("unsupported"),
          )
        ? "unsupported"
        : "draft";
  const intelligence =
    reviewOverride?.intelligence ??
    buildSourceIntelligenceArtifact({
      target,
      attempts,
      currentArtifact: currentArtifact ?? null,
    });

  return SourceInstructionArtifactSchema.parse({
    id:
      run.instructionArtifactId ??
      `source_instruction_${target.id}_${Date.now()}`,
    targetId: target.id,
    status,
    createdAt: attempts[0]?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    acceptedAt: status === "validated" ? new Date().toISOString() : null,
    basedOnRunId: run.id,
    basedOnAttemptIds: attempts.map((attempt) => attempt.id),
    notes: run.finalSummary ?? null,
    navigationGuidance,
    searchGuidance,
    detailGuidance,
    applyGuidance,
    warnings,
    intelligence,
    versionInfo: buildSourceInstructionVersionInfo(adapterKind),
    verification,
  });
}
