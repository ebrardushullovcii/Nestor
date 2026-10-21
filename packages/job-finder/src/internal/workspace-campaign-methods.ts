import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import {
  personPickedJob,
  readPlanAssessment,
  withPlanAssessment,
} from "./plan-assessment";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { createMatchAssessment } from "./matching";
import { jobNeedsFitJudgment } from "./fit-judgment";
import { randomUUID } from "node:crypto";

import {
  CampaignNotificationSchema,
  CampaignRuleFunnelProjectionSchema,
  CampaignRuleSchema,
  DeleteCampaignRuleInputSchema,
  DeleteJobSearchCampaignInputSchema,
  describeDiscoveryRunFailureReason,
  DiscoveryRunReportSchema,
  formatDiscoveryAccounting,
  DiscoveryRunRecordSchema,
  JobSearchCampaignCollectionSchema,
  JobSearchCampaignSchema,
  MarkAllCampaignNotificationsReadInputSchema,
  MarkCampaignNotificationReadInputSchema,
  ProjectCampaignRuleFunnelInputSchema,
  RunCampaignNowInputSchema,
  SaveCampaignRuleRouteInputSchema,
  SaveJobSearchCampaignInputSchema,
  SavedJobSchema,
  ToggleCampaignRuleInputSchema,
  type CampaignRule,
  type CampaignRuleEffect,
  type CampaignRuleFunnelProjection,
  type ApplicationAttempt,
  type ApplicationRecord,
  type ApplicationStatus,
  type ApplyJobResult,
  type ApplyRun,
  type DeleteCampaignRuleInput,
  type DeleteJobSearchCampaignInput,
  type DiscoveryActivityEvent,
  type DiscoveryRunRecord,
  type DiscoveryRunReport,
  type JobFinderWorkspaceSnapshot,
  type JobSearchCampaign,
  type JobSearchCampaignCollection,
  type MarkAllCampaignNotificationsReadInput,
  type MarkCampaignNotificationReadInput,
  type ProjectCampaignRuleFunnelInput,
  type RunCampaignNowInput,
  type ResumeDraft,
  type SavedJob,
  type SaveCampaignRuleRouteInput,
  type SaveJobSearchCampaignInput,
  type TailoredAsset,
  type ToggleCampaignRuleInput,
} from "@nestor/contracts";

import { createMonotonicTimestamp } from "./resume-draft-commit-support";
import { countDiscoveryStrongMatches } from "../discovery-result-bands";
import { deriveDiscoverySourceOutcome } from "../source-health";
import {
  createCampaign,
  ensureCampaignState,
  searchPreferencesForCampaignRun,
} from "./campaign-dashboard";
import {
  estimateCampaignFunnel,
  evaluateCampaignRules,
} from "./campaign-rule-evaluator";
import {
  applyDiscoveryRunRetentionCounts,
  buildDiscoveryRunReport,
} from "./workspace-discovery-run-helpers";
import {
  classifyCampaignRunOutcome,
  computeNextScheduledRunAt,
  isCampaignPauseWindowActive,
  resolveSavedScheduleRunFacts,
  updateCampaignRunFacts,
} from "./campaign-schedule";
import {
  buildCampaignDigest,
  deriveCampaignNotifications,
  describeJobSourceWorkTitle,
  markAllCampaignNotificationsRead,
  markCampaignNotificationRead,
  mergeCampaignNotifications,
} from "./campaign-digest-notifications";
import {
  isUserOwnedBlockerEvidence,
  persistAutomaticDiscoverySafeguard,
} from "./automatic-safeguards";
import { DiscoveryRunAlreadyActiveError } from "./workspace-discovery-methods";
import type { WorkspaceServiceContext } from "./workspace-service-context";
import type { CampaignRunContext } from "./workspace-service-contracts";

const IN_FLIGHT_JOB_STATUSES = new Set<ApplicationStatus>([
  "shortlisted",
  "drafting",
  "ready_for_review",
  "approved",
  "submitted",
  "assessment",
  "interview",
  "offer",
]);

const LEGACY_PRECISION_RETAINED_JOBS = 15;
const LIFTED_RETAINED_JOBS = 1_000;
function compareRetentionPriority(left: SavedJob, right: SavedJob): number {
  return (
    right.matchAssessment.score - left.matchAssessment.score ||
    left.id.localeCompare(right.id)
  );
}

function collectInFlightProtectedJobIds(input: {
  campaignId: string;
  candidateJobs: readonly SavedJob[];
  resumeDrafts: readonly ResumeDraft[];
  tailoredAssets: readonly TailoredAsset[];
  applyRuns: readonly ApplyRun[];
  applyJobResults: readonly ApplyJobResult[];
  applicationRecords: readonly ApplicationRecord[];
  applicationAttempts: readonly ApplicationAttempt[];
}): Set<string> {
  const candidateJobIds = new Set(input.candidateJobs.map((job) => job.id));
  const protectedJobIds = new Set<string>();
  const protect = (jobId: string): void => {
    if (candidateJobIds.has(jobId)) protectedJobIds.add(jobId);
  };

  for (const job of input.candidateJobs) {
    if (IN_FLIGHT_JOB_STATUSES.has(job.status)) protect(job.id);
  }
  for (const jobId of new Set(input.resumeDrafts.map((draft) => draft.jobId))) {
    protect(jobId);
  }
  for (const jobId of new Set(
    input.tailoredAssets.map((asset) => asset.jobId),
  )) {
    protect(jobId);
  }

  const protectedRunIds = new Set<string>();
  for (const run of input.applyRuns) {
    if (run.campaignId !== null && run.campaignId !== input.campaignId) {
      continue;
    }
    protectedRunIds.add(run.id);
    for (const jobId of run.jobIds) protect(jobId);
  }
  for (const result of input.applyJobResults) {
    if (protectedRunIds.has(result.runId)) protect(result.jobId);
  }
  for (const record of input.applicationRecords) protect(record.jobId);
  for (const attempt of input.applicationAttempts) protect(attempt.jobId);

  return protectedJobIds;
}

/**
 * The one sentence the plan's history, its run facts, and any failed-run
 * notification repeat about a finished run. It quotes the run's own frozen
 * counts — the same three numbers every screen prints — instead of restating
 * "jobs found" with a number that actually counted what was saved.
 */
export function describeCampaignRunSummary(
  run: DiscoveryRunRecord,
  report: DiscoveryRunReport,
  sourceTargets: readonly { id: string; label: string }[],
): string {
  const count = (value: number | null): string =>
    value === null ? "not recorded" : `${value}`;
  const sources = deriveDiscoverySourceOutcome(run);
  const failed = run.targetExecutions.find(
    (execution) => execution.state === "failed",
  );
  const failedLabel = failed
    ? ` · ${sourceTargets.find((target) => target.id === failed.targetId)?.label ?? "A job source"} failed${failed.warning ? ` (${failed.warning})` : ""}`
    : "";
  // A run that failed says why. Counts for a run that planned nothing are
  // three zeros that read as "the search found nothing", which is a different
  // and wrong story; the reason replaces them.
  const failureReason = describeDiscoveryRunFailureReason(run);
  if (run.runPhase === "interrupted") {
    return `Interrupted: ${formatDiscoveryAccounting(report)}. Jobs saved before the interruption remain available.`;
  }
  if (failureReason !== null) {
    return sources.planned === 0
      ? `Run failed: ${failureReason}`
      : `${sources.completed} of ${sources.planned} sources completed${failedLabel}. Run failed: ${failureReason}`;
  }
  if (report.unique != null) {
    const outcome =
      run.state === "cancelled"
        ? "Stopped"
        : run.state === "failed"
          ? "Failed"
          : run.state === "running"
            ? "So far"
            : "Found";
    return `${sources.completed} of ${sources.planned} sources completed${failedLabel}. ${outcome}: ${formatDiscoveryAccounting(report)}.`;
  }
  return `${sources.completed} of ${sources.planned} sources completed${failedLabel}. Discovery ${run.state}: ${count(report.found)} found · ${count(
    report.new,
  )} new · ${count(report.retained)} kept.`;
}

