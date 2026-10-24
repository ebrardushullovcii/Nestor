import {
  resolveSavedJobCompany,
  resolveSavedJobLocation,
  isLocationAbsenceLabel,
  isLikelyUtilityShortlistJob,
} from "@nestor/contracts";
import {
  isApplicationReturnedToShortlist,
  type ApplicationRecord,
  type ApplicationStatus,
  type AssetStatus,
  type CandidateProfile,
  type JobFinderSettings,
  type ResumeDraft,
  type ResumeExportArtifact,
  type ReviewQueueItem,
  type SavedJob,
  type TailoredAsset,
} from "@nestor/contracts";

import { compareDiscoveryJobs } from "../discovery-ordering";
import { resolveJobResumeApplicationMode } from "./job-resume-application-mode";
import { memoizeBySameElements } from "./same-elements-memo";

export { compareDiscoveryJobs };

const reviewableStatuses = new Set<ApplicationStatus>([
  "drafting",
  "ready_for_review",
  "approved",
]);

export {
  isLikelyEmptyNonDetailPosting,
  isLikelyCompanyHubUrl,
  inferEmployerFromCanonicalUrl,
  isEmployerAbsenceLabel,
  isLocationAbsenceLabel,
  resolveSavedJobCompany,
  resolveSavedJobLocation,
  isLikelyUtilityShortlistJob,
} from "@nestor/contracts";
const discoveryVisibleStatuses = new Set<ApplicationStatus>([
  "discovered",
  "shortlisted",
  "drafting",
  "ready_for_review",
  "approved",
]);

/**
 * Utility-chrome filtering is discovery-intake triage only.
 *
 * The heuristic reads titles and URL segments, so it can misread a real
 * posting (`/support/1234`, `/role/1234-engineer`). That is an acceptable cost
 * for an untouched candidate the user has never seen, but not for a row the
 * user has acted on: silently removing a shortlisted job — possibly one with
 * an approved tailored PDF — gives no message and no undo. Once a job leaves
 * `discovered`, it is curated work and stays visible.
 */
function isDiscoveryIntakeCandidate(job: Pick<SavedJob, "status">): boolean {
  return job.status === "discovered";
}

/** How long a resume written without its listing waits before a retry. */
const LISTING_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const assetStatusPriority: Record<AssetStatus, number> = {
  ready: 0,
  generating: 1,
  queued: 2,
  failed: 3,
  not_started: 4,
};

type ApplyResumeExportReference = Pick<
  ResumeExportArtifact,
  "id" | "jobId" | "isApproved" | "filePath" | "exportedAt"
>;

function getLatestApprovedExport<TExport extends ApplyResumeExportReference>(
  current: TExport | null,
  candidate: TExport,
): TExport {
  if (!current) {
    return candidate;
  }

  return new Date(candidate.exportedAt).getTime() >
    new Date(current.exportedAt).getTime()
    ? candidate
    : current;
}

export function resolveLatestApprovedExportForJob<
  TExport extends ApplyResumeExportReference,
>(jobId: string, exports: readonly TExport[]): TExport | null {
  let latest: TExport | null = null;

  for (const artifact of exports) {
    if (artifact.jobId !== jobId || !artifact.isApproved) {
      continue;
    }

    latest = getLatestApprovedExport(latest, artifact);
  }

  return latest;
}

/** Align apply gates with Shortlisted readiness: prefer draft.approvedExportId when still valid, else latest isApproved export. */
export function resolveApprovedResumeExportForApply<
  TExport extends ApplyResumeExportReference,
>(input: {
  draft: Pick<
    ResumeDraft,
    "jobId" | "status" | "approvedAt" | "approvedExportId"
  > | null;
  exports: readonly TExport[];
  asset?: Pick<TailoredAsset, "storagePath"> | null;
}): TExport | null {
  if (
    !input.draft ||
    input.draft.status !== "approved" ||
    !input.draft.approvedAt
  ) {
    return null;
  }

  const latestApproved = resolveLatestApprovedExportForJob(
    input.draft.jobId,
    input.exports,
  );

  if (input.draft.approvedExportId) {
    const linkedExport = input.exports.find(
      (entry) => entry.id === input.draft!.approvedExportId,
    );
    if (linkedExport) {
      if (
        linkedExport.isApproved ||
        (input.asset?.storagePath &&
          input.asset.storagePath === linkedExport.filePath)
      ) {
        return linkedExport;
      }
    }
  }

  return latestApproved;
}

export function isApprovedTailoredResumeReadyForApply(input: {
  draft: ResumeDraft | null;
  exports: readonly ResumeExportArtifact[];
  asset: TailoredAsset | null;
}): { ready: boolean; approvedExport: ResumeExportArtifact | null } {
  const approvedExport = resolveApprovedResumeExportForApply({
    draft: input.draft,
    exports: input.exports,
    asset: input.asset,
  });
  const ready = Boolean(
    approvedExport &&
    input.asset &&
    input.asset.status === "ready" &&
    input.asset.storagePath &&
    input.asset.storagePath === approvedExport.filePath,
  );

  return { ready, approvedExport };
}

