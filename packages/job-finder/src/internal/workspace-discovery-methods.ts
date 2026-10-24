import {
  copyView,
  createConcurrencyLimiter,
  yieldToEventLoop,
} from "@nestor/core";
import { isDeepStrictEqual } from "node:util";
import { channel } from "node:diagnostics_channel";
import { patchDiscoveryLedger } from "@nestor/db";
import {
  prepareDiscoveryPosting,
  prepareBodySalaryRange,
} from "./discovery-posting-preparation";
import {
  createDiscoverySavedJobWriter,
  markSupersedingDiscoveryUpdate,
} from "./discovery-saved-job-writer";
import { buildDiscoveryRunReport } from "./workspace-discovery-run-helpers";
import {
  withPlanAssessment,
  readPlanAssessment,
  personPickedJob,
  personSuppliedJob,
} from "./plan-assessment";
import { parseNormalizedCompensation } from "./matching-compensation";
import { searchPreferencesForCampaignRun } from "./campaign-dashboard";
import {
  DISCOVERY_NO_JOB_SITES_MESSAGE,
  DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE,
  DiscoveryAgentMetadataSchema,
  readPreparedBodySalaryRange,
  readPreparedDiscoveryFingerprints,
  DISCOVERY_FINGERPRINT_FIELDS,
  writeDiscoveryPreparation,
  type CandidateProfile,
  type DiscoveryActivityEvent,
  type DiscoveryRunRecord,
  type DiscoveryRunResult,
  type FitJudgment,
  type MatchAssessment,
  type DiscoveryRunScope,
  type DiscoveryTargetExecution,
  type DiscoverySourceListingCounts,
  type JobDiscoveryTarget,
  type JobFinderSearchRequest,
  type AiJobSearchBehavior,
  AiBehaviorPreferenceSchema,
  type JobFinderWorkspaceSnapshot,
  type JobPosting,
  type JobSearchPreferences,
  type JobSource,
  type ListingScreenRecord,
  type ParkedBrowserTabReference,
  type SavedJob,
  type SourceIntelligenceProviderKey,
  deriveListingDetailCapture,
  stripDiscoveryCardOnlyEvidenceWarning,
} from "@nestor/contracts";
import {
  getDiscoveryListingRecencyKey,
  toSortableListingTime,
} from "../discovery-ordering";
import {
  appendDiscoveryEvent,
  createDiscoveryEvent,
  finalizeDiscoveryState,
  summarizeProgressAction,
  updateTargetExecution,
} from "./discovery-state";
import {
  persistDiscoveryRunBlockerUserAction,
  resolveSourceAccessRequestsAfterCompletedRun,
} from "./workspace-source-user-action";
import {
  createMatchAssessment,
  createMatchAssessmentAsync,
  enrichDiscoveredPosting,
  applySightingRoute,
  mergeDiscoveredPostings,
  toSavedJobId,
  toSightingIdentityInput,
} from "./matching";
import {
  canSwitchCanonicalSighting,
  selectCanonicalSighting,
} from "./listing-sightings";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { applyFitJudgment } from "./fit-judgment-apply";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import {
  compareMatchRecommendationPriority,
  compareMatchRoleSuitabilityPriority,
  compareMatchScores,
} from "./match-assessment-ranking";
import {
  buildInstructionGuidance,
  enrichSearchPreferencesFromProfile,
  getActiveDiscoveryTargets,
  resolveActiveSourceInstructionArtifact,
  resolveAdapterKind,
} from "./workspace-helpers";
import { collectResumeAffectingChangedJobIds } from "./resume-workspace-staleness";
import {
  DEFAULT_ROLE,
  MAX_DISCOVERY_TARGET_TIME_BUDGET_MS,
  MAX_DISCOVERY_AGENT_NO_PROGRESS_STEPS,
  discoveryAdapters,
} from "./workspace-defaults";
import {
  createDiscoveryProvenance,
  formatDiscoveryFreshnessDigest,
  mergePendingJobs,
  mergeSavedJobs,
  overlayTouchedPendingJobs,
  shouldSkipPostingFromLedger,
} from "./workspace-service-helpers";
import {
  createRunDiscoveryLedger,
  createSyncedJobIdentityIndex,
} from "./discovery-run-indexes";
import {
  buildListingScreenContext,
  createListingScreenBatcher,
  listingScreenKey,
  screenListingsWithModel,
  type ListingScreenListing,
} from "./listing-screen";
import {
  compactJobIdentity,
  normalizeJobIdentityUrl,
  type JobIdentityInput,
} from "./job-identity";
import { createDiscoveryRefreshDecision } from "./workspace-discovery-refresh-schedule";
import {
  createDiscoveryFreshnessDigestInTurns,
  createDiscoveryListingFingerprints,
} from "./workspace-discovery-ledger";
import { rebaseDiscoveryLedgerEntry } from "./workspace-discovery-state-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import type {
  CampaignRunContext,
  DiscoveryTargetPipelineOptions,
  JobFinderWorkspaceService,
} from "./workspace-service-contracts";
import {
  completeTargetExecution,
  finalizeDiscoveryRun,
  finalizeRunningTargetExecutions,
  resolveDiscoveryBudgetPlan,
} from "./workspace-discovery-run-helpers";
import {
  applyDiscoveryTitleTriage,
  buildDiscoveryStartingUrls,
  collectPublicProviderJobs,
  inferSourceIntelligenceFromTarget,
  selectDiscoveryCollectionMethod,
  selectDiscoveryMethod,
} from "./workspace-source-intelligence";
import { createUniqueId, normalizeText, uniqueStrings } from "./shared";
import { createJobIdentityIndex } from "./job-identity";
import { assessJobPostingDetailQuality } from "./job-posting-detail-quality";
import { JOB_FIT_JUDGING_BATCH_SIZE } from "@nestor/ai-providers";
import { createSearchFitBatcher } from "./search-fit-batcher";
import { createSearchListingReadAhead } from "./search-listing-read-ahead";
import { selectSourcesFinishedBeforeRestart } from "./discovery-restart";
import {
  fitPostingFingerprint,
  compareFitJudgingPromise,
  jobNeedsFitJudgment,
  judgeJobFitsInBatches,
} from "./fit-judgment";
import {
  describeListingDetailEnrichment,
  createModelListingPageReader,
  createListingReadRateLimitState,
  enrichSavedJobListingDetails,
  jobNeedsListingDetail,
  LISTING_DETAIL_READS_PER_RUN,
  readSightingApplyRoutes,
} from "./listing-detail-enrichment";
import {
  countDiscoveryListingCapture,
  describeDiscoveryListingCapture,
} from "./discovery-listing-capture";
import { describeRemoteOnlySourceMismatch } from "./discovery-location-alignment";
import {
  findSiteFurnitureSalaryTexts,
  isSalaryTextStatedInBody,
  isSiteFurnitureSalaryText,
  reconcileSalaryTextWithPreparedBody,
} from "./matching-compensation";
import { normalizeListingText } from "./listing-detail-extraction";
import { toProviderAwarePosting } from "./discovery-posting-normalization";
import {
  takePreparedDiscoveryPosting,
  carryPreparedDiscoveryPosting,
} from "./discovery-feed-executor";
export {
  resolveListingEmployer,
  resolveListingLocation,
} from "./discovery-posting-normalization";

// `normalizeListingText` moved beside the other text-boundary helpers in
// `listing-detail-extraction` so the detail-read stage can use it without
// importing this module back. Re-exported here because discovery callers and
// its own tests already reach for it at this path.
export { normalizeListingText };

const DISCOVERY_ACTIVITY_SAMPLE_LIMIT = 3;
const bookkeeping = channel("nestor.discovery.bookkeeping");
/**
 * Every job a search keeps is judged (ADR 0041). Older jobs of the plan
 * that need a new verdict, after the profile or goals changed, are judged
 * up to this many per search: five calls of twenty.
 */
const OLDER_JOB_FIT_JUDGMENTS_PER_RUN = 100;
/** The older-job share each searched source brings, up to the caps. */
const OLDER_JOB_FIT_JUDGMENTS_PER_SOURCE = 10;
const OLDER_LISTING_READS_PER_SOURCE = 6;
/** Fit calls a running search keeps open beside its source agents. */
const SEARCH_FIT_JUDGING_CONCURRENCY = 3;
/**
 * How long a kept job waits for a full batch of twenty: the run's first
 * batch and a batch at least half full go after the first wait, any batch
 * after the second, so scores still show while a slow search runs.
 */
const SEARCH_FIT_PARTIAL_BATCH_WAIT_MS = 20_000;
const SEARCH_FIT_MAX_BATCH_WAIT_MS = 90_000;
/**
 * Feeds a search holds at once: downloading, waiting for the listing screen,
 * or ready to merge. Downloads themselves run a few at a time.
 */
const PUBLIC_API_PREFETCH_CONCURRENCY = 24;
const PUBLIC_API_DOWNLOAD_CONCURRENCY = 24;
/** Feed listings looked up against the run's jobs per event-loop turn. */
const SCREEN_LOOKUPS_PER_TURN = 40;
/**
 * API sources merged at the same time. Merging is main-process work, so more
 * would only interleave it; more than one keeps a source whose jobs wait on a
 * fit verdict ("Best matches only") from holding the lane.
 */
const PUBLIC_API_PROCESSING_CONCURRENCY = 3;
/**
 * How many browser sources one search works on at the same time. Each gets
 * its own browser tab. Ten readers fit the measured native host budget; tab
 * admission also leaves room for applications and popups. API feeds run in
 * their own lane beside them. Override with NESTOR_SEARCH_CONCURRENCY.
 */
const DISCOVERY_SOURCE_CONCURRENCY = (() => {
  const configured = Number.parseInt(
    process.env.NESTOR_SEARCH_CONCURRENCY ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 10)
    : 10;
})();
/**
 * The time one browser source may take in a search of several. Sources that
 * found jobs finished within 15 minutes in the owner's searches; the ones
 * that ran for hours found nothing and held a tab. A one-source search keeps
 * the long budget.
 */
const MULTI_SOURCE_TARGET_TIME_BUDGET_MS = 20 * 60_000;
const DISCOVERY_STALL_STEP_WINDOW = MAX_DISCOVERY_AGENT_NO_PROGRESS_STEPS;
const RESUME_STALENESS_FLUSH_MS = 2 * 60_000;
/** Saved jobs a search's setup prepares per event-loop turn. */
const SETUP_JOBS_PER_TURN = 50;
/** Postings a source's final pass triages and merges per event-loop turn. */
const FINAL_PASS_POSTINGS_PER_TURN = 40;
/** `items.map(map)`, giving the event loop a turn every few dozen items. */
async function mapInTurns<T, R>(
  items: readonly T[],
  map: (item: T) => R,
  perTurn = FINAL_PASS_POSTINGS_PER_TURN,
): Promise<R[]> {
  const mapped: R[] = [];
  let turnStarted = performance.now();
  for (const [position, item] of items.entries()) {
    if (position % perTurn === 0 || performance.now() - turnStarted >= 8) {
      // Serve Electron messages between CPU slices so Stop and IPC get a turn.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      turnStarted = performance.now();
    }
    mapped.push(map(item));
  }
  return mapped;
}
const DISCOVERY_SAVE_COALESCE_MIN_SOURCES = 20;

/**
 * Bounded heartbeat for duplicate-only agent checkpoint sequences.
 *
 * A checkpoint whose postings were all processed by earlier flushes carries no
 * new jobs, no ledger deltas, and no counter changes: persisting it would
 * rewrite the whole discovery singleton only to refresh resume metadata and
 * the activity tail. Such checkpoints therefore skip persistence until either
 * this many agent revisions have accumulated since the last durable
 * checkpoint — bounding how much collected progress a hard crash can lose —
 * or an unconditional trigger fires: abort, disabled mid-run saving, or a
 * real kept batch. Revision counting keeps the gate deterministic; each
 * target's first checkpoint always flushes so target-start truth becomes
 * durable promptly.
 */
const CHECKPOINT_RESUME_HEARTBEAT_REVISIONS = 8;

/**
 * Truthful warning recorded on a browser-backed target when the campaign asked
 * for the bounded agent runtime but the configured browser runtime cannot
 * provide it. Prevents a silent zero-yield target when only the direct
 * discovery stub is available.
 */
const AGENT_RUNTIME_UNAVAILABLE_WARNING =
  "The bounded browser agent runtime is unavailable for this source; live collection fell back to direct discovery.";

export function applySavedJobDelta(
  currentJob: SavedJob,
  baselineJob: SavedJob,
  intendedJob: SavedJob,
): SavedJob {
  const changedFields: Record<string, unknown> = {};
  for (const key of Object.keys(intendedJob) as Array<keyof SavedJob>) {
    const intendedDescriptor = Object.getOwnPropertyDescriptor(
      intendedJob,
      key,
    );
    const baselineDescriptor = Object.getOwnPropertyDescriptor(
      baselineJob,
      key,
    );
    if (
      intendedDescriptor?.get &&
      intendedDescriptor.get === baselineDescriptor?.get
    )
      continue;
    if (!isDeepStrictEqual(intendedJob[key], baselineJob[key])) {
      if (key === "planAssessments") {
        const assessments = { ...currentJob.planAssessments };
        for (const [planId, assessment] of Object.entries(
          intendedJob.planAssessments ?? {},
        )) {
          if (
            !isDeepStrictEqual(
              assessment,
              baselineJob.planAssessments?.[planId],
            )
          )
            assessments[planId] = assessment;
        }
        changedFields[key] = assessments;
      } else changedFields[key] = intendedJob[key];
    }
  }

  const next = copyView(currentJob, changedFields);
  const fingerprints = DISCOVERY_FINGERPRINT_FIELDS.some((field) => field in changedFields)
    ? null
    : readPreparedDiscoveryFingerprints(currentJob);
  if (fingerprints) {
    const bodySalaryRange = readPreparedBodySalaryRange(currentJob);
    writeDiscoveryPreparation(next, {
      fingerprints: { owner: next, value: fingerprints },
      ...(bodySalaryRange !== undefined ? { bodySalaryRange } : {}),
    });
    return Object.freeze(next);
  }
  let bodySalaryRange = readPreparedBodySalaryRange(next);
  if (bodySalaryRange === undefined) {
    const intendedRange = readPreparedBodySalaryRange(intendedJob);
    if (
      intendedRange !== undefined &&
      next.description === intendedJob.description
    )
      bodySalaryRange = intendedRange;
  }
  createDiscoveryListingFingerprints(next);
  if (bodySalaryRange !== undefined)
    writeDiscoveryPreparation(next, { bodySalaryRange });
  return next;
}

/** Inspection counts need identity facts, not complete retained provider postings. */
function inspectionIdentity(
  posting: JobPosting,
  id: string,
): JobIdentityInput & { id: string } {
  return Object.freeze({
    ...compactJobIdentity(posting),
    id,
    matchAcrossSources: true,
  });
}

type PublicProviderJobsResult = Awaited<
  ReturnType<typeof collectPublicProviderJobs>
>;
type SettledPublicProviderJobsResult =
  | { result: PublicProviderJobsResult; error: null }
  | { result: null; error: unknown };

type ReadyDiscoveryTarget = {
  target: JobDiscoveryTarget;
  prefetchedPublicApiResult: Promise<SettledPublicProviderJobsResult> | null;
};

/**
 * The public-API sources of a search, in the order their feeds arrive.
 *
 * A small rolling window of feed requests runs ahead of the sources being
 * processed, so a search never holds more than that many feeds in memory and
 * the network stays busy while earlier feeds are merged. Browser sources do
 * not go through here: they run in their own lane beside this one, so an API
 * source never waits behind a browser source that takes minutes.
 */
async function* iteratePublicApiTargetsByReadiness(input: {
  targets: readonly JobDiscoveryTarget[];
  createPublicApiRequest: (
    target: JobDiscoveryTarget,
  ) => Promise<SettledPublicProviderJobsResult>;
  signal: AbortSignal;
}): AsyncGenerator<ReadyDiscoveryTarget> {
  const readyApiTargets: Array<{
    target: JobDiscoveryTarget;
    request: Promise<SettledPublicProviderJobsResult>;
  }> = [];
  const activeApiRequests = new Map<
    string,
    Promise<SettledPublicProviderJobsResult>
  >();
  let notifyReady: (() => void) | null = null;

  let nextApiTargetIndex = 0;
  const startAvailableApiRequests = () => {
    while (
      activeApiRequests.size < PUBLIC_API_PREFETCH_CONCURRENCY &&
      nextApiTargetIndex < input.targets.length
    ) {
      const target = input.targets[nextApiTargetIndex];
      nextApiTargetIndex += 1;
      if (!target) continue;
      const request = input.createPublicApiRequest(target);
      activeApiRequests.set(target.id, request);
      void request.then(() => {
        if (!activeApiRequests.has(target.id)) return;
        readyApiTargets.push({ target, request });
        const notify = notifyReady;
        notifyReady = null;
        notify?.();
      });
    }
  };

  startAvailableApiRequests();
  while (activeApiRequests.size > 0) {
    if (input.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const readyApiTarget = readyApiTargets.shift();
    if (readyApiTarget) {
      activeApiRequests.delete(readyApiTarget.target.id);
      startAvailableApiRequests();
      yield {
        target: readyApiTarget.target,
        prefetchedPublicApiResult: readyApiTarget.request,
      };
      continue;
    }

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        input.signal.removeEventListener("abort", onAbort);
      };
      const finishReady = () => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };

      notifyReady = finishReady;
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (readyApiTargets.length > 0) {
        notifyReady = null;
        finishReady();
      }
    });
  }
}

function getDiscoveryBudgetListingRecency(posting: JobPosting): number {
  const listingRecency = getDiscoveryListingRecencyKey({
    postedAt: posting.postedAt,
    postedAtText: posting.postedAtText,
    providerUpdatedAt: posting.providerUpdatedAt,
  });
  if (listingRecency.basis !== null) {
    return listingRecency.timestamp;
  }
  return toSortableListingTime(posting.firstSeenAt ?? posting.discoveredAt);
}

export function selectDiscoveryBudgetPostings(input: {
  postings: readonly JobPosting[];
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  limit: number;
  preferredCanonicalUrls?: readonly string[];
  assessPosting?: (
    posting: JobPosting,
  ) => ReturnType<typeof createMatchAssessment>;
}): JobPosting[] {
  const normalizeCanonicalUrl = (value: string): string => {
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
      return parsed.toString();
    } catch {
      return value.trim();
    }
  };
  const preferredCanonicalUrls = new Set(
    (input.preferredCanonicalUrls ?? []).map(normalizeCanonicalUrl),
  );
  const ranked = input.postings
    .map((posting, index) => ({
      posting,
      index,
      preferred: preferredCanonicalUrls.has(
        normalizeCanonicalUrl(posting.canonicalUrl),
      ),
      assessment:
        input.assessPosting?.(posting) ??
        createMatchAssessment(input.profile, input.searchPreferences, posting),
      recency: getDiscoveryBudgetListingRecency(posting),
    }))
    .sort(
      (left, right) =>
        compareMatchRecommendationPriority(left.assessment, right.assessment) ||
        Number(right.preferred) - Number(left.preferred) ||
        compareMatchRoleSuitabilityPriority(
          left.assessment,
          right.assessment,
        ) ||
        compareMatchScores(left.assessment, right.assessment) ||
        right.recency - left.recency ||
        left.index - right.index,
    );
  const selected: JobPosting[] = [];
  const seenRoleVariants = new Set<string>();
  const limit = Math.max(0, input.limit);

  for (const entry of ranked) {
    if (selected.length >= limit) {
      break;
    }

    const roleVariantKey = [
      normalizeText(entry.posting.company),
      normalizeText(entry.posting.title),
    ].join(":");
    if (seenRoleVariants.has(roleVariantKey)) {
      continue;
    }

    seenRoleVariants.add(roleVariantKey);
    selected.push(entry.posting);
  }

  return selected;
}

function describeUnknownThrowable(caughtError: unknown): string {
  if (typeof caughtError === "string") {
    return caughtError;
  }

  if (
    typeof caughtError === "number" ||
    typeof caughtError === "boolean" ||
    typeof caughtError === "bigint" ||
    typeof caughtError === "symbol"
  ) {
    return String(caughtError);
  }

  if (caughtError && typeof caughtError === "object") {
    if ("message" in caughtError && typeof caughtError.message === "string") {
      return caughtError.message;
    }

    try {
      const serialized = JSON.stringify(caughtError);
      if (serialized) {
        return serialized;
      }
    } catch {
      // Ignore serialization failures and fall back to a generic description.
    }

    return "non-serializable object throwable";
  }

  return "unknown throwable";
}

function describeCloseoutMode(keptAlive: boolean) {
  return keptAlive
    ? {
        mode: "kept_alive" as const,
        label: "Browser kept open",
        detail:
          "The browser profile stayed attached so the next run can reuse the current signed-in session.",
      }
    : {
        mode: "closed" as const,
        label: "Browser closed",
        detail:
          "The discovery browser session was closed after the run finished. It will reopen automatically next time.",
      };
}

function formatDiscoveryPostingLabel(input: {
  title: string;
  company: string;
}): string {
  const title = input.title.trim();
  const company = input.company.trim();

  return company ? `${title} at ${company}` : title;
}

function formatDiscoveryPostingSamples(
  postings: readonly Pick<JobPosting, "title" | "company">[],
): string | null {
  const labels = uniqueStrings(
    postings
      .map((posting) => formatDiscoveryPostingLabel(posting))
      .filter(Boolean),
  ).slice(0, DISCOVERY_ACTIVITY_SAMPLE_LIMIT);

  return labels.length > 0
    ? labels.map((label) => `"${label}"`).join("; ")
    : null;
}

