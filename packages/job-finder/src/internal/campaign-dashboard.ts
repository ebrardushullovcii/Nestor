import type { JobSearchCampaignMode } from "@nestor/contracts";
import {
  getDefaultCampaignConfiguration,
  JobFinderDashboardSummarySchema,
  JobSearchCampaignCollectionSchema,
  JobSearchCampaignSchema,
  type ApplicationRecord,
  type ApplyJobResult,
  type ApplyRun,
  type GroupedManualAnswerDecision,
  type JobFinderDashboardSummary,
  type JobFinderDiscoveryState,
  type JobFinderIntelligenceSafeguards,
  type JobSearchCampaign,
  type JobSearchCampaignCollection,
  type JobSearchPreferences,
  type ReviewQueueItem,
  type SavedJob,
  type UserActionRequest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { projectPlanSafeguardPauses } from "../plan-safeguard-pauses";
import {
  getApplicationCrmData,
  isApplicationAwaitingUserApproval,
  projectApplicationCrmDashboard,
} from "./application-crm";

const FINAL_ACTION_STATES = new Set([
  "resolved",
  "skipped",
  "cancelled",
  "expired",
  "superseded",
]);

/**
 * The one package-side owner of the "Needs you" population, matching the
 * renderer's `lib/needs-you-count.ts` semantics exactly: unresolved requests,
 * minus the ones a pending grouped decision already represents, plus one entry
 * per pending grouped decision. Home's "N items cannot continue without you"
 * and the shell badge now describe the same set.
 */
export function countNeedsYouItems(
  requests: readonly UserActionRequest[],
  groupedDecisions?: readonly GroupedManualAnswerDecision[],
): number {
  const unresolved = requests.filter(
    (request) => !FINAL_ACTION_STATES.has(request.state),
  );
  const pendingDecisions = (groupedDecisions ?? []).filter(
    (decision) => decision.approval === "pending",
  );
  const representedRequestIds = new Set(
    pendingDecisions.flatMap((decision) =>
      decision.lineage.map((entry) => entry.requestId),
    ),
  );

  return (
    unresolved.filter((request) => !representedRequestIds.has(request.id))
      .length + pendingDecisions.length
  );
}

/**
 * Apply-run states that still own live queue work: actively running, staged
 * for submit approval, or paused at a resumable user-attention checkpoint.
 * Terminal runs (completed, cancelled, failed) keep their last-known
 * `pendingJobs` counters forever, so counting them would inflate the campaign
 * queue with stale historical work; only these states contribute.
 */
const ACTIVE_APPLY_RUN_QUEUE_STATES = new Set([
  "awaiting_submit_approval",
  "running",
  "paused_for_user_review",
  "paused_for_consent",
]);

/**
 * Apply-job result states that describe work still being processed by its
 * run. They only represent queue while the parent run can still advance them.
 */
const TRANSIENT_APPLY_JOB_RESULT_STATES = new Set([
  "planned",
  "question_capture",
  "filling",
  "submitting",
]);
function startOfLocalDay(value: Date): number {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  ).getTime();
}

// A stored job is frozen and reused between refreshes, so when it was last
// found is worked out once. Every refresh parsed each sighting's date of
// every job (20,000 jobs, about 25 ms) to count today's finds.
const latestSightingByJob = new WeakMap<object, number>();
function latestSightingTime(job: Pick<SavedJob, "provenance">): number {
  let latest = latestSightingByJob.get(job);
  if (latest === undefined) {
    latest = Number.NEGATIVE_INFINITY;
    for (const entry of job.provenance) {
      const time = Date.parse(entry.discoveredAt);
      if (time > latest) latest = time;
    }
    if (Object.isFrozen(job)) latestSightingByJob.set(job, latest);
  }
  return latest;
}

function createDefaultCampaign(
  searchPreferences: JobSearchPreferences,
  now: string,
  jobIds: readonly string[],
): JobSearchCampaign {
  const id = "campaign_default";
  return JobSearchCampaignSchema.parse({
    id,
    name: "My job search",
    sourceSelectionMode: "profile",
    description:
      "Your main search. Follows the job sites switched on in Profile.",
    mode: "precision",
    status: "active",
    createdAt: now,
    updatedAt: now,
    searchPreferences,
    sourceTargetIds: [],
    jobIds,
    minimumFitScore: null,
    ...getDefaultCampaignConfiguration("precision"),
    progress: { lastUpdatedAt: now },
    history: [
      {
        id: "campaign_history_default_created",
        campaignId: id,
        kind: "created",
        occurredAt: now,
        summary: "Existing workspace moved into the default search plan.",
        discoveryRunId: null,
      },
    ],
  });
}