function buildResumeReviewState(
  draft: ResumeDraft | null,
  approvedExport: ResumeExportArtifact | null,
): ReviewQueueItem["resumeReview"] {
  if (!draft) {
    return { status: "not_started" };
  }

  if (draft.status === "approved" && draft.approvedAt && approvedExport) {
    return {
      status: "approved",
      approvedAt: draft.approvedAt,
      approvedExportId: approvedExport.id,
      approvedFormat: approvedExport.format,
      approvedFilePath: approvedExport.filePath,
    };
  }

  if (draft.status === "stale") {
    return {
      status: "stale",
      staleReason: draft.staleReason ?? null,
    };
  }

  if (draft.status === "approved") {
    return {
      status: "needs_review",
    };
  }

  return {
    status: draft.status,
  };
}

export function buildReviewQueue(
  savedJobs: readonly SavedJob[],
  tailoredAssets: readonly TailoredAsset[],
  resumeDrafts: readonly ResumeDraft[],
  resumeExportArtifacts: readonly ResumeExportArtifact[],
  profile?: CandidateProfile,
  settings?: JobFinderSettings,
  /**
   * Per draft id, the lines its latest validation says still wait for the
   * person (the export gate's own rule). Drafts not listed have none.
   */
  linesToDecideByDraftId?: ReadonlyMap<string, number>,
): ReviewQueueItem[] {
  const originalResume = profile?.baseResume ?? null;
  const originalResumePath = originalResume?.storagePath?.trim() ?? "";
  const assetsByJobId = new Map(
    tailoredAssets.map((asset) => [asset.jobId, asset]),
  );
  const draftsByJobId = new Map(
    resumeDrafts.map((draft) => [draft.jobId, draft]),
  );
  const approvedExportsByJobId = new Map<string, ResumeExportArtifact>();

  for (const artifact of resumeExportArtifacts) {
    if (!artifact.isApproved) {
      continue;
    }

    approvedExportsByJobId.set(
      artifact.jobId,
      getLatestApprovedExport(
        approvedExportsByJobId.get(artifact.jobId) ?? null,
        artifact,
      ),
    );
  }

  // Every reviewable status is user-curated, so the intake chrome heuristic
  // never applies here (see `isDiscoveryIntakeCandidate`).
  return savedJobs
    .filter((job) => reviewableStatuses.has(job.status))
    .map<ReviewQueueItem>((job) => {
      const displayCompany = resolveSavedJobCompany(job);
      const resumeApplicationMode = resolveJobResumeApplicationMode(
        job,
        settings ?? {},
      );
      const usesOriginalResume = resumeApplicationMode === "original_resume";

      if (usesOriginalResume) {
        const hasOriginalResume = Boolean(
          originalResume && originalResumePath && originalResume.sha256,
        );
        return {
          jobId: job.id,
          title: job.title,
          company: displayCompany,
          location: job.location,
          matchScore: job.matchAssessment.score,
          applicationStatus: job.status,
          resumeApplicationMode,
          resumeTailoringMode: job.resumeTailoringMode ?? null,
          assetStatus: hasOriginalResume ? "ready" : "not_started",
          progressPercent: hasOriginalResume ? 100 : null,
          resumeAssetId: hasOriginalResume ? originalResume!.id : null,
          resumeReview: hasOriginalResume
            ? {
                status: "original_resume",
                sourceDocumentId: originalResume!.id,
                fileName: originalResume!.fileName,
                filePath: originalResumePath,
              }
            : { status: "not_started" },
          updatedAt:
            [originalResume?.textUpdatedAt, originalResume?.uploadedAt]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? job.discoveredAt,
        };
      }

      const asset = assetsByJobId.get(job.id) ?? null;
      const draft = draftsByJobId.get(job.id) ?? null;
      const approvedExport = approvedExportsByJobId.get(job.id) ?? null;
      const resumeReview = buildResumeReviewState(draft, approvedExport);
      const updatedAtCandidates = [
        asset?.updatedAt,
        draft?.updatedAt,
        approvedExport?.exportedAt,
        job.discoveredAt,
      ].filter((value): value is string => Boolean(value));

      return {
        jobId: job.id,
        title: job.title,
        company: displayCompany,
        location: job.location,
        matchScore: job.matchAssessment.score,
        applicationStatus: job.status,
        resumeApplicationMode,
        resumeTailoringMode: job.resumeTailoringMode ?? null,
        assetStatus: asset?.status ?? "not_started",
        progressPercent: asset?.progressPercent ?? null,
        resumeAssetId: asset?.id ?? null,
        resumeReview,
        ...(draft && (linesToDecideByDraftId?.get(draft.id) ?? 0) > 0
          ? { resumeLinesToDecide: linesToDecideByDraftId!.get(draft.id)! }
          : {}),
        // Written without the listing counts as still needing a resume, so a
        // batch tries the listing again; not within a day of the last try,
        // when the page would only fail the same way and take a batch slot.
        ...(asset?.status === "ready" &&
        asset.generationMethod === "deterministic" &&
        (asset.generationReason === "listing_text_missing" ||
          asset.generationReason === "listing_text_not_distinguishing") &&
        !(Date.now() - Date.parse(asset.updatedAt) < LISTING_RETRY_AFTER_MS)
          ? { resumeWrittenWithoutListing: true }
          : {}),
        updatedAt: updatedAtCandidates.sort().at(-1) ?? job.discoveredAt,
      };
    })
    .sort((left, right) => {
      const assetDelta =
        assetStatusPriority[left.assetStatus] -
        assetStatusPriority[right.assetStatus];

      if (assetDelta !== 0) {
        return assetDelta;
      }

      return right.matchScore - left.matchScore;
    });
}

