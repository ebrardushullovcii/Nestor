import {
  ApplicationRecordSchema,
  type ApplicationRecord,
  type ResumeDraft,
  type ResumeExportArtifact,
  type TailoredAsset,
} from "@nestor/contracts";

import type { JobFinderRepository } from "@nestor/db";

import { withApplicationRecordTransition } from "./application-crm";
import { isApprovedTailoredResumeReadyForApply } from "./matching-review-queue";
import { mergeEvents } from "./workspace-helpers";

function buildMissingResumeBlockerClearance(
  record: ApplicationRecord,
  detectedAt: string,
): ApplicationRecord {
  const wasResumeReview = record.latestBlocker?.code === "requires_manual_review";
  return ApplicationRecordSchema.parse({
    ...record,
    latestBlocker: null,
    lastActionLabel: wasResumeReview
      ? "Resume review completed and the approved resume is ready."
      : "Approved tailored resume is ready for this job.",
    nextActionLabel: "Retry preparation when you are ready.",
    lastUpdatedAt: detectedAt,
    events: mergeEvents(record.events, [
      {
        id: `event_${record.id}_missing_resume_cleared`,
        at: detectedAt,
        title: wasResumeReview
          ? "Resume review completed"
          : "Tailored resume approved",
        detail:
          wasResumeReview
            ? "The resume-review blocker cleared after the reviewed resume was approved and became ready for apply."
            : "The missing-resume blocker cleared after resume approval became ready for apply.",
        emphasis: "positive",
      },
    ]),
  });
}

export function listStaleMissingResumeBlockerClearances(input: {
  applicationRecords: readonly ApplicationRecord[];
  resumeDrafts: readonly ResumeDraft[];
  resumeExportArtifacts: readonly ResumeExportArtifact[];
  tailoredAssets: readonly TailoredAsset[];
  detectedAt: string;
}): ApplicationRecord[] {
  const draftsByJobId = new Map(
    input.resumeDrafts.map((draft) => [draft.jobId, draft] as const),
  );
  const assetsByJobId = new Map(
    input.tailoredAssets.map((asset) => [asset.jobId, asset] as const),
  );
  const exportsByJobId = new Map<string, ResumeExportArtifact[]>();

  for (const artifact of input.resumeExportArtifacts) {
    const existing = exportsByJobId.get(artifact.jobId) ?? [];
    existing.push(artifact);
    exportsByJobId.set(artifact.jobId, existing);
  }

  const clearances: ApplicationRecord[] = [];

  for (const record of input.applicationRecords) {
    if (
      record.latestBlocker?.code !== "missing_resume" &&
      record.latestBlocker?.code !== "requires_manual_review"
    ) {
      continue;
    }

    const draft = draftsByJobId.get(record.jobId) ?? null;
    const ready = isApprovedTailoredResumeReadyForApply({
      draft,
      exports: exportsByJobId.get(record.jobId) ?? [],
      asset: assetsByJobId.get(record.jobId) ?? null,
    }).ready;

    if (!ready) {
      continue;
    }
    // A completed review clears only an older review blocker. If a new
    // blocker was recorded after approval, the draft has drifted and the
    // current decision still needs attention.
    if (
      record.latestBlocker.code === "requires_manual_review" &&
      (!draft?.approvedAt || draft.approvedAt < record.lastUpdatedAt)
    ) {
      continue;
    }

    clearances.push(
      buildMissingResumeBlockerClearance(record, input.detectedAt),
    );
  }

  return clearances;
}

export async function reconcileStaleMissingResumeBlockers(
  repository: JobFinderRepository,
  input: {
    applicationRecords: readonly ApplicationRecord[];
    resumeDrafts: readonly ResumeDraft[];
    resumeExportArtifacts: readonly ResumeExportArtifact[];
    tailoredAssets: readonly TailoredAsset[];
    detectedAt: string;
  },
): Promise<ApplicationRecord[]> {
  const clearances = listStaleMissingResumeBlockerClearances(input);
  if (clearances.length === 0) {
    return [...input.applicationRecords];
  }

  const reconciledRecords = await Promise.all(
    clearances.map((staleClearance) =>
      withApplicationRecordTransition(
        repository,
        staleClearance.id,
        async () => {
          const currentRecord = (
            await repository.listApplicationRecords()
          ).find((record) => record.id === staleClearance.id);
          if (!currentRecord) {
            return null;
          }

          const [currentClearance] = listStaleMissingResumeBlockerClearances({
            ...input,
            applicationRecords: [currentRecord],
          });
          if (!currentClearance) {
            return currentRecord;
          }

          await repository.upsertApplicationRecord(currentClearance);
          return currentClearance;
        },
      ),
    ),
  );
  const reconciledById = new Map(
    reconciledRecords
      .filter((record): record is ApplicationRecord => record !== null)
      .map((record) => [record.id, record] as const),
  );

  return input.applicationRecords.map(
    (record) => reconciledById.get(record.id) ?? record,
  );
}