export async function ensureCampaignState(input: {
  repository: JobFinderRepository;
  searchPreferences: JobSearchPreferences;
  now?: string;
  borrowValidated?: boolean;
}): Promise<JobSearchCampaignCollection> {
  const existing = await (input.borrowValidated &&
  input.repository.readCampaignProjection
    ? input.repository.readCampaignProjection()
    : input.repository.getCampaignState());
  if (existing) return existing;
  const campaign = createDefaultCampaign(
    input.searchPreferences,
    input.now ?? new Date().toISOString(),
    await input.repository.listSavedJobIds(),
  );
  return JobSearchCampaignCollectionSchema.parse({
    activeCampaignId: campaign.id,
    campaigns: [campaign],
  });
}

/**
 * The search preferences a plan runs with: its own source selection decides
 * which sources are searched, not each source's Profile "Include in search"
 * switch. A scheduled run used to search sources the plan had left out. A
 * plan that has never chosen sources follows Profile, as its editor says.
 */
function deriveRemainingApplyQueueSize(input: {
  applyRuns: readonly ApplyRun[];
  applyJobResults: readonly ApplyJobResult[];
}): number {
  const activeRunIds = new Set(
    input.applyRuns
      .filter((run) => ACTIVE_APPLY_RUN_QUEUE_STATES.has(run.state))
      .map((run) => run.id),
  );
  const seenLineages = new Set<string>();
  let outstanding = 0;
  for (const result of input.applyJobResults) {
    // One outstanding item per run/job lineage, even if duplicate rows ever
    // share one; mirrors the capacity projection's lineage key.
    const lineage = `${result.runId}\0${result.jobId}`;
    if (seenLineages.has(lineage)) continue;
    seenLineages.add(lineage);
    if (result.state === "awaiting_review") {
      outstanding += 1;
    } else if (
      TRANSIENT_APPLY_JOB_RESULT_STATES.has(result.state) &&
      activeRunIds.has(result.runId)
    ) {
      outstanding += 1;
    }
  }
  return outstanding;
}

export function deriveCampaignProgress(input: {
  campaign: JobSearchCampaign;
  savedJobs: readonly SavedJob[];
  reviewQueue: readonly ReviewQueueItem[];
  applicationRecords: readonly ApplicationRecord[];
  applyRuns: readonly ApplyRun[];
  applyJobResults: readonly ApplyJobResult[];
  unresolvedActions: number;
  lastRunAt: string | null;
  now: string;
}): JobSearchCampaign["progress"] {
  const activeApplyRun = input.applyRuns.find((run) => run.state === "running");
  return {
    jobsFound: input.savedJobs.length,
    jobsRetained: input.reviewQueue.length,
    // Compatibility field: every surface treats the application-record ledger
    // as the application population. A prepared subset is a status, not a
    // second total.
    applicationsPrepared: input.applicationRecords.length,
    applicationsApplied: input.applicationRecords.filter(
      (record) => getApplicationCrmData(record).appliedAt !== null,
    ).length,
    currentBatchCompleted: activeApplyRun
      ? Math.max(0, activeApplyRun.totalJobs - activeApplyRun.pendingJobs)
      : 0,
    currentBatchTotal: activeApplyRun?.totalJobs ?? 0,
    blockedCount: input.unresolvedActions,
    remainingQueueSize: deriveRemainingApplyQueueSize({
      applyRuns: input.applyRuns,
      applyJobResults: input.applyJobResults,
    }),
    lastRunAt: input.lastRunAt,
    lastUpdatedAt: input.now,
  };
}