// The utility-page check parses every job's address. Rows are immutable and
// reused between refreshes, so the verdict is worked out once per row.
const utilityVerdictByJob = new WeakMap<SavedJob, boolean>();
function isCachedUtilityShortlistJob(job: SavedJob): boolean {
  let verdict = utilityVerdictByJob.get(job);
  if (verdict === undefined) {
    verdict = isLikelyUtilityShortlistJob(job);
    utilityVerdictByJob.set(job, verdict);
  }
  return verdict;
}

/**
 * Works out the utility-page verdict of saved jobs not checked yet, a slice
 * at a time with a turn of the event loop between slices, so the list that
 * follows finds every verdict ready. At start all 20,000 rows of a large
 * workspace are new, and checking them inside one refresh held main 0.35 s.
 */
export async function warmDiscoveryJobChecks(
  jobs: readonly SavedJob[],
  view: { key: string | null; of: (job: SavedJob) => SavedJob } = {
    key: null,
    of: (job) => job,
  },
): Promise<void> {
  let checked = 0;
  for (const raw of jobs) {
    if (!isDiscoveryIntakeCandidate(raw) || !Object.isFrozen(raw)) continue;
    // A refresh after one hide sees 6,000 rows it already warmed.
    if (warmedRows.get(raw) === view.key) continue;
    isCachedUtilityShortlistJob(view.of(raw));
    warmedRows.set(raw, view.key);
    checked += 1;
    if (checked % UTILITY_CHECKS_PER_TURN === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const UTILITY_CHECKS_PER_TURN = 100;
/** Which view (plan) each frozen row was last warmed for. */
const warmedRows = new WeakMap<SavedJob, string | null>();

// Frozen jobs never change, so an unchanged refresh reuses the last
// filtered, ordered list instead of re-sorting every saved job.
const orderFrozenDiscoveryJobs = memoizeBySameElements(
  (savedJobs: readonly SavedJob[]) =>
    Object.freeze(orderDiscoveryJobs(savedJobs)) as SavedJob[],
);

export function buildDiscoveryJobs(savedJobs: readonly SavedJob[]): SavedJob[] {
  return savedJobs.every((job) => Object.isFrozen(job))
    ? orderFrozenDiscoveryJobs(savedJobs)
    : orderDiscoveryJobs(savedJobs);
}

function isVisibleDiscoveryJob(job: SavedJob): boolean {
  return (
    discoveryVisibleStatuses.has(job.status) &&
    (!isDiscoveryIntakeCandidate(job) || !isCachedUtilityShortlistJob(job))
  );
}

/**
 * The saved jobs Find jobs lists, unordered and unchanged. For a caller that
 * ranks its own views of them (the workspace read does).
 */
export function selectVisibleDiscoveryJobs(
  savedJobs: readonly SavedJob[],
): SavedJob[] {
  return savedJobs.filter(isVisibleDiscoveryJob);
}

function orderDiscoveryJobs(savedJobs: readonly SavedJob[]): SavedJob[] {
  return savedJobs
    .filter(isVisibleDiscoveryJob)
    .map((job) => {
      const company = resolveSavedJobCompany(job);
      const location = resolveSavedJobLocation(job);
      if (
        company === job.company &&
        (location === null
          ? isLocationAbsenceLabel(job.location)
          : location === job.location)
      ) {
        // When location is an absence label, keep the stored string for schema
        // compatibility but discovery UI formatters hide it.
        return job;
      }

      return {
        ...job,
        company,
        ...(location ? { location } : {}),
      };
    })
    .sort(compareDiscoveryJobs);
}

/**
 * Applications, newest first. One the person moved back to Shortlisted is
 * left out until the next Apply writes to it; Shortlisted shows the job.
 */
export function buildApplicationRecords(
  savedApplicationRecords: readonly ApplicationRecord[],
): ApplicationRecord[] {
  return savedApplicationRecords
    .filter((record) => !isApplicationReturnedToShortlist(record))
    .sort(
      (left, right) =>
        new Date(right.lastUpdatedAt).getTime() -
        new Date(left.lastUpdatedAt).getTime(),
    );
}