function formatDiscoverySkipSamples(
  samples: {
    title: string;
    company: string;
    reason: string | null;
  }[],
): string | null {
  const labels = uniqueStrings(
    samples.map((sample) => {
      const label = formatDiscoveryPostingLabel(sample);
      return sample.reason ? `${label} -> ${sample.reason}` : label;
    }),
  ).slice(0, DISCOVERY_ACTIVITY_SAMPLE_LIMIT);

  return labels.length > 0
    ? labels.map((label) => `"${label}"`).join("; ")
    : null;
}

function getSourceIntelligenceProviderKey(
  intelligence: NonNullable<JobPosting["sourceIntelligence"]>,
): SourceIntelligenceProviderKey | null {
  return intelligence.provider?.key ?? null;
}

/**
 * Execution states whose stored checkpoint still represents genuinely
 * interrupted mid-source work. A completed execution may keep its last
 * checkpoint recorded for durability, so eligibility comes from this set
 * plus the run-state guard below rather than from checkpoint presence:
 * completed-run progress never replays into a fresh run. Skipped targets
 * and per-target error failures clear any inherited or earned checkpoint,
 * so a surviving checkpoint here always belongs to an execution that
 * stopped before finishing collection (user cancellation, app close before
 * recovery finalization, or a pipeline-level abort).
 */
const RESUMABLE_AGENT_CHECKPOINT_EXECUTION_STATES: ReadonlySet<
  DiscoveryTargetExecution["state"]
> = new Set(["cancelled", "failed", "running"]);

/**
 * Explicit resume eligibility for agent checkpoints.
 *
 * Only genuinely interrupted work may resume process progress (collected
 * jobs, steps, visited URLs). A prior run that reached a terminal state still
 * informs dedupe and ledger decisions through the persisted ledger, but it
 * must never seed loop progress, visited URLs, target counts, or stagnation
 * baselines into a fresh run. A still-running record (an app close observed
 * before recovery finalized it) is the newest candidate; history order is
 * newest-first, so the first eligible match carries the freshest progress.
 *
 * Progress belongs to the plan whose search was stopped: another plan's
 * stopped search never seeds this one (its jobs were never this plan's). And
 * a later finished search of the same source in this plan replaces any older
 * stopped one, so the search looks no further back than that.
 */
function selectResumableAgentCheckpoint(input: {
  activeRun: DiscoveryRunRecord | null;
  previousRuns: readonly DiscoveryRunRecord[];
  targetId: string;
  campaignId: string | null;
}): DiscoveryRunRecord["targetExecutions"][number]["agentCheckpoint"] {
  const candidateRuns =
    input.activeRun && input.activeRun.state === "running"
      ? [input.activeRun, ...input.previousRuns]
      : input.previousRuns;

  for (const run of candidateRuns) {
    if (
      (run.campaignId ?? null) !== input.campaignId ||
      !run.targetExecutions.some(
        (candidate) => candidate.targetId === input.targetId,
      )
    ) {
      continue;
    }
    if (run.state === "completed") {
      return null;
    }

    const execution = run.targetExecutions.find(
      (candidate) =>
        candidate.targetId === input.targetId &&
        candidate.agentCheckpoint &&
        RESUMABLE_AGENT_CHECKPOINT_EXECUTION_STATES.has(candidate.state),
    );
    if (execution?.agentCheckpoint) {
      return execution.agentCheckpoint;
    }
  }

  return null;
}

function getDiscoveryProviderKey(input: {
  target: JobDiscoveryTarget;
  intelligence: NonNullable<JobPosting["sourceIntelligence"]>;
}): SourceIntelligenceProviderKey | null {
  return (
    getSourceIntelligenceProviderKey(input.intelligence) ??
    inferSourceIntelligenceFromTarget({
      target: input.target,
      currentArtifact: null,
    }).provider?.key ??
    null
  );
}

function createInitialRunRecord(input: {
  id: string;
  campaignId: string | null;
  targets: readonly JobDiscoveryTarget[];
  scope: DiscoveryRunScope;
  activeRun: DiscoveryRunRecord | null;
  previousRuns?: readonly DiscoveryRunRecord[];
  searchRequest?: JobFinderSearchRequest;
}): DiscoveryRunRecord {
  const emptyDigest = () => ({
    new: 0,
    unchanged: 0,
    changed: 0,
    reactivated: 0,
    inactive: 0,
    known: 0,
    skipped: 0,
  });
  return {
    id: input.id,
    runPhase: null,
    campaignId: input.campaignId,
    state: "running",
    scope: input.scope,
    startedAt: new Date().toISOString(),
    completedAt: null,
    targetIds: input.targets.map((target) => target.id),
    ...(input.searchRequest
      ? {
          searchIntent: input.searchRequest.intent,
          ...(input.searchRequest.breadth
            ? { searchBreadth: input.searchRequest.breadth }
            : {}),
          searchFreshness: input.searchRequest.freshness,
        }
      : {}),
    targetExecutions: input.targets.map((target) => ({
      targetId: target.id,
      adapterKind: target.adapterKind,
      resolvedAdapterKind: resolveAdapterKind(target),
      collectionMethod: null,
      sourceIntelligenceProvider: null,
      state: "planned",
      startedAt: null,
      completedAt: null,
      requestedJobBudget: null,
      jobsInspected: 0,
      inspectedJobIds: [],
      uniqueInspectionsKnown: true,
      rejectedListings: [],
      listingsDeferred: 0,
      sourceCounts: [],
      jobsReviewed: 0,
      jobsFound: 0,
      jobsPersisted: 0,
      jobsStaged: 0,
      jobsSkippedByLedger: 0,
      jobsSkippedByTitleTriage: 0,
      duplicatesMerged: 0,
      invalidSkipped: 0,
      warning: null,
      encounteredJobIds: [],
      changeDigest: emptyDigest(),
      compactionState: null,
      compactionUsedFallbackTrigger: false,
      timing: null,
      agentCheckpoint: selectResumableAgentCheckpoint({
        activeRun: input.activeRun,
        previousRuns: input.previousRuns ?? [],
        targetId: target.id,
        campaignId: input.campaignId,
      }),
    })),
    activity: [],
    summary: {
      targetsPlanned: input.targets.length,
      targetsCompleted: 0,
      validJobsFound: 0,
      jobsPersisted: 0,
      jobsStaged: 0,
      jobsSkippedByLedger: 0,
      jobsSkippedByTitleTriage: 0,
      duplicatesMerged: 0,
      invalidSkipped: 0,
      durationMs: 0,
      outcome: "running",
      browserCloseout: null,
      timing: null,
      report: null,
      sourceHealth: [],
      warnings: [],
      changeDigest: emptyDigest(),
    },
  };
}

function updateRunSummary(
  run: DiscoveryRunRecord,
  patch: Partial<DiscoveryRunRecord["summary"]>,
): DiscoveryRunRecord {
  // This is the service-owned run accumulator. Reparsing it copied its full
  // activity and checkpoint history on every summary increment.
  return {
    ...run,
    summary: {
      ...run.summary,
      ...patch,
    },
  };
}

function selectTargets(
  searchPreferences: JobSearchPreferences,
  options: DiscoveryTargetPipelineOptions,
): JobDiscoveryTarget[] {
  const activeTargets = getActiveDiscoveryTargets(searchPreferences);

  if (options.scope === "single_target") {
    return activeTargets.filter((target) => target.id === options.targetId);
  }

  if (!options.searchRequest || options.searchRequest.sourceIds === "all") {
    return activeTargets;
  }

  const requestedSourceIds = new Set(options.searchRequest.sourceIds);
  return activeTargets.filter((target) => requestedSourceIds.has(target.id));
}

function getDiscoveryCollectionMethodPriority(method: string): number {
  switch (method) {
    case "api":
      return 0;
    case "listing_route":
      return 1;
    case "careers_page":
      return 2;
    case "fallback_search":
      return 3;
    default:
      return 4;
  }
}

function getSourceInstructionPriority(
  status: JobDiscoveryTarget["instructionStatus"] | null,
): number {
  switch (status) {
    case "validated":
      return 0;
    case "draft":
      return 1;
    case "missing":
      return 2;
    default:
      return 3;
  }
}