/**
 * What an automatic search says when it finishes.
 *
 * A search the person started reports itself on screen while they watch. A
 * scheduled one finishes with nobody looking: Tasks showed nothing, no
 * notification arrived, and Home was unchanged, so the only evidence the
 * search had ever run was the job list quietly growing. This is the same
 * three frozen numbers every other surface prints, in a sentence a person can
 * read in a notification list.
 */
export function describeScheduledRunCompletion(
  report: DiscoveryRunReport,
): string {
  const kept = report.retained;
  if (kept === null) {
    return "Your scheduled search finished. Open Find jobs to see what it kept.";
  }
  if (kept === 0) {
    return "Your scheduled search finished and kept nothing new this time.";
  }
  const newCount = report.new === null ? null : Math.min(report.new, kept);
  const newClause =
    newCount === null || newCount === 0
      ? ""
      : newCount === 1
        ? " 1 of them is new."
        : ` ${newCount} of them are new.`;
  return kept === 1
    ? `Your scheduled search finished and kept 1 job.${newClause}`
    : `Your scheduled search finished and kept ${kept} jobs.${newClause}`;
}

/**
 * True when a rule effect carries no measured history at all. Mutations that
 * round-trip a rule without its effect must not wipe previously measured
 * remove/downgrade counts.
 */
function isDefaultCampaignRuleEffect(effect: CampaignRuleEffect): boolean {
  return (
    effect.sampleSize === 0 &&
    effect.removedCount === 0 &&
    effect.downgradedCount === 0 &&
    effect.unknownCount === 0 &&
    effect.measuredAt === null
  );
}

/**
 * Persists one atomic campaign-state change for a rule mutation, appending a
 * typed history entry and bumping `updatedAt`. Runs inside the campaign
 * transition so it never interleaves with a scheduled-run commit.
 */
async function persistCampaignRuleChange(input: {
  ctx: WorkspaceServiceContext;
  state: JobSearchCampaignCollection;
  campaign: JobSearchCampaign;
  rules: readonly CampaignRule[];
  now: string;
  summary: string;
}): Promise<void> {
  const nextCampaign = JobSearchCampaignSchema.parse({
    ...input.campaign,
    rules: input.rules,
    updatedAt: input.now,
    history: [
      {
        id: `campaign_history_${randomUUID()}`,
        campaignId: input.campaign.id,
        kind: "updated",
        occurredAt: input.now,
        summary: input.summary,
        discoveryRunId: null,
      },
      ...input.campaign.history,
    ].slice(0, 100),
  });
  await input.ctx.repository.saveCampaignState(
    JobSearchCampaignCollectionSchema.parse({
      ...input.state,
      campaigns: input.state.campaigns.map((candidate) =>
        candidate.id === input.campaign.id ? nextCampaign : candidate,
      ),
    }),
  );
}

/** Plan candidates scored per turn of the event loop at a run's end. */
const CANDIDATES_PER_TURN = 250;
/** Saved jobs whose plan membership one transaction rewrites. */
const MEMBERSHIP_ROWS_PER_COMMIT = 250;

/**
 * Atomically commits the terminal discovery run for a campaign: campaign
 * history, progress, rules, and retained job ids plus the schedule run facts,
 * the latest digest, and merged strong-match/blocked notifications. All writes
 * happen in one serialized campaign-state save so concurrent scheduled runs
 * never interleave mid-commit. The saved jobs' plan membership is written
 * before that save, inside the same campaign transition, a few hundred jobs
 * per transaction.
 */
