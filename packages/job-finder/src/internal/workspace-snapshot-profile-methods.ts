import { withResumeBatchLiveness } from "./resume-batch-checkpoint";
import { groupCompanyConflicts } from "./same-company-sends";
import { readPlanAssessment } from "./plan-assessment";
import { readSalaryDisclosurePreference } from "./salary-disclosure-preference";
import { hasVerifiedApplicationSubmission } from "./workspace-apply-run-support";
import {
  isUnsentPreparedApplication,
  retireLostPreparedApplication,
} from "./application-page-lifecycle";
import {
  type ApplicationCrmSettings,
  type JobDiscoveryTarget,
  ApplicationCrmSettingsSchema,
  AiBehaviorPreferenceSchema,
  CoverLetterPreferenceSchema,
  AppearanceThemeSchema,
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  ResumeDocumentBundleSchema,
  ResumeDraftSummarySchema,
  ResumeExportArtifactSummarySchema,
  ResumeResearchArtifactSummarySchema,
  ProfileRevisionSummarySchema,
  ResumeSourceDocumentSchema,
  SourceDebugRunRecordSchema,
  UpdateAiBehaviorInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  type AppearanceTheme,
  type ApplicationRecord,
  type BrowserSessionState,
  type ApplyJobResult,
  type ApplyRun,
  type CandidateProfile,
  type JobFinderSettings,
  type JobFinderDiscoveryState,
  type JobFinderWorkspaceSnapshot,
  type JobSearchCampaign,
  type JobSearchCampaignCollection,
  type JobSearchPreferences,
  type JobSource,
  isBlockingResumeClaimAssessment,
  isListableCompanyName,
  type ProfileSetupState,
  type ResumeApplicationMode,
  type ResumeTimelineRepairAction,
  type DiscoveryJobView,
  type SavedJob,
  type UpdateAiBehaviorInput,
  type UpdateApplicationDefaultsInput,
  type UpdateWorkspaceBehaviorInput,
  type UserActionRequest,
} from "@nestor/contracts";
import { reassessSavedJobs } from "./saved-job-reassessment";
import { createMatchAssessmentContextFingerprint } from "./match-assessment-session";
import type { JobFinderRepositorySeed } from "@nestor/db";
import { readSavedJobProjectionChanges } from "@nestor/db";
import { mergeSortedRowChanges } from "./sorted-row-changes";
import { createListingActivityChangeResolver } from "./listing-activity-changes";

import { runApplicationNoResponseAutomation } from "./application-crm";
import {
  buildApplicationRecords,
  buildReviewQueue,
  compareDiscoveryJobs,
} from "./matching";
import {
  selectVisibleDiscoveryJobs,
  warmDiscoveryJobChecks,
} from "./matching-review-queue";
import {
  deriveAndPersistProfileSetupState,
  landProfileSetupAfterImport,
} from "./profile-workspace-state";
import { resolvePendingReviewItemsAfterExplicitSave } from "./profile-setup-review-items";
import { normalizeProfileBeforeSave } from "./profile-merge";
import {
  isResumeImportActiveInProcess,
  runResumeImportWorkflow,
} from "./resume-import-workflow";
import { persistResumeTimelineRepairAction } from "./resume-timeline-repair";
import {
  hasResumeAffectingProfileChange,
  hasResumeAffectingSettingsChange,
} from "./resume-workspace-staleness";
import { selectLatestApplyRunId } from "./workspace-apply-run-support";
import {
  groupApplyJobResultsByRunId,
  isInterruptedApplyJobState,
  isRecoveryTerminalizedApplyRun,
  recoverInterruptedApplyJobResult,
  recoverInterruptedApplyRun,
  recoverInterruptedExactLineageProjections,
  refreshTerminalizedApplyRunCounters,
  cancelInterruptedApplyJobResult,
  isSafelyParkedApplyQueue,
} from "./workspace-apply-run-recovery";
import { persistAutomaticApplicationSafeguards } from "./automatic-safeguards";
import { reconcileAutomaticBatchSampleReviews } from "./automatic-batch-review-recovery";
import { reconcileStaleMissingResumeBlockers } from "./workspace-application-blocker-sync";
import { terminalizeApplicationAfterPreparedPageLost } from "./workspace-application-user-action";
import { recordCampaignDiscoveryResult } from "./workspace-campaign-methods";
import { recoverInterruptedDiscoveryRun } from "./workspace-discovery-run-helpers";
import {
  deriveSourceAccessPrompts,
  resolveSourceBrowserEntryUrl,
} from "./workspace-source-access-prompts";
import { createBrowserSessionSnapshot } from "./workspace-service-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import {
  resolveAdapterKind,
  getPreferredSessionAdapter,
  invalidateChangedSourceGuidance,
  normalizeJobFinderSettings,
  normalizeResumeDraftTemplate,
  normalizeSearchPreferences,
} from "./workspace-helpers";
import { uniqueStrings } from "./shared";
import { SOURCE_DEBUG_RECENT_HISTORY_LIMIT } from "./workspace-defaults";
import { createWorkspaceProfileCopilotMethods } from "./workspace-profile-copilot-methods";
import { createWorkspaceProfileSetupContextHelpers } from "./workspace-profile-setup-context";
import { createWorkspaceProfileSetupReviewMethods } from "./workspace-profile-setup-review-methods";
import type { JobFinderWorkspaceService } from "./workspace-service-contracts";
import {
  deriveCampaignProgress,
  deriveDashboardSummary,
  createCampaign,
  ensureCampaignState,
} from "./campaign-dashboard";
import {
  projectDiscoveryJobViews,
  inactiveListingLedger,
} from "./listing-activity";
import { createSyncedJobIdentityIndex } from "./discovery-run-indexes";
import { warmDiscoveryLedgerIndex } from "./workspace-discovery-ledger";
import {
  deriveGlobalDailyApplicationPreparationCapacity,
  MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
} from "./application-preparation-capacity";
import { memoizeSortedBySameElements } from "./same-elements-memo";
import { settleStoredResumeDrafts } from "./resume-settle-stored-drafts";
import { rebindLegacyFitVerdicts } from "./legacy-fit-fingerprints";

const realSetImmediate = globalThis.setImmediate;
const nextTurn = () =>
  new Promise<void>((resolve) => realSetImmediate(resolve));

// Each list keeps its own last ordering: a refresh that changed no job reuses
// it, and one that changed a few merges them in instead of sorting thousands
// of jobs again. The result is frozen so later display projections can reuse
// their own work for it too.
function rankBySameElements<T extends SavedJob>() {
  return memoizeSortedBySameElements<T>(compareDiscoveryJobs);
}
const rankDiscoveryJobs = rankBySameElements<DiscoveryJobView>();
const rankDismissedJobs = rankBySameElements<DiscoveryJobView>();
const rankCompanyJobs = rankBySameElements<SavedJob>();

type JobViewInput = {
  rawSavedJobs: readonly SavedJob[];
  planId: string | null;
  pendingDiscoveryJobs: readonly SavedJob[];
  discoveryLedger: Parameters<
    typeof projectDiscoveryJobViews<SavedJob>
  >[0]["discoveryLedger"];
  listingSignals: Parameters<
    typeof projectDiscoveryJobViews<SavedJob>
  >[0]["listingSignals"];
  applicationAttempts: NonNullable<
    Parameters<
      typeof projectDiscoveryJobViews<SavedJob>
    >[0]["applicationAttempts"]
  >;
  companies: readonly { canonicalName: string; jobIds: readonly string[] }[];
};

type JobViewIdentityIndex = NonNullable<
  Parameters<typeof projectDiscoveryJobViews<SavedJob>>[0]["identityIndex"]
>;

/** The workspace's job lists, from its saved and staged jobs. */
function buildJobViews(
  input: JobViewInput,
  identityIndex?: JobViewIdentityIndex,
) {
  const savedJobs = input.rawSavedJobs.map((job) =>
    readPlanAssessment(job, input.planId),
  );
  // Ranked below with the rest of the list; ordering them here as well
  // sorted every saved job twice on each refresh.
  const persistedDiscoveryJobs = selectVisibleDiscoveryJobs(savedJobs);
  const savedJobIds = new Set(savedJobs.map((job) => job.id));
  const mergedPendingJobs = input.pendingDiscoveryJobs
    .filter((job) => !savedJobIds.has(job.id))
    .map((job) => readPlanAssessment(job, input.planId));
  // Listing activity is projected before anything is ranked: a listing whose
  // own text says it is closed must already be marked closed when the
  // ordering decides what comes first.
  const projectedJobs = projectDiscoveryJobViews({
    jobs: [...savedJobs, ...mergedPendingJobs],
    discoveryLedger: input.discoveryLedger,
    listingSignals: input.listingSignals,
    applicationAttempts: input.applicationAttempts,
    identityJobs:
      input.pendingDiscoveryJobs.length === 0
        ? input.rawSavedJobs
        : [
            ...input.rawSavedJobs,
            ...input.pendingDiscoveryJobs.filter(
              (job) => !savedJobIds.has(job.id),
            ),
          ],
    ...(identityIndex ? { identityIndex } : {}),
  });
  const projectedJobById = new Map(
    projectedJobs.map((job) => [job.id, job] as const),
  );
  const project = (jobs: readonly SavedJob[]) =>
    jobs.flatMap((job) => {
      const projected = projectedJobById.get(job.id);
      return projected ? [projected] : [];
    });
  const discoveryJobs = rankDiscoveryJobs(
    project([...persistedDiscoveryJobs, ...mergedPendingJobs]),
  );
  const projectedDismissedDiscoveryJobs = rankDismissedJobs(
    project(
      savedJobs.filter(
        (job) => job.status === "archived" && job.discoveryFeedback !== null,
      ),
    ),
  );
  const companyJobIds = new Set(
    input.companies
      .filter((company) => isListableCompanyName(company.canonicalName))
      .flatMap((company) => company.jobIds),
  );
  const companyJobById = new Map<string, SavedJob>();
  for (const job of savedJobs) {
    if (companyJobIds.has(job.id) && !companyJobById.has(job.id)) {
      companyJobById.set(job.id, job);
    }
  }
  const companyJobs = rankCompanyJobs([...companyJobById.values()]).flatMap(
    (job) => {
      const projected = projectedJobById.get(job.id);
      return projected ? [projected] : [];
    },
  );
  // Kept between refreshes, so never edited after this.
  Object.freeze(savedJobs);
  Object.freeze(companyJobs);
  return {
    savedJobs,
    discoveryJobs,
    projectedDismissedDiscoveryJobs,
    companyJobs,
    projectedJobById,
    companyJobIds,
  };
}

// What a display read still validates once the collections it borrows are
// left out. Search preferences and plans were validated when they were
// normalized and reconciled above. Built once: a fresh schema per refresh
// loses Zod's cached shape.
const BorrowedSnapshotRestSchema = JobFinderWorkspaceSnapshotSchema.omit({
  discoveryJobs: true,
  dismissedDiscoveryJobs: true,
  companyJobs: true,
  activeDiscoveryRun: true,
  recentDiscoveryRuns: true,
  activeSourceDebugRun: true,
  recentSourceDebugRuns: true,
  tailoredAssets: true,
  resumeDrafts: true,
  resumeExportArtifacts: true,
  resumeResearchArtifacts: true,
  applyRuns: true,
  applyJobResults: true,
  applicationRecords: true,
  applicationAttempts: true,
  sourceInstructionArtifacts: true,
  profileCopilotMessages: true,
  profileRevisions: true,
  userActionRequests: true,
  userActionEvents: true,
  searchPreferences: true,
  campaigns: true,
  intelligence: true,
});

const BOOTSTRAP_DEFERRED_COLLECTIONS = [
  "discovery_jobs",
  "review_queue",
  "applications",
  "source_history",
  "documents",
  "intelligence",
] as const;

/** The workspace has nothing for a Home tier to show yet (no plans). */
class HomeTierUnavailableError extends Error {}

const NO_RESPONSE_AUTOMATION_MIN_INTERVAL_MS = 5 * 60 * 1000;

const RESUME_SETTINGS_STALE_REASON =
  "Resume settings changed after approval and the resume needs a fresh review.";

const ACTIVE_REVIEW_JOB_STATUSES = new Set<SavedJob["status"]>([
  "drafting",
  "ready_for_review",
  "approved",
]);

/** Small DTOs are parsed once per immutable row, never once per refresh. */
function summaryProjection<T extends object, U extends object>(
  parse: (row: T) => U,
) {
  const rows = new WeakMap<T, U>();
  const collections = new WeakMap<readonly T[], U[]>();
  return (source: readonly T[]): U[] => {
    const reusable = Object.isFrozen(source);
    const cached = reusable ? collections.get(source) : undefined;
    if (cached) return cached;
    const result = source.map((row) => {
      const borrowed = Object.isFrozen(row);
      const previous = borrowed ? rows.get(row) : undefined;
      if (previous) return previous;
      const value = parse(row);
      if (borrowed) {
        Object.freeze(value);
        rows.set(row, value);
      }
      return value;
    });
    if (reusable) {
      Object.freeze(result);
      collections.set(source, result);
    }
    return result;
  };
}

const draftSummaries = summaryProjection((row: object) =>
  ResumeDraftSummarySchema.parse(row),
);
const exportSummaries = summaryProjection((row: object) =>
  ResumeExportArtifactSummarySchema.parse(row),
);
const researchSummaries = summaryProjection((row: object) =>
  ResumeResearchArtifactSummarySchema.parse(row),
);
const revisionSummaries = summaryProjection((row: object) =>
  ProfileRevisionSummarySchema.parse(row),
);