function prioritizeDiscoveryTargets(
  targets: readonly JobDiscoveryTarget[],
  sourceInstructionArtifacts: Awaited<
    ReturnType<
      WorkspaceServiceContext["repository"]["listSourceInstructionArtifacts"]
    >
  >,
): JobDiscoveryTarget[] {
  return [...targets]
    .map((target, index) => {
      const activeInstruction = resolveActiveSourceInstructionArtifact(
        target,
        sourceInstructionArtifacts,
      );
      const collectionMethod = selectDiscoveryCollectionMethod(
        target,
        activeInstruction,
      );
      const startingUrls = buildDiscoveryStartingUrls(
        target,
        activeInstruction,
      );

      return {
        target,
        index,
        collectionMethodPriority:
          getDiscoveryCollectionMethodPriority(collectionMethod),
        instructionPriority: getSourceInstructionPriority(
          activeInstruction?.status ?? target.instructionStatus,
        ),
        learnedRoutePriority:
          startingUrls[0] != null && startingUrls[0] !== target.startingUrl
            ? 0
            : 1,
      };
    })
    .sort((left, right) => {
      if (left.collectionMethodPriority !== right.collectionMethodPriority) {
        return left.collectionMethodPriority - right.collectionMethodPriority;
      }

      if (left.instructionPriority !== right.instructionPriority) {
        return left.instructionPriority - right.instructionPriority;
      }

      if (left.learnedRoutePriority !== right.learnedRoutePriority) {
        return left.learnedRoutePriority - right.learnedRoutePriority;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.target);
}

/**
 * Stable identity key for a raw collected posting across checkpoint payloads
 * and the final collection result. The agent's collected list only grows, so
 * the same posting appears in many consecutive checkpoints; this key lets the
 * discovery pipeline process each posting exactly once per target, keeping
 * every run counter additive when checkpoints persist jobs mid-run.
 */
function getDiscoveryCheckpointPostingKey(posting: JobPosting): string {
  return `${posting.sourceJobId ?? ""}|${posting.canonicalUrl}`;
}

/**
 * Raw agent checkpoint payloads bypass the provider-aware mapping applied to
 * final collection results, so they still carry the schema-default detail
 * quality even when the extraction captured full listing detail. Derive it
 * once here so fingerprint claiming, freshness classification, and ledger
 * skip decisions see exactly the content the merge would persist: a
 * materially richer re-extraction of a retained identity must classify as
 * changed and reach the budget-free upgrade merge instead of hiding behind
 * the card-only default. Re-assessing an already-scored posting is
 * idempotent.
 */
/** Resolve attribution from the observed page, never from its extracted apply URL. */
export function resolvePostingProducingTarget(
  posting: Pick<JobPosting, "producingPageUrl">,
  activeTarget: JobDiscoveryTarget,
  targets: readonly JobDiscoveryTarget[],
): Pick<JobDiscoveryTarget, "id" | "label" | "adapterKind" | "startingUrl"> {
  if (!posting.producingPageUrl) return activeTarget;
  const page = new URL(posting.producingPageUrl);
  const candidates = targets
    .filter((target) => {
      const start = new URL(target.startingUrl);
      const path = start.pathname.replace(/\/$/u, "");
      return (
        page.origin === start.origin &&
        (!path ||
          page.pathname === path ||
          page.pathname.startsWith(`${path}/`))
      );
    })
    .sort((left, right) => right.startingUrl.length - left.startingUrl.length);
  const match = candidates[0];
  if (match) return match;
  // A same-site results page may lead to sibling listing paths. Preserve its
  // configured source only when no other configured source matches the page.
  if (page.origin === new URL(activeTarget.startingUrl).origin)
    return activeTarget;
  return {
    id: `page:${page.origin}`,
    label: page.hostname,
    adapterKind: "auto",
    startingUrl: posting.producingPageUrl,
  };
}

function normalizeCollectedCheckpointPosting(posting: JobPosting): JobPosting {
  const detailQuality = assessJobPostingDetailQuality(posting);
  return prepareDiscoveryPosting({
    ...posting,
    detailQuality,
    listingDetailCapture: deriveListingDetailCapture({
      description: posting.description,
      detailQuality,
      listingDetailFetch: posting.listingDetailFetch,
    }),
  });
}

function createPostingWithTriage(
  posting: JobPosting,
  searchPreferences: JobSearchPreferences,
  profile: CandidateProfile,
  judgment: FitJudgment | null,
): {
  posting: JobPosting;
  triageReason: string | null;
} {
  if (posting.searchRejection)
    return {
      posting: {
        ...posting,
        titleTriageOutcome: "skip_title",
      },
      triageReason: posting.searchRejection.reason,
    };
  const triage = applyDiscoveryTitleTriage({
    posting,
    searchPreferences,
    profile,
    judgment,
  });

  return {
    posting: {
      ...posting,
      titleTriageOutcome: triage.outcome,
    },
    triageReason: triage.outcome === "pass" ? null : triage.reason,
  };
}

async function collectTargetJobs(input: {
  ctx: WorkspaceServiceContext;
  target: JobDiscoveryTarget;
  sourceInstructionArtifacts: Awaited<
    ReturnType<
      WorkspaceServiceContext["repository"]["listSourceInstructionArtifacts"]
    >
  >;
  profile: Awaited<
    ReturnType<WorkspaceServiceContext["repository"]["getProfile"]>
  >;
  searchPreferences: JobSearchPreferences;
  searchMode: "precision" | "scale";
  searchRequest?: JobFinderSearchRequest;
  /** The saved AI search behavior (Settings), handed to the agent's prompt. */
  searchGuidance: AiJobSearchBehavior;
  targetJobCount: number;
  retainAllFound: boolean;
  maxSteps: number;
  activeRun: DiscoveryRunRecord;
  emitActivity: (event: DiscoveryActivityEvent) => void;
  onAgentCheckpoint: (
    targetId: string,
    checkpoint: NonNullable<
      DiscoveryRunRecord["targetExecutions"][number]["agentCheckpoint"]
    >,
  ) => Promise<void>;
  signal?: AbortSignal;
  openedSessionSources: Set<JobSource>;
  /**
   * The session open in flight per source, so sources searched at the same
   * time wait for one open instead of each starting their own and aborting
   * one another's navigation.
   */
  sessionOpenings: Map<JobSource, Promise<void>>;
  protectedPages: Map<string, ParkedBrowserTabReference>;
  useAgentRuntime: boolean;
  /** How long the agent may spend on this source. */
  timeBudgetMs: number;
  /** Caps agent runs across the search's lanes. */
  agentSlots?: { run<T>(operation: () => Promise<T>): Promise<T> };
  prefetchedPublicApiResult?: Promise<SettledPublicProviderJobsResult>;
}): Promise<{
  result: DiscoveryRunResult;
  collectionMethod: JobPosting["collectionMethod"];
  adapterKind: JobSource;
  intelligence: NonNullable<JobPosting["sourceIntelligence"]>;
}> {
  const { ctx, target } = input;
  const adapterKind = resolveAdapterKind(target);
  const activeInstruction = resolveActiveSourceInstructionArtifact(
    target,
    input.sourceInstructionArtifacts,
  );
  const intelligence = inferSourceIntelligenceFromTarget({
    target,
    currentArtifact: activeInstruction,
  });
  const collectionMethod = selectDiscoveryCollectionMethod(
    target,
    activeInstruction,
  );
  const discoveryMethod = selectDiscoveryMethod(collectionMethod);
  const startingUrls = buildDiscoveryStartingUrls(target, activeInstruction);
  const providerLabel = intelligence.provider?.label ?? "Unknown provider";
  const sourceIntelligenceProvider = getDiscoveryProviderKey({
    target,
    intelligence,
  });

  let sourceCatalog: JobPosting[] | undefined;
  let catalogPagesCovered: number | undefined;
  let catalogWarning: string | null = null;
  if (discoveryMethod === "public_api") {
    const startedAt = new Date().toISOString();
    input.emitActivity(
      createDiscoveryEvent({
        runId: input.activeRun.id,
        timestamp: startedAt,
        kind: "progress",
        stage: "navigation",
        waitReason: "executing_tool",
        targetId: target.id,
        adapterKind: target.adapterKind,
        resolvedAdapterKind: adapterKind,
        collectionMethod,
        sourceIntelligenceProvider,
        message: `Using ${providerLabel} public API for ${target.label}`,
        url: startingUrls[0] ?? target.startingUrl,
        jobsFound: 0,
        jobsPersisted: input.activeRun.summary.jobsPersisted,
        jobsStaged: input.activeRun.summary.jobsStaged,
        duplicatesMerged: input.activeRun.summary.duplicatesMerged,
        invalidSkipped: input.activeRun.summary.invalidSkipped,
      }),
    );

    const prefetched = input.prefetchedPublicApiResult
      ? await input.prefetchedPublicApiResult
      : null;
    if (prefetched?.error) {
      throw prefetched.error instanceof Error
        ? prefetched.error
        : new Error(describeUnknownThrowable(prefetched.error));
    }
    const apiResult =
      prefetched?.result ??
      (await collectPublicProviderJobs({
        target,
        artifact: { intelligence },
        source: adapterKind,
        prepareForDiscovery: true,
        ...(input.signal ? { signal: input.signal } : {}),
      }));
    const completedAt = new Date().toISOString();

    // A plain-language goal and a freshness preference need the search
    // agent's judgement. The feed remains the cheap reader; the model gets
    // bounded catalog tools rather than silently losing the person's request.
    const needsCatalogReview =
      input.useAgentRuntime &&
      Boolean(
        input.searchRequest?.intent.trim() ||
        input.searchRequest?.freshness === "recent",
      ) &&
      ctx.browserRuntime.runAgentDiscovery !== undefined &&
      apiResult.jobs.length > 0;
    if (needsCatalogReview) {
      sourceCatalog = apiResult.jobs;
      catalogPagesCovered = apiResult.pagesCovered;
      catalogWarning = apiResult.warning;
    } else {
      const jobs = await mapInTurns(
        apiResult.jobs,
        (posting) =>
          takePreparedDiscoveryPosting(posting) ??
          toProviderAwarePosting({
            posting,
            target,
            collectionMethod,
            discoveryMethod,
            intelligence,
            adapterKind,
          }),
      );
      // The prefetched promise survives until this target finishes. It must
      // not retain another full feed after the authoritative pass takes it.
      apiResult.jobs = [];
      return {
        result: {
          source: adapterKind,
          startedAt,
          completedAt,
          querySummary: `${target.label} via ${providerLabel} API`,
          warning: apiResult.warning,
          inventoryCompleteness:
            apiResult.warning === null ? "complete" : "partial",
          // A feed of hundreds of jobs is normalized a slice per turn.
          jobs,
          agentMetadata: DiscoveryAgentMetadataSchema.parse({
            pagesCovered: apiResult.pagesCovered ?? 0,
          }),
        },
        collectionMethod,
        adapterKind,
        intelligence,
      };
    }
  }

  const sessionOpening = input.sessionOpenings.get(adapterKind);
  if (sessionOpening) {
    await sessionOpening;
  } else if (!input.openedSessionSources.has(adapterKind)) {
    input.emitActivity(
      createDiscoveryEvent({
        runId: input.activeRun.id,
        timestamp: new Date().toISOString(),
        kind: "progress",
        stage: "navigation",
        waitReason: "starting_browser",
        targetId: target.id,
        adapterKind: target.adapterKind,
        resolvedAdapterKind: adapterKind,
        collectionMethod,
        sourceIntelligenceProvider,
        message: `Starting or attaching the browser profile for ${target.label}`,
        url: target.startingUrl,
        jobsFound: 0,
        jobsPersisted: input.activeRun.summary.jobsPersisted,
        jobsStaged: input.activeRun.summary.jobsStaged,
        duplicatesMerged: input.activeRun.summary.duplicatesMerged,
        invalidSkipped: input.activeRun.summary.invalidSkipped,
      }),
    );
    const opening = ctx
      .openRunBrowserSession(adapterKind, {
        purpose: "automation",
        targetUrl: target.startingUrl,
        targetId: target.id,
      })
      .then(() => {
        input.openedSessionSources.add(adapterKind);
      })
      .finally(() => {
        input.sessionOpenings.delete(adapterKind);
      });
    input.sessionOpenings.set(adapterKind, opening);
    await opening;
  }

  const targetUrl = (() => {
    try {
      return new URL(target.startingUrl);
    } catch {
      return null;
    }
  })();
  const adapter = discoveryAdapters[adapterKind];
  const instructionLines = buildInstructionGuidance(activeInstruction);

  if (input.useAgentRuntime && ctx.browserRuntime.runAgentDiscovery) {
    const resumeCheckpoint = input.activeRun.targetExecutions.find(
      (execution) => execution.targetId === target.id,
    )?.agentCheckpoint;
    const runAgentDiscovery = ctx.browserRuntime.runAgentDiscovery.bind(
      ctx.browserRuntime,
    );
    const agentRun = () =>
      runAgentDiscovery(adapterKind, {
        // Each source searches in its own tab so several can run at once.
        dedicatedPage: true,
        ...(sourceCatalog
          ? { sourceCatalog, sourceCatalogComplete: catalogWarning === null }
          : {}),
        retainAllFound: input.retainAllFound,
        userProfile: input.profile,
        searchPreferences: {
          targetRoles:
            input.searchPreferences.targetRoles.length > 0
              ? input.searchPreferences.targetRoles
              : [DEFAULT_ROLE],
          locations: input.searchPreferences.locations,
          workModes: input.searchPreferences.workModes,
        },
        searchMode: input.searchMode,
        ...(input.searchRequest ? { searchRequest: input.searchRequest } : {}),
        searchGuidance: input.searchGuidance,
        targetJobCount: input.targetJobCount,
        maxSteps: input.maxSteps,
        runControl: {
          timeBudgetMs: input.timeBudgetMs,
          // Steps without a new job before the agent is told it is stalling;
          // the same window again with nothing new ends the source.
          noProgressStepLimit: DISCOVERY_STALL_STEP_WINDOW,
        },
        ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
        onCheckpoint: (checkpoint) =>
          input.onAgentCheckpoint(target.id, checkpoint),
        startingUrls,
        protectedPages: [...input.protectedPages.values()],
        siteLabel: target.label,
        navigationHostnames: targetUrl ? [targetUrl.hostname] : [],
        siteInstructions: [...adapter.siteInstructions, ...instructionLines],
        toolUsageNotes: adapter.toolUsageNotes,
        relevantUrlSubstrings: adapter.relevantUrlSubstrings,
        aiClient: ctx.aiClient,
        ...(input.signal ? { signal: input.signal } : {}),
        onWaitingForBrowserTab: () => {
          input.emitActivity(
            createDiscoveryEvent({
              runId: input.activeRun.id,
              timestamp: new Date().toISOString(),
              kind: "progress",
              stage: "navigation",
              targetId: target.id,
              adapterKind: target.adapterKind,
              message: `${target.label}: browser tab limit reached. Waiting for a free tab; close finished tabs to continue.`,
              url: null,
              jobsFound: null,
              jobsPersisted: input.activeRun.summary.jobsPersisted,
              jobsStaged: input.activeRun.summary.jobsStaged,
              duplicatesMerged: input.activeRun.summary.duplicatesMerged,
              invalidSkipped: input.activeRun.summary.invalidSkipped,
            }),
          );
        },
        onProgress: (progress) => {
          const summary = summarizeProgressAction(
            progress,
            target.label,
            progress.jobsFound,
          );
          input.emitActivity(
            createDiscoveryEvent({
              runId: input.activeRun.id,
              timestamp: new Date().toISOString(),
              kind: "progress",
              stage: summary.stage,
              waitReason: summary.waitReason,
              targetId: target.id,
              adapterKind: target.adapterKind,
              resolvedAdapterKind: adapterKind,
              collectionMethod,
              sourceIntelligenceProvider,
              message: summary.message,
              url: progress.currentUrl,
              jobsFound: progress.jobsFound,
              jobsPersisted: input.activeRun.summary.jobsPersisted,
              jobsStaged: input.activeRun.summary.jobsStaged,
              duplicatesMerged: input.activeRun.summary.duplicatesMerged,
              invalidSkipped: input.activeRun.summary.invalidSkipped,
            }),
          );
        },
      });
    const result = await (input.agentSlots
      ? input.agentSlots.run(agentRun)
      : agentRun());

    return {
      result: {
        ...result,
        ...(catalogPagesCovered !== undefined
          ? {
              agentMetadata: DiscoveryAgentMetadataSchema.parse({
                ...result.agentMetadata,
                pagesCovered:
                  catalogPagesCovered +
                  (result.agentMetadata?.pagesCovered ?? 0),
                coveredPageUrls: result.agentMetadata?.coveredPageUrls
                  ? [
                      ...Array.from(
                        { length: catalogPagesCovered },
                        () => target.startingUrl,
                      ),
                      ...result.agentMetadata.coveredPageUrls,
                    ]
                  : undefined,
              }),
            }
          : {}),
        ...(catalogWarning
          ? {
              warning: [catalogWarning, result.warning]
                .filter(Boolean)
                .join(" "),
              inventoryCompleteness: "partial" as const,
            }
          : {}),
        jobs: result.jobs.map((posting) =>
          toProviderAwarePosting({
            posting,
            target,
            collectionMethod,
            discoveryMethod,
            intelligence,
            adapterKind,
          }),
        ),
      },
      collectionMethod,
      adapterKind,
      intelligence,
    };
  }

  const result = await ctx.browserRuntime.runDiscovery(
    adapterKind,
    input.searchPreferences,
  );
  const agentRuntimeUnavailable =
    input.useAgentRuntime && !ctx.browserRuntime.runAgentDiscovery;
  return {
    result: {
      ...result,
      warning: agentRuntimeUnavailable
        ? [result.warning, AGENT_RUNTIME_UNAVAILABLE_WARNING]
            .filter(Boolean)
            .join(" ")
        : result.warning,
      jobs: result.jobs.map((posting) =>
        toProviderAwarePosting({
          posting,
          target,
          collectionMethod,
          discoveryMethod,
          intelligence,
          adapterKind,
        }),
      ),
    },
    collectionMethod,
    adapterKind,
    intelligence,
  };
}

/**
 * Raised when a second discovery run is asked for while one is still active.
 * It carries the live run's id so the caller can follow that run instead of
 * starting a new one, and its message is the plain sentence the person reads.
 */
export class DiscoveryRunAlreadyActiveError extends Error {
  readonly activeRunId: string | null;

  constructor(activeRunId: string | null) {
    super(DISCOVERY_RUN_ALREADY_ACTIVE_MESSAGE);
    this.name = "DiscoveryRunAlreadyActiveError";
    this.activeRunId = activeRunId;
  }
}

export function createWorkspaceDiscoveryMethods(
  ctx: WorkspaceServiceContext,
): Pick<
  JobFinderWorkspaceService,
  "runDiscovery" | "runAgentDiscovery" | "runDiscoveryForTarget"
> & {
  runCampaignDiscovery(
    campaign: CampaignRunContext,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ): Promise<JobFinderWorkspaceSnapshot>;
  runCampaignDiscoveryForTarget(
    campaign: CampaignRunContext,
    targetId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
} {
  function trackDiscoveryPromise<T>(promise: Promise<T>): Promise<T> {
    ctx.activeDiscoveryPromiseRef.current = promise;
    void promise
      .finally(() => {
        if (ctx.activeDiscoveryPromiseRef.current === promise) {
          ctx.activeDiscoveryPromiseRef.current = null;
        }
      })
      .catch(() => {});
    return promise;
  }

  async function executeDiscoveryPipeline(
    options: DiscoveryTargetPipelineOptions,
  ) {
    if (ctx.activeDiscoveryAbortControllerRef.current) {
      // Second-run guard. A Stop that has not finished yet still holds this
      // controller, so the UI can re-enable "Search now" before the first
      // pipeline is really done; starting a second run over the same plan
      // would double-write the same sources. The caller gets the live run's
      // id and one plain sentence instead of a new run.
      throw new DiscoveryRunAlreadyActiveError(
        ctx.activeDiscoveryRunIdRef.current,
      );
    }

    const executionController = new AbortController();
    ctx.activeDiscoveryAbortControllerRef.current = executionController;
    const onExternalAbort = () => executionController.abort();
    if (options.signal?.aborted) {
      executionController.abort();
    } else {
      options.signal?.addEventListener("abort", onExternalAbort);
    }
    const executionSignal = executionController.signal;
    const clearActiveController = () => {
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (
        ctx.activeDiscoveryAbortControllerRef.current === executionController
      ) {
        ctx.activeDiscoveryAbortControllerRef.current = null;
        ctx.activeDiscoveryRunIdRef.current = null;
      }
    };

    let terminalStatus: "cancelled" | "failed" | "completed" = "completed";
    let caughtError: unknown = null;
    const [
      profile,
      searchPreferences,
      settings,
      startingSavedJobs,
      startingDiscovery,
      startingUserActionRequests,
    ] = await Promise.all([
      ctx.repository.getProfile(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.getSettings(),
      // The frozen display rows, not a fresh parse: a run only derives new
      // jobs from these, and a second private copy of every saved job held
      // about half a gigabyte for the whole search on 6,284 jobs.
      ctx.repository.readSavedJobsProjection(),
      ctx.repository.readDiscoveryStateForRun?.() ??
        ctx.repository.getDiscoveryState(),
      ctx.repository.listUserActionRequests({ scopeType: "discovery_source" }),
    ]).catch((error: unknown) => {
      clearActiveController();
      throw error;
    });
    const campaignState =
      options.scope === "run_all" && !options.campaign
        ? await ctx.repository.getCampaignState().catch((error: unknown) => {
            clearActiveController();
            throw error;
          })
        : null;
    const currentPlan = campaignState?.campaigns.find(
      (plan) => plan.id === campaignState.activeCampaignId,
    );
    const effectiveCampaign =
      options.campaign ??
      (currentPlan
        ? {
            campaignId: currentPlan.id,
            searchPreferences: searchPreferencesForCampaignRun(currentPlan),
            runJobBudget: currentPlan.limits.discoveryRunJobBudget ?? null,
            mode: currentPlan.mode,
          }
        : undefined);
    const enrichedPreferences = withSavedJobSearchBehavior(
      enrichSearchPreferencesFromProfile(
        effectiveCampaign?.searchPreferences ?? searchPreferences,
        profile,
      ),
      settings,
    );
    const savedSearchGuidance = AiBehaviorPreferenceSchema.parse(
      settings.aiBehavior ?? {},
    ).jobSearch;
    const searchGuidance = {
      ...savedSearchGuidance,
      selectivity:
        enrichedPreferences.searchSelectivity ??
        savedSearchGuidance.selectivity,
    };
    // Explicit run budget resolution order: campaign limit first (the
    // campaign-scoped control), then the discovery preferences field. No
    // explicit budget means uncapped retention with normal safety ceilings.
    const runJobBudget =
      effectiveCampaign?.runJobBudget ??
      enrichedPreferences.discovery.runJobBudget ??
      null;
    const assessmentSession = createMatchAssessmentSession({
      profile,
      searchPreferences: enrichedPreferences,
      calculate: createMatchAssessment,
    });
    // Verdicts the model gave during this run, so a job judged to choose
    // which ones a result limit keeps is not judged again (ADR 0041).
    const runJudgments = new Map<string, FitJudgment>();
    // What each job's listing was when this run asked the model about it, so
    // a job it gave no verdict for is asked again only once the listing
    // changes (a full read after the search), not twice in one run.
    const fitAskedFingerprints = new Map<string, string>();
    const assessmentPlanId =
      effectiveCampaign?.campaignId ?? (await ctx.getActiveCampaignId());
    const plans = campaignState ?? (await ctx.repository.getCampaignState());
    const planJobIds = new Set(
      plans?.campaigns.find((plan) => plan.id === assessmentPlanId)?.jobIds ??
        [],
    );
    const belongsToSearchPlanAtStart = (job: SavedJob) =>
      !assessmentPlanId ||
      planJobIds.has(job.id) ||
      job.campaignIds?.includes(assessmentPlanId) === true;
    const belongsToSearchPlan = (job: SavedJob) =>
      belongsToSearchPlanAtStart(job) || runRetainedJobIds.has(job.id);
    const assessDiscoveryPosting = (posting: JobPosting) => {
      const previous = (posting as Partial<SavedJob>).matchAssessment;
      // This plan's verdict, or the shared one a job judged before plans kept
      // their own verdicts still carries; never a blank that hides its fit.
      const assessment = assessmentPlanId
        ? ((posting as Partial<SavedJob>).planAssessments?.[assessmentPlanId] ??
          previous)
        : previous;
      return assessmentSession.assess(
        copyView(posting, { matchAssessment: assessment ?? null }),
        runJudgments.get(toSavedJobId(posting)) ?? assessment?.judgment ?? null,
      );
    };
    const selectedTargets = selectTargets(enrichedPreferences, options);

    if (selectedTargets.length === 0) {
      if (options.scope === "single_target") {
        clearActiveController();
        throw new Error("single_target: target not found or unavailable");
      }

      // A whole-plan search with nothing left to search used to return the
      // current snapshot unchanged: no run started, no run ended, and the
      // newest thing the app had said about this plan stayed a success from
      // an earlier day. It starts and ends as a failed run that carries its
      // own reason, so the plan card, Find jobs and Home all read the same
      // verdict from run history.
      const emptyRunId = createUniqueId("discovery_run");
      ctx.activeDiscoveryRunIdRef.current = emptyRunId;
      let emptyRun = createInitialRunRecord({
        id: emptyRunId,
        campaignId:
          effectiveCampaign?.campaignId ?? (await ctx.getActiveCampaignId()),
        targets: [],
        scope: options.scope,
        activeRun: startingDiscovery.activeRun,
        previousRuns: startingDiscovery.recentRuns,
        ...(options.searchRequest
          ? { searchRequest: options.searchRequest }
          : {}),
      });
      emptyRun = updateRunSummary(emptyRun, {
        warnings: uniqueStrings([
          ...emptyRun.summary.warnings,
          DISCOVERY_NO_JOB_SITES_MESSAGE,
        ]),
      });
      emptyRun = finalizeDiscoveryRun(
        emptyRun,
        "failed",
        new Date().toISOString(),
      );
      await ctx
        .persistDiscoveryState((current) =>
          finalizeDiscoveryState(current, emptyRun, enrichedPreferences),
        )
        .catch(() => {});
      clearActiveController();
      throw new Error(DISCOVERY_NO_JOB_SITES_MESSAGE);
    }

    let workingSavedJobs = await mapInTurns(
      startingSavedJobs,
      (job) => {
        const matchAssessment = assessmentSession.assessPersisted(
          job,
          readPlanAssessment(job, assessmentPlanId).matchAssessment,
        );
        return matchAssessment === job.matchAssessment
          ? job
          : Object.freeze(copyView(job, { matchAssessment }));
      },
      SETUP_JOBS_PER_TURN,
    );
    let workingPendingJobs = startingDiscovery.pendingDiscoveryJobs.map(
      (job) => ({
        ...job,
        matchAssessment: assessmentSession.assessPersisted(
          job,
          readPlanAssessment(job, assessmentPlanId).matchAssessment,
        ),
      }),
    );
    const runLedger = createRunDiscoveryLedger(
      startingDiscovery.discoveryLedger,
    );
    // Each enriched posting's form as it arrived from the source.
    const postingAsArrived = new WeakMap<JobPosting, JobPosting>();
    // The feed screen's verdicts this run, by listing address; each lands on
    // the listing's ledger entry when the source records it.
    const screenRecords = new Map<string, ListingScreenRecord>();
    // Kept jobs the screen put away, or brought back after the goals changed.
    const jobsPutAwayByScreen = new Set<string>();
    const jobsBroughtBackByScreen = new Set<string>();
    const recordSighting = (
      sighting: Parameters<typeof runLedger.record>[0],
    ) => {
      const listingScreen = screenRecords.get(
        normalizeJobIdentityUrl(sighting.posting.canonicalUrl),
      );
      return runLedger.record(
        listingScreen ? { ...sighting, listingScreen } : sighting,
      );
    };
    // One identity index for the whole run, brought in step with whichever
    // working list a step reads. Working rows are replaced, never edited.
    const jobIdentity = createSyncedJobIdentityIndex<SavedJob>(
      toSightingIdentityInput,
    );
    const indexOver = (jobs: readonly SavedJob[]) => jobIdentity.sync(jobs);
    await runLedger.warm();
    await jobIdentity.warm(workingSavedJobs);
    let allJobsMemo: {
      saved: readonly SavedJob[];
      pending: readonly SavedJob[];
      merged: SavedJob[];
    } | null = null;
    // Saved and staged jobs together; the same array until either changes.
    const allJobs = (): readonly SavedJob[] => {
      if (workingPendingJobs.length === 0) return workingSavedJobs;
      if (
        allJobsMemo?.saved !== workingSavedJobs ||
        allJobsMemo.pending !== workingPendingJobs
      ) {
        allJobsMemo = {
          saved: workingSavedJobs,
          pending: workingPendingJobs,
          merged: mergeSavedJobs(workingSavedJobs, workingPendingJobs),
        };
      }
      return allJobsMemo.merged;
    };
    let allJobsByIdMemo: {
      jobs: readonly SavedJob[];
      byId: ReadonlyMap<string, SavedJob>;
    } | null = null;
    const allJobsById = (): ReadonlyMap<string, SavedJob> => {
      const jobs = allJobs();
      if (allJobsByIdMemo?.jobs !== jobs) {
        allJobsByIdMemo = {
          jobs,
          byId: new Map(jobs.map((job) => [job.id, job])),
        };
      }
      return allJobsByIdMemo.byId;
    };
    // Saved jobs are indexed as themselves, so their identity aliases are
    // built once and shared with the run's job index; postings inspected
    // later are added as they come.
    const inspectionIdentityIndex = createJobIdentityIndex<
      JobIdentityInput & { id: string }
    >(
      [],
      (value) =>
        Array.isArray((value as Partial<SavedJob>).provenance)
          ? toSightingIdentityInput(value as SavedJob)
          : { ...value, matchAcrossSources: true },
      undefined,
    );
    for (const [position, job] of [
      ...workingSavedJobs,
      ...workingPendingJobs,
    ].entries()) {
      if (position > 0 && position % SETUP_JOBS_PER_TURN === 0)
        await yieldToEventLoop();
      inspectionIdentityIndex.add(job);
    }
    const touchedSavedJobIds = new Set<string>();
    // Every posting this run retained (new or re-seen), by saved-job id: the
    // population the listing-detail read stage is allowed to touch.
    const runRetainedJobIds = new Set<string>();
    // The saved-job id each target's postings were actually stored under. A
    // site's own job number is not an id: two sites can both have a job "2",
    // and a new posting whose plain id is taken is stored under its own
    // suffixed id. Plan membership reads these, never a rebuilt plain id.
    const landedJobIdsByTarget = new Map<string, Set<string>>();
    const landedJobIdsFor = (targetId: string): Set<string> => {
      const existing = landedJobIdsByTarget.get(targetId);
      if (existing) return existing;
      const created = new Set<string>();
      landedJobIdsByTarget.set(targetId, created);
      return created;
    };
    const touchedPendingJobIds = new Set<string>();
    workingSavedJobs
      .filter(belongsToSearchPlan)
      .forEach((job) => touchedSavedJobIds.add(job.id));
    workingPendingJobs
      .filter(belongsToSearchPlan)
      .forEach((job) => touchedPendingJobIds.add(job.id));
    const originalJobsById = new Map(
      [...startingSavedJobs, ...startingDiscovery.pendingDiscoveryJobs].map(
        (job) => [job.id, job],
      ),
    );
    // Working rows show this plan's verdict. Persist it only in that plan's
    // entry, leaving the shared assessment and other plans unchanged.
    const storedJobs = new WeakMap<SavedJob, SavedJob>();
    const storedJob = (job: SavedJob): SavedJob => {
      const cached = storedJobs.get(job);
      if (cached) return cached;
      const stored = withPlanAssessment(
        job,
        assessmentPlanId,
        job.matchAssessment,
        originalJobsById.get(job.id)?.matchAssessment ?? job.matchAssessment,
      );
      storedJobs.set(job, stored);
      return stored;
    };
    // Run-start snapshots define ownership for the whole run: ledger decisions
    // and pending-job removals that differ from these baselines while the run
    // is in flight belong to the user and must survive run persistence.
    const baselineLedger = startingDiscovery.discoveryLedger;
    const baselineLedgerById = new Map(
      baselineLedger.map((entry) => [entry.id, entry]),
    );
    const baselinePendingJobIds = new Set(
      startingDiscovery.pendingDiscoveryJobs.map((job) => job.id),
    );

    const savedJobWriter = createDiscoverySavedJobWriter({
      persistedJobs: startingSavedJobs,
      toStoredJob: storedJob,
      merge: applySavedJobDelta,
      commit: async (input) => {
        await ctx.repository.commitSavedJobDelta(input);
      },
      persistDiscovery: async (update) => {
        await ctx.persistDiscoveryState(update);
      },
      // A search of many sources saves several times a second; those saves
      // share a transaction. A small search saves each one at once.
      coalesce: selectedTargets.length >= DISCOVERY_SAVE_COALESCE_MIN_SOURCES,
    });
    const touchSavedJob = (job: SavedJob): SavedJob => {
      touchedSavedJobIds.add(job.id);
      savedJobWriter.stage(job);
      return job;
    };
    // Revalidation may change older plan assessments. Stage that inventory
    // once, rather than reconsidering it at every source checkpoint.
    for (const job of workingSavedJobs) {
      if (touchedSavedJobIds.has(job.id)) savedJobWriter.stage(job);
    }
    const persistWorkingSavedJobs = savedJobWriter.persist;
    // Approved resumes whose job details a source changed. Marking them reads
    // every resume draft (a few hundred ms on a big workspace), so it runs
    // every couple of minutes and once when the search ends, not per source.
    const resumeStaleJobIds = new Set<string>();
    let resumeStalenessFlushedAt = Date.now();
    const flushResumeStaleness = async (force: boolean): Promise<void> => {
      if (settings.discoveryOnly || resumeStaleJobIds.size === 0) return;
      if (
        !force &&
        Date.now() - resumeStalenessFlushedAt < RESUME_STALENESS_FLUSH_MS
      )
        return;
      const jobIds = [...resumeStaleJobIds];
      resumeStaleJobIds.clear();
      resumeStalenessFlushedAt = Date.now();
      await ctx.staleApprovedResumeDrafts(
        "Saved job details changed after approval and the resume needs a fresh review.",
        jobIds,
      );
    };
    const attachedPlanJobIds = new Set(planJobIds);
    const openedSessionSources = new Set<JobSource>();
    const sessionOpenings = new Map<JobSource, Promise<void>>();
    const parkedSessionSources = new Set<JobSource>();
    const protectedPages = new Map(
      startingUserActionRequests.flatMap((request) => {
        if (
          request.scope.type !== "discovery_source" ||
          !request.scope.parkedTab ||
          [
            "resolved",
            "skipped",
            "cancelled",
            "expired",
            "superseded",
          ].includes(request.state)
        ) {
          return [];
        }
        return [
          [
            request.scope.parkedTab.tabId ?? request.scope.parkedTab.url,
            request.scope.parkedTab,
          ] as const,
        ];
      }),
    );
    const sourceInstructionArtifacts = await ctx.repository
      .listSourceInstructionArtifacts()
      .catch((error: unknown) => {
        clearActiveController();
        throw error;
      });
    // The same search started again after it stopped goes on with the
    // sources it had not finished (when it had finished them all, it runs
    // again in full).
    const finishedBeforeRestart =
      options.scope === "run_all"
        ? selectSourcesFinishedBeforeRestart({
            activeRun: startingDiscovery.activeRun,
            previousRuns: startingDiscovery.recentRuns,
            campaignId:
              effectiveCampaign?.campaignId ??
              (await ctx.getActiveCampaignId()),
            searchRequest: options.searchRequest,
            now: new Date(),
          })
        : new Set<string>();
    const unfinishedTargets = selectedTargets.filter(
      (target) => !finishedBeforeRestart.has(target.id),
    );
    const skippedFinishedTargets =
      unfinishedTargets.length > 0
        ? selectedTargets.length - unfinishedTargets.length
        : 0;
    const runTargets =
      skippedFinishedTargets > 0 ? unfinishedTargets : selectedTargets;
    const targets =
      options.scope === "run_all"
        ? prioritizeDiscoveryTargets(runTargets, sourceInstructionArtifacts)
        : runTargets;
    const runId = createUniqueId("discovery_run");
    // Budgets are allocated once, up front, over the stable configuration
    // order so readiness or completion order can never shift them. Invalid
    // target lists (duplicate or empty ids) fail fast here, before any run
    // record is persisted and before any API or browser work starts.
    let discoveryBudgets: ReadonlyMap<
      string,
      {
        targetJobCount: number;
        retentionJobCount: number;
        maxSteps: number;
      }
    >;
    try {
      discoveryBudgets = resolveDiscoveryBudgetPlan({
        targetIds: targets.map((target) => target.id),
        runJobBudget,
      });
    } catch (error) {
      clearActiveController();
      throw error;
    }
    const keepSessionAlive = settings.keepSessionAlive;
    // Publish the in-flight run id before any work starts, so a stop request
    // that arrives before the run record is persisted still aborts it.
    ctx.activeDiscoveryRunIdRef.current = runId;
    let activeRun = createInitialRunRecord({
      id: runId,
      campaignId:
        effectiveCampaign?.campaignId ?? (await ctx.getActiveCampaignId()),
      targets,
      scope: options.scope,
      activeRun: startingDiscovery.activeRun,
      previousRuns: startingDiscovery.recentRuns,
      ...(options.searchRequest
        ? { searchRequest: options.searchRequest }
        : {}),
    });
    if (skippedFinishedTargets > 0) {
      activeRun = appendDiscoveryEvent(
        activeRun,
        createDiscoveryEvent({
          runId,
          timestamp: new Date().toISOString(),
          kind: "info",
          stage: "run",
          targetId: null,
          adapterKind: null,
          message: `Continuing the search that stopped: ${skippedFinishedTargets} ${skippedFinishedTargets === 1 ? "source it already finished is" : "sources it already finished are"} not searched again.`,
          url: null,
          jobsFound: null,
          jobsPersisted: null,
          jobsStaged: null,
          duplicatesMerged: null,
          invalidSkipped: null,
        }),
      );
    }

    // Capture the run, ledger and pending references alongside the saved-job
    // delta. A queued commit must not publish a later source's counters before
    // that source's saved rows have reached the repository.
    const captureRunForCommit = () => ({
      ...activeRun,
      activity: [...activeRun.activity],
      targetExecutions: [...activeRun.targetExecutions],
    });
    const captureWorkingDiscoveryUpdate = () => {
      const run = captureRunForCommit();
      const ledger = runLedger.captureChanges();
      const pendingJobs = workingPendingJobs;
      const pendingIds = new Set(touchedPendingJobIds);
      return markSupersedingDiscoveryUpdate(
        Object.assign(
          (current: typeof startingDiscovery) =>
            finalizeDiscoveryState(
              {
                ...current,
                pendingDiscoveryJobs: overlayTouchedPendingJobs(
                  current.pendingDiscoveryJobs,
                  pendingJobs.map(storedJob),
                  pendingIds,
                  baselinePendingJobIds,
                ),
                discoveryLedger: patchDiscoveryLedger(
                  current.discoveryLedger,
                  ledger.entries.map((entry) => ({
                    id: entry.id,
                    update: (persisted) =>
                      rebaseDiscoveryLedgerEntry(
                        baselineLedgerById.get(entry.id) ?? null,
                        entry,
                        persisted,
                      ),
                  })),
                ),
              },
              run,
              enrichedPreferences,
            ),
          { committed: ledger.committed },
        ),
      );
    };

    const recordActivity = (event: DiscoveryActivityEvent) => {
      activeRun = appendDiscoveryEvent(activeRun, event);
    };
    const publishActivity = (event: DiscoveryActivityEvent) => {
      options.onActivity?.(event);
    };
    const emitActivity = (event: DiscoveryActivityEvent) => {
      recordActivity(event);
      publishActivity(event);
    };

    // Puts the model's verdicts on the run's working jobs; the next persist
    // saves them.
    const applyRunVerdicts = (
      judgments: ReadonlyMap<string, FitJudgment>,
      fullAssessments: ReadonlyMap<string, MatchAssessment> = new Map(),
    ): void => {
      const pendingJobIds = new Set(workingPendingJobs.map((job) => job.id));
      const applyVerdict = <T extends SavedJob>(job: T): T => {
        const judgment = judgments.get(job.id);
        const fullAssessment = fullAssessments.get(job.id);
        if (!judgment && !fullAssessment) return job;
        const next = readPlanAssessment(
          withPlanAssessment(
            job,
            assessmentPlanId,
            fullAssessment ?? assessmentSession.assess(job, judgment),
          ),
          assessmentPlanId,
        );
        if (pendingJobIds.has(job.id)) touchedPendingJobIds.add(job.id);
        else touchSavedJob(next);
        return next;
      };
      workingSavedJobs = workingSavedJobs.map(applyVerdict);
      workingPendingJobs = workingPendingJobs.map(applyVerdict);
    };

    // Fit is judged while the search runs (ADR 0041): the jobs each source
    // keeps go to the model in batches as they land, so a long search shows
    // scores as it goes rather than after its last source.
    const searchFitConsidered = new Set<string>();
    let searchFitClosed = false;
    let searchFitJudged = 0;
    // Whether a kept job still needs a verdict: a job found again with a
    // current verdict, or already judged in this run, does not take a seat
    // in a batch (those seats used to go out nearly empty).
    const needsSearchFit = (job: SavedJob): boolean => {
      if (runJudgments.has(job.id)) return false;
      const assessed = readPlanAssessment(storedJob(job), assessmentPlanId);
      return (
        assessed.matchAssessment.judgment?.source !== "full" &&
        jobNeedsFitJudgment(
          assessed,
          assessmentSession.verdictFingerprint,
          assessmentSession.contextFingerprint,
        )
      );
    };
    const judgeSearchFitBatch = async (
      jobIds: readonly string[],
    ): Promise<void> => {
      const byId = allJobsById();
      const jobs = jobIds.flatMap((jobId) => {
        const job = byId.get(jobId);
        return job && needsSearchFit(job)
          ? [readPlanAssessment(storedJob(job), assessmentPlanId)]
          : [];
      });
      if (jobs.length === 0) return;
      for (const job of jobs) {
        fitAskedFingerprints.set(job.id, fitPostingFingerprint(job));
      }
      const judgments = await judgeJobFitsInBatches({
        aiClient: ctx.aiClient,
        profile,
        searchPreferences: enrichedPreferences,
        jobs,
        contextFingerprint: assessmentSession.verdictFingerprint,
        signal: executionSignal,
        concurrency: 1,
      });
      if (searchFitClosed || judgments.size === 0) return;
      for (const [jobId, judgment] of judgments) {
        runJudgments.set(jobId, judgment);
      }
      applyRunVerdicts(judgments);
      await persistWorkingSavedJobs();
      searchFitJudged += judgments.size;
      emitActivity(
        createDiscoveryEvent({
          runId,
          timestamp: new Date().toISOString(),
          kind: "info",
          stage: "extraction",
          targetId: null,
          adapterKind: null,
          resolvedAdapterKind: null,
          message: `Judged fit for ${searchFitJudged} ${searchFitJudged === 1 ? "job" : "jobs"} so far.`,
          url: null,
          jobsFound: null,
          jobsPersisted: null,
          jobsStaged: null,
          duplicatesMerged: null,
          invalidSkipped: null,
        }),
      );
    };
    const searchFitBatcher = createSearchFitBatcher({
      batchSize: JOB_FIT_JUDGING_BATCH_SIZE,
      concurrency: SEARCH_FIT_JUDGING_CONCURRENCY,
      finishConcurrency: 5,
      partialWaitMs: SEARCH_FIT_PARTIAL_BATCH_WAIT_MS,
      maxWaitMs: SEARCH_FIT_MAX_BATCH_WAIT_MS,
      // A batch the model or the save failed leaves its jobs unjudged; the
      // end of the run asks again if their listing changed.
      judge: judgeSearchFitBatch,
    });
    const queueKeptJobsForFit = (): void => {
      if (
        searchFitClosed ||
        !ctx.aiClient.judgeJobFits ||
        executionSignal.aborted
      ) {
        return;
      }
      const fresh = [...runRetainedJobIds].filter(
        (jobId) => !searchFitConsidered.has(jobId),
      );
      if (fresh.length === 0) return;
      const byId = allJobsById();
      const toJudge: string[] = [];
      for (const jobId of fresh) {
        const job = byId.get(jobId);
        if (!job) continue;
        searchFitConsidered.add(jobId);
        if (needsSearchFit(job)) toJudge.push(jobId);
      }
      searchFitBatcher.enqueue(toJudge);
    };
    const finishSearchFitJudging = (): Promise<void> =>
      searchFitBatcher.finish();
    const stopSearchFitJudging = (): void => {
      searchFitClosed = true;
      searchFitBatcher.stop();
    };

    // Read page facts ahead, but leave the card jobs and their fit scheduling
    // untouched. The usual final pass alone selects and applies these facts.
    const listingAbortController = new AbortController();
    const listingSignal = AbortSignal.any([
      executionSignal,
      listingAbortController.signal,
    ]);
    const canReadListingUrlNow = (url: string): boolean => {
      try {
        const host = new URL(url).host;
        return !activeRun.targetExecutions.some((execution) => {
          if (execution.accessBlockerReason !== "site_protection") return false;
          const target = targets.find(
            (target) => target.id === execution.targetId,
          );
          return [execution.parkedTab?.url, target?.startingUrl].some(
            (blocked) => {
              try {
                return blocked ? new URL(blocked).host === host : false;
              } catch {
                return false;
              }
            },
          );
        });
      } catch {
        return false;
      }
    };
    // Picked jobs already have priority over new results. Prepare those while
    // sources collect; ordinary older jobs wait so they cannot spend every
    // read before new listings arrive. All reads share one run-wide allowance.
    const runSourceCount = Math.max(1, activeRun.targetIds.length);
    let olderReadAheadLeft = Math.min(
      LISTING_DETAIL_READS_PER_RUN,
      OLDER_LISTING_READS_PER_SOURCE * runSourceCount,
    );
    const olderReadCandidates = allJobs()
      .filter(
        (job) =>
          belongsToSearchPlan(job) &&
          jobNeedsListingDetail(job) &&
          canReadListingUrlNow(job.canonicalUrl),
      )
      .sort(
        (left, right) =>
          Number(personPickedJob(right)) - Number(personPickedJob(left)) ||
          compareMatchRecommendationPriority(
            left.matchAssessment,
            right.matchAssessment,
          ) ||
          compareMatchRoleSuitabilityPriority(
            left.matchAssessment,
            right.matchAssessment,
          ) ||
          compareMatchScores(left.matchAssessment, right.matchAssessment),
      )
      .filter((job) => personSuppliedJob(job) || olderReadAheadLeft-- > 0)
      .filter(personPickedJob);
    const listingReadAhead = createSearchListingReadAhead({
      maxJobs: LISTING_DETAIL_READS_PER_RUN,
      getJob: (id) => allJobsById().get(id),
      canRead: (job) =>
        belongsToSearchPlan(job) &&
        jobNeedsListingDetail(job) &&
        canReadListingUrlNow(job.canonicalUrl),
    });
    const renderedListingSlots = createConcurrencyLimiter(2);
    const listingRateLimitState = createListingReadRateLimitState();
    const startListingReadAhead = (): Promise<void> => {
      if (!ctx.fetchListingHtml) return Promise.resolve();
      listingReadAhead.enqueue(olderReadCandidates.map((job) => job.id));
      const readRenderedPage = ctx.browserRuntime.readRenderedPage?.bind(
        ctx.browserRuntime,
      );
      return enrichSavedJobListingDetails({
        jobs: [],
        nextJob: () => listingReadAhead.next(),
        onReadPrepared: (job, read) => listingReadAhead.record(job, read),
        rateLimitState: listingRateLimitState,
        fetchHtml: ctx.fetchListingHtml,
        readPage: createModelListingPageReader(ctx.aiClient),
        ...(readRenderedPage
          ? {
              readRenderedPage: (
                url: string,
                options: { signal?: AbortSignal },
              ) =>
                renderedListingSlots.run(() => readRenderedPage(url, options)),
            }
          : {}),
        assess: assessDiscoveryPosting,
        signal: listingSignal,
      }).then(() => undefined);
    };
    let listingReadAheadPass: Promise<void> | undefined;

    const planningEvent = createDiscoveryEvent({
      runId,
      timestamp: new Date().toISOString(),
      kind: "info",
      stage: "planning",
      waitReason: "waiting_on_ai",
      targetId: null,
      adapterKind: null,
      resolvedAdapterKind: null,
      message:
        options.scope === "single_target"
          ? `Planning discovery for ${targets[0]?.label ?? "selected source"}`
          : `Planning ${targets.length} discovery target${targets.length === 1 ? "" : "s"}`,
      url: null,
      jobsFound: 0,
      jobsPersisted: 0,
      jobsStaged: 0,
      duplicatesMerged: 0,
      invalidSkipped: 0,
    });
    recordActivity(planningEvent);

    await ctx
      .persistDiscoveryState((current) => ({
        ...current,
        runState: "running",
        activeRun,
        recentRuns: current.recentRuns,
        pendingDiscoveryJobs: overlayTouchedPendingJobs(
          current.pendingDiscoveryJobs,
          workingPendingJobs.map(storedJob),
          touchedPendingJobIds,
          baselinePendingJobIds,
        ),
        discoveryLedger: current.discoveryLedger,
      }))
      .catch((error: unknown) => {
        clearActiveController();
        throw error;
      });
    publishActivity(planningEvent);

    // Public inventories are independent network reads, but starting hundreds
    // at once can starve Electron's main process and retain every response until
    // the run ends. The readiness iterator keeps a small rolling window and
    // releases each response after its durable target batch is processed.
    // Every selected source enters the collection set. Sampling and retained
    // result limits are separate, so a request for fewer jobs than sources
    // still checks every selected source.
    const apiTargets: JobDiscoveryTarget[] = [];
    const browserTargets: JobDiscoveryTarget[] = [];
    for (const target of targets) {
      const artifact = resolveActiveSourceInstructionArtifact(
        target,
        sourceInstructionArtifacts,
      );
      if (selectDiscoveryCollectionMethod(target, artifact) === "api")
        apiTargets.push(target);
      else browserTargets.push(target);
    }
    // Agent runs (browser sources, and API catalogs the agent reviews for a
    // plain-language request) share one cap, whichever lane starts them.
    const agentSlots = createConcurrencyLimiter(DISCOVERY_SOURCE_CONCURRENCY);
    // Feed downloads run a few at a time; feeds waiting on the screen below
    // do not hold a download slot.
    const feedDownloads = createConcurrencyLimiter(
      PUBLIC_API_DOWNLOAD_CONCURRENCY,
    );

    // The model screens each feed's new listings by title, place and work
    // mode before the search keeps them (ADR 0024, ADR 0041, amended
    // 2026-10-21). A feed the agent reviews for a plain-language request is
    // chosen by the agent instead.
    const feedsGoToAgent =
      (options.useAgentRuntime ?? false) &&
      ctx.browserRuntime.runAgentDiscovery !== undefined &&
      Boolean(
        options.searchRequest?.intent.trim() ||
        options.searchRequest?.freshness === "recent",
      );
    const screenContext = buildListingScreenContext({
      searchPreferences: enrichedPreferences,
      selectivity:
        options.searchRequest?.breadth === "wide"
          ? "wide_net"
          : options.searchRequest?.breadth === "best_only"
            ? "best_matches"
            : searchGuidance.selectivity,
      request: options.searchRequest?.intent,
    });
    const screenBatcher = ctx.aiClient.chatWithTools
      ? createListingScreenBatcher({
          screen: (listings) =>
            screenListingsWithModel({
              aiClient: ctx.aiClient,
              context: screenContext,
              listings,
              signal: executionSignal,
            }),
        })
      : null;
    const rejectedByScreen = (
      posting: JobPosting,
      record: ListingScreenRecord,
    ): JobPosting =>
      carryPreparedDiscoveryPosting(posting, {
        ...posting,
        searchRejection: {
          category: record.category ?? "role",
          reason: record.reason ?? "Not the kind of job this search is for.",
        },
      });
    const screenFeed = async (
      result: PublicProviderJobsResult,
    ): Promise<PublicProviderJobsResult> => {
      if (feedsGoToAgent || result.jobs.length === 0) return result;
      const jobs = [...result.jobs];
      const jobIndex = indexOver(allJobs());
      const undecided: Array<{
        position: number;
        listing: ListingScreenListing;
        key: string;
        urlKey: string;
        retained: SavedJob | null;
      }> = [];
      for (const [position, posting] of jobs.entries()) {
        if (position > 0 && position % SCREEN_LOOKUPS_PER_TURN === 0) {
          await yieldToEventLoop();
          executionSignal.throwIfAborted();
        }
        const listing: ListingScreenListing = {
          title: posting.title,
          company: posting.company,
          location: posting.location,
          workMode: posting.workMode,
          department: posting.department,
          team: posting.team,
        };
        const key = listingScreenKey(screenContext, listing);
        const urlKey = normalizeJobIdentityUrl(posting.canonicalUrl);
        const entry = runLedger.find(posting);
        const remembered = entry?.listingScreen ?? null;
        const retained = jobIndex.find({
          ...posting,
          matchAcrossSources: true,
        });
        if (retained) {
          // A kept job is screened only when it was kept unscreened and
          // nobody has touched it since, or the screen put it away under
          // goals that have changed.
          const untouched =
            retained.status === "discovered" &&
            !retained.discoveryFeedback &&
            !retained.personSupplied;
          const putAwayByScreen =
            retained.status === "archived" &&
            !retained.discoveryFeedback &&
            remembered?.verdict === "reject";
          if (
            (remembered?.verdict === "pending" && untouched) ||
            (putAwayByScreen && remembered?.key !== key)
          )
            undecided.push({ position, listing, key, urlKey, retained });
          continue;
        }
        // The person already skipped or applied to it.
        if (
          entry?.latestStatus === "skipped" ||
          entry?.latestStatus === "applied"
        )
          continue;
        if (
          remembered &&
          remembered.key === key &&
          remembered.verdict !== "pending"
        ) {
          screenRecords.set(urlKey, remembered);
          if (remembered.verdict === "reject")
            jobs[position] = rejectedByScreen(posting, remembered);
          continue;
        }
        undecided.push({ position, listing, key, urlKey, retained: null });
      }
      if (undecided.length === 0) return { ...result, jobs };
      const verdicts = screenBatcher
        ? await screenBatcher.screen(undecided.map((item) => item.listing))
        : undecided.map(() => null);
      undecided.forEach((item, index) => {
        const verdict = verdicts[index];
        // Not screened (the AI was busy or away): kept as it is, and
        // screened by the next search.
        if (!verdict) {
          screenRecords.set(item.urlKey, {
            key: null,
            verdict: "pending",
            category: null,
            reason: null,
          });
          return;
        }
        const record: ListingScreenRecord = verdict.keep
          ? { key: item.key, verdict: "keep", category: null, reason: null }
          : {
              key: item.key,
              verdict: "reject",
              category: verdict.category,
              reason: verdict.reason,
            };
        screenRecords.set(item.urlKey, record);
        const posting = jobs[item.position];
        if (!verdict.keep && posting)
          jobs[item.position] = rejectedByScreen(posting, record);
        if (item.retained) {
          if (!verdict.keep) jobsPutAwayByScreen.add(item.retained.id);
          else if (item.retained.status === "archived")
            jobsBroughtBackByScreen.add(item.retained.id);
        }
      });
      return { ...result, jobs };
    };

    try {
      listingReadAheadPass = startListingReadAhead();
      let executionIndex = 0;
      const readyApiTargets = iteratePublicApiTargetsByReadiness({
        targets: apiTargets,
        createPublicApiRequest: (target) => {
          const artifact = resolveActiveSourceInstructionArtifact(
            target,
            sourceInstructionArtifacts,
          );
          const intelligence = inferSourceIntelligenceFromTarget({
            target,
            currentArtifact: artifact,
          });
          return feedDownloads
            .run(() =>
              collectPublicProviderJobs({
                target,
                artifact: { intelligence },
                source: resolveAdapterKind(target),
                prepareForDiscovery: true,
                signal: executionSignal,
              }),
            )
            .then(screenFeed)
            .then(
              (result): SettledPublicProviderJobsResult => ({
                result,
                error: null,
              }),
              (error: unknown): SettledPublicProviderJobsResult => ({
                result: null,
                error,
              }),
            );
        },
        signal: executionSignal,
      })[Symbol.asyncIterator]();
      // Sources are searched a few at a time, each in its own browser tab.
      // Every update below reads the current run state, so interleaving is
      // safe; one source waiting on its model never holds the others.
      const runOneTarget = async (
        readyTarget: ReadyDiscoveryTarget,
      ): Promise<void> => {
        const { target, prefetchedPublicApiResult } = readyTarget;
        const index = executionIndex;
        executionIndex += 1;
        if (executionSignal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const targetStartedAt = new Date().toISOString();
        const targetArtifact = resolveActiveSourceInstructionArtifact(
          target,
          sourceInstructionArtifacts,
        );
        const targetIntelligence = inferSourceIntelligenceFromTarget({
          target,
          currentArtifact: targetArtifact,
        });
        const targetCollectionMethod = selectDiscoveryCollectionMethod(
          target,
          targetArtifact,
        );

        const plannedBudget = discoveryBudgets.get(target.id);
        if (!plannedBudget) {
          throw new Error(
            `Missing planned discovery budget for target ${target.label}.`,
          );
        }

        activeRun = updateTargetExecution(activeRun, target.id, (entry) => ({
          ...entry,
          state: "running",
          startedAt: targetStartedAt,
        }));
        emitActivity(
          createDiscoveryEvent({
            runId,
            timestamp: targetStartedAt,
            kind: "info",
            stage: "target",
            waitReason: "executing_tool",
            targetId: target.id,
            adapterKind: target.adapterKind,
            resolvedAdapterKind: resolveAdapterKind(target),
            collectionMethod: targetCollectionMethod,
            sourceIntelligenceProvider: getDiscoveryProviderKey({
              target,
              intelligence: targetIntelligence,
            }),
            message: `Starting target ${target.label}`,
            url: target.startingUrl,
            jobsFound: 0,
            jobsPersisted: activeRun.summary.jobsPersisted,
            jobsStaged: activeRun.summary.jobsStaged,
            duplicatesMerged: activeRun.summary.duplicatesMerged,
            invalidSkipped: activeRun.summary.invalidSkipped,
          }),
        );

        const discoveryBudget = plannedBudget;
        activeRun = updateTargetExecution(activeRun, target.id, (entry) => ({
          ...entry,
          requestedJobBudget:
            runJobBudget == null ? null : discoveryBudget.targetJobCount,
        }));
        const resolvedTargetAdapterKind = resolveAdapterKind(target);
        const targetProviderKey = getDiscoveryProviderKey({
          target,
          intelligence: targetIntelligence,
        });

        // ------------------------------------------------------------------
        // Incremental checkpoint persistence.
        //
        // Agent checkpoints carry the kept-jobs snapshot after every tool
        // call. Each new posting is processed through exactly the same
        // triage/ledger/budget/merge path as final collection and committed
        // atomically (saved or staged pending jobs + ledger + run state), so
        // distinct usable jobs become visible while the source is still
        // running. Every posting is processed at most once per target: the
        // final pass handles only the remainder, which keeps found/persisted/
        // duplicate counters additive and idempotent without a second merge.
        // A failed incremental attempt rolls back to the pre-attempt state and
        // falls back to end-of-source persistence instead of failing the run;
        // AbortError still propagates so cancellation stays immediate.
        const targetBaselineLedger = runLedger.captureSnapshot();
        // Processed identity keys carry the listing-fingerprint composites of
        // every raw variant already processed for that identity (one identity
        // may legitimately appear with several card/title variants inside one
        // payload). A repeat whose composite was seen before is fully handled
        // and suppressed; a repeat with a NEW composite (a richer re-extraction
        // of the same job) is deliberately reprocessed so the upgrade reaches
        // the merge — where it updates the existing saved/staged job and counts
        // exactly like a legacy single-pass duplicate merge (found/duplicates
        // yes, new/persisted/staged no).
        const checkpointState = {
          processedKeys: new Map<string, string[]>(),
          budgetedCount: 0,
          sourceCounts: new Map<string, DiscoverySourceListingCounts>(),
          inspectedJobIds: new Set<string>(),
          inspectedCount: 0,
          rejectedListings: [] as NonNullable<
            DiscoveryTargetExecution["rejectedListings"]
          >,
          deferredCount: 0,
          reviewedCount: 0,
          validatedCount: 0,
          jobsPersisted: 0,
          jobsStaged: 0,
          skippedByLedger: 0,
          skippedByTitleTriage: 0,
          duplicatesMerged: 0,
          invalidSkipped: 0,
          disabled: false,
          // Newest checkpoint revision known to be durable in storage; null
          // until this target's first checkpoint flush. Drives the bounded
          // duplicate-checkpoint heartbeat.
          persistedCheckpointRevision: null as number | null,
        };
        const producingTargets = new Map<
          string | null,
          ReturnType<typeof resolvePostingProducingTarget>
        >();
        const producingTargetFor = (
          posting: Pick<JobPosting, "producingPageUrl">,
        ) => {
          const key = posting.producingPageUrl ?? null;
          let source = producingTargets.get(key);
          if (!source) {
            source = resolvePostingProducingTarget(
              posting,
              target,
              enrichedPreferences.discovery.targets,
            );
            producingTargets.set(key, source);
          }
          return source;
        };
        const sourceCountsFor = (
          posting: Pick<JobPosting, "producingPageUrl">,
        ): DiscoverySourceListingCounts => {
          const source = producingTargetFor(posting);
          let counts = checkpointState.sourceCounts.get(source.id);
          if (!counts) {
            counts = {
              sourceId: source.id,
              label: source.label,
              startingUrl: source.startingUrl,
              inspected: 0,
              saved: 0,
              rejected: 0,
              duplicates: 0,
              deferred: 0,
              pagesCovered: null,
            };
            checkpointState.sourceCounts.set(source.id, counts);
          }
          return counts;
        };
        // Copies for the run record: saving it freezes what it was given, and
        // these counts keep growing on the next page.
        const copySourceCounts = (): DiscoverySourceListingCounts[] =>
          [...checkpointState.sourceCounts.values()].map((counts) => ({
            ...counts,
          }));
        const getDiscoveryCheckpointFingerprintKey = (
          posting: JobPosting,
        ): string => {
          const fingerprints = createDiscoveryListingFingerprints(posting);
          return `${fingerprints.card}|${fingerprints.material}`;
        };
        // True when the posting was never processed, or carries a content
        // variant that was not processed before (an upgrade worth merging).
        const isUnprocessedOrMateriallyChangedPosting = (
          posting: JobPosting,
        ): boolean => {
          const retainedVariants = checkpointState.processedKeys.get(
            getDiscoveryCheckpointPostingKey(posting),
          );
          if (!retainedVariants) {
            return true;
          }
          return !retainedVariants.includes(
            getDiscoveryCheckpointFingerprintKey(posting),
          );
        };
        const titleTriageSkipSamples: Array<{
          title: string;
          company: string;
          reason: string | null;
        }> = [];
        const resumeAffectingChangedJobIds: string[] = [];

        const runTriageAndLedgerForPostings = (
          rawPostings: readonly JobPosting[],
        ): {
          keptPostings: JobPosting[];
          keptUpgradePostings: JobPosting[];
          skippedByLedger: number;
          skippedByTitleTriage: number;
        } => {
          const startedAt = performance.now();
          const keptPostings: JobPosting[] = [];
          // Re-observations of identities already processed by an earlier
          // phase whose content changed (richer re-extractions), plus
          // identities already retained as kept jobs from any earlier run,
          // are kept separately: they merge over the existing saved/staged
          // row without consuming a new budget slot.
          const keptUpgradePostings: JobPosting[] = [];
          // Identities already persisted as kept jobs mirror exactly the pool
          // the merge step treats as existing rows: saved jobs normally, and
          // staged pending jobs alongside saved jobs in discovery-only mode.
          // Re-observing them can never produce a new distinct job, so they
          // must never compete with fresh candidates for budget.
          const retainedJobIndex = indexOver(
            settings.discoveryOnly ? allJobs() : workingSavedJobs,
          );
          // Repeat identities inside one pass must keep flowing through
          // triage/budget/merge so duplicate merges stay counted exactly like
          // single-pass collection; only identities fully processed by an
          // earlier phase with unchanged content are skipped here. Changed
          // content (a richer re-extraction) is reprocessed on purpose so the
          // upgrade reaches the merge.
          const processedBeforePass = new Map(checkpointState.processedKeys);
          let phaseSkippedByLedger = 0;
          let phaseSkippedByTitleTriage = 0;

          for (const rawPosting of rawPostings) {
            const postingKey = getDiscoveryCheckpointPostingKey(rawPosting);
            const fingerprintKey =
              getDiscoveryCheckpointFingerprintKey(rawPosting);
            const retainedBeforePass = processedBeforePass.get(postingKey);
            const isEarlierPhaseIdentity = retainedBeforePass !== undefined;
            if (
              retainedBeforePass &&
              retainedBeforePass.includes(fingerprintKey)
            ) {
              continue;
            }
            const knownVariants =
              checkpointState.processedKeys.get(postingKey) ?? [];
            if (!knownVariants.includes(fingerprintKey)) {
              checkpointState.processedKeys.set(
                postingKey,
                knownVariants.concat(fingerprintKey),
              );
            }

            checkpointState.inspectedCount += 1;
            const posting = rawPosting;
            const knownInspection = inspectionIdentityIndex.find({
              ...posting,
              matchAcrossSources: true,
            });
            const inspectionId = knownInspection?.id ?? toSavedJobId(posting);
            inspectionIdentityIndex.add(
              inspectionIdentity(posting, inspectionId),
            );
            checkpointState.inspectedJobIds.add(inspectionId);
            const sourceCounts = sourceCountsFor(posting);
            sourceCounts.inspected += 1;
            const { posting: triagedPosting, triageReason } =
              createPostingWithTriage(
                posting,
                enrichedPreferences,
                profile,
                runJudgments.get(toSavedJobId(posting)) ?? null,
              );

            if (triagedPosting.titleTriageOutcome !== "pass") {
              sourceCounts.rejected += 1;
              phaseSkippedByTitleTriage += 1;
              const judgment = runJudgments.get(toSavedJobId(posting));
              checkpointState.rejectedListings.push({
                title: posting.title,
                url: posting.canonicalUrl,
                category:
                  posting.searchRejection?.category ??
                  (judgment?.role === "conflict"
                    ? "role"
                    : judgment?.locationReach === "outside_area"
                      ? "place"
                      : "person_exclusion"),
                reason: triageReason ?? "Excluded by your search preferences.",
              });
              if (
                titleTriageSkipSamples.length < DISCOVERY_ACTIVITY_SAMPLE_LIMIT
              ) {
                titleTriageSkipSamples.push({
                  title: triagedPosting.title,
                  company: triagedPosting.company,
                  reason: triageReason,
                });
              }
              recordSighting({
                posting: triagedPosting,
                targetId: target.id,
                seenAt: triagedPosting.discoveredAt,
                status: "seen",
                skipReason: triageReason,
              });
              continue;
            }

            const ledgerEntry = runLedger.find(triagedPosting);
            const refreshDecision = createDiscoveryRefreshDecision({
              ledgerEntry,
              posting: triagedPosting,
              evaluatedAt: triagedPosting.discoveredAt,
            });
            const retainedJob = retainedJobIndex.find(triagedPosting) ?? null;
            const ledgerDecision = shouldSkipPostingFromLedger({
              ledgerEntry,
              posting: triagedPosting,
              triageOutcome: triagedPosting.titleTriageOutcome,
              ...(retainedJob ? { hasRetainedJob: true } : {}),
            });
            const canReuseKnownPosting =
              ledgerDecision.skip &&
              refreshDecision.disposition !== "refresh_now";

            if (canReuseKnownPosting) {
              sourceCounts.duplicates += 1;
              phaseSkippedByLedger += 1;
              recordSighting({
                posting: {
                  ...triagedPosting,
                  titleTriageOutcome: ledgerDecision.outcome,
                },
                targetId: target.id,
                seenAt: triagedPosting.discoveredAt,
                status: ledgerEntry?.latestStatus ?? "skipped",
                skipReason: ledgerDecision.reason,
              });
              continue;
            }

            recordSighting({
              posting: triagedPosting,
              targetId: target.id,
              seenAt: triagedPosting.discoveredAt,
              status: "seen",
            });
            // Enrich once, here, so budget selection and the merge below score
            // exactly the content that will be persisted.
            const enrichedKept = enrichDiscoveredPosting(
              triagedPosting,
              undefined,
            );
            postingAsArrived.set(enrichedKept, triagedPosting);
            if (isEarlierPhaseIdentity || retainedJob) {
              // A retained identity with changed content (a richer
              // re-extraction or a provider update) merges over its existing
              // row as a budget-free upgrade; it can never become a new
              // distinct result even when the refresh schedule asks for an
              // immediate verification.
              keptUpgradePostings.push(enrichedKept);
            } else {
              keptPostings.push(enrichedKept);
            }
          }

          checkpointState.skippedByLedger += phaseSkippedByLedger;
          checkpointState.skippedByTitleTriage += phaseSkippedByTitleTriage;
          if (bookkeeping.hasSubscribers)
            bookkeeping.publish({
              phase: "triage",
              rows: rawPostings.length,
              ms: performance.now() - startedAt,
            });
          return {
            keptPostings,
            keptUpgradePostings,
            skippedByLedger: phaseSkippedByLedger,
            skippedByTitleTriage: phaseSkippedByTitleTriage,
          };
        };

        const mergeAndAccountPostings = (
          newCandidates: readonly JobPosting[],
          upgradeCandidates: readonly JobPosting[],
        ): {
          budgetedPostings: JobPosting[];
          mergeResult: ReturnType<typeof mergeDiscoveredPostings>;
          jobsPersisted: number;
          jobsStaged: number;
        } => {
          const startedAt = performance.now();
          // Greedy budget applies only to genuinely new identities: each
          // consumes one of the target's remaining slots. Upgrades of already
          // retained identities update existing saved/staged rows and consume
          // no slot, so they stay eligible even when the budget is exhausted.
          const remainingBudget = Math.max(
            0,
            discoveryBudget.retentionJobCount - checkpointState.budgetedCount,
          );
          // Default searches keep every eligible listing already collected
          // (ADR 0024). Only a person-specified result budget may discard one;
          // normal identity merging still removes actual duplicates.
          const budgetedNewPostings =
            runJobBudget == null
              ? [...newCandidates]
              : selectDiscoveryBudgetPostings({
                  postings: newCandidates,
                  profile,
                  searchPreferences: enrichedPreferences,
                  limit: remainingBudget,
                  preferredCanonicalUrls: [target.startingUrl],
                  assessPosting: assessDiscoveryPosting,
                });
          const budgeted = new Set(budgetedNewPostings);
          for (const posting of newCandidates)
            if (!budgeted.has(posting)) sourceCountsFor(posting).deferred += 1;
          checkpointState.deferredCount +=
            newCandidates.length - budgetedNewPostings.length;
          checkpointState.budgetedCount += budgetedNewPostings.length;
          checkpointState.reviewedCount +=
            budgetedNewPostings.length + upgradeCandidates.length;
          const budgetedPostings = [
            ...budgetedNewPostings,
            ...upgradeCandidates,
          ];

          const mergeSeedJobs = settings.discoveryOnly
            ? allJobs()
            : workingSavedJobs;
          const mergeIdentityIndex = indexOver(mergeSeedJobs);
          const batchSavedJobIds = new Set<string>();
          const batchSavedJobs = new Map<string, SavedJob>();
          for (const posting of budgetedPostings) {
            const known = mergeIdentityIndex.find({
              ...posting,
              matchAcrossSources: true,
            });
            if (known) {
              runRetainedJobIds.add(known.id);
              batchSavedJobIds.add(known.id);
              batchSavedJobs.set(known.id, known);
            }
          }
          const mergeResult = mergeDiscoveredPostings(
            profile,
            enrichedPreferences,
            mergeSeedJobs,
            budgetedPostings,
            (posting) => {
              const producingTarget = producingTargetFor(posting);
              return createDiscoveryProvenance({
                targetId: producingTarget.id,
                sourceLabel: producingTarget.label,
                adapterKind: producingTarget.adapterKind,
                resolvedAdapterKind:
                  producingTarget.id === target.id
                    ? resolvedTargetAdapterKind
                    : posting.source,
                startingUrl: producingTarget.startingUrl,
                discoveredAt: new Date().toISOString(),
                collectionMethod: targetCollectionMethod,
                providerKey: posting.providerKey,
                providerBoardToken: posting.providerBoardToken,
                titleTriageOutcome: posting.titleTriageOutcome,
                listingUrl: posting.canonicalUrl,
                applicationUrl: posting.applicationUrl,
                sourceJobId: posting.sourceJobId,
                applyPath: posting.applyPath,
              });
            },
            executionSignal,
            assessDiscoveryPosting,
            batchSavedJobIds,
            {
              identityIndex: mergeIdentityIndex,
              recordRankOnlyAudits: false,
              reuseInventory: true,
            },
          );
          const landedIndex = jobIdentity.accept(mergeResult.mergedJobs);
          const landed = landedJobIdsFor(target.id);
          const landedJobs = new Map<string, SavedJob>();
          for (const posting of budgetedPostings) {
            const stored = landedIndex.find({
              ...posting,
              matchAcrossSources: true,
            });
            if (stored) {
              runRetainedJobIds.add(stored.id);
              landed.add(stored.id);
              landedJobs.set(stored.id, stored);
            }
          }
          resumeAffectingChangedJobIds.push(
            ...collectResumeAffectingChangedJobIds(
              [...batchSavedJobs.values()],
              [...landedJobs.values()],
            ),
          );

          const persistedSavedJobIds = settings.discoveryOnly
            ? new Set(workingSavedJobs.map((job) => job.id))
            : null;
          let jobsPersisted = 0;
          let jobsStaged = 0;

          if (settings.discoveryOnly) {
            const nextPendingJobs = mergeResult.mergedJobs.filter(
              (job) => !persistedSavedJobIds!.has(job.id),
            );
            workingSavedJobs = mergeResult.mergedJobs.filter(
              (job) =>
                persistedSavedJobIds!.has(job.id) &&
                !mergeResult.newJobs.some((newJob) => newJob.id === job.id),
            );
            workingPendingJobs = mergePendingJobs(
              workingPendingJobs,
              nextPendingJobs,
            );
            jobsStaged = mergeResult.newJobs.length;
          } else {
            workingSavedJobs = mergeResult.mergedJobs;
            jobsPersisted = mergeResult.newJobs.length;
          }
          for (const job of landedJobs.values()) {
            if (settings.discoveryOnly && !persistedSavedJobIds!.has(job.id)) {
              touchedPendingJobIds.add(job.id);
            } else touchSavedJob(job);
          }

          for (const posting of budgetedPostings) {
            recordSighting({
              // The ledger fingerprints a listing as it arrives, which is what
              // the next sighting is compared with. Fingerprinting the
              // enriched copy (screening hints, keyword signals) made every
              // kept job read as "changed" when seen again, so each search
              // merged and rewrote every kept job of every board it read.
              posting: postingAsArrived.get(posting) ?? posting,
              targetId: producingTargetFor(posting).id,
              seenAt: new Date().toISOString(),
              status:
                posting.detailQuality === "detail_enriched"
                  ? "enriched"
                  : "seen",
            });
          }

          const newIndex = createJobIdentityIndex(
            mergeResult.newJobs,
            toSightingIdentityInput,
          );
          const countedNewIds = new Set<string>();
          for (const posting of budgetedPostings) {
            const newJob = newIndex.find(posting);
            const sourceCounts = sourceCountsFor(posting);
            if (newJob && !countedNewIds.has(newJob.id)) {
              sourceCounts.saved += 1;
              countedNewIds.add(newJob.id);
            } else sourceCounts.duplicates += 1;
          }
          checkpointState.validatedCount += mergeResult.validatedCount;
          checkpointState.jobsPersisted += jobsPersisted;
          checkpointState.jobsStaged += jobsStaged;
          checkpointState.duplicatesMerged += mergeResult.duplicatesMerged;
          checkpointState.invalidSkipped += mergeResult.invalidSkipped;

          if (bookkeeping.hasSubscribers)
            bookkeeping.publish({
              phase: "merge",
              rows: budgetedPostings.length,
              ms: performance.now() - startedAt,
            });
          return { budgetedPostings, mergeResult, jobsPersisted, jobsStaged };
        };

        // Two settings decide which new jobs are kept: a result limit keeps
        // only some, and "Best matches only" keeps only what fits. The model
        // judges the jobs first so both rest on its verdict rather than on
        // recency or title words (ADR 0041); the verdicts are reused after
        // the search, not asked for again.
        const judgeBeforeKeeping = async (
          postings: readonly JobPosting[],
        ): Promise<void> => {
          const remainingBudget = Math.max(
            0,
            discoveryBudget.retentionJobCount - checkpointState.budgetedCount,
          );
          const limitMustChoose =
            runJobBudget != null && postings.length > remainingBudget;
          const keepsOnlyFits =
            enrichedPreferences.discovery.collectOnlyHardCriteriaMatches ===
            true;
          if (
            (!limitMustChoose && !keepsOnlyFits) ||
            postings.length === 0 ||
            !ctx.aiClient.judgeJobFits ||
            executionSignal.aborted
          ) {
            return;
          }
          const unjudged = postings
            .map((posting) => ({ ...posting, id: toSavedJobId(posting) }))
            .filter(
              (posting) =>
                !runJudgments.has(posting.id) &&
                fitAskedFingerprints.get(posting.id) !==
                  fitPostingFingerprint(posting),
            );
          for (const posting of unjudged) {
            fitAskedFingerprints.set(
              posting.id,
              fitPostingFingerprint(posting),
            );
          }
          const fitProgress = (completed: number, total: number) =>
            emitActivity(
              createDiscoveryEvent({
                runId,
                timestamp: new Date().toISOString(),
                kind: "progress",
                stage: "extraction",
                targetId: target.id,
                adapterKind: target.adapterKind,
                message: `Judging fit ${completed} of ${total}.`,
                progress: { phase: "judging_fit", completed, total },
                url: null,
                jobsFound: null,
                jobsPersisted: null,
                jobsStaged: null,
                duplicatesMerged: null,
                invalidSkipped: null,
              }),
            );
          if (unjudged.length > 0) fitProgress(0, unjudged.length);
          try {
            const judgments = await judgeJobFitsInBatches({
              aiClient: ctx.aiClient,
              profile,
              searchPreferences: enrichedPreferences,
              jobs: unjudged,
              onProgress: fitProgress,
              contextFingerprint: assessmentSession.verdictFingerprint,
              signal: executionSignal,
            });
            for (const [jobId, judgment] of judgments) {
              runJudgments.set(jobId, judgment);
            }
          } catch (error) {
            if (executionSignal.aborted) throw error;
            // Unjudged jobs fall back to the newest first, and are judged
            // after the search.
          }
        };

        // Jobs a running search keeps join its plan as they are saved, so
        // Find jobs shows them while the search goes on, and a run that fails
        // or times out still leaves what it kept reviewable. The end of the
        // run applies the plan's rules and counts as before.
        const addKeptJobsToRunningPlan = async (
          candidateJobIds: readonly string[],
        ): Promise<void> => {
          const campaignId = activeRun.campaignId;
          if (!campaignId) return;
          const jobIds = uniqueStrings(
            candidateJobIds.filter((jobId) => !attachedPlanJobIds.has(jobId)),
          );
          if (jobIds.length === 0) return;
          await ctx.withCampaignTransition(async () => {
            const state = await ctx.repository.getCampaignState();
            const campaign = state?.campaigns.find(
              (candidate) => candidate.id === campaignId,
            );
            if (!state || !campaign) return;
            const existing = new Set(campaign.jobIds);
            const missing = jobIds.filter((jobId) => !existing.has(jobId));
            if (missing.length === 0) {
              for (const jobId of jobIds) attachedPlanJobIds.add(jobId);
              return;
            }
            await ctx.repository.saveCampaignState({
              ...state,
              campaigns: state.campaigns.map((candidate) =>
                candidate.id === campaignId
                  ? {
                      ...candidate,
                      jobIds: [...candidate.jobIds, ...missing],
                    }
                  : candidate,
              ),
            });
            for (const jobId of jobIds) attachedPlanJobIds.add(jobId);
          });
        };

        const persistTargetWorkingState = async (): Promise<void> => {
          activeRun = updateRunSummary(activeRun, {
            report: buildDiscoveryRunReport(
              activeRun,
              new Date().toISOString(),
            ),
          });
          await persistWorkingSavedJobs(captureWorkingDiscoveryUpdate());
        };

        // Lightweight run-state-only save for checkpoints that carry no
        // unprocessed postings: keeps the resume checkpoint and live run
        // truth durable without a saved-job delta commit or ledger rebase.
        const persistTargetRunStateOnly = async (): Promise<void> => {
          activeRun = updateRunSummary(activeRun, {
            report: buildDiscoveryRunReport(
              activeRun,
              new Date().toISOString(),
            ),
          });
          const run = captureRunForCommit();
          await persistWorkingSavedJobs((current) =>
            finalizeDiscoveryState(current, run, enrichedPreferences),
          );
        };

        const processCheckpointJobs = async (
          checkpoint: NonNullable<
            DiscoveryRunRecord["targetExecutions"][number]["agentCheckpoint"]
          >,
        ): Promise<void> => {
          // Clone at storage assignment so the stored revision can never alias
          // the runtime-provided checkpoint object or its mutable arrays.
          activeRun = updateTargetExecution(activeRun, target.id, (entry) => ({
            ...entry,
            agentCheckpoint: {
              ...checkpoint,
              collectedJobs: checkpoint.collectedJobs.map((posting) => ({
                ...posting,
              })),
              visitedUrls: [...checkpoint.visitedUrls],
            },
            // The checkpoint itself is replaced by the next one, so the
            // listings it carried are appended to the durable encountered
            // list before that happens.
            encounteredJobIds: uniqueStrings([
              ...entry.encounteredJobIds,
              ...landedJobIdsFor(target.id),
              ...(() => {
                const index = indexOver(allJobs());
                return checkpoint.collectedJobs.flatMap((posting) => {
                  const stored = index.find({
                    ...posting,
                    matchAcrossSources: true,
                  });
                  return stored ? [stored.id] : [];
                });
              })(),
            ]),
          }));

          // Copy the checkpoint payload: collectedJobs is the agent's live
          // mutable array, and processing must never alias it. Detail quality
          // is derived from the payload content before any fingerprint is
          // claimed so richer re-extractions of known identities reach the
          // upgrade merge instead of being skipped as unchanged cards.
          const checkpointJobs = checkpoint.collectedJobs.map(
            normalizeCollectedCheckpointPosting,
          );
          const newRawPostings = checkpointJobs.filter(
            isUnprocessedOrMateriallyChangedPosting,
          );

          if (
            checkpointState.disabled ||
            newRawPostings.length === 0 ||
            executionSignal.aborted
          ) {
            // A checkpoint with no newly processable postings carries no job,
            // ledger, or counter delta: persisting it would rewrite the whole
            // discovery singleton only to refresh resume metadata and the
            // activity tail. Flush only when durability is required — abort,
            // disabled mid-run saving, this target's first checkpoint (so
            // target-start truth becomes durable promptly), or the bounded
            // revision heartbeat. Everything else stays in memory for the
            // next kept batch or the unconditional terminal saves.
            const shouldPersistCheckpoint =
              executionSignal.aborted ||
              checkpointState.disabled ||
              checkpointState.persistedCheckpointRevision === null ||
              checkpoint.revision -
                checkpointState.persistedCheckpointRevision >=
                CHECKPOINT_RESUME_HEARTBEAT_REVISIONS;
            if (!shouldPersistCheckpoint) {
              return;
            }
            await persistTargetRunStateOnly();
            checkpointState.persistedCheckpointRevision = checkpoint.revision;
            return;
          }

          await judgeBeforeKeeping(newRawPostings);

          // Rollback snapshot for the speculative incremental attempt. The
          // working containers are replaced immutably by merges, so restoring
          // the captured references plus the tracked additions undoes the
          // attempt completely; the repository commit itself is atomic.
          const stateBeforeAttempt = {
            workingSavedJobs,
            workingPendingJobs,
            ledgerEntries: runLedger.entries(),
            activeRun,
          };
          const totalsBeforeAttempt = {
            sourceCounts: new Map(
              [...checkpointState.sourceCounts].map(([id, counts]) => [
                id,
                { ...counts },
              ]),
            ),
            inspectedJobIds: new Set(checkpointState.inspectedJobIds),
            inspectedCount: checkpointState.inspectedCount,
            rejectedListings: [...checkpointState.rejectedListings],
            deferredCount: checkpointState.deferredCount,
            budgetedCount: checkpointState.budgetedCount,
            reviewedCount: checkpointState.reviewedCount,
            validatedCount: checkpointState.validatedCount,
            jobsPersisted: checkpointState.jobsPersisted,
            jobsStaged: checkpointState.jobsStaged,
            skippedByLedger: checkpointState.skippedByLedger,
            skippedByTitleTriage: checkpointState.skippedByTitleTriage,
            duplicatesMerged: checkpointState.duplicatesMerged,
            invalidSkipped: checkpointState.invalidSkipped,
          };
          const samplePoolSnapshot = titleTriageSkipSamples.length;
          const resumeChangeIdsSnapshot = resumeAffectingChangedJobIds.length;
          // Snapshot of the processed-key map before the attempt; restoring
          // it releases exactly the keys and fingerprints this attempt claimed,
          // including any claimed before a mid-closure throw.
          const processedKeysBeforeAttempt = new Map(
            checkpointState.processedKeys,
          );

          try {
            const triageOutcome = runTriageAndLedgerForPostings(newRawPostings);

            const { mergeResult, jobsPersisted, jobsStaged } =
              mergeAndAccountPostings(
                triageOutcome.keptPostings,
                triageOutcome.keptUpgradePostings,
              );

            // validJobsFound counts only distinct additions retained by this
            // run (persisted or staged). Duplicate merges and upgrades that
            // update an existing retained job stay in duplicatesMerged and
            // never inflate the run's found/kept total.
            activeRun = updateRunSummary(activeRun, {
              validJobsFound:
                activeRun.summary.validJobsFound + jobsPersisted + jobsStaged,
              jobsPersisted: activeRun.summary.jobsPersisted + jobsPersisted,
              jobsStaged: activeRun.summary.jobsStaged + jobsStaged,
              jobsSkippedByLedger:
                activeRun.summary.jobsSkippedByLedger +
                triageOutcome.skippedByLedger,
              jobsSkippedByTitleTriage:
                activeRun.summary.jobsSkippedByTitleTriage +
                triageOutcome.skippedByTitleTriage,
              duplicatesMerged:
                activeRun.summary.duplicatesMerged +
                mergeResult.duplicatesMerged,
              invalidSkipped:
                activeRun.summary.invalidSkipped + mergeResult.invalidSkipped,
            });
            // Mirror cumulative truth onto the running execution so a snapshot
            // or cancellation taken mid-run reports what checkpoints already
            // committed, not zeros. jobsFound carries the distinct-retained
            // semantic (persisted + staged additions); review volume lives in
            // jobsReviewed and duplicate merges in duplicatesMerged.
            activeRun = updateTargetExecution(
              activeRun,
              target.id,
              (entry) => ({
                ...entry,
                sourceCounts: copySourceCounts(),
                inspectedJobIds: [...checkpointState.inspectedJobIds],
                jobsInspected: checkpointState.inspectedCount,
                rejectedListings: [...checkpointState.rejectedListings],
                listingsDeferred: checkpointState.deferredCount,
                jobsReviewed: checkpointState.reviewedCount,
                jobsFound:
                  checkpointState.jobsPersisted + checkpointState.jobsStaged,
                jobsPersisted: checkpointState.jobsPersisted,
                jobsStaged: checkpointState.jobsStaged,
                jobsSkippedByLedger: checkpointState.skippedByLedger,
                jobsSkippedByTitleTriage: checkpointState.skippedByTitleTriage,
                duplicatesMerged: checkpointState.duplicatesMerged,
                invalidSkipped: checkpointState.invalidSkipped,
              }),
            );

            const keptNow = jobsPersisted + jobsStaged;
            // User-facing "kept" claims derive from distinct persisted or
            // staged additions only; duplicate merges stay in their own
            // counter and never inflate what this run claims to have kept.
            const keptOverall =
              checkpointState.jobsPersisted + checkpointState.jobsStaged;
            const checkpointEvent = createDiscoveryEvent({
              runId,
              timestamp: new Date().toISOString(),
              kind: keptNow > 0 ? "progress" : "info",
              stage: "persistence",
              waitReason: "persisting_results",
              targetId: target.id,
              adapterKind: target.adapterKind,
              resolvedAdapterKind: resolvedTargetAdapterKind,
              collectionMethod: targetCollectionMethod,
              sourceIntelligenceProvider: targetProviderKey,
              message:
                keptNow > 0
                  ? `Saved ${keptNow} new job${keptNow === 1 ? "" : "s"} from ${target.label} so far (${keptOverall} kept overall). Results stay available while the search continues.`
                  : `Reviewed new results from ${target.label}; no additional distinct jobs were kept.`,
              url: target.startingUrl,
              // Event-level jobsFound deliberately keeps the review-volume
              // semantic (valid cards merged, duplicates included): the
              // renderer count label derives "unique retained" as jobsFound
              // minus duplicatesMerged. Kept/found claims come from the run
              // summary and execution fields, which carry distinct-retained.
              jobsFound: checkpointState.validatedCount,
              jobsPersisted,
              jobsStaged,
              duplicatesMerged: mergeResult.duplicatesMerged,
              invalidSkipped: mergeResult.invalidSkipped,
            });
            recordActivity(checkpointEvent);
            await persistTargetWorkingState();
            checkpointState.persistedCheckpointRevision = checkpoint.revision;
            // The ids these postings were stored under; a site's own job
            // number can name another site's job.
            await addKeptJobsToRunningPlan([...landedJobIdsFor(target.id)]);
            publishActivity(checkpointEvent);
            queueKeptJobsForFit();
          } catch (error) {
            const interrupted =
              executionSignal.aborted ||
              (error instanceof DOMException && error.name === "AbortError");
            if (interrupted) {
              throw error;
            }

            checkpointState.disabled = true;
            checkpointState.processedKeys = processedKeysBeforeAttempt;
            Object.assign(checkpointState, totalsBeforeAttempt);
            titleTriageSkipSamples.length = samplePoolSnapshot;
            resumeAffectingChangedJobIds.length = resumeChangeIdsSnapshot;
            workingSavedJobs = stateBeforeAttempt.workingSavedJobs;
            savedJobWriter.restoreWorkingRows(
              workingSavedJobs.filter((job) => touchedSavedJobIds.has(job.id)),
            );
            workingPendingJobs = stateBeforeAttempt.workingPendingJobs;
            runLedger.restore(stateBeforeAttempt.ledgerEntries);
            activeRun = stateBeforeAttempt.activeRun;

            emitActivity(
              createDiscoveryEvent({
                runId,
                timestamp: new Date().toISOString(),
                kind: "warning",
                stage: "persistence",
                waitReason: "finalizing",
                targetId: target.id,
                adapterKind: target.adapterKind,
                resolvedAdapterKind: resolvedTargetAdapterKind,
                collectionMethod: targetCollectionMethod,
                sourceIntelligenceProvider: targetProviderKey,
                message: `Mid-run saving hit a problem (${describeUnknownThrowable(error)}). Jobs will be saved when this source finishes.`,
                url: target.startingUrl,
                jobsFound: null,
                jobsPersisted: 0,
                jobsStaged: 0,
                duplicatesMerged: 0,
                invalidSkipped: 0,
              }),
            );
          }
        };

        let collected: Awaited<ReturnType<typeof collectTargetJobs>>;
        try {
          collected = await collectTargetJobs({
            ctx,
            target,
            sourceInstructionArtifacts,
            profile,
            searchPreferences: enrichedPreferences,
            // A run-scoped breadth (evaluation lanes) wins; otherwise the
            // saved AI search behavior decides, and only its middle setting
            // defers to the plan's own precision-or-scale mode.
            searchMode:
              options.searchRequest?.breadth === "wide"
                ? "scale"
                : options.searchRequest?.breadth === "best_only"
                  ? "precision"
                  : searchGuidance.selectivity === "wide_net"
                    ? "scale"
                    : searchGuidance.selectivity === "best_matches"
                      ? "precision"
                      : (effectiveCampaign?.mode ?? "precision"),
            searchGuidance,
            ...(options.searchRequest
              ? { searchRequest: options.searchRequest }
              : {}),
            targetJobCount: discoveryBudget.targetJobCount,
            retainAllFound: runJobBudget == null,
            maxSteps: discoveryBudget.maxSteps,
            activeRun,
            emitActivity,
            onAgentCheckpoint: async (targetId, checkpoint) => {
              if (targetId !== target.id) {
                return;
              }
              await processCheckpointJobs(checkpoint);
            },
            signal: executionSignal,
            openedSessionSources,
            sessionOpenings,
            protectedPages,
            useAgentRuntime: options.useAgentRuntime ?? false,
            timeBudgetMs:
              targets.length > 1
                ? MULTI_SOURCE_TARGET_TIME_BUDGET_MS
                : MAX_DISCOVERY_TARGET_TIME_BUDGET_MS,
            agentSlots,
            ...(prefetchedPublicApiResult ? { prefetchedPublicApiResult } : {}),
          });
        } catch (error) {
          targetBaselineLedger.release();
          const interrupted =
            executionSignal.aborted ||
            (error instanceof DOMException && error.name === "AbortError");
          if (interrupted || options.scope === "single_target") {
            throw error;
          }

          const failedAt = new Date().toISOString();
          const warning = `Discovery failed for ${target.label}: ${describeUnknownThrowable(error)}`;
          activeRun = completeTargetExecution(activeRun, target.id, failedAt, {
            state: "failed",
            requestedJobBudget:
              runJobBudget == null ? null : discoveryBudget.targetJobCount,
            // Failure truth is cumulative: checkpoint flushes may already have
            // committed jobs durably, so the failed execution must report what
            // was actually kept rather than zeros. jobsFound is the distinct
            // retained total (persisted + staged), matching the summary.
            sourceCounts: copySourceCounts(),
            inspectedJobIds: [...checkpointState.inspectedJobIds],
            jobsInspected: checkpointState.inspectedCount,
            rejectedListings: [...checkpointState.rejectedListings],
            listingsDeferred: checkpointState.deferredCount,
            jobsReviewed: checkpointState.reviewedCount,
            jobsFound:
              checkpointState.jobsPersisted + checkpointState.jobsStaged,
            jobsPersisted: checkpointState.jobsPersisted,
            jobsStaged: checkpointState.jobsStaged,
            jobsSkippedByLedger: checkpointState.skippedByLedger,
            jobsSkippedByTitleTriage: checkpointState.skippedByTitleTriage,
            duplicatesMerged: checkpointState.duplicatesMerged,
            invalidSkipped: checkpointState.invalidSkipped,
            warning,
            // An errored source is dead work, not resumable progress: the
            // ledger keeps what was committed, and the next run starts fresh.
            agentCheckpoint: null,
          });
          emitActivity(
            createDiscoveryEvent({
              runId,
              timestamp: failedAt,
              kind: "error",
              stage: "target",
              waitReason: "finalizing",
              targetId: target.id,
              adapterKind: target.adapterKind,
              resolvedAdapterKind: resolveAdapterKind(target),
              collectionMethod: targetCollectionMethod,
              sourceIntelligenceProvider: getDiscoveryProviderKey({
                target,
                intelligence: targetIntelligence,
              }),
              terminalState: "failed",
              message: warning,
              url: target.startingUrl,
              jobsFound: 0,
              jobsPersisted: activeRun.summary.jobsPersisted,
              jobsStaged: activeRun.summary.jobsStaged,
              duplicatesMerged: activeRun.summary.duplicatesMerged,
              invalidSkipped: activeRun.summary.invalidSkipped,
            }),
          );
          return;
        }
        const collectedJobs = collected.result.jobs;
        // Freshness classification runs against the ledger captured before
        // this target started processing (checkpoint flushes included), so a
        // job kept mid-run still classifies exactly once against the same
        // pre-target baseline.
        const freshnessDigest = await createDiscoveryFreshnessDigestInTurns({
          ledger: [],
          postings: collectedJobs,
          index: targetBaselineLedger,
          perTurn: FINAL_PASS_POSTINGS_PER_TURN,
        }).finally(() => targetBaselineLedger.release());
        const freshnessSummary =
          formatDiscoveryFreshnessDigest(freshnessDigest);
        // Re-seen postings never reach the merge (their content is unchanged),
        // but a card the last search left unread is still a card: it is in
        // this run's retained population for the listing-detail read.
        const collectedIdentityIndex = indexOver(allJobs());
        const collectedStoredIds: string[] = [];
        for (const [position, posting] of collectedJobs.entries()) {
          if (position > 0 && position % FINAL_PASS_POSTINGS_PER_TURN === 0)
            await yieldToEventLoop();
          const stored = collectedIdentityIndex.find({
            ...posting,
            matchAcrossSources: true,
          });
          if (stored) {
            runRetainedJobIds.add(stored.id);
            collectedStoredIds.push(stored.id);
          }
        }
        const collectedProviderKey = getDiscoveryProviderKey({
          target,
          intelligence: collected.intelligence,
        });

        activeRun = updateTargetExecution(activeRun, target.id, (entry) => ({
          ...entry,
          collectionMethod: collected.collectionMethod,
          sourceIntelligenceProvider: collectedProviderKey,
          // Every listing this target collected, so campaign membership can
          // read what the run encountered even when the agent finished in a
          // single pass and left no resume checkpoint behind.
          encounteredJobIds: uniqueStrings([
            ...entry.encounteredJobIds,
            ...landedJobIdsFor(target.id),
            ...collectedStoredIds,
          ]),
          compactionState:
            collected.result.agentMetadata?.compactionState ?? null,
          compactionUsedFallbackTrigger:
            collected.result.agentMetadata?.compactionUsedFallbackTrigger ??
            false,
          accessBlockerReason:
            collected.result.agentMetadata?.accessBlockerReason ?? null,
          parkedTab: collected.result.agentMetadata?.parkedTab ?? null,
        }));
        if (
          collected.result.agentMetadata?.accessBlockerReason &&
          collected.result.agentMetadata.parkedTab
        ) {
          parkedSessionSources.add(collected.adapterKind);
          const parkedTab = collected.result.agentMetadata.parkedTab;
          protectedPages.set(parkedTab.tabId ?? parkedTab.url, parkedTab);
        }

        emitActivity(
          createDiscoveryEvent({
            runId,
            timestamp: new Date().toISOString(),
            kind: collected.result.warning ? "warning" : "progress",
            stage: "extraction",
            waitReason: "extracting_jobs",
            targetId: target.id,
            adapterKind: target.adapterKind,
            resolvedAdapterKind: collected.adapterKind,
            collectionMethod: collected.collectionMethod,
            sourceIntelligenceProvider: collectedProviderKey,
            message: collected.result.warning
              ? `Collected ${collectedJobs.length} candidate jobs from ${target.label}. ${freshnessSummary} Sample: ${formatDiscoveryPostingSamples(collectedJobs) ?? "none"}. ${collected.result.warning}`
              : `Collected ${collectedJobs.length} candidate jobs from ${target.label}. ${freshnessSummary} Sample: ${formatDiscoveryPostingSamples(collectedJobs) ?? "none"}`,
            url: target.startingUrl,
            jobsFound: collectedJobs.length,
            jobsPersisted: activeRun.summary.jobsPersisted,
            jobsStaged: activeRun.summary.jobsStaged,
            duplicatesMerged: activeRun.summary.duplicatesMerged,
            invalidSkipped: activeRun.summary.invalidSkipped,
          }),
        );

        const targetSeenUrls = uniqueStrings(
          collected.result.jobs.map((posting) => posting.canonicalUrl),
        );
        const collectionSupportsInactiveMarking =
          collected.result.warning == null &&
          collected.result.inventoryCompleteness === "complete";

        // Checkpoint processing already handled its postings; the final pass
        // covers only the remainder (plus any posting whose content was
        // materially upgraded after it was first processed) so no job is
        // merged, ledger-recorded, or counted twice.
        const remainingRawPostings = (
          await mapInTurns(collectedJobs, (posting) =>
            isUnprocessedOrMateriallyChangedPosting(posting) ? posting : null,
          )
        ).filter((posting): posting is JobPosting => posting !== null);
        await judgeBeforeKeeping(remainingRawPostings);
        if (jobsPutAwayByScreen.size > 0 || jobsBroughtBackByScreen.size > 0) {
          // A job kept unscreened earlier that the screen now rejects is put
          // away like a hidden job; one it put away under goals that have
          // since changed comes back.
          workingSavedJobs = workingSavedJobs.map((job) => {
            if (job.discoveryFeedback) return job;
            const status =
              jobsPutAwayByScreen.has(job.id) && job.status === "discovered"
                ? "archived"
                : jobsBroughtBackByScreen.has(job.id) &&
                    job.status === "archived"
                  ? "discovered"
                  : null;
            return status ? touchSavedJob({ ...job, status }) : job;
          });
          jobsPutAwayByScreen.clear();
          jobsBroughtBackByScreen.clear();
        }
        // A board of hundreds of new jobs is triaged and merged a slice at a
        // time, with a turn of the event loop between slices: in one go it
        // held the main process for seconds, and the provider downloads
        // running beside it timed out. A result limit chooses among all of
        // a source's jobs at once, so a limited search keeps one slice.
        const finalPassSliceSize =
          runJobBudget == null
            ? FINAL_PASS_POSTINGS_PER_TURN
            : Math.max(1, remainingRawPostings.length);
        const triageOutcome = { skippedByLedger: 0, skippedByTitleTriage: 0 };
        const triagedPostings: JobPosting[] = [];
        const budgetedPostings: JobPosting[] = [];
        const mergeResult = {
          validatedCount: 0,
          duplicatesMerged: 0,
          invalidSkipped: 0,
        };
        let jobsPersisted = 0;
        let jobsStaged = 0;
        for (
          let sliceStart = 0;
          sliceStart === 0 || sliceStart < remainingRawPostings.length;
          sliceStart += finalPassSliceSize
        ) {
          await yieldToEventLoop();
          if (executionSignal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          const sliceTriage = runTriageAndLedgerForPostings(
            remainingRawPostings.slice(
              sliceStart,
              sliceStart + finalPassSliceSize,
            ),
          );
          triageOutcome.skippedByLedger += sliceTriage.skippedByLedger;
          triageOutcome.skippedByTitleTriage +=
            sliceTriage.skippedByTitleTriage;
          triagedPostings.push(...sliceTriage.keptPostings);
          // No low-yield rescue: a job the triage skipped stays skipped.
          // Under Best matches only the person asked for exactly that drop,
          // and in the other two modes the triage skips only blocked
          // companies and excluded places.
          const sliceMerge = mergeAndAccountPostings(
            sliceTriage.keptPostings,
            sliceTriage.keptUpgradePostings,
          );
          budgetedPostings.push(...sliceMerge.budgetedPostings);
          mergeResult.validatedCount += sliceMerge.mergeResult.validatedCount;
          mergeResult.duplicatesMerged +=
            sliceMerge.mergeResult.duplicatesMerged;
          mergeResult.invalidSkipped += sliceMerge.mergeResult.invalidSkipped;
          jobsPersisted += sliceMerge.jobsPersisted;
          jobsStaged += sliceMerge.jobsStaged;
        }
        const fairShareSuffix =
          triagedPostings.length > budgetedPostings.length
            ? ` Limited ${triagedPostings.length} qualifying jobs to the ${budgetedPostings.length} strongest matches for this source.`
            : "";

        emitActivity(
          createDiscoveryEvent({
            runId,
            timestamp: new Date().toISOString(),
            kind: "progress",
            stage: "scoring",
            waitReason: "merging_results",
            targetId: target.id,
            adapterKind: target.adapterKind,
            resolvedAdapterKind: collected.adapterKind,
            collectionMethod: collected.collectionMethod,
            sourceIntelligenceProvider: collectedProviderKey,
            message:
              budgetedPostings.length > 0
                ? `Reviewing ${budgetedPostings.length} promising jobs from ${target.label}. Sample: ${formatDiscoveryPostingSamples(budgetedPostings) ?? "none"}${fairShareSuffix}`
                : `Reviewing 0 promising jobs from ${target.label}. Title triage skipped ${checkpointState.skippedByTitleTriage}. Sample skips: ${formatDiscoverySkipSamples(titleTriageSkipSamples) ?? "none"}`,
            url: target.startingUrl,
            jobsFound: budgetedPostings.length,
            jobsPersisted: activeRun.summary.jobsPersisted,
            jobsStaged: activeRun.summary.jobsStaged,
            duplicatesMerged: activeRun.summary.duplicatesMerged,
            invalidSkipped: activeRun.summary.invalidSkipped,
          }),
        );

        const newlyInactiveCount = runLedger.markInactive({
          targetId: target.id,
          seenCanonicalUrls: targetSeenUrls,
          occurredAt: new Date().toISOString(),
          allowInactiveMarking:
            (options.allowInactiveMarking ?? options.scope === "run_all") &&
            collectionSupportsInactiveMarking,
        });

        emitActivity(
          createDiscoveryEvent({
            runId,
            timestamp: new Date().toISOString(),
            kind: "progress",
            stage: "persistence",
            waitReason: "persisting_results",
            targetId: target.id,
            adapterKind: target.adapterKind,
            resolvedAdapterKind: collected.adapterKind,
            collectionMethod: collected.collectionMethod,
            sourceIntelligenceProvider: collectedProviderKey,
            message: `Saving the kept jobs and updated discovery ledger for ${target.label}`,
            url: target.startingUrl,
            // Review-volume semantic on purpose: see the checkpoint persistence
            // event above. Kept/found claims read the summary/execution
            // fields, which carry distinct retained additions.
            jobsFound: mergeResult.validatedCount,
            jobsPersisted,
            jobsStaged,
            duplicatesMerged: mergeResult.duplicatesMerged,
            invalidSkipped: mergeResult.invalidSkipped,
          }),
        );

        // validJobsFound counts only distinct additions retained by this run
        // (persisted or staged); duplicate merges stay in duplicatesMerged.
        activeRun = updateRunSummary(activeRun, {
          validJobsFound:
            activeRun.summary.validJobsFound + jobsPersisted + jobsStaged,
          jobsPersisted: activeRun.summary.jobsPersisted + jobsPersisted,
          jobsStaged: activeRun.summary.jobsStaged + jobsStaged,
          jobsSkippedByLedger:
            activeRun.summary.jobsSkippedByLedger +
            triageOutcome.skippedByLedger,
          jobsSkippedByTitleTriage:
            activeRun.summary.jobsSkippedByTitleTriage +
            triageOutcome.skippedByTitleTriage,
          duplicatesMerged:
            activeRun.summary.duplicatesMerged + mergeResult.duplicatesMerged,
          invalidSkipped:
            activeRun.summary.invalidSkipped + mergeResult.invalidSkipped,
        });

        const agentDuplicates =
          collected.result.agentMetadata?.duplicateListings ?? 0;
        const unreadable =
          collected.result.agentMetadata?.unreadableListings ?? [];
        const duplicatePageUrls =
          collected.result.agentMetadata?.duplicateListingPageUrls ?? [];
        const countPage = (pageUrl: string | undefined) =>
          sourceCountsFor({ producingPageUrl: pageUrl ?? target.startingUrl });
        for (let i = 0; i < agentDuplicates; i += 1) {
          const counts = countPage(duplicatePageUrls[i]);
          counts.inspected += 1;
          counts.duplicates += 1;
        }
        for (const listing of unreadable) {
          const counts = countPage(listing.url);
          counts.inspected += 1;
          counts.rejected += 1;
        }
        const coveredPages = collected.result.agentMetadata?.coveredPageUrls;
        if (coveredPages)
          for (const pageUrl of coveredPages) {
            const counts = countPage(pageUrl);
            counts.pagesCovered = (counts.pagesCovered ?? 0) + 1;
          }
        else if (collected.result.agentMetadata?.pagesCovered !== undefined)
          countPage(target.startingUrl).pagesCovered =
            collected.result.agentMetadata.pagesCovered;
        const deferredPageUrls =
          collected.result.agentMetadata?.deferredListingPageUrls ?? [];
        for (const pageUrl of deferredPageUrls) {
          const counts = countPage(pageUrl);
          counts.inspected += 1;
          counts.deferred += 1;
        }
        checkpointState.inspectedCount +=
          agentDuplicates + unreadable.length + deferredPageUrls.length;
        checkpointState.deferredCount += deferredPageUrls.length;
        checkpointState.duplicatesMerged += agentDuplicates;
        checkpointState.rejectedListings.push(...unreadable);
        const targetCompletedAt = new Date().toISOString();
        const targetFailed = Boolean(
          collected.result.agentMetadata?.accessBlockerReason ||
          (collected.result.warning && collectedJobs.length === 0),
        );
        // A finished source never resumes, so its checkpoint keeps its record
        // but not the copies of every posting it collected; those are in the
        // saved jobs and the ledger. Kept, they grew the run by a couple of
        // kilobytes per posting seen, rewritten at every later checkpoint.
        const finishedCheckpoint = activeRun.targetExecutions.find(
          (entry) => entry.targetId === target.id,
        )?.agentCheckpoint;
        activeRun = completeTargetExecution(
          activeRun,
          target.id,
          targetCompletedAt,
          {
            ...(collected.result.agentMetadata?.pagesCovered !== undefined
              ? { pagesCovered: collected.result.agentMetadata.pagesCovered }
              : {}),
            state: targetFailed ? "failed" : "completed",
            ...(!targetFailed && finishedCheckpoint
              ? {
                  agentCheckpoint: { ...finishedCheckpoint, collectedJobs: [] },
                }
              : {}),
            encounteredJobIds: uniqueStrings([
              ...(activeRun.targetExecutions.find(
                (entry) => entry.targetId === target.id,
              )?.encounteredJobIds ?? []),
              ...landedJobIdsFor(target.id),
            ]),
            requestedJobBudget:
              runJobBudget == null ? null : discoveryBudget.targetJobCount,
            // Execution truth is cumulative across checkpoint flushes and the
            // final remainder, so a completed source never hides the work its
            // mid-run persistence already committed. Reviewed counts every
            // scored/merged observation; budget slots are tracked separately
            // so upgrades of known identities do not consume them. jobsFound
            // is the distinct retained total (persisted + staged), matching
            // the run summary so user-facing found/kept claims stay truthful.
            uniqueInspectionsKnown:
              unreadable.length === 0 && deferredPageUrls.length === 0,
            sourceCounts: copySourceCounts(),
            inspectedJobIds: [...checkpointState.inspectedJobIds],
            jobsInspected: checkpointState.inspectedCount,
            rejectedListings: [...checkpointState.rejectedListings],
            listingsDeferred: checkpointState.deferredCount,
            jobsReviewed: checkpointState.reviewedCount,
            jobsFound:
              checkpointState.jobsPersisted + checkpointState.jobsStaged,
            jobsPersisted: checkpointState.jobsPersisted,
            jobsStaged: checkpointState.jobsStaged,
            jobsSkippedByLedger: checkpointState.skippedByLedger,
            jobsSkippedByTitleTriage: checkpointState.skippedByTitleTriage,
            duplicatesMerged: checkpointState.duplicatesMerged,
            invalidSkipped: checkpointState.invalidSkipped,
            changeDigest: {
              new: freshnessDigest.counts.new,
              unchanged: freshnessDigest.counts.unchanged,
              changed: freshnessDigest.counts.changed,
              reactivated: freshnessDigest.counts.reactivated,
              inactive: newlyInactiveCount,
              known:
                freshnessDigest.counts.unchanged +
                freshnessDigest.counts.changed +
                freshnessDigest.counts.reactivated,
              skipped:
                checkpointState.skippedByLedger +
                checkpointState.skippedByTitleTriage +
                checkpointState.invalidSkipped,
            },
            warning: collected.result.warning,
          },
        );
        const targetCompletedEvent = createDiscoveryEvent({
          runId,
          timestamp: targetCompletedAt,
          kind: targetFailed ? "error" : "success",
          stage: "target",
          waitReason: "persisting_results",
          targetId: target.id,
          adapterKind: target.adapterKind,
          resolvedAdapterKind: collected.adapterKind,
          collectionMethod: collected.collectionMethod,
          sourceIntelligenceProvider: collectedProviderKey,
          terminalState: targetFailed ? "failed" : "completed",
          message: targetFailed
            ? `Could not finish ${target.label}: ${collected.result.warning}`
            : collected.result.agentMetadata?.phaseCompletionReason
              ? `${target.label}: ${collected.result.agentMetadata.phaseCompletionReason}`
              : `Finished ${target.label} (${index + 1}/${targets.length})`,
          url: target.startingUrl,
          // Review-volume semantic on purpose (valid cards merged, duplicates
          // included): the renderer count label derives "unique retained" as
          // jobsFound minus duplicatesMerged from merged-result events. The
          // execution and summary fields above carry distinct retained.
          jobsFound: checkpointState.validatedCount,
          jobsPersisted: checkpointState.jobsPersisted,
          jobsStaged: checkpointState.jobsStaged,
          duplicatesMerged: checkpointState.duplicatesMerged,
          invalidSkipped: checkpointState.invalidSkipped,
        });
        // Record the event before saving so run history stays complete, but do
        // not publish "Finished" until the jobs and ledger are durable. The
        // desktop uses this terminal event as its progressive-refresh signal.
        recordActivity(targetCompletedEvent);

        for (const jobId of resumeAffectingChangedJobIds)
          resumeStaleJobIds.add(jobId);
        await flushResumeStaleness(false);
        await persistWorkingSavedJobs(captureWorkingDiscoveryUpdate());
        const completedExecution = activeRun.targetExecutions.find(
          (execution) => execution.targetId === target.id,
        );
        if (completedExecution) {
          const replacedTabs = await persistDiscoveryRunBlockerUserAction({
            repository: ctx.repository,
            runId,
            target,
            execution: completedExecution,
            occurredAt: targetCompletedAt,
          });
          const doneTabs = await resolveSourceAccessRequestsAfterCompletedRun({
            repository: ctx.repository,
            runId,
            target,
            execution: completedExecution,
            occurredAt: targetCompletedAt,
          });
          for (const tab of [...replacedTabs, ...doneTabs]) {
            await ctx
              .closeParkedBrowserTab(resolveAdapterKind(target), tab)
              .catch(() => undefined);
          }
        }
        publishActivity(targetCompletedEvent);
        queueKeptJobsForFit();
        listingReadAhead.enqueue(runRetainedJobIds);

        // Persistence and matching above can resolve entirely through
        // microtasks for fast API sources. Give Electron a real event-loop turn
        // so window messages and IPC remain responsive during large catalogs.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      };
      // Two lanes run side by side: API feeds, merged a few at a time as they
      // arrive, and browser sources, a few at a time in their own tabs. One
      // queue for both let three slow browser sources hold every API source
      // back for minutes while its feed request timed out.
      const apiWorkers = Array.from(
        {
          length: Math.min(
            PUBLIC_API_PROCESSING_CONCURRENCY,
            apiTargets.length,
          ),
        },
        async () => {
          for (;;) {
            const next = await readyApiTargets.next();
            if (next.done) return;
            await runOneTarget(next.value);
          }
        },
      );
      let nextBrowserTargetIndex = 0;
      const browserWorkers = Array.from(
        {
          length: Math.min(DISCOVERY_SOURCE_CONCURRENCY, browserTargets.length),
        },
        async () => {
          for (;;) {
            const target = browserTargets[nextBrowserTargetIndex];
            if (!target) return;
            nextBrowserTargetIndex += 1;
            await runOneTarget({ target, prefetchedPublicApiResult: null });
          }
        },
      );
      await Promise.all([...apiWorkers, ...browserWorkers]);
      // Stop may arrive while the last source's atomic write is settling.
      // Keep that durable checkpoint, but do not report a completed search
      // merely because no later listing read or fit call checks the signal.
      executionSignal.throwIfAborted();
      // The last sources' jobs are judged before their listings are read,
      // so the reads go to the best fits first.
      queueKeptJobsForFit();
      await finishSearchFitJudging();
      listingReadAhead.close();
      await listingReadAheadPass;
      executionSignal.throwIfAborted();

      // A browser handoff also ends this run's later HTTP reads on that host.
      const blockedSourceHosts = new Set(
        activeRun.targetExecutions
          .filter(
            (execution) => execution.accessBlockerReason === "site_protection",
          )
          .flatMap((execution) => [
            execution.parkedTab?.url,
            targets.find((target) => target.id === execution.targetId)
              ?.startingUrl,
          ])
          .flatMap((url) => {
            try {
              return url ? [new URL(url).host] : [];
            } catch {
              return [];
            }
          }),
      );
      const canReadListingUrl = (url: string) => {
        try {
          return !blockedSourceHosts.has(new URL(url).host);
        } catch {
          return false;
        }
      };

      // Read every uncaptured listing, with person-supplied and selected jobs
      // first, then new results, then the older queue. Discovery-only jobs
      // live in the pending collection and must be included here too.
      // Every retained card gets one plain-HTTP read of its own page, then a
      // fresh score from the same assessment session, before the run is
      // declared finished: "Search finished" should mean the results are
      // scored, not that a list of titles arrived. Bounded (per-job time,
      // concurrency) and never fatal: a page that will not read stays a
      // title match with the attempt recorded on the job.
      // The older queue rides along in proportion to the search: a search of
      // one source reads a few older listings, a search of every source the
      // full allowance. A one-source search used to read up to 60 older
      // listings and judge up to 100 older jobs, as costly as a full search.
      // Shortlisted and other picked jobs go first in that queue but share
      // its allowance; only jobs the person brought in themselves are read
      // and judged whatever the size of the search. Exempting every picked
      // job made a one-source search re-read dozens of listings and re-judge
      // two hundred shortlisted jobs, about a million tokens.
      let olderListingReadsLeft = Math.min(
        LISTING_DETAIL_READS_PER_RUN,
        OLDER_LISTING_READS_PER_SOURCE * runSourceCount,
      );
      let unreadListingReadsLeft = Math.max(
        0,
        LISTING_DETAIL_READS_PER_RUN - listingReadAhead.readsStarted,
      );
      const enrichmentCandidates = mergeSavedJobs(
        workingSavedJobs,
        workingPendingJobs,
      )
        .filter(
          (job) =>
            belongsToSearchPlan(job) &&
            jobNeedsListingDetail(job) &&
            canReadListingUrl(job.canonicalUrl),
        )
        .sort(
          (left, right) =>
            Number(personPickedJob(right)) - Number(personPickedJob(left)) ||
            Number(runRetainedJobIds.has(right.id)) -
              Number(runRetainedJobIds.has(left.id)) ||
            compareMatchRecommendationPriority(
              left.matchAssessment,
              right.matchAssessment,
            ) ||
            compareMatchRoleSuitabilityPriority(
              left.matchAssessment,
              right.matchAssessment,
            ) ||
            compareMatchScores(left.matchAssessment, right.matchAssessment),
        )
        .filter(
          (job) =>
            personSuppliedJob(job) ||
            runRetainedJobIds.has(job.id) ||
            olderListingReadsLeft-- > 0,
        )
        .filter(
          (job) => listingReadAhead.read(job) || unreadListingReadsLeft-- > 0,
        );
      const readEvent = (
        message: string,
        progress?: DiscoveryActivityEvent["progress"],
      ) =>
        createDiscoveryEvent({
          runId,
          timestamp: new Date().toISOString(),
          kind: "info",
          stage: "extraction",
          waitReason: "extracting_jobs",
          targetId: null,
          adapterKind: null,
          resolvedAdapterKind: null,
          message,
          ...(progress ? { progress } : {}),
          url: null,
          jobsFound:
            activeRun.summary.jobsPersisted + activeRun.summary.jobsStaged,
          jobsPersisted: activeRun.summary.jobsPersisted,
          jobsStaged: activeRun.summary.jobsStaged,
          duplicatesMerged: activeRun.summary.duplicatesMerged,
          invalidSkipped: activeRun.summary.invalidSkipped,
        });
      // No reader configured means no reads: the desktop composes the
      // plain-HTTP reader in; tests and other hosts opt in explicitly so a
      // fixture URL is never fetched for real.
      let listingReadsReserved = listingReadAhead.readsStarted;
      if (
        ctx.fetchListingHtml &&
        enrichmentCandidates.length > 0 &&
        !executionSignal.aborted
      ) {
        const fetchListingHtml = ctx.fetchListingHtml;
        // Supplied and selected jobs are first in the candidates, so they are
        // read within the per-run budget; the rest wait for the next search.
        const readsThisRun = Math.min(
          enrichmentCandidates.length,
          LISTING_DETAIL_READS_PER_RUN,
        );
        listingReadsReserved += enrichmentCandidates.filter(
          (job) => !listingReadAhead.read(job),
        ).length;
        const readingProgress = (completed: number, total: number) =>
          emitActivity(
            readEvent(`Reading listings ${completed} of ${total}.`, {
              phase: "reading_listings",
              completed,
              total,
            }),
          );
        readingProgress(0, readsThisRun);
        try {
          const enrichment = await enrichSavedJobListingDetails({
            jobs: enrichmentCandidates,
            readAhead: (job) => listingReadAhead.read(job),
            rateLimitState: listingRateLimitState,
            maxJobs: readsThisRun,
            onProgress: readingProgress,
            fetchHtml: fetchListingHtml,
            readPage: createModelListingPageReader(ctx.aiClient),
            ...(ctx.browserRuntime.readRenderedPage
              ? {
                  readRenderedPage: ctx.browserRuntime.readRenderedPage.bind(
                    ctx.browserRuntime,
                  ),
                }
              : {}),
            // Re-scoring keeps a job's model verdict; the judging stage below
            // asks the model about jobs whose listing changed.
            assess: assessDiscoveryPosting,
            signal: executionSignal,
          });
          if (enrichment.changedJobIds.length > 0) {
            const enrichedById = new Map(
              enrichment.jobs.map((job) => [job.id, job]),
            );
            workingSavedJobs = workingSavedJobs.map((job) => {
              const next = enrichedById.get(job.id);
              return next && next !== job ? touchSavedJob(next) : job;
            });
            workingPendingJobs = workingPendingJobs.map(
              (job) => enrichedById.get(job.id) ?? job,
            );
            const pendingJobIds = new Set(
              workingPendingJobs.map((job) => job.id),
            );
            for (const jobId of enrichment.changedJobIds) {
              if (pendingJobIds.has(jobId)) {
                touchedPendingJobIds.add(jobId);
              } else {
                touchedSavedJobIds.add(jobId);
              }
            }
            // The scan-time "only cards were read" warning stops being true
            // for a target once any of its retained jobs has a body.
            const targetsWithBodies = new Set(
              mergeSavedJobs(workingSavedJobs, workingPendingJobs)
                .filter(
                  (job) =>
                    runRetainedJobIds.has(job.id) &&
                    job.detailQuality !== "card_only",
                )
                .flatMap((job) =>
                  job.provenance.map((entry) => entry.targetId),
                ),
            );
            activeRun = {
              ...activeRun,
              targetExecutions: activeRun.targetExecutions.map((execution) =>
                targetsWithBodies.has(execution.targetId)
                  ? {
                      ...execution,
                      warning: stripDiscoveryCardOnlyEvidenceWarning(
                        execution.warning,
                      ),
                    }
                  : execution,
              ),
            };
            if (targetsWithBodies.size > 0) {
              activeRun = updateRunSummary(activeRun, {
                warnings: activeRun.summary.warnings
                  .map((warning) =>
                    stripDiscoveryCardOnlyEvidenceWarning(warning),
                  )
                  .filter((warning): warning is string => Boolean(warning)),
              });
            }
            await persistWorkingSavedJobs();
          }
          emitActivity(
            readEvent(describeListingDetailEnrichment(enrichment.summary)),
          );
        } catch (error) {
          if (executionSignal.aborted) {
            throw error;
          }
          emitActivity(
            readEvent(
              `Listing details could not be read this time: ${describeUnknownThrowable(error)}`,
            ),
          );
        }
      }

      // A job this run saw on more than one source shows the listing whose
      // application is the employer's own form, else the first one found
      // (ADR 0030). Merges already keep the first one; here the other
      // listings are read once for their apply link, and the choice is
      // settled on what the pages actually say.
      if (!executionSignal.aborted) {
        const multiSourceJobs = mergeSavedJobs(
          workingSavedJobs,
          workingPendingJobs,
        ).filter(
          (job) =>
            runRetainedJobIds.has(job.id) &&
            canSwitchCanonicalSighting(job) &&
            job.provenance.filter((entry) => entry.listingUrl).length > 1,
        );
        let routedJobs = multiSourceJobs;
        if (ctx.fetchListingHtml && multiSourceJobs.length > 0) {
          try {
            const routeRead = await readSightingApplyRoutes({
              jobs: multiSourceJobs,
              maxReads: Math.max(
                0,
                LISTING_DETAIL_READS_PER_RUN - listingReadsReserved,
              ),
              fetchHtml: ctx.fetchListingHtml,
              canReadUrl: canReadListingUrl,
              readPage: createModelListingPageReader(ctx.aiClient),
              signal: executionSignal,
            });
            routedJobs = routeRead.jobs;
          } catch (error) {
            if (executionSignal.aborted) throw error;
          }
        }
        const originalById = new Map(
          multiSourceJobs.map((job) => [job.id, job]),
        );
        const reroutedById = new Map<string, SavedJob>();
        let switchedCount = 0;
        for (const job of routedJobs) {
          const winner = selectCanonicalSighting(job.provenance);
          let next = job;
          if (winner?.listingUrl && winner.listingUrl !== job.canonicalUrl) {
            const routed = applySightingRoute(job, winner);
            next = {
              ...routed,
              matchAssessment: assessDiscoveryPosting(routed),
            };
            if (routed.canonicalUrl !== job.canonicalUrl) switchedCount += 1;
          }
          if (next !== originalById.get(job.id)) {
            reroutedById.set(job.id, next);
          }
        }
        if (reroutedById.size > 0) {
          workingSavedJobs = workingSavedJobs.map((job) => {
            const next = reroutedById.get(job.id);
            return next ? touchSavedJob(next) : job;
          });
          workingPendingJobs = workingPendingJobs.map(
            (job) => reroutedById.get(job.id) ?? job,
          );
          const pendingJobIds = new Set(
            workingPendingJobs.map((job) => job.id),
          );
          for (const jobId of reroutedById.keys()) {
            if (pendingJobIds.has(jobId)) {
              touchedPendingJobIds.add(jobId);
            } else {
              touchedSavedJobIds.add(jobId);
            }
          }
          await persistWorkingSavedJobs();
        }
        if (switchedCount > 0) {
          emitActivity(
            readEvent(
              `Using the employer's own application page for ${switchedCount} ${
                switchedCount === 1 ? "job" : "jobs"
              } found on more than one source.`,
            ),
          );
        }
      }

      // The model judges how the jobs fit the person (ADR 0041): many jobs
      // per call, only those never judged or judged before the profile, the
      // goals or the listing changed. Most of this run's jobs were judged
      // while it searched; what is left here is a listing read in full since,
      // a verdict that did not come, the jobs the person brought in, and
      // older jobs of the plan (picked ones first), those last ones capped
      // per search. A job it does not answer for stays unjudged until the
      // next search.
      if (!executionSignal.aborted && ctx.aiClient.judgeJobFits) {
        let olderJobsLeft = Math.min(
          OLDER_JOB_FIT_JUDGMENTS_PER_RUN,
          OLDER_JOB_FIT_JUDGMENTS_PER_SOURCE * runSourceCount,
        );
        const toJudge = mergeSavedJobs(workingSavedJobs, workingPendingJobs)
          .filter(belongsToSearchPlan)
          .map((job) => readPlanAssessment(storedJob(job), assessmentPlanId))
          .filter(
            (job) =>
              jobNeedsFitJudgment(
                job,
                assessmentSession.verdictFingerprint,
                assessmentSession.contextFingerprint,
                { refreshRubric: true },
              ) &&
              fitAskedFingerprints.get(job.id) !== fitPostingFingerprint(job),
          )
          // The capped older jobs are the likeliest fits, not whichever
          // came first.
          .sort(
            (left, right) =>
              Number(personPickedJob(right)) - Number(personPickedJob(left)) ||
              Number(runRetainedJobIds.has(right.id)) -
                Number(runRetainedJobIds.has(left.id)) ||
              compareFitJudgingPromise(left, right),
          )
          .filter(
            (job) =>
              personSuppliedJob(job) ||
              runRetainedJobIds.has(job.id) ||
              olderJobsLeft-- > 0,
          );
        for (const job of toJudge) {
          fitAskedFingerprints.set(job.id, fitPostingFingerprint(job));
        }
        if (toJudge.length > 0) {
          let fitCompleted = 0;
          const fitProgress = (completed: number) =>
            emitActivity(
              readEvent(`Judging fit ${completed} of ${toJudge.length}.`, {
                phase: "judging_fit",
                completed,
                total: toJudge.length,
              }),
            );
          fitProgress(0);
          try {
            // A new rubric needs a fresh verdict, not another extraction of
            // unchanged requirement evidence. Changed facts still take the
            // full comparison below.
            const rubricRefreshIds = new Set(
              toJudge
                .filter(
                  (job) =>
                    job.matchAssessment.judgment?.source === "full" &&
                    !jobNeedsFitJudgment(
                      job,
                      assessmentSession.verdictFingerprint,
                      assessmentSession.contextFingerprint,
                    ),
                )
                .map((job) => job.id),
            );
            const judgments = await judgeJobFitsInBatches({
              aiClient: ctx.aiClient,
              profile,
              searchPreferences: enrichedPreferences,
              jobs: toJudge.filter(
                (job) =>
                  job.matchAssessment.judgment?.source !== "full" ||
                  rubricRefreshIds.has(job.id),
              ),
              contextFingerprint: assessmentSession.verdictFingerprint,
              signal: executionSignal,
              onProgress: (completed) => {
                fitCompleted = completed;
                fitProgress(fitCompleted);
              },
            });
            // Changed goals or profile require another full comparison for
            // a job previously read in full. A batch verdict cannot replace
            // that read or erase its requirement evidence.
            const fullAssessments = new Map<string, MatchAssessment>();
            for (const job of toJudge) {
              if (!rubricRefreshIds.has(job.id)) continue;
              const judgment = judgments.get(job.id);
              if (!judgment) continue;
              fullAssessments.set(
                job.id,
                assessmentSession.remember(
                  job,
                  applyFitJudgment(job.matchAssessment, {
                    ...judgment,
                    source: "full",
                  }),
                ),
              );
              judgments.delete(job.id);
            }
            const fullJobs = toJudge.filter(
              (job) =>
                job.matchAssessment.judgment?.source === "full" &&
                !rubricRefreshIds.has(job.id),
            );
            let fullCursor = 0;
            await Promise.all(
              Array.from({ length: Math.min(5, fullJobs.length) }, async () => {
                while (fullCursor < fullJobs.length) {
                  executionSignal.throwIfAborted();
                  const job = fullJobs[fullCursor++];
                  if (!job) return;
                  try {
                    const assessed = await createMatchAssessmentAsync(
                      ctx.aiClient,
                      profile,
                      enrichedPreferences,
                      job,
                      executionSignal,
                      { background: true },
                    );
                    fullAssessments.set(
                      job.id,
                      assessmentSession.remember(job, assessed),
                    );
                  } catch (error) {
                    if (executionSignal.aborted) throw error;
                    // Keep the last completed full assessment until a later pass.
                  } finally {
                    fitCompleted += 1;
                    fitProgress(fitCompleted);
                  }
                }
              }),
            );
            if (judgments.size > 0 || fullAssessments.size > 0) {
              applyRunVerdicts(judgments, fullAssessments);
              await persistWorkingSavedJobs();
            }
            emitActivity(
              readEvent(
                judgments.size + fullAssessments.size === toJudge.length
                  ? `Judged ${judgments.size + fullAssessments.size} jobs against your profile and goals`
                  : `Judged ${judgments.size + fullAssessments.size} of ${toJudge.length} jobs; the rest keep their previous assessment and are judged on the next search`,
              ),
            );
          } catch (error) {
            if (executionSignal.aborted) {
              throw error;
            }
            emitActivity(
              readEvent(
                `Jobs could not be judged this time: ${describeUnknownThrowable(error)}`,
              ),
            );
          }
        }
      }

      // A run does not get to finish quietly over jobs it never opened. Every
      // job this run kept now has one capture state — read, refused, or still
      // to read — and the run says out loud how many are in each, so the
      // result screen and the scoring panel are reading a number the run
      // recorded rather than each inferring one.
      let correctedSalaryCount = 0;
      const reconcileCapturedSalary = (
        job: SavedJob,
        touchedJobIds: Set<string>,
      ): SavedJob => {
        if (!runRetainedJobIds.has(job.id)) return job;
        const salaryText = reconcileSalaryTextWithPreparedBody(
          job.salaryText,
          prepareBodySalaryRange(job),
          () => job.description,
        );
        if (salaryText === job.salaryText) return job;
        correctedSalaryCount += 1;
        touchedJobIds.add(job.id);
        const correctedJob: SavedJob = {
          ...job,
          salaryText,
          normalizedCompensation: parseNormalizedCompensation(null),
        };
        return {
          ...correctedJob,
          matchAssessment: assessDiscoveryPosting(correctedJob),
        };
      };
      // Each job's whole listing is searched for its pay; with thousands of
      // jobs that held main for a second, so it goes a slice per turn.
      workingSavedJobs = await mapInTurns(
        workingSavedJobs,
        (job) => {
          const next = reconcileCapturedSalary(job, touchedSavedJobIds);
          return next !== job ? touchSavedJob(next) : job;
        },
        SETUP_JOBS_PER_TURN,
      );
      workingPendingJobs = await mapInTurns(
        workingPendingJobs,
        (job) => reconcileCapturedSalary(job, touchedPendingJobIds),
        SETUP_JOBS_PER_TURN,
      );
      if (correctedSalaryCount > 0) {
        await persistWorkingSavedJobs();
      }

      const retainedRunJobs = mergeSavedJobs(
        workingSavedJobs,
        workingPendingJobs,
      ).filter((job) => runRetainedJobIds.has(job.id));
      if (retainedRunJobs.length > 0) {
        emitActivity(
          readEvent(
            describeDiscoveryListingCapture(
              countDiscoveryListingCapture(retainedRunJobs),
            ),
          ),
        );

        // One house pay band printed in a page's chrome was picked up as the
        // salary of every result on that page, so unrelated jobs carried the
        // same "$80000 - 150000" — one of them over its own body reading
        // "Pay: $22.00 per hour". A band most of this run shares and almost
        // none of the listing bodies state is the page's furniture; it is
        // dropped so the row says the pay was not stated rather than stating
        // someone else's.
        const furnitureSalaries = findSiteFurnitureSalaryTexts(
          retainedRunJobs.map((job) => ({
            description: job.description,
            salaryText: job.salaryText,
          })),
        );
        if (furnitureSalaries.size > 0) {
          let droppedSalaryCount = 0;
          const sanitizeFurnitureSalary = (
            job: SavedJob,
            touchedJobIds: Set<string>,
          ): SavedJob => {
            if (
              !runRetainedJobIds.has(job.id) ||
              !isSiteFurnitureSalaryText(job.salaryText, furnitureSalaries) ||
              isSalaryTextStatedInBody(job.description, job.salaryText)
            ) {
              return job;
            }
            droppedSalaryCount += 1;
            touchedJobIds.add(job.id);
            const sanitizedJob: SavedJob = {
              ...job,
              salaryText: null,
              normalizedCompensation: parseNormalizedCompensation(null),
            };
            return {
              ...sanitizedJob,
              matchAssessment: assessDiscoveryPosting(sanitizedJob),
            };
          };
          workingSavedJobs = workingSavedJobs.map((job) => {
            const next = sanitizeFurnitureSalary(job, touchedSavedJobIds);
            return next !== job ? touchSavedJob(next) : job;
          });
          workingPendingJobs = workingPendingJobs.map((job) =>
            sanitizeFurnitureSalary(job, touchedPendingJobIds),
          );
          if (droppedSalaryCount > 0) {
            await persistWorkingSavedJobs();
            emitActivity(
              readEvent(
                `The same pay band appeared on ${droppedSalaryCount} of this source's results whose listings did not state it, so it was treated as part of the page rather than as their pay.`,
              ),
            );
          }
        }
      }

      const completedTargets = activeRun.targetExecutions.filter(
        (target) => target.state === "completed",
      ).length;
      const failedTargets = activeRun.targetExecutions.filter(
        (target) => target.state === "failed",
      );
      if (completedTargets === 0 && failedTargets.length > 0) {
        terminalStatus = "failed";
        caughtError = new Error(
          failedTargets[0]?.warning ??
            "Discovery could not complete any configured source. Retry the failed source from Search history.",
        );
      }
    } catch (error) {
      const interrupted =
        error instanceof DOMException && error.name === "AbortError";
      terminalStatus = interrupted ? "cancelled" : "failed";
      caughtError = error;
      activeRun = finalizeRunningTargetExecutions(
        activeRun,
        terminalStatus,
        new Date().toISOString(),
      );
    } finally {
      // Verdicts still on their way when a run stops are not saved after it.
      stopSearchFitJudging();
      listingAbortController.abort();
      listingReadAhead.stop();
      await listingReadAheadPass;
      screenBatcher?.stop();
      if (!keepSessionAlive) {
        for (const source of openedSessionSources) {
          // `closeRunBrowserSession` closes the shared browser host, not just
          // this run's page. Any unresolved parked handoff loaded before this
          // run therefore protects the host just as much as a blocker created
          // by this run.
          if (parkedSessionSources.has(source) || protectedPages.size > 0) {
            continue;
          }
          await ctx.closeRunBrowserSession(source).catch(() => {});
        }
      }

      if (openedSessionSources.size > 0) {
        const representativeSource =
          [...openedSessionSources].pop() ?? "target_site";
        const browserCloseoutOccurredAt = new Date().toISOString();
        const session = await ctx.browserRuntime
          .getSessionState(representativeSource)
          .catch(() => null);
        if (session) {
          activeRun = updateRunSummary(activeRun, {
            browserCloseout: {
              ...describeCloseoutMode(
                keepSessionAlive ||
                  parkedSessionSources.has(representativeSource) ||
                  protectedPages.size > 0,
              ),
              status: session.status,
              driver: session.driver,
              occurredAt: browserCloseoutOccurredAt,
            },
          });
        }
      }

      clearActiveController();
    }

    const retainedJobsForRun = mergeSavedJobs(
      workingSavedJobs,
      workingPendingJobs,
    ).filter((job) => runRetainedJobIds.has(job.id));
    const remoteOnlySourceWarning = describeRemoteOnlySourceMismatch(
      retainedJobsForRun,
      enrichedPreferences,
    );
    if (remoteOnlySourceWarning) {
      activeRun = updateRunSummary(activeRun, {
        warnings: uniqueStrings([
          ...activeRun.summary.warnings,
          remoteOnlySourceWarning,
        ]),
      });
    }

    activeRun = finalizeDiscoveryRun(
      activeRun,
      terminalStatus,
      new Date().toISOString(),
    );

    await flushResumeStaleness(true).catch(() => undefined);
    await persistWorkingSavedJobs(captureWorkingDiscoveryUpdate());

    if (terminalStatus === "failed") {
      throw caughtError instanceof Error
        ? caughtError
        : new Error(
            `Discovery pipeline failed with a non-Error throwable: ${describeUnknownThrowable(caughtError)}`,
          );
    }

    // Discovery can run inside source-access recovery. Starting recovery
    // again here would find the same verifying request and await its own
    // in-flight promise forever. The outer user action performs the recovered
    // snapshot after this exact continuation completes.
    return (ctx.readWorkspaceProjection ?? ctx.readWorkspaceSnapshot)();
  }

  return {
    async runDiscovery(targetId) {
      if (targetId) {
        return trackDiscoveryPromise(
          executeDiscoveryPipeline({
            scope: "single_target",
            targetId,
            allowInactiveMarking: false,
            useAgentRuntime: false,
          }),
        );
      }

      return trackDiscoveryPromise(
        executeDiscoveryPipeline({
          scope: "run_all",
          allowInactiveMarking: true,
          useAgentRuntime: false,
        }),
      );
    },
    async runAgentDiscovery(onActivity, signal, targetId, searchRequest) {
      if (targetId) {
        return trackDiscoveryPromise(
          executeDiscoveryPipeline({
            scope: "single_target",
            targetId,
            ...(onActivity ? { onActivity } : {}),
            ...(signal ? { signal } : {}),
            ...(searchRequest ? { searchRequest } : {}),
            allowInactiveMarking: false,
            useAgentRuntime: true,
          }),
        );
      }

      return trackDiscoveryPromise(
        executeDiscoveryPipeline({
          scope: "run_all",
          ...(onActivity ? { onActivity } : {}),
          ...(signal ? { signal } : {}),
          ...(searchRequest ? { searchRequest } : {}),
          allowInactiveMarking: true,
          useAgentRuntime: true,
        }),
      );
    },
    async runDiscoveryForTarget(targetId, onActivity, signal) {
      return trackDiscoveryPromise(
        executeDiscoveryPipeline({
          scope: "single_target",
          targetId,
          ...(onActivity ? { onActivity } : {}),
          ...(signal ? { signal } : {}),
          allowInactiveMarking: false,
          useAgentRuntime: true,
        }),
      );
    },
    async runCampaignDiscovery(campaign, onActivity) {
      // Campaign runs are discovery-only and always cover every enabled target
      // of the supplied campaign using that campaign's own preferences. The
      // run record is tagged with the campaign id while the active campaign and
      // the global search preferences are left untouched.
      //
      // Browser-backed targets run on the bounded agent runtime (the direct
      // discovery path is a zero-yield production stub); public API sources
      // stay progressive through the shared readiness iterator regardless.
      return trackDiscoveryPromise(
        executeDiscoveryPipeline({
          scope: "run_all",
          campaign,
          ...(onActivity ? { onActivity } : {}),
          allowInactiveMarking: true,
          useAgentRuntime: true,
        }),
      );
    },
    async runCampaignDiscoveryForTarget(campaign, targetId) {
      return trackDiscoveryPromise(
        executeDiscoveryPipeline({
          scope: "single_target",
          targetId,
          campaign,
          allowInactiveMarking: false,
          useAgentRuntime: true,
        }),
      );
    },
  };
}