export async function commitCampaignRunTerminal(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  beforeJobProvenanceFingerprints: ReadonlyMap<string, string>;
  beforeCampaignJobIds?: readonly string[];
  now: string;
  /**
   * Who asked for this run. A scheduled run has no screen watching it, so it
   * is the one that must leave a notification behind whatever it found; a
   * manual run already reports itself where the person is standing.
   */
  trigger?: "manual" | "scheduled";
}): Promise<void> {
  let committedCampaign: JobSearchCampaign | null = null;
  await input.ctx.withCampaignTransition(async () => {
    // The work collections below are only read, so the cached display rows
    // serve: a fresh copy of every resume draft and application here took
    // seconds at the end of a large search.
    const display = await input.ctx.repository.readDisplayCollections?.();
    const [
      state,
      savedJobs,
      discovery,
      resumeDrafts,
      tailoredAssets,
      applyRuns,
      applyJobResults,
      applicationRecords,
      applicationAttempts,
    ] = await Promise.all([
      input.ctx.repository.getCampaignState(),
      // Read-only below; the cached display rows spare a full parse.
      input.ctx.repository.readSavedJobsProjection(),
      input.ctx.repository.getDiscoveryState(),
      display?.resumeDrafts ?? input.ctx.repository.listResumeDrafts(),
      display?.tailoredAssets ?? input.ctx.repository.listTailoredAssets(),
      display?.applyRuns ?? input.ctx.repository.listApplyRuns(),
      display?.applyJobResults ?? input.ctx.repository.listApplyJobResults(),
      display?.applicationRecords ??
        input.ctx.repository.listApplicationRecords(),
      display?.applicationAttempts ??
        input.ctx.repository.listApplicationAttempts(),
    ]);
    if (!state) return;
    const recordedRun =
      discovery.recentRuns.find((run) => run.campaignId === input.campaignId) ??
      (discovery.activeRun?.campaignId === input.campaignId
        ? discovery.activeRun
        : null);
    if (!recordedRun) return;
    // The newest run for this plan may be one that was already committed: a
    // Run now that never opened a run of its own — the sources are gone, a
    // safeguard blocks it, or a read fails before the pipeline starts — still
    // arrives here. Recounting a settled run against the current workspace
    // moves numbers no search produced, because the jobs it introduced are by
    // then already members of the plan: the same finished search read "66
    // new" before and "51 new" after. A frozen report is measured once.
    if (
      recordedRun.summary.report !== null &&
      recordedRun.summary.report.worthOpening !== null
    ) {
      return;
    }
    const campaign = state.campaigns.find(
      (candidate) => candidate.id === input.campaignId,
    );
    if (!campaign) return;
    const sourceOutcome = deriveDiscoverySourceOutcome(recordedRun);
    const latestRun = DiscoveryRunRecordSchema.parse({
      ...recordedRun,
      summary: {
        ...recordedRun.summary,
        // Failed, skipped, and cancelled sources are terminal, but they are
        // not completed. Persist the canonical denominator so Home, history,
        // and Find jobs stop reporting a failed source inside "3 of 3".
        targetsCompleted: sourceOutcome.completed,
      },
    });

    const outcome = classifyCampaignRunOutcome({
      state: latestRun.state,
      targetExecutions: latestRun.targetExecutions,
    });
    // Never commit a run that is not terminal yet.
    if (outcome === null) return;

    // Discovery-only mode keeps new findings in pendingDiscoveryJobs until the
    // user shortlists them. They are still real results owned by this campaign
    // and must participate in retention; otherwise the renderer's campaign
    // filter hides the entire completed run.
    const availableJobs = [...savedJobs, ...discovery.pendingDiscoveryJobs];
    const encounteredCanonicalUrls = new Set(
      latestRun.targetExecutions.flatMap((execution) =>
        (execution.agentCheckpoint?.collectedJobs ?? []).map(
          (posting) => posting.canonicalUrl,
        ),
      ),
    );
    // The run's own record of what each target collected. The agent checkpoint
    // only holds the batch that was open when it was written — a target that
    // finished in one pass leaves none — so the durable per-execution list is
    // the primary reading and the checkpoint covers runs recorded before it.
    const encounteredRecordedJobIds = new Set(
      latestRun.targetExecutions.flatMap(
        (execution) => execution.encounteredJobIds,
      ),
    );
    const encounteredJobIds = new Set(
      availableJobs
        .filter((job) => {
          // Campaign membership is allowed to follow only a listing identity
          // the run itself recorded. Timestamps and source provenance describe
          // historical rows too broadly and cannot identify which duplicates
          // a compact run actually encountered.
          return (
            encounteredRecordedJobIds.has(job.id) ||
            encounteredCanonicalUrls.has(job.canonicalUrl)
          );
        })
        .map((job) => job.id),
    );
    const priorCampaignJobIds = new Set(
      input.beforeCampaignJobIds ?? campaign.jobIds,
    );
    const newToPlanJobIds = new Set(
      [...encounteredJobIds].filter((jobId) => !priorCampaignJobIds.has(jobId)),
    );
    // "Already here" is a statement about the plan before this run, so it is
    // the other half of the same split that produced `new`. The run's own
    // duplicate tally cannot answer it: that counts every merge the run made,
    // including a listing two sources both returned inside this one run, which
    // is why a first search on an empty workspace reported listings as already
    // here.
    const alreadyInPlanJobIds = new Set(
      [...encounteredJobIds].filter((jobId) => priorCampaignJobIds.has(jobId)),
    );
    // Live membership may be published while a search is collecting. It is
    // not proof that an older workspace job belongs to this run. Start with
    // the plan before the search, then add only this run's actual encounters
    // and jobs the person selected here while it was running.
    const campaignJobIds = new Set(campaign.jobIds);
    const candidateJobIds = new Set([
      ...priorCampaignJobIds,
      ...encounteredJobIds,
      ...availableJobs
        .filter((job) => campaignJobIds.has(job.id) && personPickedJob(job))
        .map((job) => job.id),
    ]);
    const candidates = availableJobs
      .filter((job) => candidateJobIds.has(job.id) && job.status !== "archived")
      .map((job) => readPlanAssessment(job, campaign.id));
    const profile = await input.ctx.repository.getProfile();
    const preferences = withSavedJobSearchBehavior(
      enrichSearchPreferencesFromProfile(
        searchPreferencesForCampaignRun(campaign),
        profile,
      ),
      await input.ctx.repository.getSettings(),
    );
    const session = createMatchAssessmentSession({
      profile,
      searchPreferences: preferences,
      calculate: createMatchAssessment,
    });
    // Discovery judges all eligible jobs before taking this commit lock.
    // Do not make another model request while plan edits are waiting for it.
    // Thousands of candidates are scored a slice per turn of the event loop,
    // so the end of a search does not hold the window for seconds.
    const planId = campaign.id;
    const assessCandidate = (job: SavedJob): SavedJob => {
      // A verdict from another plan cannot say this job fits the current one.
      // This plan's own verdict stands even when the profile or goals changed
      // since: it is the best answer until the job is judged again (ADR 0041).
      // Dropping it made one search after a profile edit wipe every verdict
      // of the plan (6,200 on the owner's data), each then bought again.
      const ownVerdict = job.planAssessments?.[planId]?.judgment;
      const assessment =
        ownVerdict ||
        !jobNeedsFitJudgment(
          job,
          session.verdictFingerprint,
          session.contextFingerprint,
        )
          ? job.matchAssessment
          : session.assess({ ...job, matchAssessment: null });
      return readPlanAssessment(
        withPlanAssessment(job, planId, assessment),
        planId,
      );
    };
    const candidateJobs: SavedJob[] = [];
    for (const [position, job] of candidates.entries()) {
      if (position > 0 && position % CANDIDATES_PER_TURN === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
      candidateJobs.push(assessCandidate(job));
    }
    const assessedById = new Map(candidateJobs.map((job) => [job.id, job]));
    const measuredAt = latestRun.completedAt ?? latestRun.startedAt;
    const evaluatedRules = evaluateCampaignRules({
      rules: campaign.rules,
      jobs: candidateJobs,
      measuredAt,
    });
    const funnel = estimateCampaignFunnel({
      rules: campaign.rules,
      jobs: candidateJobs,
      measuredAt,
    });
    const allowedByRules = new Set(funnel.rankedJobIds);
    const rankedRetainedJobIds = candidateJobs
      .filter(
        (job) =>
          allowedByRules.has(job.id) &&
          job.matchAssessment.judgment?.role !== "conflict" &&
          job.matchAssessment.judgment?.locationReach !== "outside_area" &&
          // A job the model has not judged yet was not measured, so the
          // plan's minimum fit does not drop it (ADR 0041).
          (campaign.minimumFitScore === null ||
            !job.matchAssessment.judgment ||
            job.matchAssessment.score >= campaign.minimumFitScore),
      )
      .sort(compareRetentionPriority)
      // Plans created before the cap was lifted still carry the old
      // fifteen-job default; nobody chose it, so it reads as the new one.
      .slice(
        0,
        campaign.limits.retainedJobTarget === LEGACY_PRECISION_RETAINED_JOBS
          ? LIFTED_RETAINED_JOBS
          : campaign.limits.retainedJobTarget,
      )
      .map((job) => job.id);
    const retainedJobIdSet = new Set([
      ...rankedRetainedJobIds,
      ...collectInFlightProtectedJobIds({
        campaignId: campaign.id,
        candidateJobs,
        resumeDrafts,
        tailoredAssets,
        applyRuns,
        applyJobResults,
        applicationRecords,
        applicationAttempts,
      }),
    ]);
    const retainedJobIds = candidateJobs
      .filter((job) => retainedJobIdSet.has(job.id))
      .sort(compareRetentionPriority)
      .map((job) => job.id);
    const retainedMembership = new Set(retainedJobIds);
    const retainedRunJobs = candidateJobs.filter(
      (job) => retainedJobIdSet.has(job.id) && encounteredJobIds.has(job.id),
    );

    // Retention is decided here and nowhere else, so this is the one moment
    // these two numbers are measured. Everything downstream — the history
    // entry, the run facts, the notification body, and every screen — reads
    // them back rather than recounting the current inventory, which is what
    // made one search read as 100, 50 and 15 depending on where the user
    // stood.
    const retentionCounts = {
      measuredAt,
      alreadyHere: alreadyInPlanJobIds.size,
      retained: retainedRunJobs.length,
      worthOpening: countDiscoveryStrongMatches(retainedRunJobs),
    };
    const runReport = DiscoveryRunReportSchema.parse({
      ...(latestRun.summary.report ??
        buildDiscoveryRunReport(latestRun, measuredAt)),
      alreadyHere: retentionCounts.alreadyHere,
      retained: retentionCounts.retained,
      worthOpening: retentionCounts.worthOpening,
      retentionLimitApplied: campaign.limits.retainedJobTarget,
      minimumFitScoreApplied: campaign.minimumFitScore,
    });
    const runSummary = describeCampaignRunSummary(
      latestRun,
      runReport,
      campaign.searchPreferences.discovery.targets,
    );
    const runFacts = updateCampaignRunFacts({
      schedule: campaign.schedule,
      outcome,
      completedAt: measuredAt,
      summary: runSummary,
    });

    const digest = buildCampaignDigest({
      campaignId: campaign.id,
      run: latestRun,
      generatedAt: measuredAt,
      jobIds: retainedJobIds,
      // The plan card reads its numbers from here. The Search plans screen is
      // only given the active plan's run records, so a card that had to look
      // the run up said "Counts were not recorded" about a search that had
      // just finished.
      report: runReport,
    });

    const strongMatches = candidateJobs
      .filter(
        (job) => retainedMembership.has(job.id) && newToPlanJobIds.has(job.id),
      )
      .map((job) => ({
        jobId: job.id,
        title: job.title,
        company: job.company,
        fitScore: job.matchAssessment.score,
        assessment: {
          discoveryMethod: job.discoveryMethod,
          matchAssessment: job.matchAssessment,
        },
      }));
    // Notifications name a source by the label the user saved for it; the
    // internal target id never reaches a user-facing string.
    const campaignSourceTargets = campaign.searchPreferences.discovery.targets;
    const failedSourceWork = (digest?.failedSources ?? []).map((source) => ({
      workId: `discovery_source_${latestRun.id}_${source.sourceTargetId}`,
      sourceTargetId: source.sourceTargetId,
      title: describeJobSourceWorkTitle(
        source.sourceTargetId,
        campaignSourceTargets,
      ),
      reason: source.reason,
    }));
    const blockedSourceWork = failedSourceWork.filter((source) =>
      isUserOwnedBlockerEvidence(source.reason),
    );
    const technicalSourceWork = failedSourceWork.filter(
      (source) => !isUserOwnedBlockerEvidence(source.reason),
    );
    const derivedNotifications = deriveCampaignNotifications({
      campaignId: campaign.id,
      now: measuredAt,
      strongMatches,
      minimumFitScore: campaign.minimumFitScore,
      blockedWork: blockedSourceWork,
      failedWork: technicalSourceWork,
      runFacts,
    });
    // A scheduled run that simply worked produced no notification at all:
    // `deriveCampaignNotifications` only speaks up for a strong match, a
    // blocked source, or a failure. Silence after unattended work is
    // indistinguishable from the schedule never having fired.
    const scheduledCompletionNotifications =
      input.trigger === "scheduled" && outcome !== "failed"
        ? [
            CampaignNotificationSchema.parse({
              id: `n_${campaign.id}_scheduled_run_${latestRun.id}`,
              campaignId: campaign.id,
              kind: "digest_ready" as const,
              title: `${campaign.name}: scheduled search finished`,
              body: describeScheduledRunCompletion(runReport),
              createdAt: measuredAt,
              unread: true,
              readAt: null,
              jobId: null,
              sourceTargetId: null,
            }),
          ]
        : [];
    const notifications = mergeCampaignNotifications({
      existing: state.notifications,
      incoming: [...derivedNotifications, ...scheduledCompletionNotifications],
    });

    const alreadyRecorded = campaign.history.some(
      (entry) => entry.discoveryRunId === latestRun.id,
    );
    const nextCampaign = JobSearchCampaignSchema.parse({
      ...campaign,
      jobIds: retainedJobIds,
      rules: campaign.rules.map((rule) => {
        const evaluated = evaluatedRules.find(
          (candidate) => candidate.rule.id === rule.id,
        );
        return evaluated ? { ...rule, effect: evaluated.effect } : rule;
      }),
      history: alreadyRecorded
        ? campaign.history
        : [
            {
              id: `campaign_history_discovery_${latestRun.id}`,
              campaignId: campaign.id,
              kind: "discovery_run" as const,
              occurredAt: measuredAt,
              summary: runSummary,
              discoveryRunId: latestRun.id,
            },
            ...campaign.history,
          ].slice(0, 100),
      schedule: { ...campaign.schedule, runFacts },
      latestDigest: digest ?? campaign.latestDigest,
      progress: {
        ...campaign.progress,
        // Only the active plan's progress is re-derived from live inventory,
        // so every other plan card kept saying "Jobs in this plan 0" straight
        // after its own run. Retention was just decided here; record it.
        jobsFound: retainedJobIds.length,
        lastRunAt: measuredAt,
        lastUpdatedAt: input.now,
      },
      updatedAt: input.now,
    });
    const planIdsByJobId = new Map<string, string[]>();
    for (const existingCampaign of state.campaigns) {
      for (const jobId of existingCampaign.jobIds) {
        const planIds = planIdsByJobId.get(jobId);
        if (planIds) planIds.push(existingCampaign.id);
        else planIdsByJobId.set(jobId, [existingCampaign.id]);
      }
    }
    const nextCampaignIds = (job: SavedJob): string[] => {
      const campaignIds = new Set(job.campaignIds ?? []);
      // Campaign.jobIds is the durable join from workspaces created before
      // the SavedJob membership field existed, and it also repairs a row if
      // an older duplicate-merge build dropped the mirrored list.
      for (const planId of planIdsByJobId.get(job.id) ?? []) {
        campaignIds.add(planId);
      }
      if (retainedMembership.has(job.id)) {
        campaignIds.add(campaign.id);
      } else {
        campaignIds.delete(campaign.id);
      }
      return [...campaignIds].sort();
    };
    // The jobs this commit can change: a different plan membership or a new
    // verdict for this plan. Every other saved job was read, parsed, copied
    // and compared in the write for nothing (about 7 s of the main process
    // at the end of a search with 12,000 saved jobs). Read again right
    // before the write, so a job changed meanwhile is judged as it is now.
    const currentSavedJobs =
      await input.ctx.repository.readSavedJobsProjection();
    const changedSavedJobIds = currentSavedJobs
      .filter((job) => {
        if (
          JSON.stringify(nextCampaignIds(job)) !==
          JSON.stringify(job.campaignIds ?? [])
        )
          return true;
        const assessed = assessedById.get(job.id);
        return (
          assessed?.planAssessments !== undefined &&
          JSON.stringify(job.planAssessments?.[campaign.id]) !==
            JSON.stringify(assessed.matchAssessment)
        );
      })
      .map((job) => job.id);
    const updateCampaignMembership = (job: SavedJob): SavedJob => {
      return SavedJobSchema.parse({
        ...job,
        campaignIds: nextCampaignIds(job),
        ...(assessedById.get(job.id)?.planAssessments
          ? {
              planAssessments: {
                ...job.planAssessments,
                [campaign.id]: assessedById.get(job.id)!.matchAssessment,
              },
            }
          : {}),
      });
    };
    // Thousands of jobs can join or leave the plan at once (the first search
    // of a large plan). Written in one transaction that held main for tens
    // of seconds; written in parts, a turn of the event loop apart, the run
    // record going with the last part. Each part reads the rows it changes
    // inside its own transaction. The plan itself is saved after the jobs,
    // in its own transaction, as before; a stop between parts leaves the same
    // kind of gap a stop before that save always could, and the plan's next
    // run settles every membership again.
    const membershipParts: string[][] = [];
    for (
      let start = 0;
      start < changedSavedJobIds.length;
      start += MEMBERSHIP_ROWS_PER_COMMIT
    )
      membershipParts.push(
        changedSavedJobIds.slice(start, start + MEMBERSHIP_ROWS_PER_COMMIT),
      );
    const lastMembershipPart = membershipParts.pop() ?? [];
    for (const part of membershipParts) {
      await input.ctx.repository.commitSavedJobDelta({
        update: updateCampaignMembership,
        updateJobIds: part,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await input.ctx.repository.commitSavedJobDelta({
      update: updateCampaignMembership,
      updateJobIds: lastMembershipPart,
      updateDiscoveryState: (current) => ({
        ...current,
        activeRun:
          current.activeRun && current.activeRun.id === latestRun.id
            ? applyDiscoveryRunRetentionCounts(
                DiscoveryRunRecordSchema.parse({
                  ...current.activeRun,
                  summary: {
                    ...current.activeRun.summary,
                    targetsCompleted: sourceOutcome.completed,
                  },
                }),
                retentionCounts,
              )
            : current.activeRun,
        recentRuns: current.recentRuns.map((run) =>
          run.id === latestRun.id
            ? applyDiscoveryRunRetentionCounts(
                DiscoveryRunRecordSchema.parse({
                  ...run,
                  summary: {
                    ...run.summary,
                    targetsCompleted: sourceOutcome.completed,
                  },
                }),
                retentionCounts,
              )
            : run,
        ),
        pendingDiscoveryJobs: current.pendingDiscoveryJobs.map(
          updateCampaignMembership,
        ),
      }),
    });
    await input.ctx.repository.saveCampaignState(
      JobSearchCampaignCollectionSchema.parse({
        notifications,
        activeCampaignId: state.activeCampaignId,
        campaigns: state.campaigns.map((candidate) =>
          candidate.id === campaign.id ? nextCampaign : candidate,
        ),
      }),
    );
    committedCampaign = nextCampaign;
  });

  // Rebuild the technical failure sample from persisted campaign runs after
  // the campaign transition is released. Automatic safeguard persistence is
  // best-effort and must never turn a committed discovery result into an
  // exception (or deadlock on the campaign transition).
  if (committedCampaign !== null) {
    await persistAutomaticDiscoverySafeguard({
      ctx: input.ctx,
      campaign: committedCampaign,
      now: input.now,
    }).catch(() => {});
  }
}

/**
 * Legacy entry point used by the active-campaign manual discovery path. It now
 * shares the full atomic terminal commit (history/progress/rules/jobIds plus
 * run facts, digest, and notifications) so every finished discovery run keeps
 * the campaign ledger truthful.
 */
export async function recordCampaignDiscoveryResult(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  beforeJobProvenanceFingerprints: ReadonlyMap<string, string>;
  beforeCampaignJobIds?: readonly string[];
}): Promise<void> {
  await commitCampaignRunTerminal({
    ctx: input.ctx,
    campaignId: input.campaignId,
    beforeJobProvenanceFingerprints: input.beforeJobProvenanceFingerprints,
    ...(input.beforeCampaignJobIds
      ? { beforeCampaignJobIds: input.beforeCampaignJobIds }
      : {}),
    now: new Date().toISOString(),
  });
}

/**
 * Initializes a missing `runFacts.nextRunAt` truthfully (strictly after `now`)
 * without scheduling any immediate work. Returns `null` when the schedule
 * cannot produce a due time or already has one.
 */
function initializeNextRunAt(input: {
  campaign: JobSearchCampaign;
  now: string;
}): JobSearchCampaign | null {
  const schedule = input.campaign.schedule;
  if (!schedule.enabled || schedule.mode === "manual") return null;
  if (schedule.runFacts.nextRunAt !== null) return null;
  const nextRunAt = computeNextScheduledRunAt({
    schedule,
    now: input.now,
  });
  if (nextRunAt === null) return null;
  return JobSearchCampaignSchema.parse({
    ...input.campaign,
    schedule: {
      ...schedule,
      runFacts: { ...schedule.runFacts, nextRunAt },
    },
  });
}

/**
 * Initializes a missing `runFacts.nextRunAt` inside the campaign transition.
 * The due instant is computed from the freshly read campaign state so a
 * concurrent schedule/rule/history/pointer edit survives; the outer snapshot
 * only nominates the campaign id. Writes nothing when the campaign vanished,
 * left the active status, or its schedule cannot produce a due time
 * (disabled, manual, or already initialized by another tick).
 */
async function persistInitializedNextRun(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  now: string;
}): Promise<boolean> {
  return input.ctx.withCampaignTransition(async () => {
    const state = await input.ctx.repository.getCampaignState();
    if (!state) return false;
    const current = state.campaigns.find(
      (candidate) => candidate.id === input.campaignId,
    );
    if (!current || current.status !== "active") return false;
    const initialized = initializeNextRunAt({
      campaign: current,
      now: input.now,
    });
    if (!initialized) return false;
    await input.ctx.repository.saveCampaignState(
      JobSearchCampaignCollectionSchema.parse({
        ...state,
        campaigns: state.campaigns.map((candidate) =>
          candidate.id === input.campaignId ? initialized : candidate,
        ),
      }),
    );
    return true;
  });
}

function isDiscoveryInProgressError(error: unknown): boolean {
  return (
    error instanceof DiscoveryRunAlreadyActiveError ||
    (error instanceof Error && error.message.includes("already in progress"))
  );
}

/**
 * Deterministically claims one due schedule slot inside the campaign
 * transition. The claim is a compare-and-set on the persisted `nextRunAt`:
 * only the tick that observed this exact due instant may clear it, so two
 * overlapping ticks can never execute the same slot and a save/select that
 * serialized in between cannot resurrect a consumed slot. Clearing
 * `nextRunAt` doubles as the restart marker: a claimed slot whose run never
 * commits (crash) is re-initialized truthfully by a later tick without
 * immediate work.
 *
 * The freshly validated claimed campaign is returned so the run executes with
 * the budget, preferences, and status current at claim time instead of the
 * ticker's stale outer snapshot (campaign-scoped preferences ride on the
 * snapshot; no separate global read is needed). `null` means this tick does
 * not own the slot.
 */
async function claimDueScheduledSlot(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  dueNextRunAt: string;
  now: string;
}): Promise<JobSearchCampaign | null> {
  return input.ctx.withCampaignTransition(async () => {
    if ((await input.ctx.repository.getActivityControl()).paused) return null;
    const state = await input.ctx.repository.getCampaignState();
    if (!state) return null;
    const campaign = state.campaigns.find(
      (candidate) => candidate.id === input.campaignId,
    );
    if (!campaign || campaign.status !== "active") return null;
    const schedule = campaign.schedule;
    if (!schedule.enabled || schedule.mode === "manual") return null;
    if (schedule.runFacts.nextRunAt !== input.dueNextRunAt) return null;
    const nextRunAtMs = Date.parse(input.dueNextRunAt);
    if (!Number.isFinite(nextRunAtMs) || nextRunAtMs > Date.parse(input.now)) {
      return null;
    }
    if (
      isCampaignPauseWindowActive({
        windows: schedule.pauseWindows,
        at: input.now,
      })
    ) {
      return null;
    }
    const claimed = JobSearchCampaignSchema.parse({
      ...campaign,
      schedule: {
        ...schedule,
        runFacts: { ...schedule.runFacts, nextRunAt: null },
      },
    });
    await input.ctx.repository.saveCampaignState(
      JobSearchCampaignCollectionSchema.parse({
        ...state,
        campaigns: state.campaigns.map((candidate) =>
          candidate.id === campaign.id ? claimed : candidate,
        ),
      }),
    );
    return claimed;
  });
}

/**
 * Puts a claimed-but-unstarted slot back when a concurrent discovery owns the
 * pipeline, keeping the slot due so the next tick retries it. No-op when the
 * slot already advanced or another writer changed it.
 */
async function restoreClaimedScheduledSlot(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  dueNextRunAt: string;
}): Promise<void> {
  await input.ctx.withCampaignTransition(async () => {
    const state = await input.ctx.repository.getCampaignState();
    if (!state) return;
    const campaign = state.campaigns.find(
      (candidate) => candidate.id === input.campaignId,
    );
    if (!campaign || campaign.schedule.runFacts.nextRunAt !== null) return;
    await input.ctx.repository.saveCampaignState(
      JobSearchCampaignCollectionSchema.parse({
        ...state,
        campaigns: state.campaigns.map((candidate) =>
          candidate.id === campaign.id
            ? JobSearchCampaignSchema.parse({
                ...candidate,
                schedule: {
                  ...candidate.schedule,
                  runFacts: {
                    ...candidate.schedule.runFacts,
                    nextRunAt: input.dueNextRunAt,
                  },
                },
              })
            : candidate,
        ),
      }),
    );
  });
}