export function deriveDashboardSummary(input: {
  safeguards?: JobFinderIntelligenceSafeguards;
  generatedAt: string;
  campaigns: JobSearchCampaignCollection;
  savedJobs: readonly SavedJob[];
  reviewQueue: readonly ReviewQueueItem[];
  applicationRecords: readonly ApplicationRecord[];
  applyRuns: readonly ApplyRun[];
  userActionRequests: readonly UserActionRequest[];
  /**
   * Pending grouped manual-answer decisions. The Needs you screen renders one
   * card per pending decision instead of its member requests, so a summary
   * that counts the raw requests reports a different number than the screen
   * and than the shell badge: one grouped decision covering three questions
   * read as 3 here and 1 there. Optional so existing callers keep compiling;
   * omitting it means "no grouping applies".
   */
  groupedDecisions?: readonly GroupedManualAnswerDecision[];
  discovery: Pick<JobFinderDiscoveryState, "activeSourceDebugRun">;
  sourceHealth?: JobFinderDashboardSummary["sourceHealth"] | undefined;
}): JobFinderDashboardSummary {
  const now = new Date(input.generatedAt);
  const nowMs = now.getTime();
  const today = startOfLocalDay(now);
  // Applied-day metrics follow the local calendar so they align with the
  // local-midnight application capacity reset; the weekly metric keeps its
  // existing rolling seven-day window, only re-anchored at local midnight.
  const weekStart = today - 6 * 86_400_000;
  const appliedTimestamps = input.applicationRecords
    .map((record) => getApplicationCrmData(record).appliedAt)
    .filter(
      (appliedAt): appliedAt is string =>
        appliedAt !== null && Number.isFinite(Date.parse(appliedAt)),
    )
    .map((appliedAt) => Date.parse(appliedAt));
  const unresolvedActions =
    projectPlanSafeguardPauses(input.safeguards, input.campaigns.campaigns)
      .length +
    countNeedsYouItems(input.userActionRequests, input.groupedDecisions);
  const crm = projectApplicationCrmDashboard({
    records: input.applicationRecords,
    now: input.generatedAt,
  });
  const sourceHealth = input.sourceHealth ?? {
    healthy: 0,
    needsAttention: 0,
    running: 0,
    total: 0,
  };
  const jobsFoundToday = input.savedJobs.filter(
    (job) => latestSightingTime(job) >= today,
  ).length;
  const readyForApproval = input.applicationRecords.filter(
    isApplicationAwaitingUserApproval,
  ).length;
  const backgroundOperationCount =
    input.applyRuns.filter((run) => run.state === "running").length +
    (input.discovery.activeSourceDebugRun?.state === "running" ? 1 : 0);

  const recommendedNextAction =
    unresolvedActions > 0
      ? {
          label: "Resolve what needs you",
          detail: `${unresolvedActions} item${unresolvedActions === 1 ? "" : "s"} cannot continue without you.`,
          route: "/job-finder/actions",
        }
      : readyForApproval > 0
        ? {
            label: "Review prepared applications",
            detail: `${readyForApproval} application${readyForApproval === 1 ? " is" : "s are"} ready for approval.`,
            route: "/job-finder/applications",
          }
        : input.reviewQueue.length > 0
          ? {
              label: "Review shortlisted jobs",
              detail: `${input.reviewQueue.length} shortlisted job${input.reviewQueue.length === 1 ? " is" : "s are"} waiting for your decision.`,
              route: "/job-finder/review-queue",
            }
          : {
              label: "Find jobs",
              detail:
                "Run the active search plan to collect relevant openings.",
              route: "/job-finder/discovery",
            };

  return JobFinderDashboardSummarySchema.parse({
    generatedAt: input.generatedAt,
    activeCampaignId: input.campaigns.activeCampaignId,
    activeCampaignCount: input.campaigns.campaigns.filter(
      (campaign) => campaign.status === "active",
    ).length,
    jobsFoundToday,
    jobsAwaitingReview: input.reviewQueue.length,
    applicationsReadyForApproval: readyForApproval,
    applicationsAppliedToday: appliedTimestamps.filter(
      (appliedAtMs) => appliedAtMs >= today && appliedAtMs <= nowMs,
    ).length,
    applicationsAppliedThisWeek: appliedTimestamps.filter(
      (appliedAtMs) => appliedAtMs >= weekStart && appliedAtMs <= nowMs,
    ).length,
    needsYouCount: unresolvedActions,
    upcomingInterviews: crm.upcomingInterviews.length,
    upcomingFollowUps: crm.pendingFollowUps.length,
    responseRate:
      crm.responseRate !== null
        ? {
            numerator: Math.round(
              (crm.responseRate / 100) * crm.rateDenominator,
            ),
            denominator: crm.rateDenominator,
            percent: crm.responseRate,
          }
        : null,
    interviewRate:
      crm.interviewRate !== null
        ? {
            numerator: Math.round(
              (crm.interviewRate / 100) * crm.rateDenominator,
            ),
            denominator: crm.rateDenominator,
            percent: crm.interviewRate,
          }
        : null,
    sourceHealth,
    backgroundOperationCount,
    recommendedNextAction,
  });
}

export function createCampaign(input: {
  id: string;
  name: string;
  description?: string;
  mode: JobSearchCampaignMode;
  searchPreferences: JobSearchPreferences;
  now: string;
}): JobSearchCampaign {
  return JobSearchCampaignSchema.parse({
    id: input.id,
    name: input.name,
    description: input.description ?? "",
    mode: input.mode,
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
    searchPreferences: input.searchPreferences,
    sourceTargetIds: [],
    jobIds: [],
    minimumFitScore: null,
    ...getDefaultCampaignConfiguration(input.mode),
    progress: { lastUpdatedAt: input.now },
    history: [
      {
        id: `${input.id}_created`,
        campaignId: input.id,
        kind: "created",
        occurredAt: input.now,
        summary: `${input.name} created with the ${input.mode === "precision" ? "Focused search" : "Wider search"} setting.`,
        discoveryRunId: null,
      },
    ],
  });
}
