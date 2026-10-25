import {
  describeDiscoveryRunFailureReason,
  DiscoveryRunReportSchema,
  formatDiscoveryAccounting,
  JobSearchCampaignCollectionSchema,
  JobSearchCampaignSchema,
  type ApplicationAttempt,
  type ApplicationRecord,
  type ApplicationStatus,
  type ApplyJobResult,
  type ApplyRun,
  type DiscoveryRunRecord,
  type DiscoveryRunReport,
  type JobSearchCampaign,
  type ResumeDraft,
  type SavedJob,
  type TailoredAsset,
} from "@nestor/contracts";
import { yieldToEventLoop } from "@nestor/core";
import { isDeepStrictEqual } from "node:util";
import { countDiscoveryStrongMatches } from "../discovery-result-bands";
import { deriveDiscoverySourceOutcome } from "../source-health";
import { persistAutomaticDiscoverySafeguard } from "./automatic-safeguards";
import {
  personPickedJob,
  readPlanAssessment,
  withPlanAssessment,
} from "./plan-assessment";
import {
  applyDiscoveryRunRetentionCounts,
  buildDiscoveryRunReport,
} from "./workspace-discovery-run-helpers";
import type { WorkspaceServiceContext } from "./workspace-service-context";

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
 * The history summary for a finished run quotes the run's own frozen
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

/** Saved jobs whose plan membership one transaction rewrites. */
const MEMBERSHIP_ROWS_PER_COMMIT = 12;

/** Records the finished search, its retained jobs, and its frozen report. */
export async function commitCampaignRunTerminal(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  beforeJobProvenanceFingerprints?: ReadonlyMap<string, string>;
  beforeCampaignJobIds?: readonly string[];
  now: string;
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
      input.ctx.repository.readDiscoveryStateForRun?.() ??
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
    const latestRun: DiscoveryRunRecord = {
      ...recordedRun,
      summary: {
        ...recordedRun.summary,
        // Failed, skipped, and cancelled sources are terminal, but they are
        // not completed. Persist the canonical denominator so Home, history,
        // and Find jobs stop reporting a failed source inside "3 of 3".
        targetsCompleted: sourceOutcome.completed,
      },
    };

    if (latestRun.state === "idle" || latestRun.state === "running") return;

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
    // Discovery already revalidated the inventory and persisted this plan's
    // verdicts. Closing the run only consumes them; it never scores again.
    const candidateJobs = candidates.map((job) =>
      readPlanAssessment(withPlanAssessment(job, campaign.id), campaign.id),
    );
    const assessedById = new Map(candidateJobs.map((job) => [job.id, job]));
    const measuredAt = latestRun.completedAt ?? latestRun.startedAt;
    const rankedRetainedJobIds = candidateJobs
      .filter(
        (job) =>
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
    // entry and every screen — reads
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
    const alreadyRecorded = campaign.history.some(
      (entry) => entry.discoveryRunId === latestRun.id,
    );
    const nextCampaign = JobSearchCampaignSchema.parse({
      ...campaign,
      jobIds: retainedJobIds,
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
    const changedSavedJobIds: string[] = [];
    for (const [position, job] of currentSavedJobs.entries()) {
      if (position % 80 === 0) await yieldToEventLoop();
      const assessed = assessedById.get(job.id);
      if (
        !isDeepStrictEqual(nextCampaignIds(job), job.campaignIds ?? []) ||
        (assessed?.planAssessments !== undefined &&
          !isDeepStrictEqual(
            job.planAssessments?.[campaign.id],
            assessed.matchAssessment,
          ))
      )
        changedSavedJobIds.push(job.id);
    }
    const updateCampaignMembership = (job: SavedJob): SavedJob => {
      return {
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
      };
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
        borrowCurrentJobs: true,
        update: updateCampaignMembership,
        updateJobIds: part,
      });
      await yieldToEventLoop();
    }
    await input.ctx.repository.commitSavedJobDelta({
      borrowCurrentJobs: true,
      update: updateCampaignMembership,
      updateJobIds: lastMembershipPart,
      updateDiscoveryState: (current) => ({
        ...current,
        activeRun:
          current.activeRun && current.activeRun.id === latestRun.id
            ? applyDiscoveryRunRetentionCounts(
                {
                  ...current.activeRun,
                  summary: {
                    ...current.activeRun.summary,
                    targetsCompleted: sourceOutcome.completed,
                  },
                },
                retentionCounts,
              )
            : current.activeRun,
        recentRuns: current.recentRuns.map((run) =>
          run.id === latestRun.id
            ? applyDiscoveryRunRetentionCounts(
                {
                  ...run,
                  summary: {
                    ...run.summary,
                    targetsCompleted: sourceOutcome.completed,
                  },
                },
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
        ...state,
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

/** Records manual discovery on the internal default campaign. */
export async function recordCampaignDiscoveryResult(input: {
  ctx: WorkspaceServiceContext;
  campaignId: string;
  beforeJobProvenanceFingerprints?: ReadonlyMap<string, string>;
  beforeCampaignJobIds?: readonly string[];
}): Promise<void> {
  await commitCampaignRunTerminal({
    ctx: input.ctx,
    campaignId: input.campaignId,
    ...(input.beforeCampaignJobIds
      ? { beforeCampaignJobIds: input.beforeCampaignJobIds }
      : {}),
    now: new Date().toISOString(),
  });
}