/**
 * The browser lane a workspace with no persisted adapter session is actually
 * on. Asking the runtime is cheap (it reports its current state and never
 * launches anything), and it keeps a cold start from being reported as the
 * catalog-only lane while the app is really running an agent-backed browser.
 * Returns null whenever a session already exists or the runtime cannot answer.
 */
async function readUninitializedRuntimeSession(
  ctx: Pick<WorkspaceServiceContext, "browserRuntime">,
  sessions: ReadonlyArray<JobFinderDiscoveryState["sessions"][number]>,
  preferredAdapter: JobSource,
): Promise<BrowserSessionState | null> {
  if (sessions.length > 0) {
    return null;
  }

  return ctx.browserRuntime.getSessionState(preferredAdapter).catch(() => null);
}

function pickDefined<TValue>(
  input: Record<string, TValue>,
): Record<string, TValue> {
  const result: Record<string, TValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Pins the previous default CV mode onto active jobs that never chose one,
 * so changing the default cannot silently rewrite in-flight applications.
 */
function capturePreviousResumeApplicationMode(
  previousResumeApplicationMode: ResumeApplicationMode,
): (job: SavedJob) => SavedJob {
  return (job) =>
    job.resumeApplicationMode === null &&
    ACTIVE_REVIEW_JOB_STATUSES.has(job.status)
      ? { ...job, resumeApplicationMode: previousResumeApplicationMode }
      : job;
}

/**
 * Newer of two optional dashboard instants. Progress merges use this so a
 * terminal commit that serialized ahead of a parked projection keeps the
 * later `lastRunAt`/`lastUpdatedAt` instead of being regressed by it.
 */
function laterIsoTimestamp(left: string, right: string | null): string;
function laterIsoTimestamp(
  left: string | null,
  right: string | null,
): string | null;
function laterIsoTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) >= Date.parse(left) ? right : left;
}

function resolveCampaignForJobs(
  campaignIdsByJobId: ReadonlyMap<string, ReadonlySet<string>>,
  jobIds: readonly string[],
): string | null {
  if (jobIds.length === 0) return null;
  const candidates = campaignIdsByJobId.get(jobIds[0]!);
  if (!candidates) return null;
  let campaignId: string | null = null;
  for (const id of candidates) {
    if (!jobIds.every((jobId) => campaignIdsByJobId.get(jobId)?.has(id)))
      continue;
    if (campaignId !== null) return null;
    campaignId = id;
  }
  return campaignId;
}

function onlyValue(values: ReadonlySet<string>): string | null {
  if (values.size !== 1) return null;
  for (const value of values) return value;
  return null;
}

function projectCampaignApplicationFacts(input: {
  activeCampaign: JobSearchCampaign;
  campaigns: readonly JobSearchCampaign[];
  applicationRecords: readonly ApplicationRecord[];
  applyJobResults: readonly ApplyJobResult[];
  applyRuns: readonly ApplyRun[];
  userActionRequests: readonly UserActionRequest[];
}) {
  // Resolve lineage through the job's memberships rather than scanning every
  // campaign for each run, record and action request. A group shared by more
  // than one campaign remains ambiguous and is still excluded.
  const campaignIdsByJobId = new Map<string, Set<string>>();
  for (const [id, campaign] of new Map(
    input.campaigns.map((campaign) => [campaign.id, campaign]),
  )) {
    for (const jobId of campaign.jobIds) {
      const memberships = campaignIdsByJobId.get(jobId) ?? new Set<string>();
      memberships.add(id);
      campaignIdsByJobId.set(jobId, memberships);
    }
  }
  const activeSourceTargetIds = new Set(input.activeCampaign.sourceTargetIds);
  const runCampaignById = new Map(
    input.applyRuns.map((run) => [
      run.id,
      run.campaignId ?? resolveCampaignForJobs(campaignIdsByJobId, run.jobIds),
    ]),
  );
  const resultsByApplicationRecordId = new Map<string, ApplyJobResult[]>();
  for (const result of input.applyJobResults) {
    if (!result.applicationRecordId) continue;
    const results =
      resultsByApplicationRecordId.get(result.applicationRecordId) ?? [];
    results.push(result);
    resultsByApplicationRecordId.set(result.applicationRecordId, results);
  }
  const recordCampaignById = new Map<string, string | null>();

  for (const record of input.applicationRecords) {
    const linkedResults = resultsByApplicationRecordId.get(record.id) ?? [];
    const linkedCampaignIds = new Set(
      linkedResults.flatMap((result) => {
        const campaignId = runCampaignById.get(result.runId) ?? null;
        return campaignId ? [campaignId] : [];
      }),
    );
    const campaignId =
      linkedResults.length > 0
        ? onlyValue(linkedCampaignIds)
        : resolveCampaignForJobs(campaignIdsByJobId, [record.jobId]);
    recordCampaignById.set(record.id, campaignId);
  }

  const activeCampaignId = input.activeCampaign.id;
  const applicationRecords = input.applicationRecords.filter(
    (record) => recordCampaignById.get(record.id) === activeCampaignId,
  );
  const applicationRecordIds = new Set(
    applicationRecords.map((record) => record.id),
  );
  const applyRuns = input.applyRuns.filter(
    (run) => runCampaignById.get(run.id) === activeCampaignId,
  );
  const resultById = new Map(
    input.applyJobResults.map((result) => [result.id, result]),
  );
  const userActionRequests = input.userActionRequests.filter((request) => {
    if (request.scope.type === "discovery_source") {
      return activeSourceTargetIds.has(request.scope.targetId);
    }
    if (runCampaignById.get(request.scope.runId) !== activeCampaignId) {
      return false;
    }
    if (request.scope.applicationRecordId) {
      if (!applicationRecordIds.has(request.scope.applicationRecordId)) {
        return false;
      }
      if (!request.scope.resultId) return true;
      const result = resultById.get(request.scope.resultId);
      return (
        result?.runId === request.scope.runId &&
        result.applicationRecordId === request.scope.applicationRecordId
      );
    }
    return (
      resolveCampaignForJobs(campaignIdsByJobId, [request.scope.jobId]) ===
      activeCampaignId
    );
  });

  return { applicationRecords, applyRuns, userActionRequests };
}

export function createWorkspaceSnapshotProfileMethods(
  ctx: WorkspaceServiceContext,
): Pick<
  JobFinderWorkspaceService,
  | "getWorkspaceSnapshot"
  | "getWorkspaceProjection"
  | "getWorkspaceBootstrap"
  | "getWorkspaceHomeSnapshot"
  | "getResumeImportState"
  | "resetWorkspace"
  | "openBrowserSession"
  | "checkBrowserSession"
  | "saveProfile"
  | "saveProfileAndSearchPreferences"
  | "runResumeImport"
  | "analyzeProfileFromResume"
  | "saveSearchPreferences"
  | "saveProfileSetupState"
  | "applyProfileSetupReviewAction"
  | "applyResumeTimelineRepairAction"
  | "sendProfileCopilotMessage"
  | "proposeProfileCopilotChange"
  | "applyProfileCopilotPatchGroup"
  | "rejectProfileCopilotPatchGroup"
  | "undoProfileRevision"
  | "saveSettings"
  | "updateApplicationDefaults"
  | "updateWorkspaceBehavior"
  | "updateAiBehavior"
  | "updateTrackerCrm"
  | "updateAppearanceTheme"
