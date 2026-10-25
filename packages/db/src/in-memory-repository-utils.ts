import type {
  ResumeDocumentBundle,
  ResumeDraft,
  ResumeExportArtifact,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  ResumeResearchArtifact,
  ResumeValidationResult,
} from "@nestor/contracts";

export function upsertById<TValue extends { id: string }>(
  current: readonly TValue[],
  nextValue: TValue,
): TValue[] {
  const nextValues = [...current];
  const existingIndex = nextValues.findIndex(
    (entry) => entry.id === nextValue.id,
  );

  if (existingIndex >= 0) {
    nextValues[existingIndex] = nextValue;
  } else {
    nextValues.push(nextValue);
  }

  return nextValues;
}

function sortByDateDesc<TValue extends { id?: string }>(
  values: readonly TValue[],
  getDate: (value: TValue) => string,
): TValue[] {
  return [...values].sort((left, right) => {
    const difference =
      new Date(getDate(right)).getTime() - new Date(getDate(left)).getTime();
    return difference !== 0
      ? difference
      : String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}

export function sortResumeDrafts<
  TValue extends { id?: string; updatedAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.updatedAt);
}

export function sortNewestFirst<
  TValue extends { id?: string; createdAt: string },
>(values: readonly TValue[]): TValue[] {
  return sortByDateDesc(values, (value) => value.createdAt);
}

export function sortValidationResults(
  values: readonly ResumeValidationResult[],
): ResumeValidationResult[] {
  return sortByDateDesc(values, (value) => value.validatedAt);
}

export function sortExports(
  values: readonly ResumeExportArtifact[],
): ResumeExportArtifact[] {
  return sortByDateDesc(values, (value) => value.exportedAt);
}

export function sortResearch(
  values: readonly ResumeResearchArtifact[],
): ResumeResearchArtifact[] {
  return sortByDateDesc(values, (value) => value.fetchedAt);
}

export function sortImportRuns(
  values: readonly ResumeImportRun[],
): ResumeImportRun[] {
  return sortByDateDesc(values, (value) => value.startedAt);
}

export function sortMessages<TValue extends { id?: string; createdAt: string }>(
  values: readonly TValue[],
): TValue[] {
  return [...values].sort((left, right) => {
    const difference =
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return difference !== 0
      ? difference
      : String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}

export function clearApprovedResumeExportsForJob<
  TValue extends { jobId: string; isApproved: boolean },
>(values: readonly TValue[], jobId: string): TValue[] {
  return values.map((entry) =>
    entry.jobId === jobId ? { ...entry, isApproved: false } : entry,
  );
}

export function resolveApprovedExportId(
  currentArtifacts: readonly ResumeExportArtifact[],
  draft: ResumeDraft,
): string | null {
  if (!draft.approvedExportId) {
    return null;
  }

  return currentArtifacts.some(
    (artifact) =>
      artifact.id === draft.approvedExportId &&
      artifact.draftId === draft.id &&
      artifact.jobId === draft.jobId,
  )
    ? draft.approvedExportId
    : null;
}

export function replaceArtifactsForRun(
  currentBundles: readonly ResumeDocumentBundle[],
  currentCandidates: readonly ResumeImportFieldCandidate[],
  runId: string,
  documentBundles: readonly ResumeDocumentBundle[],
  fieldCandidates: readonly ResumeImportFieldCandidate[],
) {
  return {
    bundles: [
      ...currentBundles.filter((bundle) => bundle.runId !== runId),
      ...documentBundles,
    ],
    candidates: [
      ...currentCandidates.filter((candidate) => candidate.runId !== runId),
      ...fieldCandidates,
    ],
  };
}