/**
 * Executes one discovery cycle for a campaign and then atomically commits the
 * terminal run into the campaign. A discovery failure still commits the failed
 * terminal state so the schedule advances instead of hot-looping; a concurrent
 * discovery (already-in-progress) is surfaced to the caller without committing.
 */
async function executeCampaignRun(input: {
  ctx: WorkspaceServiceContext;
  campaign: JobSearchCampaign;
  runCampaignDiscovery: (
    campaign: CampaignRunContext,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ) => Promise<JobFinderWorkspaceSnapshot>;
  now: string;
  onActivity?: (event: DiscoveryActivityEvent) => void;
  trigger: "manual" | "scheduled";
}): Promise<void> {
  // Only fingerprinted below; the cached display rows serve that.
  const [beforeSavedJobs, beforeDiscovery] = await Promise.all([
    input.ctx.repository.readSavedJobsProjection(),
    input.ctx.repository.readDiscoveryDisplayProjection(),
  ]);
  const beforeJobProvenanceFingerprints = new Map(
    [...beforeSavedJobs, ...beforeDiscovery.pendingDiscoveryJobs].map((job) => [
      job.id,
      JSON.stringify(job.provenance),
    ]),
  );
  try {
    await input.runCampaignDiscovery(
      {
        campaignId: input.campaign.id,
        mode: input.campaign.mode,
        searchPreferences: searchPreferencesForCampaignRun(input.campaign),
        runJobBudget: input.campaign.limits.discoveryRunJobBudget ?? null,
      },
      input.onActivity,
    );
  } catch (error) {
    if (!isDiscoveryInProgressError(error)) {
      await commitCampaignRunTerminal({
        ctx: input.ctx,
        campaignId: input.campaign.id,
        beforeJobProvenanceFingerprints,
        beforeCampaignJobIds: input.campaign.jobIds,
        now: input.now,
        trigger: input.trigger,
      });
    }
    throw error;
  }
  await commitCampaignRunTerminal({
    ctx: input.ctx,
    campaignId: input.campaign.id,
    beforeJobProvenanceFingerprints,
    beforeCampaignJobIds: input.campaign.jobIds,
    now: input.now,
    trigger: input.trigger,
  });
}