> & {
  /** Internal: the assistant sidebar's profile commit (ADR 0037). */
  applyAssistantProfilePatchGroup: ReturnType<
    typeof createWorkspaceProfileCopilotMethods
  >["applyAssistantProfilePatchGroup"];
} {
  const { buildBundleFromStoredResume, getCurrentSetupStateContext } =
    createWorkspaceProfileSetupContextHelpers(ctx);

  let interruptedDiscoveryRecoveryPromise: Promise<void> | null = null;
  let interruptedApplyRecoveryPromise: Promise<void> | null = null;
  // Once per service: drafts written before ADR 0051 get their unbacked
  // generated lines settled, so nothing on Shortlisted waits on the person.
  let storedResumeDraftSettlement: Promise<unknown> | null = null;
  // Once per service, in the background: fit verdicts stored with the old
  // whole-profile fingerprint are re-bound before any edit can strand them.
  let legacyFitFingerprintRebinding: Promise<unknown> | null = null;
  let lastNoResponseAutomationRunAt: number | null = null;
  let ledgerWarmup: Promise<void> | null = null;
  const normalizedDraftRows = new WeakMap<
    object,
    {
      templates: string;
      draft: ReturnType<typeof normalizeResumeDraftTemplate>;
    }
  >();
  let normalizedDraftSource: readonly object[] | null = null;
  let normalizedDraftTemplates = "";
  let normalizedDraftCollection: ReturnType<
    typeof normalizeResumeDraftTemplate
  >[] = [];
  const orderedRecordCollections = new WeakMap<
    readonly ApplicationRecord[],
    ApplicationRecord[]
  >();
  let displayCampaignProgress: {
    source: JobSearchCampaignCollection;
    key: string;
    projected: JobSearchCampaignCollection;
  } | null = null;
  let sourceAccessCache: {
    input: Parameters<typeof deriveSourceAccessPrompts>[0];
    prompts: ReturnType<typeof deriveSourceAccessPrompts>;
  } | null = null;

  // Rescoring every saved job against an edited profile or goals took
  // seconds on a large workspace and held the save (and the app) until it
  // finished. A save now answers at once; the rescoring runs after it, one
  // pass at a time, and the window refreshes when scores changed.
  let savedJobRescoring: Promise<void> | null = null;
  let rescoreAgain = false;
  function rescoreSavedJobsInBackground(): void {
    if (savedJobRescoring) {
      rescoreAgain = true;
      return;
    }
    rescoreAgain = false;
    savedJobRescoring = nextTurn()
      .then(() => reassessSavedJobs(ctx))
      .then((changed) => {
        if (changed) ctx.onSavedJobsRescored?.();
      })
      .catch((error: unknown) => {
        console.warn("[Job Finder] Rescoring saved jobs failed", error);
      })
      .finally(() => {
        savedJobRescoring = null;
        if (rescoreAgain && !ctx.isWorkspaceClosing?.())
          rescoreSavedJobsInBackground();
      });
  }
  /** A canonical read reflects the rescoring the latest save started. */
  async function settleSavedJobRescoring(): Promise<void> {
    while (savedJobRescoring) await savedJobRescoring;
  }

  // Display reads hand back the same frozen collections while nothing in
  // them changed, so the job lists built from them are kept with them. On
  // 20,000 jobs, rebuilding them on a refresh that changed nothing was about
  // half of every refresh. A change to any input rebuilds them (each row's
  // own work stays cached with the row).
  let lastJobViews: {
    input: JobViewInput;
    views: ReturnType<typeof buildJobViews>;
    rawById: ReadonlyMap<string, SavedJob>;
  } | null = null;
  // Kept in step with the listed jobs from one refresh to the next, so a
  // refresh indexes only the jobs that changed since the last one.
  const jobViewIdentityIndex =
    ctx.listingActivityIdentityIndex ??
    createSyncedJobIdentityIndex<SavedJob>((job) => job);
  const listingActivityChanges =
    createListingActivityChangeResolver(jobViewIdentityIndex);
  function deriveJobViews(input: JobViewInput) {
    const last = lastJobViews;
    const sameEvidence =
      last &&
      last.input.planId === input.planId &&
      last.input.pendingDiscoveryJobs === input.pendingDiscoveryJobs &&
      last.input.listingSignals === input.listingSignals &&
      last.input.applicationAttempts === input.applicationAttempts;
    let companyJobIds = last?.views.companyJobIds ?? new Set<string>();
    if (!last || last.input.companies !== input.companies) {
      const next = new Set(
        input.companies
          .filter((company) => isListableCompanyName(company.canonicalName))
          .flatMap((company) => company.jobIds),
      );
      if (
        next.size !== companyJobIds.size ||
        [...next].some((id) => !companyJobIds.has(id))
      )
        companyJobIds = next;
    }
    const sameInactive =
      last &&
      inactiveListingLedger(last.input.discoveryLedger) ===
        inactiveListingLedger(input.discoveryLedger);
    if (
      sameEvidence &&
      sameInactive &&
      companyJobIds === last.views.companyJobIds &&
      last.input.rawSavedJobs === input.rawSavedJobs
    ) {
      lastJobViews = { ...last, input };
      return last.views;
    }
    if (sameEvidence && Object.isFrozen(input.rawSavedJobs)) {
      const sameJobs = last.input.rawSavedJobs === input.rawSavedJobs;
      const changes = sameJobs
        ? { rows: [], removedIds: [] }
        : readSavedJobProjectionChanges(
            last.input.rawSavedJobs,
            input.rawSavedJobs,
          );
      const rawById = changes
        ? new Map(last.rawById)
        : new Map(input.rawSavedJobs.map((job) => [job.id, job]));
      if (changes) {
        for (const id of changes.removedIds) rawById.delete(id);
        for (const row of changes.rows) rawById.set(row.id, row);
      }
      const rawChanged =
        changes?.rows ??
        input.rawSavedJobs.filter((job) => last.rawById.get(job.id) !== job);
      const removed = changes
        ? changes.removedIds.map((id) => last.rawById.get(id)!).filter(Boolean)
        : [...last.rawById.values()].filter((job) => !rawById.has(job.id));
      const evidenceIds = listingActivityChanges({
        beforeJobs:
          input.pendingDiscoveryJobs.length === 0
            ? last.input.rawSavedJobs
            : [
                ...last.input.rawSavedJobs,
                ...input.pendingDiscoveryJobs.filter(
                  (row) => !last.rawById.has(row.id),
                ),
              ],
        jobs:
          input.pendingDiscoveryJobs.length === 0
            ? input.rawSavedJobs
            : [
                ...input.rawSavedJobs,
                ...input.pendingDiscoveryJobs.filter(
                  (row) => !rawById.has(row.id),
                ),
              ],
        beforeById: last.rawById,
        changed: rawChanged,
        removed,
        beforeLedger: last.input.discoveryLedger,
        ledger: input.discoveryLedger,
      });
      const changedIds = new Set([
        ...rawChanged.map((row) => row.id),
        ...removed.map((row) => row.id),
        ...evidenceIds,
      ]);
      if (companyJobIds !== last.views.companyJobIds) {
        for (const id of last.views.companyJobIds)
          if (!companyJobIds.has(id)) changedIds.add(id);
        for (const id of companyJobIds)
          if (!last.views.companyJobIds.has(id)) changedIds.add(id);
      }
      const changed = [...changedIds].flatMap((id) => {
        const row = rawById.get(id);
        return row ? [readPlanAssessment(row, input.planId)] : [];
      });
      for (const job of input.pendingDiscoveryJobs)
        if (changedIds.has(job.id) && !rawById.has(job.id))
          changed.push(readPlanAssessment(job, input.planId));
      const projectedJobById = new Map(last.views.projectedJobById);
      for (const id of changedIds) projectedJobById.delete(id);
      for (const view of projectDiscoveryJobViews({
        jobs: changed,
        identityJobs:
          input.pendingDiscoveryJobs.length === 0
            ? input.rawSavedJobs
            : [
                ...input.rawSavedJobs,
                ...input.pendingDiscoveryJobs.filter(
                  (job) => !rawById.has(job.id),
                ),
              ],
        discoveryLedger: input.discoveryLedger,
        listingSignals: input.listingSignals,
        applicationAttempts: input.applicationAttempts,
        identityIndex: jobViewIdentityIndex,
      }))
        projectedJobById.set(view.id, view);
      const project = (jobs: readonly SavedJob[]) =>
        jobs.flatMap((job) => {
          const view = projectedJobById.get(job.id);
          return view ? [view] : [];
        });
      const savedJobs =
        changes &&
        changes.removedIds.length === 0 &&
        input.rawSavedJobs.length === last.input.rawSavedJobs.length
          ? last.views.savedJobs.slice()
          : input.rawSavedJobs.map((job) =>
              readPlanAssessment(job, input.planId),
            );
      if (
        changes &&
        changes.removedIds.length === 0 &&
        input.rawSavedJobs.length === last.input.rawSavedJobs.length
      ) {
        for (const row of changes.rows) {
          let low = 0;
          let high = input.rawSavedJobs.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (input.rawSavedJobs[middle]!.id < row.id) low = middle + 1;
            else high = middle;
          }
          if (input.rawSavedJobs[low]?.id === row.id)
            savedJobs[low] = readPlanAssessment(row, input.planId);
        }
      }
      const views: ReturnType<typeof buildJobViews> = {
        savedJobs: Object.freeze(savedJobs) as SavedJob[],
        discoveryJobs: mergeSortedRowChanges(
          last.views.discoveryJobs,
          changedIds,
          project(selectVisibleDiscoveryJobs(changed)),
          compareDiscoveryJobs,
        ),
        projectedDismissedDiscoveryJobs: mergeSortedRowChanges(
          last.views.projectedDismissedDiscoveryJobs,
          changedIds,
          project(
            changed.filter(
              (job) =>
                job.status === "archived" && job.discoveryFeedback !== null,
            ),
          ),
          compareDiscoveryJobs,
        ),
        companyJobs: mergeSortedRowChanges(
          last.views.companyJobs,
          changedIds,
          project(
            changed.filter(
              (job) => rawById.has(job.id) && companyJobIds.has(job.id),
            ),
          ),
          (left, right) =>
            compareDiscoveryJobs(
              readPlanAssessment(rawById.get(left.id) ?? left, input.planId),
              readPlanAssessment(rawById.get(right.id) ?? right, input.planId),
            ),
        ),
        projectedJobById,
        companyJobIds,
      };
      Object.freeze(views.companyJobs);
      lastJobViews = { input, views, rawById };
      return views;
    }
    // Only the borrowed display rows keep their identity between refreshes.
    const views = buildJobViews(
      input,
      Object.isFrozen(input.rawSavedJobs) ? jobViewIdentityIndex : undefined,
    );
    lastJobViews = Object.isFrozen(input.rawSavedJobs)
      ? {
          input,
          views,
          rawById: new Map(input.rawSavedJobs.map((job) => [job.id, job])),
        }
      : null;
    return views;
  }

  async function runNoResponseAutomationIfDue(options?: {
    settings?: ApplicationCrmSettings;
  }): Promise<void> {
    const now = Date.now();
    if (
      lastNoResponseAutomationRunAt !== null &&
      now - lastNoResponseAutomationRunAt <
        NO_RESPONSE_AUTOMATION_MIN_INTERVAL_MS
    ) {
      return;
    }

    const settings =
      options?.settings ??
      normalizeJobFinderSettings(
        await ctx.repository.getSettings(),
        ctx.documentManager.listResumeTemplates(),
      ).applicationCrm ??
      ApplicationCrmSettingsSchema.parse({});
    try {
      await ctx.withApplicationCrmTransition(() =>
        runApplicationNoResponseAutomation({
          repository: ctx.repository,
          settings,
        }),
      );
    } catch (error) {
      console.warn(
        "[JobFinderWorkspace] No-response automation skipped.",
        error,
      );
    }
    lastNoResponseAutomationRunAt = now;
  }

  async function syncActiveCampaignPreferences(
    searchPreferences: JobSearchPreferences,
  ): Promise<void> {
    // The preferences/pointer rewrite is derived from a fresh collection read
    // inside the campaign transition so a scheduled-run commit that lands
    // first keeps its history, run facts, rules, and notifications.
    await ctx.withCampaignTransition(async () => {
      const campaignState = await ensureCampaignState({
        repository: ctx.repository,
        searchPreferences,
      });
      const now = new Date().toISOString();
      await ctx.repository.saveCampaignState({
        ...campaignState,
        campaigns: campaignState.campaigns.map((campaign) => {
          const liveTargets = searchPreferences.discovery.targets;
          const campaignPreferences =
            campaign.id === campaignState.activeCampaignId
              ? {
                  ...searchPreferences,
                  discovery: {
                    ...searchPreferences.discovery,
                    targets: liveTargets,
                  },
                }
              : {
                  ...campaign.searchPreferences,
                  discovery: {
                    ...campaign.searchPreferences.discovery,
                    targets: liveTargets,
                  },
                };
          return {
            ...campaign,
            searchPreferences: campaignPreferences,
            sourceTargetIds: campaign.sourceTargetIds,
            updatedAt: now,
          };
        }),
      });
    });
  }

  async function recoverInterruptedApplyRunsOnLoad(): Promise<void> {
    if (
      ctx.activeApplyRunAbortControllers.size > 0 ||
      ctx.activeApplyRunPromises.size > 0
    ) {
      return;
    }

    if (interruptedApplyRecoveryPromise) {
      await interruptedApplyRecoveryPromise;
      return;
    }

    const recoveryPromise = (async () => {
      // Every workspace refresh runs this check, so it reads job ids, not
      // every saved job; a lost page below loads the jobs it needs.
      const display = await ctx.repository.readDisplayCollections?.();
      const [runs, allResults, savedJobIds, activityControl] =
        await Promise.all([
          display?.applyRuns ?? ctx.repository.listApplyRuns(),
          display?.applyJobResults ?? ctx.repository.listApplyJobResults(),
          ctx.browserRuntime.hasApplicationPageBinding
            ? ctx.repository.listSavedJobIds()
            : Promise.resolve([]),
          ctx.repository.getActivityControl(),
        ]);

      if (
        ctx.activeApplyRunAbortControllers.size > 0 ||
        ctx.activeApplyRunPromises.size > 0
      ) {
        return;
      }

      const resultsByRunId = groupApplyJobResultsByRunId(allResults);
      const runById = new Map(runs.map((run) => [run.id, run]));
      const parkedRunIds = new Set(
        runs
          .filter((run) =>
            isSafelyParkedApplyQueue({
              run,
              results: resultsByRunId.get(run.id) ?? [],
              control: activityControl,
            }),
          )
          .map((run) => run.id),
      );
      const interruptedRuns = runs.filter(
        (run) => run.state === "running" && !parkedRunIds.has(run.id),
      );
      // Runs already terminal BECAUSE a prior recovery pass terminalized them:
      // a crash between committing the failed run and sweeping its results
      // once stranded non-terminal rows under it forever, because only running
      // runs were swept. The recovery summary pins provenance, so user-owned
      // cancelled/completed runs keep their parked rows and counters untouched.
      // Any terminal run, not only recovery-terminalized ones: a cancelled
      // run whose in-flight rows were never stopped (older builds) would
      // otherwise show "filling in the form" forever. Parked awaiting_review
      // rows are not in-flight and are never touched here.
      const partiallyRecoveredRunIds = new Set(
        runs
          .filter(
            (run) =>
              isRecoveryTerminalizedApplyRun(run) || run.state !== "running",
          )
          .map((run) => run.id),
      );
      const recoveryTerminalizedRunIds = new Set(
        runs.filter(isRecoveryTerminalizedApplyRun).map((run) => run.id),
      );
      const cancelledRunIds = new Set(
        runs.filter((run) => run.state === "cancelled").map((run) => run.id),
      );
      const hasPartiallyRecoveredOrphans =
        partiallyRecoveredRunIds.size > 0 &&
        allResults.some(
          (result) =>
            partiallyRecoveredRunIds.has(result.runId) &&
            isInterruptedApplyJobState(result.state) &&
            (recoveryTerminalizedRunIds.has(result.runId) ||
              cancelledRunIds.has(result.runId) ||
              result.state !== "planned"),
        );

      const savedJobIdSet = new Set(savedJobIds);
      const verifiedJobIds = new Set(
        allResults
          .filter(hasVerifiedApplicationSubmission)
          .map((result) => result.jobId),
      );
      const lostPreparedReviewCandidates = ctx.browserRuntime
        .hasApplicationPageBinding
        ? allResults.filter(
            (result) =>
              !verifiedJobIds.has(result.jobId) &&
              isUnsentPreparedApplication(result) &&
              result.privacyReceipt?.submissionOutcome?.outcome !==
                "outcome_uncertain" &&
              savedJobIdSet.has(result.jobId) &&
              (runById.get(result.runId)?.state !== "running" ||
                parkedRunIds.has(result.runId)),
          )
        : [];

      if (
        interruptedRuns.length === 0 &&
        !hasPartiallyRecoveredOrphans &&
        lostPreparedReviewCandidates.length === 0
      ) {
        return;
      }

      const completedAt = new Date().toISOString();
      // A cancelled run must not overwrite a later retry of its exact record.
      // Keep the newest result from two distinct runs, so excluding the run
      // being recovered is constant time even after thousands of retries.
      const latestResultsByRecordId = new Map<
        string,
        { latest: ApplyJobResult; otherRun: ApplyJobResult | null }
      >();
      if (hasPartiallyRecoveredOrphans && cancelledRunIds.size > 0) {
        for (const result of allResults) {
          if (!result.applicationRecordId) continue;
          const previous = latestResultsByRecordId.get(
            result.applicationRecordId,
          );
          if (!previous) {
            latestResultsByRecordId.set(result.applicationRecordId, {
              latest: result,
              otherRun: null,
            });
          } else if (result.runId === previous.latest.runId) {
            if (result.startedAt > previous.latest.startedAt)
              previous.latest = result;
          } else if (result.startedAt > previous.latest.startedAt) {
            latestResultsByRecordId.set(result.applicationRecordId, {
              latest: result,
              otherRun: previous.latest,
            });
          } else if (
            !previous.otherRun ||
            result.startedAt > previous.otherRun.startedAt
          ) {
            previous.otherRun = result;
          }
        }
      }
      await Promise.all([
        Promise.all(
          interruptedRuns.map(async (run) => {
            const runResults = resultsByRunId.get(run.id) ?? [];
            const recoveredRun = recoverInterruptedApplyRun(
              run,
              completedAt,
              runResults,
            );
            const terminalizedRecordIds = new Set<string>();
            const recoveredResults: ApplyJobResult[] = [];
            for (const result of runResults) {
              const recoveredResult = recoverInterruptedApplyJobResult(
                result,
                completedAt,
              );
              if (!recoveredResult) {
                continue;
              }
              // Exact applicationRecordId lineage only: legacy rows with a
              // null record id stay fail-closed and are never attributed to
              // an application record here.
              if (result.applicationRecordId) {
                terminalizedRecordIds.add(result.applicationRecordId);
              }
              recoveredResults.push(recoveredResult);
            }
            // Crash-resumable persist order: exact-lineage projections land
            // before the run/result commits, so a crash mid-recovery leaves
            // the parent run durably non-terminal and this whole replay reruns
            // idempotently on the next load. A crash after the projections can
            // never strand in-progress attempt/record rows under a terminal
            // run, because the projections are already durable by then.
            await recoverInterruptedExactLineageProjections({
              repository: ctx.repository,
              interruptedRecordIds: terminalizedRecordIds,
              completedAt,
              eventIdFor: (recordId) =>
                `event_${run.id}_app_closed_recovery_${recordId}`,
            });
            await Promise.all([
              ...recoveredResults.map((recoveredResult) =>
                ctx.repository.upsertApplyJobResult(recoveredResult),
              ),
              ctx.repository.upsertApplyRun(recoveredRun),
            ]);
            await persistAutomaticApplicationSafeguards({
              ctx,
              run: recoveredRun,
              now: completedAt,
            }).catch((safeguardError: unknown) => {
              console.error(
                "Failed to persist automatic application safeguards.",
                safeguardError,
              );
            });
          }),
        ),
        (async () => {
          if (!hasPartiallyRecoveredOrphans) {
            return;
          }

          for (const runId of partiallyRecoveredRunIds) {
            const run = runById.get(runId);
            if (!run) continue;
            const runResults = resultsByRunId.get(runId) ?? [];
            const orphanWrites: Promise<void>[] = [];
            const recoveryTerminalized = isRecoveryTerminalizedApplyRun(run);
            for (const result of runResults) {
              if (!isInterruptedApplyJobState(result.state)) {
                continue;
              }
              // Completed runs retain their queued history. A cancelled
              // run cannot still have a queued job waiting its turn.
              if (
                !recoveryTerminalized &&
                run.state !== "cancelled" &&
                result.state === "planned"
              ) {
                continue;
              }
              const recoveredResult = recoveryTerminalized
                ? recoverInterruptedApplyJobResult(result, completedAt)
                : run.state === "cancelled"
                  ? cancelInterruptedApplyJobResult(
                      result,
                      run.completedAt ?? run.updatedAt,
                    )
                  : recoverInterruptedApplyJobResult(result, completedAt);
              if (!recoveredResult) {
                continue;
              }
              orphanWrites.push(
                ctx.repository.upsertApplyJobResult(recoveredResult),
              );
            }
            if (orphanWrites.length === 0) {
              continue;
            }
            // Deterministic orphan sweep: the repository exposes no central
            // multi-entity recovery transaction, so convergence comes from
            // idempotent per-row writes with deterministic event ids instead.
            // A queued job never started an attempt. Nor may an older
            // cancelled run overwrite a later retry of the same record.
            // Other exact-lineage rows remain eligible so partial recovery
            // of an in-flight attempt can still converge.
            const sweptRecordIds = new Set<string>();
            for (const result of runResults) {
              const recordId = result.applicationRecordId;
              if (!recordId) continue;
              if (run.state === "cancelled" && result.state === "planned") {
                continue;
              }
              if (
                run.state === "cancelled" &&
                (() => {
                  const latest = latestResultsByRecordId.get(recordId);
                  const other =
                    latest?.latest.runId === run.id
                      ? latest.otherRun
                      : latest?.latest;
                  return (
                    other &&
                    other.startedAt > (run.completedAt ?? run.updatedAt)
                  );
                })()
              ) {
                continue;
              }
              sweptRecordIds.add(recordId);
            }
            await recoverInterruptedExactLineageProjections({
              repository: ctx.repository,
              interruptedRecordIds: sweptRecordIds,
              completedAt,
              eventIdFor: (recordId) =>
                `event_${runId}_app_closed_recovery_${recordId}`,
            });
            // The prior pass terminalized this run but may have crashed before
            // its stale running-time counters could be recomputed; restore
            // counter truth without rewriting its state, copy, or completion.
            const refreshedRun = refreshTerminalizedApplyRunCounters(
              run,
              runResults,
              completedAt,
            );
            await Promise.all([
              ...orphanWrites,
              ...(refreshedRun
                ? [ctx.repository.upsertApplyRun(refreshedRun)]
                : []),
            ]);
          }
        })(),
      ]);

      if (
        ctx.browserRuntime.hasApplicationPageBinding &&
        lostPreparedReviewCandidates.length > 0
      ) {
        const jobsById = new Map(
          (
            await ctx.repository.listSavedJobsByIds(
              lostPreparedReviewCandidates.map((result) => result.jobId),
            )
          ).map((job) => [job.id, job]),
        );
        for (const result of lostPreparedReviewCandidates) {
          const job = jobsById.get(result.jobId);
          if (!job || !result.applicationRecordId) continue;
          const isResuming = (
            await ctx.repository.listUserActionRequests({
              states: ["verifying"],
              scopeType: "application",
            })
          ).some(
            (request) =>
              request.scope.type === "application" &&
              request.scope.resultId === result.id,
          );
          if (isResuming) continue;
          const hasBinding = await ctx.browserRuntime.hasApplicationPageBinding(
            job.source,
            result.id,
          );
          if (hasBinding) continue;
          // Binding checks are asynchronous. A continuation or send may have
          // claimed this exact run while the runtime answered, so recheck the
          // in-memory owners and the persisted request immediately before any
          // terminal write.
          if (
            ctx.activeApplyRunAbortControllers.has(result.runId) ||
            ctx.activeApplyRunPromises.has(result.runId)
          ) {
            continue;
          }
          const beganResuming = (
            await ctx.repository.listUserActionRequests({
              states: ["verifying"],
              scopeType: "application",
            })
          ).some(
            (request) =>
              request.scope.type === "application" &&
              request.scope.resultId === result.id,
          );
          if (beganResuming) continue;
          await terminalizeApplicationAfterPreparedPageLost({
            repository: ctx.repository,
            runId: result.runId,
            jobId: result.jobId,
            applicationRecordId: result.applicationRecordId,
            resultId: result.id,
            occurredAt: completedAt,
            eventId: `event_${result.id}_prepared_page_binding_lost`,
            preserveRunningRun: parkedRunIds.has(result.runId),
          });
          await retireLostPreparedApplication({
            repository: ctx.repository,
            applicationRecordId: result.applicationRecordId,
            resultId: result.id,
            occurredAt: completedAt,
          });
        }
      }
    })();

    interruptedApplyRecoveryPromise = recoveryPromise;
    try {
      await recoveryPromise;
    } finally {
      if (interruptedApplyRecoveryPromise === recoveryPromise) {
        interruptedApplyRecoveryPromise = null;
      }
    }
  }

  async function recoverInterruptedDiscoveryStateOnLoad(): Promise<void> {
    if (
      ctx.activeDiscoveryAbortControllerRef.current ||
      ctx.activeDiscoveryPromiseRef.current
    ) {
      return;
    }

    if (interruptedDiscoveryRecoveryPromise) {
      await interruptedDiscoveryRecoveryPromise;
      return;
    }

    const recoveryPromise = (async () => {
      // Every refresh runs this check. The discovery projection is cached and
      // answers "was anything running?"; the plan state and search settings
      // (hundreds of KB with a large search) are read only when it was.
      const discoveryState =
        await ctx.repository.readDiscoveryDisplayProjection();
      if (
        ctx.activeDiscoveryAbortControllerRef.current ||
        ctx.activeDiscoveryPromiseRef.current
      ) {
        return;
      }

      const activeRun = discoveryState.activeRun;
      if (discoveryState.runState !== "running" && !activeRun) {
        return;
      }
      const [searchPreferences, campaignState] = await Promise.all([
        ctx.repository.getSearchPreferences(),
        ctx.repository.getCampaignState(),
      ]);
      if (
        ctx.activeDiscoveryAbortControllerRef.current ||
        ctx.activeDiscoveryPromiseRef.current
      ) {
        return;
      }

      const completedAt = new Date().toISOString();
      const historyLimit =
        normalizeSearchPreferences(searchPreferences).discovery.historyLimit;
      // Recheck ownership at commit time: a newer writer (for example a run
      // started between the read above and this transaction) that replaced
      // the observed run must survive untouched.
      const observedRunState = discoveryState.runState;
      const observedActiveRunId = activeRun?.id ?? null;
      const observedActiveRunState = activeRun?.state ?? null;

      const persisted = await ctx.repository.commitDiscoveryStateUpdate(
        (current) => {
          if (
            current.runState !== observedRunState ||
            (current.activeRun?.id ?? null) !== observedActiveRunId ||
            (current.activeRun?.state ?? null) !== observedActiveRunState
          ) {
            return current;
          }

          // The cheap read above only detects recovery work. Recover the
          // transaction-current canonical run so every checkpoint (including
          // updates since that read) survives the move into history.
          const recoveredRunBase =
            current.activeRun?.state === "running"
              ? recoverInterruptedDiscoveryRun(current.activeRun, completedAt)
              : current.activeRun;
          const recoveredRun = recoveredRunBase
            ? {
                ...recoveredRunBase,
                campaignId:
                  recoveredRunBase.campaignId ??
                  campaignState?.activeCampaignId ??
                  null,
              }
            : null;
          return {
            ...current,
            runState: recoveredRun?.state ?? "failed",
            activeRun: null,
            recentRuns: recoveredRun
              ? [
                  recoveredRun,
                  ...current.recentRuns.filter(
                    (run) => run.id !== recoveredRun.id,
                  ),
                ].slice(0, historyLimit)
              : current.recentRuns,
          };
        },
      );
      const recoveredRun = persisted.recentRuns.find(
        (run) =>
          run.id === observedActiveRunId && run.runPhase === "interrupted",
      );
      if (
        recoveredRun?.campaignId &&
        persisted.activeRun?.id !== recoveredRun.id
      ) {
        await recordCampaignDiscoveryResult({
          ctx,
          campaignId: recoveredRun.campaignId,
          beforeJobProvenanceFingerprints: new Map(),
        });
      }
    })();

    interruptedDiscoveryRecoveryPromise = recoveryPromise;
    try {
      await recoveryPromise;
    } finally {
      if (interruptedDiscoveryRecoveryPromise === recoveryPromise) {
        interruptedDiscoveryRecoveryPromise = null;
      }
    }
  }

  function resolveBrowserSessionTarget(input: {
    targets: readonly JobDiscoveryTarget[];
    targetId: string | null | undefined;
  }): JobDiscoveryTarget | null {
    if (!input.targetId) {
      return null;
    }

    const target =
      input.targets.find((candidate) => candidate.id === input.targetId) ??
      null;

    if (!target) {
      throw new Error("The requested job source is no longer available.");
    }

    return target;
  }

  async function getWorkspaceSnapshot(
    borrowValidatedJobs = false,
    /**
     * Home's first view (ADR 0077): only the jobs the person took past Find
     * jobs, no Find jobs lists, and nothing written back. The full snapshot
     * follows and replaces it.
     */
    homeTier = false,
  ): Promise<JobFinderWorkspaceSnapshot> {
    // Display reads show the scores as they stand and refresh when the
    // rescoring lands; a canonical read waits for it.
    if (!borrowValidatedJobs) await settleSavedJobRescoring();
    await runNoResponseAutomationIfDue();

    storedResumeDraftSettlement ??= settleStoredResumeDrafts(ctx).catch(
      (error: unknown) => {
        console.warn(
          "[Job Finder] Settling stored resume drafts failed",
          error,
        );
      },
    );
    await Promise.all([
      recoverInterruptedDiscoveryStateOnLoad(),
      recoverInterruptedApplyRunsOnLoad(),
      storedResumeDraftSettlement,
    ]);
    if (borrowValidatedJobs) await nextTurn();
    await reconcileAutomaticBatchSampleReviews(ctx);

    // Display reads exclude resume checkpoints before parsing and reuse
    // unchanged state. Canonical snapshots still load the complete state.
    let unchangedDiscoveryRead: JobFinderDiscoveryState | null = null;
    if (!ctx.activeSourceDebugExecutionIdRef.current) {
      const discoveryState =
        await ctx.repository.readDiscoveryDisplayProjection();
      const activeSourceDebugRun = discoveryState.activeSourceDebugRun;
      unchangedDiscoveryRead = discoveryState;

      if (activeSourceDebugRun?.state === "running") {
        unchangedDiscoveryRead = null;
        const interruptedRun = SourceDebugRunRecordSchema.parse({
          ...activeSourceDebugRun,
          state: "interrupted",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          activePhase: null,
          finalSummary:
            activeSourceDebugRun.finalSummary ??
            "Source debug run was interrupted before completion.",
        });

        await ctx.repository.upsertSourceDebugRun(interruptedRun);
        await ctx.repository.commitDiscoveryStateUpdate((current) => {
          if (
            current.activeSourceDebugRun?.id !== interruptedRun.id ||
            current.activeSourceDebugRun?.state !== "running"
          ) {
            return current;
          }

          return {
            ...current,
            activeSourceDebugRun: null,
            recentSourceDebugRuns: [
              interruptedRun,
              ...current.recentSourceDebugRuns.filter(
                (run) => run.id !== interruptedRun.id,
              ),
            ].slice(0, SOURCE_DEBUG_RECENT_HISTORY_LIMIT),
          };
        });
      }
    }

    const display = borrowValidatedJobs
      ? await ctx.repository.readDisplayCollections?.()
      : undefined;
    const [
      setupContext,
      rawSavedJobs,
      tailoredAssets,
      resumeDrafts,
      resumeExportArtifacts,
      resumeResearchArtifacts,
      applyRuns,
      applyJobResults,
      applicationRecords,
      applicationAttempts,
      sourceInstructionArtifacts,
      sourceDebugAttempts,
      profileCopilotMessages,
      profileRevisions,
      rawSettings,
      discovery,
      userActionRequests,
      userActionEvents,
      activityControl,
      rawIntelligence,
      applyQueue,
    ] = await Promise.all([
      getCurrentSetupStateContext(borrowValidatedJobs),
      homeTier
        ? readHomeTierSavedJobs()
        : borrowValidatedJobs
          ? ctx.repository.readSavedJobsProjection()
          : ctx.repository.listSavedJobs(),
      display?.tailoredAssets ?? ctx.repository.listTailoredAssets(),
      display?.resumeDrafts ?? ctx.repository.listResumeDrafts(),
      display?.resumeExportArtifacts ??
        ctx.repository.listResumeExportArtifacts(),
      display?.resumeResearchArtifacts ??
        ctx.repository.listResumeResearchArtifacts(),
      display?.applyRuns ?? ctx.repository.listApplyRuns(),
      display?.applyJobResults ?? ctx.repository.listApplyJobResults(),
      display?.applicationRecords ?? ctx.repository.listApplicationRecords(),
      display?.applicationAttempts ?? ctx.repository.listApplicationAttempts(),
      display?.sourceInstructionArtifacts ??
        ctx.repository.listSourceInstructionArtifacts(),
      display?.sourceDebugAttempts ?? ctx.repository.listSourceDebugAttempts(),
      display?.profileCopilotMessages ??
        ctx.repository.listProfileCopilotMessages(),
      display?.profileRevisions ?? ctx.repository.listProfileRevisions(),
      ctx.repository.getSettings(),
      borrowValidatedJobs
        ? (unchangedDiscoveryRead ??
          ctx.repository.readDiscoveryDisplayProjection())
        : ctx.repository.getDiscoveryState(),
      display?.userActionRequests ?? ctx.repository.listUserActionRequests(),
      display?.userActionEvents ?? ctx.repository.listUserActionEvents(),
      ctx.repository.getActivityControl(),
      borrowValidatedJobs && ctx.repository.readIntelligenceProjection
        ? ctx.repository.readIntelligenceProjection()
        : ctx.repository.getIntelligenceState(),
      ctx.repository.getApplyQueue(),
    ]);
    // From the jobs this read already loaded, so it costs no second read.
    if (borrowValidatedJobs) await nextTurn();
    if (!homeTier)
      legacyFitFingerprintRebinding ??= rebindLegacyFitVerdicts(ctx, {
        savedJobs: rawSavedJobs,
        pendingDiscoveryJobs: discovery.pendingDiscoveryJobs,
      }).catch((error: unknown) => {
        console.warn(
          "[Job Finder] Re-binding stored fit verdicts failed",
          error,
        );
      });

    // Grouping needs every job; the full snapshot does it.
    let intelligence = homeTier
      ? rawIntelligence
      : groupCompanyConflicts(
          rawIntelligence,
          applicationRecords,
          rawSavedJobs,
        );
    if (
      intelligence !== rawIntelligence &&
      JSON.stringify(intelligence) !== JSON.stringify(rawIntelligence)
    ) {
      intelligence = await ctx.withIntelligenceTransition(async () => {
        const current = await ctx.repository.getIntelligenceState();
        const grouped = groupCompanyConflicts(
          current,
          applicationRecords,
          rawSavedJobs,
        );
        if (
          grouped !== current &&
          JSON.stringify(grouped) !== JSON.stringify(current)
        )
          await ctx.repository.saveIntelligenceState(grouped);
        return grouped;
      });
    }

    const availableResumeTemplates = ctx.documentManager.listResumeTemplates();
    const normalizedSettings = normalizeJobFinderSettings(
      {
        ...rawSettings,
        salaryDisclosure: await readSalaryDisclosurePreference(ctx.repository),
      },
      availableResumeTemplates,
    );
    const settings: JobFinderSettings = normalizedSettings.applicationCrm
      ? normalizedSettings
      : {
          ...normalizedSettings,
          applicationCrm: ApplicationCrmSettingsSchema.parse({}),
        };
    const templateKey = JSON.stringify(
      availableResumeTemplates.map(({ id, label }) => [id, label]),
    );
    const normalizedResumeDrafts =
      display &&
      normalizedDraftSource === resumeDrafts &&
      normalizedDraftTemplates === templateKey
        ? normalizedDraftCollection
        : resumeDrafts.map((draft) => {
            const cached = display ? normalizedDraftRows.get(draft) : undefined;
            if (cached?.templates === templateKey) return cached.draft;
            const normalized = normalizeResumeDraftTemplate(
              draft,
              availableResumeTemplates,
            );
            if (display) {
              Object.freeze(normalized);
              normalizedDraftRows.set(draft, {
                templates: templateKey,
                draft: normalized,
              });
            }
            return normalized;
          });
    if (display) {
      Object.freeze(normalizedResumeDrafts);
      normalizedDraftSource = resumeDrafts;
      normalizedDraftTemplates = templateKey;
      normalizedDraftCollection = normalizedResumeDrafts;
    }

    const discoverySessions = await ctx.refreshDiscoverySessions(
      setupContext.searchPreferences,
      discovery.sessions,
    );
    const preferredSessionAdapter = getPreferredSessionAdapter(
      setupContext.searchPreferences,
    );
    const browserSession = createBrowserSessionSnapshot(
      discoverySessions,
      preferredSessionAdapter,
      await readUninitializedRuntimeSession(
        ctx,
        discoverySessions,
        preferredSessionAdapter,
      ),
    );
    const generatedAt = new Date().toISOString();
    const sourceAccessInput = {
      targets: setupContext.searchPreferences.discovery.targets,
      recentSourceDebugRuns: discovery.recentSourceDebugRuns,
      activeSourceDebugRun: discovery.activeSourceDebugRun,
      sourceDebugAttempts,
      sourceInstructionArtifacts,
      searchPreferences: setupContext.searchPreferences,
      generatedAt,
    };
    const previousAccess = borrowValidatedJobs ? sourceAccessCache : null;
    const sameAccess =
      previousAccess &&
      (
        [
          "targets",
          "recentSourceDebugRuns",
          "activeSourceDebugRun",
          "sourceDebugAttempts",
          "sourceInstructionArtifacts",
          "searchPreferences",
        ] as const
      ).every((key) => previousAccess.input[key] === sourceAccessInput[key]);
    const sourceAccessPrompts = sameAccess
      ? previousAccess.prompts.map((prompt) =>
          prompt.updatedAt === previousAccess.input.generatedAt
            ? { ...prompt, updatedAt: generatedAt }
            : prompt,
        )
      : deriveSourceAccessPrompts(sourceAccessInput);
    if (borrowValidatedJobs)
      sourceAccessCache = {
        input: sourceAccessInput,
        prompts: sourceAccessPrompts,
      };

    let campaignState = homeTier
      ? await readHomeTierCampaignState()
      : await ctx.withCampaignTransition(() =>
          ensureCampaignState({
            repository: ctx.repository,
            searchPreferences: setupContext.searchPreferences,
            now: generatedAt,
            borrowValidated: borrowValidatedJobs,
          }),
        );
    const snapshotPlanId = campaignState.activeCampaignId;
    if (
      !homeTier &&
      (lastJobViews?.input.rawSavedJobs !== rawSavedJobs ||
        lastJobViews.input.planId !== snapshotPlanId)
    )
      await warmDiscoveryJobChecks(
        lastJobViews && lastJobViews.input.planId === snapshotPlanId
          ? (readSavedJobProjectionChanges(
              lastJobViews.input.rawSavedJobs,
              rawSavedJobs,
            )?.rows ?? rawSavedJobs)
          : rawSavedJobs,
        {
          key: snapshotPlanId,
          of: (job) => readPlanAssessment(job, snapshotPlanId),
        },
      );
    if (
      !homeTier &&
      !lastJobViews &&
      inactiveListingLedger(discovery.discoveryLedger).length > 0
    )
      await jobViewIdentityIndex.warm?.(rawSavedJobs);
    const {
      savedJobs,
      discoveryJobs,
      projectedDismissedDiscoveryJobs,
      companyJobs,
    } = homeTier
      ? {
          savedJobs: rawSavedJobs.map((job) =>
            readPlanAssessment(job, snapshotPlanId),
          ),
          discoveryJobs: [],
          projectedDismissedDiscoveryJobs: [],
          companyJobs: [],
        }
      : deriveJobViews({
          rawSavedJobs,
          planId: snapshotPlanId,
          pendingDiscoveryJobs: discovery.pendingDiscoveryJobs,
          discoveryLedger: discovery.discoveryLedger,
          listingSignals: intelligence.safeguards.listingSignals,
          applicationAttempts,
          companies: intelligence.companies,
        });
    // A draft not yet approved can hold lines the export gate refuses until
    // the person decides them (a stretched line, or an Assistant edit kept
    // with "Accept anyway"). The queue has to know, or it calls the resume
    // ready and Apply's approval step refuses it with nothing on screen.
    const linesToDecideByDraftId = new Map<string, number>();
    const reviewableDrafts = normalizedResumeDrafts.filter(
      (draft) => draft.status === "draft" || draft.status === "needs_review",
    );
    const latestValidationByDraftId = new Map(
      (
        display?.latestResumeValidationResults ??
        (await ctx.repository.listLatestResumeValidationResults(
          reviewableDrafts.map((draft) => draft.id),
        ))
      ).map((validation) => [validation.draftId, validation]),
    );
    for (const draft of reviewableDrafts) {
      const latestValidation = latestValidationByDraftId.get(draft.id);
      if (!latestValidation) continue;
      const count = latestValidation.claimAssessments.filter((assessment) =>
        isBlockingResumeClaimAssessment({ assessment, draft }),
      ).length;
      if (count > 0) linesToDecideByDraftId.set(draft.id, count);
    }
    const reviewQueue = buildReviewQueue(
      savedJobs,
      tailoredAssets,
      normalizedResumeDrafts,
      resumeExportArtifacts,
      setupContext.profile,
      settings,
      linesToDecideByDraftId,
    ).map((item) => ({
      ...item,
      listingAssessmentPending:
        ctx.listingAssessmentJobIds?.has(item.jobId) ?? false,
    }));
    const reconciledApplicationRecords = homeTier
      ? applicationRecords
      : await reconcileStaleMissingResumeBlockers(ctx.repository, {
          applicationRecords,
          resumeDrafts: normalizedResumeDrafts,
          resumeExportArtifacts,
          tailoredAssets,
          detectedAt: generatedAt,
        });
    const recordSource =
      display &&
      reconciledApplicationRecords.length === applicationRecords.length &&
      reconciledApplicationRecords.every(
        (record, index) => record === applicationRecords[index],
      )
        ? applicationRecords
        : reconciledApplicationRecords;
    const orderedApplicationRecords =
      (display ? orderedRecordCollections.get(recordSource) : undefined) ??
      buildApplicationRecords(recordSource);
    if (display) {
      Object.freeze(orderedApplicationRecords);
      orderedRecordCollections.set(recordSource, orderedApplicationRecords);
    }
    // Creation and adoption reconcile rewrite the whole collection, so they
    // hold the campaign transition like every other mutating campaign
    // operation; the returned state is truthful for this snapshot.
    const activeCampaign = campaignState.campaigns.find(
      (campaign) => campaign.id === campaignState.activeCampaignId,
    );
    if (!activeCampaign) {
      throw new Error("The active job search campaign is unavailable.");
    }
    const activeCampaignJobIds = new Set(activeCampaign.jobIds);
    const activeCampaignTargetIds = new Set(activeCampaign.sourceTargetIds);
    const campaignSavedJobs = savedJobs.filter((job) =>
      activeCampaignJobIds.has(job.id),
    );
    const campaignReviewQueue = reviewQueue.filter((item) =>
      activeCampaignJobIds.has(item.jobId),
    );
    const {
      applicationRecords: campaignApplicationRecords,
      applyRuns: campaignApplyRuns,
      userActionRequests: campaignApplicationFacts,
    } = projectCampaignApplicationFacts({
      activeCampaign,
      campaigns: campaignState.campaigns,
      applicationRecords: orderedApplicationRecords,
      applyJobResults,
      applyRuns,
      userActionRequests,
    });
    const campaignApplyRunIds = new Set(campaignApplyRuns.map((run) => run.id));
    const campaignApplyJobResults = applyJobResults.filter((result) =>
      campaignApplyRunIds.has(result.runId),
    );
    const campaignUserActionRequests = campaignApplicationFacts.filter(
      (request) =>
        request.scope.type === "application" ||
        activeCampaignTargetIds.has(request.scope.targetId),
    );
    const campaignUnresolvedActionCount = campaignUserActionRequests.filter(
      (request) =>
        !["resolved", "skipped", "cancelled", "expired", "superseded"].includes(
          request.state,
        ),
    ).length;
    const campaignUserActionRequestIds = new Set(
      campaignUserActionRequests.map((request) => request.id),
    );
    const campaignUserActionEvents = userActionEvents.filter((event) =>
      campaignUserActionRequestIds.has(event.requestId),
    );
    const activeCampaignRunIds = new Set(
      activeCampaign.history.flatMap((entry) =>
        entry.discoveryRunId ? [entry.discoveryRunId] : [],
      ),
    );
    const activeCampaignRecentRuns = discovery.recentRuns.filter(
      (run) =>
        run.campaignId === activeCampaign.id ||
        activeCampaignRunIds.has(run.id),
    );
    const activeCampaignActiveRun =
      discovery.activeRun?.campaignId === activeCampaign.id
        ? discovery.activeRun
        : null;
    const nextProgress = deriveCampaignProgress({
      campaign: activeCampaign,
      savedJobs: campaignSavedJobs,
      reviewQueue: campaignReviewQueue,
      applicationRecords: campaignApplicationRecords,
      applyRuns: campaignApplyRuns,
      applyJobResults: campaignApplyJobResults,
      unresolvedActions: campaignUnresolvedActionCount,
      lastRunAt:
        activeCampaignActiveRun?.startedAt ??
        activeCampaignRecentRuns[0]?.startedAt ??
        null,
      now: generatedAt,
    });
    // Progress is derived and carries its own time; the plan's updatedAt is
    // when the person (or the Assistant) last edited it, and edits check it.
    const comparableProgress = (progress: JobSearchCampaign["progress"]) => ({
      ...progress,
      lastUpdatedAt: "",
    });
    // Progress counts every job; the Home tier shows the stored one.
    const campaignProgressChanged =
      !homeTier &&
      JSON.stringify(comparableProgress(activeCampaign.progress)) !==
        JSON.stringify(comparableProgress(nextProgress));
    if (!campaignProgressChanged && borrowValidatedJobs && !homeTier)
      displayCampaignProgress = null;
    if (campaignProgressChanged && borrowValidatedJobs) {
      const key = JSON.stringify(comparableProgress(nextProgress));
      const projected =
        displayCampaignProgress?.source === campaignState &&
        displayCampaignProgress.key === key
          ? displayCampaignProgress.projected
          : {
              ...campaignState,
              campaigns: campaignState.campaigns.map((campaign) =>
                campaign.id === activeCampaign.id
                  ? { ...campaign, progress: nextProgress }
                  : campaign,
              ),
            };
      displayCampaignProgress = { source: campaignState, key, projected };
      Object.freeze(projected.campaigns);
      for (const campaign of projected.campaigns) {
        Object.freeze(campaign.progress);
        Object.freeze(campaign);
      }
      Object.freeze(projected);
      campaignState = projected;
    } else if (campaignProgressChanged) {
      // The projection delta lands on the latest committed collection inside
      // the campaign transition: the progress is re-derived against the
      // freshly read campaign so current saved-job counts stay truthful while
      // run timestamps merge forward — a terminal commit that serialized
      // ahead of this parked projection keeps its advanced lastRunAt and
      // lastUpdatedAt, plus its pointer, rules, history, run facts, and
      // notifications.
      campaignState = await ctx.withCampaignTransition(async () => {
        const latestState =
          (await ctx.repository.getCampaignState()) ?? campaignState;
        const latestCampaign = latestState.campaigns.find(
          (campaign) => campaign.id === activeCampaign.id,
        );
        if (!latestCampaign) return latestState;
        const mergedProgress = {
          ...deriveCampaignProgress({
            campaign: latestCampaign,
            savedJobs: campaignSavedJobs,
            reviewQueue: campaignReviewQueue,
            applicationRecords: campaignApplicationRecords,
            applyRuns: campaignApplyRuns,
            applyJobResults: campaignApplyJobResults,
            unresolvedActions: campaignUnresolvedActionCount,
            lastRunAt: laterIsoTimestamp(
              nextProgress.lastRunAt,
              latestCampaign.progress.lastRunAt,
            ),
            now: generatedAt,
          }),
          lastUpdatedAt: laterIsoTimestamp(
            generatedAt,
            latestCampaign.progress.lastUpdatedAt,
          ),
        };
        if (
          JSON.stringify(comparableProgress(latestCampaign.progress)) ===
          JSON.stringify(comparableProgress(mergedProgress))
        ) {
          return latestState;
        }
        const nextState = {
          ...latestState,
          campaigns: latestState.campaigns.map((campaign) =>
            campaign.id === activeCampaign.id
              ? { ...campaign, progress: mergedProgress }
              : campaign,
          ),
        };
        await ctx.repository.saveCampaignState(nextState);
        return nextState;
      });
    }
    const dashboard = deriveDashboardSummary({
      safeguards: intelligence.safeguards,
      generatedAt,
      campaigns: campaignState,
      savedJobs: campaignSavedJobs,
      reviewQueue: campaignReviewQueue,
      applicationRecords: campaignApplicationRecords,
      applyRuns: campaignApplyRuns,
      userActionRequests: campaignUserActionRequests,
      discovery,
      searchPreferences: setupContext.searchPreferences,
      sourceAccessPrompts,
    });
    dashboard.globalDailyApplicationPreparationCapacity =
      deriveGlobalDailyApplicationPreparationCapacity({
        applyRuns,
        applyJobResults,
        limit:
          settings.maxApplicationsPerLocalDay ??
          MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
        // An application prepared outside an apply run leaves only its
        // record, and the day's counter has to see it.
        applicationRecords: orderedApplicationRecords,
        now: new Date(generatedAt),
      });

    const listableIntelligence = {
      ...withResumeBatchLiveness(ctx.repository, intelligence),
      companies: intelligence.companies.filter((company) =>
        isListableCompanyName(company.canonicalName),
      ),
    };

    const snapshot = {
      module: "job-finder",
      generatedAt,
      hydration: homeTier
        ? { phase: "bootstrap", deferredCollections: ["discovery_jobs"] }
        : { phase: "complete", deferredCollections: [] },
      agentProvider: ctx.aiClient.getStatus(),
      visionProvider: ctx.visionProvider?.getStatus() ?? null,
      availableResumeTemplates,
      profile: setupContext.profile,
      searchPreferences: setupContext.searchPreferences,
      profileSetupState: setupContext.profileSetupState,
      browserSession,
      sourceAccessPrompts,
      discoverySessions,
      discoveryRunState: discovery.runState,
      fitJudgmentProgress: ctx.fitJudgmentProgressRef?.current ?? null,
      activeDiscoveryRun: discovery.activeRun,
      recentDiscoveryRuns: activeCampaignRecentRuns,
      activeSourceDebugRun: discovery.activeSourceDebugRun,
      recentSourceDebugRuns: discovery.recentSourceDebugRuns,
      discoveryJobs,
      dismissedDiscoveryJobs: projectedDismissedDiscoveryJobs,
      companyJobs,
      selectedDiscoveryJobId: discoveryJobs[0]?.id ?? null,
      reviewQueue,
      selectedReviewJobId: reviewQueue[0]?.jobId ?? null,
      tailoredAssets,
      resumeDrafts: normalizedResumeDrafts,
      resumeExportArtifacts,
      resumeResearchArtifacts,
      applyRuns,
      applyJobResults,
      applicationRecords: orderedApplicationRecords,
      applicationAttempts,
      sourceInstructionArtifacts,
      latestResumeImportRun: setupContext.latestResumeImportRun,
      resumeImportActive:
        isResumeImportActiveInProcess(ctx) ||
        ctx.activeResumeVisionRunIds.size > 0,
      latestResumeImportReviewCandidates:
        setupContext.latestResumeImportReviewCandidateSummaries,
      profileCopilotMessages,
      profileRevisions,
      selectedApplyRunId: selectLatestApplyRunId(applyRuns),
      selectedApplicationRecordId: orderedApplicationRecords[0]?.id ?? null,
      settings,
      userActionRequests: campaignUserActionRequests,
      userActionEvents: campaignUserActionEvents,
      campaigns: campaignState.campaigns,
      activeCampaignId: campaignState.activeCampaignId,
      campaignNotifications: campaignState.notifications,
      dashboard,
      activityControl,
      applyQueue,
      intelligence: listableIntelligence,
    };
    if (!borrowValidatedJobs)
      return JobFinderWorkspaceSnapshotSchema.parse(snapshot);
    // The window only needs display evidence. Keep the canonical feedback
    // cache warm for triage after the first full view has reached the window.
    if (!homeTier)
      ledgerWarmup ??= (async () => {
        await ctx.backgroundWorkReady;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (ctx.isWorkspaceClosing?.()) return;
        const canonical = await ctx.repository.readDiscoveryStateForRun?.();
        await warmDiscoveryLedgerIndex(
          canonical?.discoveryLedger ?? discovery.discoveryLedger,
        );
      })().catch((error: unknown) => {
        console.warn("[Job Finder] Warming triage history failed", error);
      });
    // Rows were validated on entering the immutable repository projection.
    // Re-parsing the same jobs in three lists deep-copied every listing again
    // on each progress update. Only display callers borrow these values; IPC
    // gives the renderer its own copy, and ordinary snapshots remain owned.
    return {
      ...BorrowedSnapshotRestSchema.parse(snapshot),
      searchPreferences: snapshot.searchPreferences,
      campaigns: snapshot.campaigns,
      intelligence: snapshot.intelligence,
      activeDiscoveryRun: discovery.activeRun,
      recentDiscoveryRuns: activeCampaignRecentRuns,
      activeSourceDebugRun: discovery.activeSourceDebugRun,
      recentSourceDebugRuns: discovery.recentSourceDebugRuns,
      discoveryJobs,
      dismissedDiscoveryJobs: projectedDismissedDiscoveryJobs,
      companyJobs,
      tailoredAssets:
        tailoredAssets as JobFinderWorkspaceSnapshot["tailoredAssets"],
      resumeDrafts: draftSummaries(normalizedResumeDrafts),
      resumeExportArtifacts: exportSummaries(resumeExportArtifacts),
      resumeResearchArtifacts: researchSummaries(resumeResearchArtifacts),
      applyRuns: applyRuns as JobFinderWorkspaceSnapshot["applyRuns"],
      applyJobResults:
        applyJobResults as JobFinderWorkspaceSnapshot["applyJobResults"],
      applicationRecords: orderedApplicationRecords,
      applicationAttempts:
        applicationAttempts as JobFinderWorkspaceSnapshot["applicationAttempts"],
      sourceInstructionArtifacts:
        sourceInstructionArtifacts as JobFinderWorkspaceSnapshot["sourceInstructionArtifacts"],
      profileCopilotMessages:
        profileCopilotMessages as JobFinderWorkspaceSnapshot["profileCopilotMessages"],
      profileRevisions: revisionSummaries(profileRevisions),
      userActionRequests: campaignUserActionRequests,
      userActionEvents: campaignUserActionEvents,
    };
  }

  /** The jobs past Find jobs, and every job an application points at. */
  async function readHomeTierSavedJobs(): Promise<readonly SavedJob[]> {
    const [curated, records] = await Promise.all([
      ctx.repository.listCuratedSavedJobIds!(),
      ctx.repository.listApplicationRecords(),
    ]);
    return ctx.repository.listSavedJobsByIds([
      ...new Set([...curated, ...records.map((record) => record.jobId)]),
    ]);
  }

  async function readHomeTierCampaignState(): Promise<JobSearchCampaignCollection> {
    const state = await (ctx.repository.readCampaignProjection?.() ??
      ctx.repository.getCampaignState());
    // A workspace without plans is created by the full snapshot.
    if (!state) throw new HomeTierUnavailableError();
    return state;
  }

  /**
   * Home's first view, before the full snapshot (ADR 0077). Null when this
   * workspace cannot give one; the full snapshot is the answer then.
   */
  async function getWorkspaceHomeSnapshot(): Promise<JobFinderWorkspaceSnapshot | null> {
    if (!ctx.repository.listCuratedSavedJobIds) return null;
    try {
      return await getWorkspaceSnapshot(true, true);
    } catch (error) {
      if (error instanceof HomeTierUnavailableError) return null;
      throw error;
    }
  }

  async function getWorkspaceBootstrap(): Promise<JobFinderWorkspaceSnapshot> {
    // The first paint must not wait for every job, source history, application,
    // document, and intelligence row. Keep this response deliberately small:
    // it contains only the profile and controls needed to render the shell.
    // The explicit hydration marker prevents empty deferred collections from
    // being mistaken for a completed search.
    const [
      setupContext,
      rawSettings,
      discovery,
      existingCampaignState,
      userActionRequests,
      activityControl,
      applyQueue,
    ] = await Promise.all([
      getCurrentSetupStateContext(),
      ctx.repository.getSettings(),
      ctx.repository.readDiscoveryDisplayProjection(),
      ctx.repository.getCampaignState(),
      ctx.repository.listUserActionRequests(),
      ctx.repository.getActivityControl(),
      ctx.repository.getApplyQueue(),
    ]);
    const availableResumeTemplates = ctx.documentManager.listResumeTemplates();
    const settings = normalizeJobFinderSettings(
      {
        ...rawSettings,
        salaryDisclosure: await readSalaryDisclosurePreference(ctx.repository),
      },
      availableResumeTemplates,
    );
    const generatedAt = new Date().toISOString();
    // Keep source targets in the bootstrap. They are small setup data, and
    // clearing them here would let an early settings save erase the sources
    // before the large collections finish hydrating.
    const bootstrapSearchPreferences = JobSearchPreferencesSchema.parse(
      setupContext.searchPreferences,
    );
    const campaignState = existingCampaignState ?? {
      activeCampaignId: "campaign_default",
      campaigns: [
        createCampaign({
          id: "campaign_default",
          name: "My job search",
          description:
            "Your main search. Find jobs uses this plan's roles and places, plus the job sources enabled on Profile.",
          mode: "precision",
          searchPreferences: setupContext.searchPreferences,
          now: generatedAt,
        }),
      ],
      notifications: [],
    };
    const bootstrapCampaignState = campaignState;
    const bootstrapActiveCampaign = campaignState.campaigns.find(
      (campaign) => campaign.id === campaignState.activeCampaignId,
    );
    const bootstrapTargetIds = new Set(
      bootstrapActiveCampaign?.sourceTargetIds ?? [],
    );
    // Application lineage is deferred in bootstrap snapshots. Fail closed
    // until the complete snapshot can join requests to runs and records.
    const bootstrapUserActionRequests = userActionRequests.filter(
      (request) =>
        request.scope.type === "discovery_source" &&
        bootstrapTargetIds.has(request.scope.targetId),
    );
    // A bootstrap snapshot of a workspace that has never run discovery still
    // has to name the real browser lane, or the first paint claims the search
    // runtime is the offline catalog before anything has been tried.
    const bootstrapRuntimeSession = await readUninitializedRuntimeSession(
      ctx,
      discovery.sessions,
      getPreferredSessionAdapter(setupContext.searchPreferences),
    );
    // Bootstrap intentionally omits sourceAccessPrompts: login-required
    // prompts need deferred debug history, so attention here reflects stored
    // target fields until the complete snapshot hydrates.
    const dashboard = deriveDashboardSummary({
      generatedAt,
      campaigns: bootstrapCampaignState,
      savedJobs: [],
      reviewQueue: [],
      applicationRecords: [],
      applyRuns: [],
      userActionRequests: bootstrapUserActionRequests,
      discovery: {
        ...discovery,
        activeRun: discovery.activeRun,
        recentRuns: [],
        activeSourceDebugRun: discovery.activeSourceDebugRun,
        recentSourceDebugRuns: [],
        sessions: discovery.sessions,
      },
      searchPreferences: bootstrapSearchPreferences,
    });

    return JobFinderWorkspaceSnapshotSchema.parse({
      module: "job-finder",
      generatedAt,
      hydration: {
        phase: "bootstrap",
        deferredCollections: [...BOOTSTRAP_DEFERRED_COLLECTIONS],
      },
      agentProvider: ctx.aiClient.getStatus(),
      visionProvider: ctx.visionProvider?.getStatus() ?? null,
      availableResumeTemplates,
      profile: setupContext.profile,
      searchPreferences: bootstrapSearchPreferences,
      profileSetupState: setupContext.profileSetupState,
      browserSession: createBrowserSessionSnapshot(
        discovery.sessions,
        getPreferredSessionAdapter(setupContext.searchPreferences),
        bootstrapRuntimeSession,
      ),
      sourceAccessPrompts: [],
      discoverySessions: discovery.sessions,
      discoveryRunState: discovery.runState,
      activeDiscoveryRun: discovery.activeRun,
      recentDiscoveryRuns: [],
      activeSourceDebugRun: discovery.activeSourceDebugRun,
      recentSourceDebugRuns: [],
      discoveryJobs: [],
      dismissedDiscoveryJobs: [],
      companyJobs: [],
      selectedDiscoveryJobId: null,
      reviewQueue: [],
      selectedReviewJobId: null,
      tailoredAssets: [],
      resumeDrafts: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      applyRuns: [],
      applyJobResults: [],
      applicationRecords: [],
      applicationAttempts: [],
      sourceInstructionArtifacts: [],
      latestResumeImportRun: setupContext.latestResumeImportRun,
      resumeImportActive:
        isResumeImportActiveInProcess(ctx) ||
        ctx.activeResumeVisionRunIds.size > 0,
      latestResumeImportReviewCandidates:
        setupContext.latestResumeImportReviewCandidateSummaries,
      profileCopilotMessages: [],
      profileRevisions: [],
      selectedApplyRunId: null,
      selectedApplicationRecordId: null,
      settings,
      campaigns: bootstrapCampaignState.campaigns,
      activeCampaignId: bootstrapCampaignState.activeCampaignId,
      campaignNotifications: bootstrapCampaignState.notifications,
      dashboard,
      activityControl,
      applyQueue,
      intelligence: {},
      userActionRequests: bootstrapUserActionRequests,
      userActionEvents: [],
    });
  }

  const profileSetupReviewMethods = createWorkspaceProfileSetupReviewMethods({
    ctx,
    getCurrentSetupStateContext,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
  });

  const profileCopilotMethods = createWorkspaceProfileCopilotMethods({
    ctx,
    getCurrentSetupStateContext,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
    // The same write Settings > AI behavior makes for the resume level.
    commitResumeApplicationMode: (resumeApplicationMode) =>
      commitApplicationDefaultFields({ resumeApplicationMode }),
  });

  async function preserveRemovedSourceLabels(
    currentSearchPreferences: JobSearchPreferences,
    nextSearchPreferences: JobSearchPreferences,
  ): Promise<void> {
    const removedSourceLabels = new Map(
      currentSearchPreferences.discovery.targets
        .filter(
          (target) =>
            !nextSearchPreferences.discovery.targets.some(
              (next) => next.id === target.id,
            ),
        )
        .map((target) => [target.id, target.label]),
    );
    if (removedSourceLabels.size > 0) {
      const preserveLabels = (job: SavedJob): SavedJob => ({
        ...job,
        provenance: job.provenance.map((entry) =>
          entry.sourceLabel || !removedSourceLabels.has(entry.targetId)
            ? entry
            : {
                ...entry,
                sourceLabel: removedSourceLabels.get(entry.targetId),
              },
        ),
      });
      await ctx.repository.commitSavedJobDelta({
        update: preserveLabels,
        updateDiscoveryState: (current) => ({
          ...current,
          pendingDiscoveryJobs:
            current.pendingDiscoveryJobs.map(preserveLabels),
        }),
      });
    }
  }

  async function persistSearchPreferences(
    searchPreferences: JobSearchPreferences,
    options: { preserveAiBehaviorOwnedFields: boolean },
  ) {
    const currentProfile = await ctx.repository.getProfile();
    const currentProfileSetupState =
      await ctx.repository.getProfileSetupState();
    const currentSearchPreferences = normalizeSearchPreferences(
      await ctx.repository.getSearchPreferences(),
    );
    const parsedSearchPreferences = normalizeSearchPreferences(
      JobSearchPreferencesSchema.parse(searchPreferences),
    );
    // Profile and guided-setup callers still send the complete preferences
    // record. The resume approach and strict collection flag moved to
    // Settings in ADR 0025, so an older Profile draft must never write its
    // copies back over a newer Settings save. The AI-behavior save opts out
    // because it is the sole owner allowed to change these two fields.
    const ownedFieldsPreservedSearchPreferences =
      options.preserveAiBehaviorOwnedFields
        ? {
            ...parsedSearchPreferences,
            tailoringMode: currentSearchPreferences.tailoringMode,
            discovery: {
              ...parsedSearchPreferences.discovery,
              collectOnlyHardCriteriaMatches:
                currentSearchPreferences.discovery
                  .collectOnlyHardCriteriaMatches ?? false,
            },
          }
        : parsedSearchPreferences;
    const nextSearchPreferences = invalidateChangedSourceGuidance(
      currentSearchPreferences,
      ownedFieldsPreservedSearchPreferences,
    );
    await preserveRemovedSourceLabels(
      currentSearchPreferences,
      nextSearchPreferences,
    );
    await ctx.repository.saveSearchPreferences(nextSearchPreferences);
    await syncActiveCampaignPreferences(nextSearchPreferences);
    await deriveAndPersistProfileSetupState(ctx, {
      persistedState: currentProfileSetupState,
      profile: currentProfile,
      searchPreferences: nextSearchPreferences,
      latestResumeImportRunId:
        (await ctx.repository.getLatestResumeImportRun())?.id ?? null,
    });
    rescoreSavedJobsInBackground();
    return getWorkspaceSnapshot(true);
  }

  async function saveSearchPreferences(
    searchPreferences: JobSearchPreferences,
  ) {
    return persistSearchPreferences(searchPreferences, {
      preserveAiBehaviorOwnedFields: true,
    });
  }

  /**
   * Merges the given application-default fields into the transaction-current
   * settings. A resume-affecting change stales approved drafts first, and a
   * change of the default resume mode pins the previous default onto active
   * null-mode jobs in the same repository commit.
   */
  async function commitApplicationDefaultFields(
    defaultsFields: Partial<JobFinderSettings>,
  ): Promise<void> {
    const availableResumeTemplates = ctx.documentManager.listResumeTemplates();
    const mergeApplicationDefaults = (current: JobFinderSettings) =>
      normalizeJobFinderSettings(
        { ...current, ...defaultsFields },
        availableResumeTemplates,
      );

    const currentSettings = normalizeJobFinderSettings(
      await ctx.repository.getSettings(),
      availableResumeTemplates,
    );
    const nextSettings = mergeApplicationDefaults(currentSettings);

    if (hasResumeAffectingSettingsChange(currentSettings, nextSettings)) {
      await ctx.staleApprovedResumeDrafts(RESUME_SETTINGS_STALE_REASON);
    }

    const previousResumeApplicationMode =
      currentSettings.resumeApplicationMode ?? "tailored_per_job";
    const nextResumeApplicationMode =
      nextSettings.resumeApplicationMode ?? "tailored_per_job";

    if (previousResumeApplicationMode === nextResumeApplicationMode) {
      await ctx.repository.commitSettingsUpdate(mergeApplicationDefaults);
    } else {
      await ctx.repository.commitSavedJobDelta({
        update: capturePreviousResumeApplicationMode(
          previousResumeApplicationMode,
        ),
        updateSettings: mergeApplicationDefaults,
      });
    }
  }

  return {
    getWorkspaceSnapshot,
    getWorkspaceProjection: () => getWorkspaceSnapshot(true),
    getWorkspaceBootstrap,
    getWorkspaceHomeSnapshot,
    async getResumeImportState() {
      const [
        resumeImportRuns,
        resumeImportDocumentBundles,
        resumeImportFieldCandidates,
      ] = await Promise.all([
        ctx.repository.listResumeImportRuns(),
        ctx.repository.listResumeImportDocumentBundles(),
        ctx.repository.listResumeImportFieldCandidates(),
      ]);

      return {
        activeVisionRunIds: [...ctx.activeResumeVisionRunIds],
        resumeImportRuns,
        resumeImportDocumentBundles,
        resumeImportFieldCandidates,
      };
    },
    async resetWorkspace(seed: JobFinderRepositorySeed) {
      await ctx.repository.reset(seed);
      lastNoResponseAutomationRunAt = null;
      return getWorkspaceSnapshot(true);
    },
    async openBrowserSession(input) {
      const searchPreferences = normalizeSearchPreferences(
        await ctx.repository.getSearchPreferences(),
      );
      const sourceInstructionArtifacts =
        await ctx.repository.listSourceInstructionArtifacts();
      const configuredTargets = searchPreferences.discovery.targets;
      const target = resolveBrowserSessionTarget({
        targets: configuredTargets,
        targetId: input?.targetId,
      });
      const sessionSource = target
        ? resolveAdapterKind(target)
        : getPreferredSessionAdapter(searchPreferences);
      try {
        const session = await ctx.browserRuntime.openSession(
          sessionSource,
          target
            ? {
                targetUrl: resolveSourceBrowserEntryUrl({
                  target,
                  searchPreferences,
                  sourceInstructionArtifacts,
                }),
              }
            : undefined,
        );
        await ctx.persistBrowserSessionState(session);
        return getWorkspaceSnapshot(true);
      } catch (error) {
        if (target) {
          const session = await ctx.browserRuntime
            .getSessionState(sessionSource)
            .catch(() => null);

          if (session) {
            await ctx.persistBrowserSessionState(session);
          }
        }

        throw error;
      }
    },
    async checkBrowserSession() {
      const searchPreferences = normalizeSearchPreferences(
        await ctx.repository.getSearchPreferences(),
      );
      const session = await ctx.browserRuntime.getSessionState(
        getPreferredSessionAdapter(searchPreferences),
      );
      await ctx.persistBrowserSessionState(session);
      return getWorkspaceSnapshot(true);
    },
    async saveProfile(profile: CandidateProfile) {
      const currentProfile = await ctx.repository.getProfile();
      const currentSearchPreferences = normalizeSearchPreferences(
        await ctx.repository.getSearchPreferences(),
      );
      const currentProfileSetupState =
        await ctx.repository.getProfileSetupState();
      const nextProfile = normalizeProfileBeforeSave(
        currentProfile,
        CandidateProfileSchema.parse(profile),
      );
      const nextProfileSetupState = resolvePendingReviewItemsAfterExplicitSave({
        currentProfile,
        currentSearchPreferences,
        nextProfile,
        nextSearchPreferences: currentSearchPreferences,
        profileSetupState: currentProfileSetupState,
        now: new Date().toISOString(),
      });

      await nextTurn();
      if (hasResumeAffectingProfileChange(currentProfile, nextProfile)) {
        await ctx.staleApprovedResumeDrafts(
          "Profile details changed after approval and the resume needs a fresh review.",
          undefined,
          { profile: nextProfile },
        );
      } else {
        await ctx.repository.saveProfile(nextProfile);
      }
      await nextTurn();
      await deriveAndPersistProfileSetupState(ctx, {
        persistedState: nextProfileSetupState,
        profile: nextProfile,
        searchPreferences: currentSearchPreferences,
        latestResumeImportRunId:
          (await ctx.repository.getLatestResumeImportRun())?.id ?? null,
      });
      await nextTurn();
      const snapshot = await getWorkspaceSnapshot(true);
      if (
        createMatchAssessmentContextFingerprint(
          currentProfile,
          currentSearchPreferences,
        ) !==
        createMatchAssessmentContextFingerprint(
          nextProfile,
          currentSearchPreferences,
        )
      )
        rescoreSavedJobsInBackground();
      return snapshot;
    },
    async saveProfileAndSearchPreferences(
      profile: CandidateProfile,
      searchPreferences: JobSearchPreferences,
    ) {
      const currentProfile = await ctx.repository.getProfile();
      const currentProfileSetupState =
        await ctx.repository.getProfileSetupState();
      const nextProfile = normalizeProfileBeforeSave(
        currentProfile,
        CandidateProfileSchema.parse(profile),
      );
      const currentSearchPreferences = normalizeSearchPreferences(
        await ctx.repository.getSearchPreferences(),
      );
      const parsedSearchPreferences = normalizeSearchPreferences(
        JobSearchPreferencesSchema.parse(searchPreferences),
      );
      const nextSearchPreferences = invalidateChangedSourceGuidance(
        currentSearchPreferences,
        {
          ...parsedSearchPreferences,
          tailoringMode: currentSearchPreferences.tailoringMode,
          discovery: {
            ...parsedSearchPreferences.discovery,
            collectOnlyHardCriteriaMatches:
              currentSearchPreferences.discovery
                .collectOnlyHardCriteriaMatches ?? false,
          },
        },
      );
      const nextProfileSetupState = resolvePendingReviewItemsAfterExplicitSave({
        currentProfile,
        currentSearchPreferences,
        nextProfile,
        nextSearchPreferences,
        profileSetupState: currentProfileSetupState,
        now: new Date().toISOString(),
      });

      await nextTurn();
      await preserveRemovedSourceLabels(
        currentSearchPreferences,
        nextSearchPreferences,
      );
      if (hasResumeAffectingProfileChange(currentProfile, nextProfile)) {
        await ctx.staleApprovedResumeDrafts(
          "Profile details changed after approval and the resume needs a fresh review.",
          undefined,
          { profile: nextProfile, searchPreferences: nextSearchPreferences },
        );
      } else {
        await ctx.repository.saveProfileAndSearchPreferences(
          nextProfile,
          nextSearchPreferences,
        );
      }
      await nextTurn();
      await syncActiveCampaignPreferences(nextSearchPreferences);
      await nextTurn();
      await deriveAndPersistProfileSetupState(ctx, {
        persistedState: nextProfileSetupState,
        profile: nextProfile,
        searchPreferences: nextSearchPreferences,
        latestResumeImportRunId:
          (await ctx.repository.getLatestResumeImportRun())?.id ?? null,
      });
      await nextTurn();
      const snapshot = await getWorkspaceSnapshot(true);
      if (
        createMatchAssessmentContextFingerprint(
          currentProfile,
          currentSearchPreferences,
        ) !==
        createMatchAssessmentContextFingerprint(
          nextProfile,
          nextSearchPreferences,
        )
      )
        rescoreSavedJobsInBackground();
      return snapshot;
    },
    async runResumeImport(input) {
      const baseResume = ResumeSourceDocumentSchema.parse(input.baseResume);
      const documentBundle = ResumeDocumentBundleSchema.parse(
        input.documentBundle,
      );
      const searchPreferences = await ctx.repository.getSearchPreferences();
      const profileAtStart = await ctx.repository.getProfileWithRevision();
      const currentProfile = profileAtStart.profile;
      const nextProfile = normalizeProfileBeforeSave(currentProfile, {
        ...currentProfile,
        baseResume,
      });

      if (!baseResume.textContent && !input.visionArtifact?.pages.length) {
        const noTextWarnings = uniqueStrings([
          ...baseResume.analysisWarnings,
          ...documentBundle.warnings,
          ...(input.importWarnings ?? []),
          "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
        ]);
        const noTextCommit = await ctx.repository.commitProfileUpdate(
          (current) => {
            const normalized = normalizeProfileBeforeSave(current, {
              ...current,
              baseResume,
            });
            return CandidateProfileSchema.parse({
              ...normalized,
              baseResume: {
                ...normalized.baseResume,
                analysisWarnings: noTextWarnings,
              },
            });
          },
          { expectedRevision: profileAtStart.revision },
        );

        if (
          noTextCommit.status === "applied" &&
          hasResumeAffectingProfileChange(currentProfile, noTextCommit.profile)
        ) {
          await ctx.staleApprovedResumeDrafts(
            "Profile details changed after approval and the resume needs a fresh review.",
          );
        }

        return getWorkspaceSnapshot(true);
      }

      const importStartedAt = new Date().toISOString();
      const workflowResult = await runResumeImportWorkflow(ctx, {
        profile: nextProfile,
        ...(input.signal ? { signal: input.signal } : {}),
        searchPreferences,
        documentBundle,
        trigger: "import",
        expectedProfileRevision: profileAtStart.revision,
        ...(input.importWarnings
          ? { importWarnings: input.importWarnings }
          : {}),
        ...(input.visionArtifact
          ? { visionArtifact: input.visionArtifact }
          : {}),
      });
      await landProfileSetupAfterImport(ctx, { importStartedAt });

      if (
        hasResumeAffectingProfileChange(currentProfile, workflowResult.profile)
      ) {
        await ctx.staleApprovedResumeDrafts(
          "Profile details changed after approval and the resume needs a fresh review.",
        );
      }

      return getWorkspaceSnapshot(true);
    },
    async analyzeProfileFromResume() {
      const [profileAtStart, searchPreferences] = await Promise.all([
        ctx.repository.getProfileWithRevision(),
        ctx.repository.getSearchPreferences(),
      ]);
      const profile = profileAtStart.profile;

      if (!profile.baseResume.textContent) {
        await ctx.repository.commitProfileUpdate(
          (current) =>
            CandidateProfileSchema.parse({
              ...current,
              baseResume: {
                ...current.baseResume,
                extractionStatus: "needs_text",
                lastAnalyzedAt: null,
                analysisWarnings: [
                  "Paste plain-text resume content to let the agent extract candidate details.",
                ],
              },
            }),
          { expectedRevision: profileAtStart.revision },
        );

        throw new Error(
          "Resume text is required before the profile agent can extract candidate details.",
        );
      }

      const latestBundle =
        (
          await ctx.repository.listResumeImportDocumentBundles({
            sourceResumeId: profile.baseResume.id,
          })
        )[0] ?? buildBundleFromStoredResume(profile);
      await runResumeImportWorkflow(ctx, {
        profile,
        searchPreferences,
        documentBundle: latestBundle,
        trigger: "refresh",
        expectedProfileRevision: profileAtStart.revision,
      });

      return getWorkspaceSnapshot(true);
    },
    saveSearchPreferences,
    async saveProfileSetupState(profileSetupState: ProfileSetupState) {
      const [profile, searchPreferences] = await Promise.all([
        ctx.repository.getProfile(),
        ctx.repository.getSearchPreferences(),
      ]);
      const normalizedSearchPreferences =
        normalizeSearchPreferences(searchPreferences);
      await deriveAndPersistProfileSetupState(ctx, {
        persistedState: ProfileSetupStateSchema.parse(profileSetupState),
        profile,
        searchPreferences: normalizedSearchPreferences,
        latestResumeImportRunId:
          (await ctx.repository.getLatestResumeImportRun())?.id ?? null,
      });
      return getWorkspaceSnapshot(true);
    },
    applyProfileSetupReviewAction:
      profileSetupReviewMethods.applyProfileSetupReviewAction,
    async applyResumeTimelineRepairAction(
      runId: string,
      proposalId: string,
      action: ResumeTimelineRepairAction,
    ) {
      const previousProfile = await ctx.repository.getProfile();
      const result = await persistResumeTimelineRepairAction({
        repository: ctx.repository,
        runId,
        proposalId,
        action,
        occurredAt: new Date().toISOString(),
      });
      if (hasResumeAffectingProfileChange(previousProfile, result.profile)) {
        await ctx.staleApprovedResumeDrafts(
          action === "accept"
            ? "Resume timeline repair accepted"
            : action === "undo"
              ? "Resume timeline repair undone"
              : "Resume timeline repair reviewed",
        );
      }
      return getWorkspaceSnapshot(true);
    },
    sendProfileCopilotMessage: profileCopilotMethods.sendProfileCopilotMessage,
    applyAssistantProfilePatchGroup:
      profileCopilotMethods.applyAssistantProfilePatchGroup,
    proposeProfileCopilotChange:
      profileCopilotMethods.proposeProfileCopilotChange,
    applyProfileCopilotPatchGroup:
      profileCopilotMethods.applyProfileCopilotPatchGroup,
    rejectProfileCopilotPatchGroup:
      profileCopilotMethods.rejectProfileCopilotPatchGroup,
    undoProfileRevision: profileCopilotMethods.undoProfileRevision,
    async saveSettings(settings: JobFinderSettings) {
      const availableResumeTemplates =
        ctx.documentManager.listResumeTemplates();
      const currentSettings = normalizeJobFinderSettings(
        await ctx.repository.getSettings(),
        availableResumeTemplates,
      );
      const nextSettings = normalizeJobFinderSettings(
        settings,
        availableResumeTemplates,
      );

      if (hasResumeAffectingSettingsChange(currentSettings, nextSettings)) {
        await ctx.staleApprovedResumeDrafts(RESUME_SETTINGS_STALE_REASON);
      }

      const currentResumeApplicationMode =
        currentSettings.resumeApplicationMode ?? "tailored_per_job";
      const nextResumeApplicationMode =
        nextSettings.resumeApplicationMode ?? "tailored_per_job";

      if (currentResumeApplicationMode === nextResumeApplicationMode) {
        await ctx.repository.commitSettingsUpdate(() => nextSettings);
      } else {
        await ctx.repository.commitSavedJobDelta({
          update: capturePreviousResumeApplicationMode(
            currentResumeApplicationMode,
          ),
          updateSettings: () => nextSettings,
        });
      }
      return getWorkspaceSnapshot(true);
    },
    async updateApplicationDefaults(input: UpdateApplicationDefaultsInput) {
      const parsedInput = UpdateApplicationDefaultsInputSchema.parse(input);
      await commitApplicationDefaultFields(
        pickDefined({
          resumeApplicationMode: parsedInput.resumeApplicationMode,
          resumeTemplateId: parsedInput.resumeTemplateId,
          fontPreset: parsedInput.fontPreset,
          coverLetter: parsedInput.coverLetter,
          applicationAutomationMode: parsedInput.applicationAutomationMode,
          maxApplicationsPerLocalDay: parsedInput.maxApplicationsPerLocalDay,
          salaryDisclosure: parsedInput.salaryDisclosure,
        }),
      );
      return getWorkspaceSnapshot(true);
    },
    async updateAiBehavior(input: UpdateAiBehaviorInput) {
      const patch = UpdateAiBehaviorInputSchema.parse(input);
      const saved = await ctx.repository.getSettings();
      const current = AiBehaviorPreferenceSchema.parse(saved.aiBehavior ?? {});
      // Merge explicit fields before defaults: an omitted declaration list is
      // never permission to restore approvals the person withdrew.
      const parsedInput = {
        ...patch,
        aiBehavior:
          patch.aiBehavior === undefined
            ? undefined
            : AiBehaviorPreferenceSchema.parse({
                profileAssistant: {
                  ...current.profileAssistant,
                  ...patch.aiBehavior.profileAssistant,
                },
                jobSearch: {
                  ...current.jobSearch,
                  ...patch.aiBehavior.jobSearch,
                },
                applying: { ...current.applying, ...patch.aiBehavior.applying },
              }),
        coverLetter:
          patch.coverLetter === undefined
            ? undefined
            : CoverLetterPreferenceSchema.parse({
                ...saved.coverLetter,
                ...patch.coverLetter,
              }),
      };
      const resumeApproach = parsedInput.resumeApproach;

      // Settings first: the behavior preference, the letter preference, and
      // the original-versus-tailored half of the resume approach. A change of
      // that default pins the previous default onto active null-mode jobs in
      // the same commit, exactly as the older application-defaults save did.
      await commitApplicationDefaultFields(
        pickDefined({
          aiBehavior: parsedInput.aiBehavior,
          coverLetter: parsedInput.coverLetter,
          resumeApplicationMode:
            resumeApproach === undefined
              ? undefined
              : resumeApproach === "original_resume"
                ? ("original_resume" as const)
                : ("tailored_per_job" as const),
        }),
      );

      // Then the two search-preference fields this section owns. They go
      // through the ordinary preferences save so the active plan's copy of
      // the preferences (which a search actually reads) stays in step.
      const nextTailoringMode =
        resumeApproach !== undefined && resumeApproach !== "original_resume"
          ? resumeApproach
          : undefined;
      const nextCollectOnlyHardCriteriaMatches =
        parsedInput.aiBehavior === undefined
          ? undefined
          : parsedInput.aiBehavior.jobSearch.selectivity === "best_matches";
      if (
        nextTailoringMode !== undefined ||
        nextCollectOnlyHardCriteriaMatches !== undefined
      ) {
        const currentSearchPreferences = normalizeSearchPreferences(
          await ctx.repository.getSearchPreferences(),
        );
        const changed =
          (nextTailoringMode !== undefined &&
            nextTailoringMode !== currentSearchPreferences.tailoringMode) ||
          (nextCollectOnlyHardCriteriaMatches !== undefined &&
            nextCollectOnlyHardCriteriaMatches !==
              (currentSearchPreferences.discovery
                .collectOnlyHardCriteriaMatches ?? false));
        if (changed) {
          await persistSearchPreferences(
            {
              ...currentSearchPreferences,
              ...(nextTailoringMode !== undefined
                ? { tailoringMode: nextTailoringMode }
                : {}),
              discovery: {
                ...currentSearchPreferences.discovery,
                ...(nextCollectOnlyHardCriteriaMatches !== undefined
                  ? {
                      collectOnlyHardCriteriaMatches:
                        nextCollectOnlyHardCriteriaMatches,
                    }
                  : {}),
              },
            },
            { preserveAiBehaviorOwnedFields: false },
          );
        }
      }
      return getWorkspaceSnapshot(true);
    },
    async updateWorkspaceBehavior(input: UpdateWorkspaceBehaviorInput) {
      const parsedInput = UpdateWorkspaceBehaviorInputSchema.parse(input);
      const behaviorFields = pickDefined({
        keepSessionAlive: parsedInput.keepSessionAlive,
        discoveryOnly: parsedInput.discoveryOnly,
        collapseSideMenuWithAssistant:
          parsedInput.collapseSideMenuWithAssistant,
        writeResumesOnShortlist: parsedInput.writeResumesOnShortlist,
      });
      await ctx.repository.commitSettingsUpdate((current) =>
        JobFinderSettingsSchema.parse({ ...current, ...behaviorFields }),
      );
      return getWorkspaceSnapshot(true);
    },
    async updateTrackerCrm(applicationCrm: ApplicationCrmSettings) {
      const committedCrm = ApplicationCrmSettingsSchema.parse(applicationCrm);
      await ctx.repository.commitSettingsUpdate((current) => ({
        ...current,
        applicationCrm: committedCrm,
      }));
      await runNoResponseAutomationIfDue({ settings: committedCrm });
      return getWorkspaceSnapshot(true);
    },
    async updateAppearanceTheme(appearanceTheme: AppearanceTheme) {
      const parsedTheme = AppearanceThemeSchema.parse(appearanceTheme);
      await ctx.repository.commitSettingsUpdate((current) => ({
        ...current,
        appearanceTheme: parsedTheme,
      }));
      return getWorkspaceSnapshot(true);
    },
  };
}