async function resolveCampaignForRun(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string | null;
}): Promise<JobSearchCampaign> {
  // Creating/reconciling campaign state writes the whole collection, so it
  // must hold the campaign transition like every other mutating campaign
  // operation; the resolved snapshot is then truthful for this run.
  return input.ctx.withCampaignTransition(async () => {
    let state = await input.ctx.repository.getCampaignState();
    if (!state) {
      state = await ensureCampaignState({
        repository: input.ctx.repository,
        searchPreferences: await input.ctx.repository.getSearchPreferences(),
      });
    }
    const campaign = state.campaigns.find(
      (candidate) =>
        candidate.id === (input.campaignId ?? state.activeCampaignId),
    );
    if (!campaign) {
      throw new Error("The requested job search campaign is unavailable.");
    }
    if (campaign.status !== "active") {
      throw new Error(
        `The campaign is ${campaign.status}. Set it to active before running it.`,
      );
    }
    return campaign;
  });
}

export function createWorkspaceCampaignMethods(input: {
  ctx: WorkspaceServiceContext;
  getWorkspaceSnapshot: () => Promise<JobFinderWorkspaceSnapshot>;
  runCampaignDiscovery: (
    campaign: CampaignRunContext,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ) => Promise<JobFinderWorkspaceSnapshot>;
  afterCampaignRun: (campaignId: string) => Promise<JobFinderWorkspaceSnapshot>;
}) {
  async function getState() {
    return ensureCampaignState({
      repository: input.ctx.repository,
      searchPreferences: await input.ctx.repository.getSearchPreferences(),
    });
  }

  async function processDueScheduledCampaigns(
    rawNow?: string,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ): Promise<boolean> {
    const candidateNow = rawNow ?? new Date().toISOString();
    const now = Number.isFinite(Date.parse(candidateNow))
      ? candidateNow
      : new Date().toISOString();
    if ((await input.ctx.repository.getActivityControl()).paused) {
      return false;
    }

    const state = await input.ctx.repository.getCampaignState();
    if (!state) return false;

    let changed = false;
    for (const campaign of state.campaigns) {
      if (campaign.status !== "active") continue;
      const schedule = campaign.schedule;
      if (!schedule.enabled || schedule.mode === "manual") continue;

      if (schedule.runFacts.nextRunAt === null) {
        // Initialization reconciles against freshly read state inside the
        // transition; the stale outer snapshot only nominates the id.
        changed =
          (await persistInitializedNextRun({
            ctx: input.ctx,
            campaignId: campaign.id,
            now,
          })) || changed;
        continue;
      }

      const dueNextRunAt = schedule.runFacts.nextRunAt;
      const nextRunAtMs = Date.parse(dueNextRunAt);
      if (!Number.isFinite(nextRunAtMs) || nextRunAtMs > Date.parse(now)) {
        continue;
      }
      if (
        isCampaignPauseWindowActive({
          windows: schedule.pauseWindows,
          at: now,
        })
      ) {
        // Leave the run due so it executes once when the window ends.
        continue;
      }

      const claimed = await claimDueScheduledSlot({
        ctx: input.ctx,
        campaignId: campaign.id,
        dueNextRunAt,
        now,
      });
      if (!claimed) continue;
      changed = true;

      if ((await input.ctx.repository.getActivityControl()).paused) {
        await restoreClaimedScheduledSlot({
          ctx: input.ctx,
          campaignId: claimed.id,
          dueNextRunAt,
        });
        break;
      }
      let ranScheduledCampaign = false;
      await executeCampaignRun({
        ctx: input.ctx,
        campaign: claimed,
        runCampaignDiscovery: input.runCampaignDiscovery,
        now,
        ...(onActivity ? { onActivity } : {}),
        trigger: "scheduled",
      })
        .then(() => {
          ranScheduledCampaign = true;
        })
        .catch(async (error: unknown) => {
          if (isDiscoveryInProgressError(error)) {
            // A manual or scheduled discovery owns the pipeline; put the
            // claimed slot back so the next tick retries it.
            await restoreClaimedScheduledSlot({
              ctx: input.ctx,
              campaignId: claimed.id,
              dueNextRunAt,
            });
            return;
          }
          // The failed terminal state was already committed by
          // executeCampaignRun, so the schedule advances; swallow so one
          // campaign never blocks the rest of the ticker.
        });

      // A scheduled run finishes the same way a manual one does, including
      // the post-run refresh the manual path already ran. Without it the
      // run's own findings reached the workspace while everything derived
      // from them (company intelligence, and the snapshot the screens read)
      // stayed on the previous search.
      if (ranScheduledCampaign) {
        await input.afterCampaignRun(claimed.id);
      }
    }

    return changed;
  }

  return {
    async saveCampaign(
      rawCampaign: SaveJobSearchCampaignInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const { expectedUpdatedAt, ...campaignInput } =
        SaveJobSearchCampaignInputSchema.parse(rawCampaign);
      // The whole collection is rewritten from the state read here, so the
      // read-modify-write must hold the campaign transition or a concurrent
      // scheduled-run commit (run facts, rule effects, notifications, active
      // pointer) would be silently overwritten by this stale snapshot.
      await input.ctx.withCampaignTransition(async () => {
        await getState();
        const now = new Date().toISOString();
        const newCampaignId = `campaign_${randomUUID()}`;
        await input.ctx.repository.commitCampaignPreferencesUpdate(
          (current) => {
            const state = current.campaignState;
            if (!state) throw new Error("Campaign state is unavailable.");
            const existing = campaignInput.id
              ? state.campaigns.find(
                  (campaign) => campaign.id === campaignInput.id,
                )
              : null;
            const availableTargetIds = new Set(
              campaignInput.searchPreferences.discovery.targets.map(
                (target) => target.id,
              ),
            );
            const normalizedSourceTargetIds = [
              ...new Set(campaignInput.sourceTargetIds),
            ].filter((targetId) => availableTargetIds.has(targetId));
            if (campaignInput.id && !existing) {
              throw new Error(
                "The requested job search campaign no longer exists.",
              );
            }
            if (
              expectedUpdatedAt &&
              existing?.updatedAt !== expectedUpdatedAt
            ) {
              throw new Error(
                "This search plan changed while it was being edited. Read it again before saving.",
              );
            }
            if (
              !existing &&
              !["active", "paused"].includes(campaignInput.status)
            ) {
              throw new Error("New campaigns must start active or paused.");
            }
            if (
              existing?.id === state.activeCampaignId &&
              campaignInput.status === "archived"
            ) {
              throw new Error(
                "Select another campaign before archiving the active campaign.",
              );
            }

            const existingSourceIds = new Set(existing?.sourceTargetIds ?? []);
            const sourceChoicesUnchanged =
              normalizedSourceTargetIds.length === existingSourceIds.size &&
              normalizedSourceTargetIds.every((id) =>
                existingSourceIds.has(id),
              );
            const campaign = existing
              ? {
                  ...existing,
                  ...campaignInput,
                  sourceSelectionMode:
                    campaignInput.sourceSelectionMode ??
                    (sourceChoicesUnchanged
                      ? existing.sourceSelectionMode
                      : undefined) ??
                    (normalizedSourceTargetIds.length === 0
                      ? "profile"
                      : "selected"),
                  searchPreferences: {
                    ...campaignInput.searchPreferences,
                    discovery: {
                      ...campaignInput.searchPreferences.discovery,
                      targets: current.searchPreferences.discovery.targets,
                    },
                  },
                  sourceTargetIds: normalizedSourceTargetIds,
                  id: existing.id,
                  createdAt: existing.createdAt,
                  updatedAt: createMonotonicTimestamp(existing.updatedAt),
                  progress: existing.progress,
                  history: [
                    {
                      id: `campaign_history_${randomUUID()}`,
                      campaignId: existing.id,
                      kind:
                        existing.status !== campaignInput.status
                          ? campaignInput.status === "paused"
                            ? ("paused" as const)
                            : campaignInput.status === "completed"
                              ? ("completed" as const)
                              : campaignInput.status === "active"
                                ? ("resumed" as const)
                                : ("updated" as const)
                          : ("updated" as const),
                      occurredAt: now,
                      summary: `${campaignInput.name} updated.`,
                      discoveryRunId: null,
                    },
                    ...existing.history,
                  ].slice(0, 100),
                }
              : {
                  ...createCampaign({
                    id: newCampaignId,
                    name: campaignInput.name,
                    description: campaignInput.description,
                    mode: campaignInput.mode,
                    searchPreferences: campaignInput.searchPreferences,
                    now,
                  }),
                  ...campaignInput,
                  sourceSelectionMode:
                    campaignInput.sourceSelectionMode ??
                    (normalizedSourceTargetIds.length === 0
                      ? "profile"
                      : "selected"),
                  searchPreferences: {
                    ...campaignInput.searchPreferences,
                    discovery: {
                      ...campaignInput.searchPreferences.discovery,
                      targets: current.searchPreferences.discovery.targets,
                    },
                  },
                  sourceTargetIds: normalizedSourceTargetIds,
                  id: newCampaignId,
                  createdAt: now,
                  updatedAt: now,
                  jobIds: [],
                  progress: { lastUpdatedAt: now },
                };
            // The saved plan states its concrete next run immediately; it
            // used to stay empty until the next app start rebuilt the
            // schedule, so the card read "not scheduled yet" for hours.
            const scheduledCampaign = {
              ...campaign,
              schedule: {
                ...campaign.schedule,
                runFacts: resolveSavedScheduleRunFacts({
                  schedule: campaign.schedule,
                  previousSchedule: existing?.schedule ?? null,
                  isScheduledPlan: campaign.status === "active",
                  now,
                }),
              },
            };
            const currentActiveCampaign = state.campaigns.find(
              (candidate) =>
                candidate.id === state.activeCampaignId &&
                candidate.status !== "archived",
            );
            const nextState = JobSearchCampaignCollectionSchema.parse({
              notifications: state.notifications,
              activeCampaignId:
                existing || currentActiveCampaign
                  ? state.activeCampaignId
                  : campaign.id,
              campaigns: existing
                ? state.campaigns.map((candidate) =>
                    candidate.id === scheduledCampaign.id
                      ? scheduledCampaign
                      : candidate,
                  )
                : [...state.campaigns, scheduledCampaign],
            });
            return {
              result: null,
              campaignState: nextState,
              searchPreferences:
                nextState.activeCampaignId === scheduledCampaign.id
                  ? {
                      ...scheduledCampaign.searchPreferences,
                      discovery: {
                        ...scheduledCampaign.searchPreferences.discovery,
                        targets: current.searchPreferences.discovery.targets,
                      },
                    }
                  : current.searchPreferences,
            };
          },
        );
      });
      return input.getWorkspaceSnapshot();
    },

    async selectCampaign(
      campaignId: string,
    ): Promise<JobFinderWorkspaceSnapshot> {
      // The active pointer and the per-campaign history entry are written as
      // one collection save derived from the state read here; holding the
      // campaign transition keeps a concurrent scheduled-run commit or rule
      // mutation from being clobbered by this snapshot.
      await input.ctx.withCampaignTransition(async () => {
        await getState();
        const now = new Date().toISOString();
        await input.ctx.repository.commitCampaignPreferencesUpdate(
          (current) => {
            const state = current.campaignState;
            if (!state) throw new Error("Campaign state is unavailable.");
            const selected = state.campaigns.find(
              (campaign) => campaign.id === campaignId,
            );
            if (!selected || selected.status === "archived") {
              throw new Error("The selected campaign is unavailable.");
            }
            const nextState = JobSearchCampaignCollectionSchema.parse({
              notifications: state.notifications,
              activeCampaignId: selected.id,
              campaigns: state.campaigns.map((campaign) =>
                campaign.id === selected.id
                  ? {
                      ...campaign,
                      updatedAt: now,
                      history: [
                        {
                          id: `campaign_history_${randomUUID()}`,
                          campaignId: campaign.id,
                          kind: "activated",
                          occurredAt: now,
                          summary: `${campaign.name} made current.`,
                          discoveryRunId: null,
                        },
                        ...campaign.history,
                      ].slice(0, 100),
                    }
                  : campaign,
              ),
            });
            return {
              result: null,
              campaignState: nextState,
              searchPreferences: {
                ...selected.searchPreferences,
                discovery: {
                  ...selected.searchPreferences.discovery,
                  targets: current.searchPreferences.discovery.targets,
                },
              },
            };
          },
        );
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Deletes one whole search plan. Unknown ids resolve to `false` without
     * mutating anything, and the sole remaining plan is never deleted so the
     * workspace always keeps a valid active pointer. Deleting the active plan
     * hands the pointer to the first remaining non-archived plan and adopts
     * that plan's stored search preferences; deleting any other plan leaves
     * the pointer and preferences untouched. Campaign-scoped facts persisted
     * outside the campaign collection (append-only rapid review logs in
     * intelligence state, discovery run records) are preserved.
     */
    async deleteCampaign(
      rawInput: DeleteJobSearchCampaignInput,
    ): Promise<boolean> {
      const request = DeleteJobSearchCampaignInputSchema.parse(rawInput);
      return input.ctx.withCampaignTransition(async () => {
        const state = await getState();
        const campaign = state.campaigns.find(
          (candidate) => candidate.id === request.campaignId,
        );
        if (!campaign) return false;
        if (
          request.expectedUpdatedAt &&
          campaign.updatedAt !== request.expectedUpdatedAt
        )
          return false;
        const remaining = state.campaigns.filter(
          (candidate) => candidate.id !== campaign.id,
        );
        if (remaining.length === 0) return false;
        const successor =
          campaign.id === state.activeCampaignId
            ? (remaining.find((candidate) => candidate.status !== "archived") ??
              null)
            : null;
        if (campaign.id === state.activeCampaignId && !successor) {
          // Refuse rather than leave the active pointer on an archived plan.
          return false;
        }
        await input.ctx.repository.saveCampaignState(
          JobSearchCampaignCollectionSchema.parse({
            notifications: state.notifications,
            activeCampaignId: successor ? successor.id : state.activeCampaignId,
            campaigns: remaining,
          }),
        );
        if (successor) {
          await input.ctx.repository.saveSearchPreferences(
            successor.searchPreferences,
          );
        }
        return true;
      });
    },

    /**
     * Manual campaign run. Works regardless of the schedule's `enabled` flag
     * or pause windows, but still obeys the global activity pause and the
     * campaign's own status.
     */
    async runCampaignNow(
      rawInput?: RunCampaignNowInput,
      onActivity?: (event: DiscoveryActivityEvent) => void,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request = RunCampaignNowInputSchema.parse(rawInput ?? {});
      // "Run now" is an explicit click: it resumes paused background work
      // instead of failing. Scheduled runs go through runDueScheduledCampaigns,
      // which still obeys the pause.
      await input.ctx.resumeActivityForExplicitStart();
      const campaign = await resolveCampaignForRun({
        ctx: input.ctx,
        campaignId: request.campaignId ?? null,
      });
      // A plan with every source switched off — or whose only source was
      // removed from Profile — used to stop here without a run, leaving an
      // older "Last run succeeded" as the newest thing the app had said. The
      // discovery pipeline now starts and ends a failed run for the same
      // condition, so the refusal is recorded where the plan card, Find jobs
      // and Home all read it.
      await executeCampaignRun({
        ctx: input.ctx,
        campaign,
        runCampaignDiscovery: input.runCampaignDiscovery,
        now: new Date().toISOString(),
        ...(onActivity ? { onActivity } : {}),
        trigger: "manual",
      });
      return input.afterCampaignRun(campaign.id);
    },

    /**
     * Scheduled campaign ticker. For every active campaign with an enabled,
     * non-manual schedule it runs once when the persisted `nextRunAt` is due
     * (`<= now`, including overdue catch-up). The due slot is claimed with a
     * compare-and-set inside the campaign transition before any work starts,
     * so only one scheduled run can ever execute a due slot even when ticks
     * overlap or an edit/select/save serializes in between, and the claim
     * returns the freshly validated campaign so execution uses the budget and
     * preferences current at claim time rather than this tick's outer
     * snapshot. A missing
     * `nextRunAt` (including a claimed slot whose run never committed, e.g.
     * after a crash) is initialized truthfully without immediate work. Pause
     * windows and the global activity pause suppress runs; a concurrent
     * discovery run releases its claimed slot and is retried next tick.
     */
    async runDueScheduledCampaigns(
      rawNow?: string,
      onActivity?: (event: DiscoveryActivityEvent) => void,
    ): Promise<JobFinderWorkspaceSnapshot> {
      await processDueScheduledCampaigns(rawNow, onActivity);
      return input.getWorkspaceSnapshot();
    },

    processDueScheduledCampaigns,

    /**
     * Marks a single in-app campaign notification read. Unknown ids and
     * invalid read timestamps are a no-op; the flip is serialized through the
     * campaign transition so it never interleaves with a scheduled-run commit.
     */
    async markCampaignNotificationRead(
      rawInput: MarkCampaignNotificationReadInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request = MarkCampaignNotificationReadInputSchema.parse(rawInput);
      await input.ctx.withCampaignTransition(async () => {
        const state = await input.ctx.repository.getCampaignState();
        if (!state) return;
        const notifications = markCampaignNotificationRead({
          notifications: state.notifications,
          notificationId: request.notificationId,
          readAt: request.readAt,
        });
        await input.ctx.repository.saveCampaignState(
          JobSearchCampaignCollectionSchema.parse({
            ...state,
            notifications,
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Marks every unread in-app campaign notification read. Already-read
     * notifications keep their original read timestamps; the flip is
     * serialized through the campaign transition so it never interleaves with
     * a scheduled-run commit. An invalid read timestamp is a no-op.
     */
    async markAllCampaignNotificationsRead(
      rawInput: MarkAllCampaignNotificationsReadInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request =
        MarkAllCampaignNotificationsReadInputSchema.parse(rawInput);
      await input.ctx.withCampaignTransition(async () => {
        const state = await input.ctx.repository.getCampaignState();
        if (!state) return;
        const notifications = markAllCampaignNotificationsRead({
          notifications: state.notifications,
          readAt: request.readAt,
        });
        await input.ctx.repository.saveCampaignState(
          JobSearchCampaignCollectionSchema.parse({
            ...state,
            notifications,
          }),
        );
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Creates or updates one campaign rule. A new rule starts with an
     * unmeasured (zeroed) effect; an update preserves previously measured
     * remove/downgrade counts unless the caller explicitly replaces them.
     */
    async saveCampaignRule(
      rawInput: SaveCampaignRuleRouteInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request = SaveCampaignRuleRouteInputSchema.parse(rawInput);
      const now = new Date().toISOString();
      await input.ctx.withCampaignTransition(async () => {
        const state = await input.ctx.repository.getCampaignState();
        if (!state) {
          throw new Error("The job search campaign workspace is unavailable.");
        }
        const campaign = state.campaigns.find(
          (candidate) => candidate.id === request.campaignId,
        );
        if (!campaign) {
          throw new Error(
            "The requested job search campaign no longer exists.",
          );
        }
        const existing = request.rule.id
          ? campaign.rules.find((rule) => rule.id === request.rule.id)
          : null;
        if (request.rule.id && !existing) {
          throw new Error("The campaign rule no longer exists.");
        }
        const rules = existing
          ? campaign.rules.map((rule) =>
              rule.id === existing.id
                ? CampaignRuleSchema.parse({
                    ...rule,
                    ...request.rule,
                    id: existing.id,
                    effect: isDefaultCampaignRuleEffect(request.rule.effect)
                      ? rule.effect
                      : request.rule.effect,
                  })
                : rule,
            )
          : [
              ...campaign.rules,
              CampaignRuleSchema.parse({
                ...request.rule,
                id: `campaign_rule_${randomUUID()}`,
                effect: {},
              }),
            ];
        if (rules.length > 200) {
          throw new Error("A campaign can hold at most 200 rules.");
        }
        await persistCampaignRuleChange({
          ctx: input.ctx,
          state,
          campaign,
          rules,
          now,
          summary: existing ? "Campaign rule updated." : "Campaign rule added.",
        });
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Removes one campaign rule by id. Unknown rules and campaigns are
     * surfaced as errors instead of silently mutating state.
     */
    async deleteCampaignRule(
      rawInput: DeleteCampaignRuleInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request = DeleteCampaignRuleInputSchema.parse(rawInput);
      const now = new Date().toISOString();
      await input.ctx.withCampaignTransition(async () => {
        const state = await input.ctx.repository.getCampaignState();
        if (!state) {
          throw new Error("The job search campaign workspace is unavailable.");
        }
        const campaign = state.campaigns.find(
          (candidate) => candidate.id === request.campaignId,
        );
        if (!campaign) {
          throw new Error(
            "The requested job search campaign no longer exists.",
          );
        }
        if (!campaign.rules.some((rule) => rule.id === request.ruleId)) {
          throw new Error("The campaign rule no longer exists.");
        }
        await persistCampaignRuleChange({
          ctx: input.ctx,
          state,
          campaign,
          rules: campaign.rules.filter((rule) => rule.id !== request.ruleId),
          now,
          summary: "Campaign rule removed.",
        });
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Toggles one campaign rule's enabled/disabled state. Disabled rules are
     * preserved with their history but are never evaluated by discovery or by
     * the funnel projection.
     */
    async toggleCampaignRule(
      rawInput: ToggleCampaignRuleInput,
    ): Promise<JobFinderWorkspaceSnapshot> {
      const request = ToggleCampaignRuleInputSchema.parse(rawInput);
      const now = new Date().toISOString();
      await input.ctx.withCampaignTransition(async () => {
        const state = await input.ctx.repository.getCampaignState();
        if (!state) {
          throw new Error("The job search campaign workspace is unavailable.");
        }
        const campaign = state.campaigns.find(
          (candidate) => candidate.id === request.campaignId,
        );
        if (!campaign) {
          throw new Error(
            "The requested job search campaign no longer exists.",
          );
        }
        if (!campaign.rules.some((rule) => rule.id === request.ruleId)) {
          throw new Error("The campaign rule no longer exists.");
        }
        await persistCampaignRuleChange({
          ctx: input.ctx,
          state,
          campaign,
          rules: campaign.rules.map((rule) =>
            rule.id === request.ruleId
              ? CampaignRuleSchema.parse({ ...rule, enabled: request.enabled })
              : rule,
          ),
          now,
          summary: request.enabled
            ? "Campaign rule enabled."
            : "Campaign rule disabled.",
        });
      });
      return input.getWorkspaceSnapshot();
    },

    /**
     * Read-only projection of how the campaign's rules treat its currently
     * retained jobs. Uses `evaluateCampaignRules`/`estimateCampaignFunnel`
     * ONLY against real persisted jobs referenced by the campaign; when the
     * campaign retains no jobs the funnel is zeroed instead of fabricated.
     */
    async projectCampaignRuleFunnel(
      rawInput: ProjectCampaignRuleFunnelInput,
    ): Promise<CampaignRuleFunnelProjection> {
      const request = ProjectCampaignRuleFunnelInputSchema.parse(rawInput);
      const [state, savedJobs] = await Promise.all([
        input.ctx.repository.getCampaignState(),
        input.ctx.repository.readSavedJobsProjection(),
      ]);
      const campaign = state?.campaigns.find(
        (candidate) => candidate.id === request.campaignId,
      );
      if (!campaign) {
        throw new Error("The requested job search campaign no longer exists.");
      }
      const campaignJobIds = new Set(campaign.jobIds);
      const sample = savedJobs.filter((job) => campaignJobIds.has(job.id));
      const measuredAt = new Date().toISOString();
      const evaluatedRules = evaluateCampaignRules({
        rules: campaign.rules,
        jobs: sample,
        measuredAt,
      });
      const funnel = estimateCampaignFunnel({
        rules: campaign.rules,
        jobs: sample,
        measuredAt,
      });
      return CampaignRuleFunnelProjectionSchema.parse({
        campaignId: campaign.id,
        generatedAt: measuredAt,
        rules: evaluatedRules.map((entry) => ({
          ...entry.rule,
          effect: entry.effect,
        })),
        disabledRuleIds: campaign.rules
          .filter((rule) => !rule.enabled)
          .map((rule) => rule.id),
        funnel,
      });
    },
  };
}
