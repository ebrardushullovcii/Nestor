import { JobFinderDiscoveryCancellationInputSchema } from "@nestor/contracts";
import { holdDiscoveryWorkspaceUpdates } from "../services/job-finder/workspace-updates";
import { buildWorkspaceFileExport } from "../services/job-finder/workspace-file-exports";
import { readJobFinderJobDetail } from "../services/job-finder/read-job-detail";
import {
  JOB_FINDER_ACTIONS,
  executeJobFinderAction,
  type JobFinderActionId,
} from "@nestor/job-finder";
import {
  ApplicationPageStatesInputSchema,
  ApplicationPageStatesSchema,
  ReopenApplicationPageInputSchema,
  ApplicationPageStateSchema,
  ApplicationPageReopenProgressSchema,
} from "@nestor/contracts";
import { getApplicationPageAccessForWorkspaceService } from "../services/job-finder/create-workspace-service";
import {
  ResumeBatchGenerationInputSchema,
  ResumeBatchGenerationResultSchema,
  ResumeBatchGenerationProgressSchema,
} from "@nestor/contracts";
import {
  readUiResumeBatch,
  blockUiResumeBatch,
  invalidateUiResumeBatch,
} from "../services/assistant/ui-resume-batch";
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";
import { resetJobFinderBrowser } from "../services/job-finder/reset-workspace";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  parsePersonalWorkspaceExport,
  restorePersonalWorkspace,
} from "../services/job-finder/personal-workspace-restore";
import {
  getJobFinderDocumentsDirectory,
  getCandidateAssetsDirectory,
  getApplicationDocumentsDirectory,
} from "../services/job-finder/paths";
import path from "node:path";
import { access } from "node:fs/promises";
import { createConcurrencyLimiter } from "@nestor/core";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import type {
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  SaveDialogOptions,
} from "electron";
import {
  type PersonalWorkspaceExport,
  PersonalWorkspaceRestorePreviewSchema,
  ConfirmPersonalWorkspaceRestoreSchema,
  PersonalWorkspaceRestoreResultSchema,
  ApplicationCrmExportInputSchema,
  ApplicationCrmFileExportResultSchema,
  ApplicationCrmSettingsSchema,
  ApplicationPacketSchema,
  ApplyGroupedManualAnswerInputSchema,
  ApplyRunDetailsSchema,
  DiscoveryActivityEventSchema,
  DesktopTestOkResponseSchema,
  JobFinderAgentDiscoveryActionInputSchema,
  JobFinderApplicationPacketExportResultSchema,
  JobFinderApplyCopilotActionInputSchema,
  JobFinderApplyConsentActionInputSchema,
  JobFinderApplyQueueActionInputSchema,
  JobFinderApplyRunActionInputSchema,
  JobFinderApplyRunDetailsQuerySchema,
  JobFinderApplicationStartTargetSchema,
  JobFinderPreviewResumeDraftInputSchema,
  JobFinderResumePreviewSchema,
  JobFinderResumePreviewModeSchema,
  JobFinderRepositoryStateSchema,
  JobFinderStartupDatabaseRecoveryFactSchema,
  JobFinderStartupResetRecoveryFactSchema,
  ResumeQualityBenchmarkRequestSchema,
  ResumeImportBenchmarkRequestSchema,
  JobFinderResumeWorkspaceQuerySchema,
  JobFinderResumeWorkspaceSchema,
  JobFinderExportResumePdfInputSchema,
  JobFinderResumePdfExportOutcomeSchema,
  JobFinderJobActionInputSchema,
  JobFinderSendPreparedApplicationsInputSchema,
  JobFinderPreparedApplicationPageInputSchema,
  RevealSavedFileInputSchema,
  RevealSavedFileResultSchema,
  JobFinderOpenBrowserSessionInputSchema,
  JobFinderPerformanceSnapshotSchema,
  JobFinderDiagnosticExportResultSchema,
  JobFinderSourceDebugActionInputSchema,
  JobFinderSourceInstructionActionInputSchema,
  SaveJobFinderWorkspaceInputSchema,
  ProjectGroupedManualAnswerCommandSchema,
  SourceDebugProgressEventSchema,
  JobFinderWorkspaceEntityMutationInputSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobFinderJobDetailQuerySchema,
  JobFinderTailoredAssetQuerySchema,
  JobFinderTailoredAssetDetailSchema,
  JobFinderWorkspaceSyncInputSchema,
  JobFinderWorkspaceHeldRevisionSchema,
  RunCampaignNowInputSchema,
  MarkCampaignNotificationReadInputSchema,
  ResumeImportBenchmarkReportSchema,
  ResumeImportBenchmarkCaseSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ImportResumeRequestSchema,
  CancelResumeImportRequestSchema,
  ResumeImportProgressEventSchema,
  ResumeImportRunSchema,
  ResumeQualityBenchmarkReportSchema,
  SaveApplicationAnswerCommandSchema,
  SaveUserActionAnswerDraftInputSchema,
  UserActionCommandSchema,
  WriteClipboardTextInputSchema,
  WriteClipboardTextResultSchema,
} from "@nestor/contracts";
import type {
  JobFinderAgentDiscoveryReply,
  JobFinderApplyQueueActionInput,
  JobFinderWorkspaceSnapshot,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
  JobFinderResumePdfExportReply,
} from "@nestor/contracts";
import {
  JobFinderApplyQueueControlInputSchema,
  JobFinderRemoveFromApplyQueueInputSchema,
  JobFinderApproveResumesInputSchema,
  JobFinderStartApplyQueueInputSchema,
  type ApplicationAutomationMode,
  type ApplyQueueSkippedJob,
} from "@nestor/contracts";
import {
  MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
  deriveGlobalDailyApplicationPreparationCapacity,
  recordApplicationAuthoritySuccessor,
  resolveApplicationAuthoritySuccessorId,
  resolveTailoredAssetLabel,
  withApplicationAuthorityGate,
} from "@nestor/job-finder";
import {
  createApplyQueueRunner,
  type ApplyQueueRunner,
  type ApplyQueueStartedRun,
} from "../services/job-finder/apply-queue-runner";
import {
  buildPersonalWorkspaceExport,
  personalWorkspaceExportFileName,
} from "../services/job-finder/build-diagnostic-export";
import { collectJobFinderPerformanceSnapshot } from "../services/job-finder/collect-performance-snapshot";
import { createJobFinderWorkspaceDeltaTracker } from "../services/job-finder/workspace-delta";
import { toRendererWorkspaceSnapshot } from "../services/job-finder/renderer-workspace-view";
import { usesWorkspaceQueryUpdates } from "../services/job-finder/query-update-mode";
import {
  notifyJobFinderWorkspaceListeners,
  createSearchProgressPublisher,
  publishJobFinderWorkspaceUpdate,
  scheduleAnswerDraftWorkspaceUpdate,
  withJobFinderWorkspaceUpdates,
} from "../services/job-finder/workspace-updates";
import { runBoundedNewSourceReadabilityCheck } from "../services/job-finder/new-source-readability-check";
import type { ApplyQueue } from "@nestor/contracts";
import { getFinishedWorkNotifier } from "../setup/finished-work-notifier-instance";
import {
  applyQueueFinishedNotice,
  searchFinishedNotice,
} from "../setup/finished-work-notices";
import {
  listJobsNotInProgress,
  startApplyBatch,
} from "../services/job-finder/start-apply-batch";
import {
  getJobFinderApplicationAuthorityService,
  getJobFinderRepositoryForWorkspaceService,
  getJobFinderWorkspaceService,
  importResumeFromSourcePath,
  retryInterruptedResumeImport,
  isDesktopTestApiEnabled,
  loadApplyQueueDemoState,
  loadAgentOwnedBrowserDriveState,
  loadResumeWorkspaceDemoState,
  loadWorkHistoryReviewDriveState,
  parseResumeImportPathPayload,
  resetJobFinderWorkspace,
  getJobFinderStartupResetRecoveryFact,
  dismissJobFinderStartupDatabaseRecoveryNotice,
  getJobFinderStartupDatabaseRecoveryFact,
  runDesktopResumeQualityBenchmark,
  runDesktopResumeImportBenchmark,
  defaultBenchmarkCases,
  setJobFinderWorkspaceServiceTestEnv,
} from "../services/job-finder";
import {
  armJobFinderTestSaveFailure,
  consumeArmedJobFinderTestSaveFailure,
  type JobFinderSaveChannel,
} from "../services/job-finder/test-save-failure";
import { registerJobFinderBootstrapDesktopRoutes } from "../setup/register-job-finder-bootstrap-routes";

function parseAgentDiscoveryRequest(payload: unknown) {
  return JobFinderAgentDiscoveryActionInputSchema.parse(payload);
}

function canonicalOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns the saved plain-language apply mode into one current, task-scoped
 * authority. Settings never stores an empty envelope: the exact jobs,
 * resumes, and known application origins only exist when the task starts.
 */
export async function syncApplicationAuthorityForSavedMode(
  workspaceService: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
  jobIds: readonly string[],
  modeOverride?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
  /**
   * Sending forms filled in earlier: they belong to a run that may hold
   * more jobs than this press, and each send counts against that run.
   */
  perRunFloor = 0,
): Promise<void> {
  const repository =
    getJobFinderRepositoryForWorkspaceService(workspaceService);
  if (!repository) return;

  const settings = await repository.getSettings();
  const mode =
    modeOverride ?? settings.applicationAutomationMode ?? "prepare_only";
  const authorityService = getJobFinderApplicationAuthorityService();
  const active = (await authorityService.list({ status: "active" }))[0] ?? null;

  if (mode === "prepare_only") {
    if (active && active.mode !== "prepare_only") {
      let current = active;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const revoked = await authorityService.revoke({
          id: current.id,
          expectedRevision: current.revision,
        });
        if (
          revoked.status === "applied" ||
          revoked.status === "missing" ||
          revoked.current?.status === "revoked"
        )
          return;
        current =
          (await authorityService.list({ status: "active" }))[0] ?? current;
      }
      throw new Error(
        "Job Finder could not turn off sending. Try Fill-in only again.",
      );
    }
    return;
  }

  const [profileState, jobs] = await Promise.all([
    repository.getProfileWithRevision(),
    repository.listSavedJobs(),
  ]);
  const selectedJobs = jobs.filter((job) => jobIds.includes(job.id));
  if (selectedJobs.length !== new Set(jobIds).size) {
    throw new Error(
      "Job Finder could not create permission for every application in this batch, so nothing was started.",
    );
  }
  const resumeDigests: string[] = [];
  const scopedJobIds: string[] = [];
  const origins: string[] = [];

  for (const job of selectedJobs) {
    const usesOriginalResume =
      (job.resumeApplicationMode ??
        settings.resumeApplicationMode ??
        "tailored_per_job") === "original_resume";
    const exports = usesOriginalResume
      ? []
      : await repository.listResumeExportArtifacts({ jobId: job.id });
    const latestApproved = exports
      .filter((artifact) => artifact.isApproved && Boolean(artifact.sha256))
      .sort((left, right) =>
        right.exportedAt.localeCompare(left.exportedAt),
      )[0];
    const resumeSha256 = (
      usesOriginalResume
        ? profileState.profile.baseResume.sha256
        : latestApproved?.sha256
    )
      ?.trim()
      .toLowerCase();
    if (!resumeSha256) {
      throw new Error(
        `The approved application resume for '${job.title}' is not ready, so this batch was not started. Try Apply again after the resume is ready.`,
      );
    }

    const jobOrigins = [job.applicationUrl, job.canonicalUrl]
      .map((value) => canonicalOrigin(value))
      .filter((value): value is string => value !== null);
    if (jobOrigins.length === 0) {
      throw new Error(
        `The application site for '${job.title}' is not ready, so this batch was not started.`,
      );
    }
    scopedJobIds.push(job.id);
    resumeDigests.push(resumeSha256);
    origins.push(...jobOrigins);
  }

  const uniqueJobIds = [...new Set(scopedJobIds)];
  const uniqueDigests = [...new Set(resumeDigests)];
  const uniqueOrigins = [...new Set(origins)];
  if (
    uniqueJobIds.length === 0 ||
    uniqueDigests.length === 0 ||
    uniqueOrigins.length === 0
  ) {
    throw new Error(
      "Job Finder could not create permission for every application in this batch, so nothing was started.",
    );
  }

  if (uniqueJobIds.length !== new Set(jobIds).size) {
    throw new Error(
      "Job Finder could not create permission for every application in this batch, so nothing was started.",
    );
  }

  // The switch in Settings is the approval of the person's current answers
  // (ADR 0022). A profile write that lands between the read and the approval
  // makes it stale once; a second attempt reads the fresh revision. Anything
  // else is said plainly: this used to return silently, and Send for me then
  // ran as Fill-in without a word.
  let answerApproval = await authorityService.approveCurrentAnswers({
    expectedProfileRevision: profileState.revision,
    confirmedCurrentAnswers: true,
  });
  if (answerApproval.status === "stale") {
    const fresh = await repository.getProfileWithRevision();
    answerApproval = await authorityService.approveCurrentAnswers({
      expectedProfileRevision: fresh.revision,
      confirmedCurrentAnswers: true,
    });
  }
  if (
    answerApproval.status !== "created" &&
    answerApproval.status !== "duplicate"
  ) {
    throw new Error(
      "Job Finder could not confirm your saved answers, so it did not start. Try again in a moment.",
    );
  }

  const dailyCap = settings.maxApplicationsPerLocalDay ?? 20;
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const policyFor = (current: typeof active) => {
    // A different mode is a different choice by the person. Do not carry
    // jobs approved under Ask before sending into Send for me.
    const sameMode = current?.mode === mode ? current : null;
    return {
      mode,
      scope: {
        campaignId: null,
        jobIds: [
          ...new Set([...(sameMode?.scope.jobIds ?? []), ...uniqueJobIds]),
        ].slice(-1000),
      },
      maxApplicationsPerRun: Math.max(
        sameMode?.maxApplicationsPerRun ?? 0,
        Math.min(dailyCap, Math.max(1, jobIds.length, perRunFloor)),
      ),
      maxApplicationsPerLocalDay: dailyCap,
      intermediateMutationsAuthorized: true,
      preApprovedAttestationKinds:
        sameMode?.decisionPolicy?.answerPolicy.preApprovedAttestationKinds ??
        [],
      salaryDisclosure:
        current?.decisionPolicy?.answerPolicy.salaryDisclosure ??
        "pause_for_user",
      allowedResumeSha256: [
        ...new Set([
          ...(sameMode?.allowedResumeSha256 ?? []),
          ...uniqueDigests,
        ]),
      ].slice(-1000),
      allowedOrigins: [
        ...new Set([...(sameMode?.allowedOrigins ?? []), ...uniqueOrigins]),
      ].slice(-1000),
      expiresAt,
    } as const;
  };

  // Approving the answers above can move the envelope's revision, so the
  // update reads it again just before writing. A stale update used to be
  // ignored: the person switched to Ask before sending, or applied to a new
  // job, and the envelope silently kept its old mode and scope, so the run
  // narrowed itself to fill-in without a word.
  await withApplicationAuthorityGate(repository, undefined, async () => {
    // A queued start must not restore a mode the person changed while it
    // waited behind a final send.
    const latestSettings = await repository.getSettings();
    if (
      (latestSettings.applicationAutomationMode ?? "prepare_only") !==
      (settings.applicationAutomationMode ?? "prepare_only")
    )
      return;
    const firstCurrent =
      (await authorityService.list({ status: "active" }))[0] ?? null;
    if (
      active &&
      firstCurrent?.id !==
        resolveApplicationAuthoritySuccessorId(repository, active.id)
    )
      return;
    let expectedActiveId = firstCurrent?.id ?? null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current =
        (await authorityService.list({ status: "active" }))[0] ?? null;
      if (
        expectedActiveId &&
        current?.id !==
          resolveApplicationAuthoritySuccessorId(repository, expectedActiveId)
      )
        return;
      if (!current) {
        try {
          const created = await authorityService.create(policyFor(null));
          if (created.status === "applied") return;
        } catch (error) {
          // Another application may have created the active grant after the
          // list. Retry with that grant's current scope instead of dropping it.
          if ((await authorityService.list({ status: "active" })).length === 0)
            throw error;
        }
        continue;
      }
      expectedActiveId = current.id;

      const mutation = await authorityService.update({
        ...policyFor(current),
        id: current.id,
        expectedRevision: current.revision,
      });
      if (mutation.status === "applied") return;
      const fresh = (await authorityService.list({ status: "active" }))[0];
      if (
        expectedActiveId &&
        fresh?.id !==
          resolveApplicationAuthoritySuccessorId(repository, expectedActiveId)
      )
        return;
      if (
        !fresh ||
        fresh.id !== current.id ||
        fresh.revision !== current.revision
      )
        continue;

      // A used envelope cannot be edited. Replace that exact revision in
      // one transition, without leaving a gap between revoking and creating.
      const currentSettings = await repository.getSettings();
      if (
        (currentSettings.applicationAutomationMode ?? "prepare_only") !==
        (settings.applicationAutomationMode ?? "prepare_only")
      )
        return;
      const replaced = await authorityService.replaceUsed({
        ...policyFor(fresh),
        id: fresh.id,
        expectedRevision: fresh.revision,
      });
      if (replaced.status === "applied") {
        recordApplicationAuthoritySuccessor(
          repository,
          fresh.id,
          replaced.envelope.id,
        );
        return;
      }
    }
    throw new Error(
      "Job Finder could not record your applying permission for this job, so it did not start. Try again in a moment.",
    );
  });
}

/**
 * A form filled in under Prepare for me has no sending permission. Once the
 * person chose Send for me (or Ask before sending), their saved mode covers
 * it: the permission is scoped to these jobs first, as a batch start would,
 * sized for the whole run the forms were filled in by (each send counts
 * against that run), so the agent can press Send on each kept page.
 */
/** The requested jobs whose newest result is a filled-in form not yet sent. */
export async function listJobsStillReadyToSend(
  workspaceService: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
  jobIds: readonly string[],
): Promise<string[]> {
  const repository =
    getJobFinderRepositoryForWorkspaceService(workspaceService);
  if (!repository) return [...jobIds];
  const results = await repository.listApplyJobResults();
  return [...new Set(jobIds)].filter((jobId) => {
    const latest = results
      .filter((result) => result.jobId === jobId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return (
      latest?.state === "awaiting_review" &&
      latest.privacyReceipt?.submissionOutcome?.outcome !== "submitted" &&
      latest.privacyReceipt?.submissionOutcome?.outcome !== "outcome_uncertain"
    );
  });
}

export async function scopeSendPermissionToPreparedJobs(
  workspaceService: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
  jobIds: readonly string[],
  /**
   * A written instruction in the assistant sidebar that says to send
   * (ADR 0039) stands in for the Send press, whatever the saved mode.
   */
  modeOverride?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
): Promise<void> {
  const repository =
    getJobFinderRepositoryForWorkspaceService(workspaceService);
  if (!repository) return;
  const settings = await repository.getSettings();
  if (
    !modeOverride &&
    (settings.applicationAutomationMode ?? "prepare_only") === "prepare_only"
  )
    return;
  const [runs, results] = await Promise.all([
    repository.listApplyRuns(),
    repository.listApplyJobResults(),
  ]);
  const runIds = new Set(
    results
      .filter((result) => jobIds.includes(result.jobId))
      .map((result) => result.runId),
  );
  const perRunFloor = Math.max(
    0,
    ...runs.filter((run) => runIds.has(run.id)).map((run) => run.jobIds.length),
  );
  await syncApplicationAuthorityForSavedMode(
    workspaceService,
    jobIds,
    modeOverride,
    perRunFloor,
  );
}

/**
 * Apply and Try again approve Light and Tailored resumes. Each entry point
 * performs the same export-and-approve sequence before
 * submission authority is scoped from approved export hashes.
 */
/** A job whose resume Apply could not approve, and the sentence saying why. */
export interface HeldBackApplicationResume {
  jobId: string;
  title: string;
  reason: string;
}

// Shared by bulk presses: overlapping presses cannot multiply print workers.
const resumeApprovals = createConcurrencyLimiter(2);

export async function approveApplicationResumes(
  workspaceService: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
  jobIds: readonly string[],
  options?: {
    /**
     * A batch press holds back only the jobs whose resume waits on the
     * person (an unapproved Aggressive resume, a line still to decide) and
     * approves the rest; a single-job press refuses with the same sentence.
     */
    holdBackResumesAwaitingPerson?: boolean;
    /**
     * The person pressed Approve for exactly these resumes: that press is
     * the Aggressive approval, and one resume that cannot be approved is
     * held back with its reason instead of stopping the others.
     */
    personApproved?: boolean;
    onProgress?: (done: number) => void;
  },
): Promise<HeldBackApplicationResume[]> {
  const heldBack: HeldBackApplicationResume[] = [];
  const holdBack = (job: { id: string; title: string }, reason: string) => {
    if (!options?.holdBackResumesAwaitingPerson) throw new Error(reason);
    heldBack.push({ jobId: job.id, title: job.title, reason });
  };
  const repository =
    getJobFinderRepositoryForWorkspaceService(workspaceService);
  if (!repository) {
    throw new Error(
      "Job Finder could not open the application workspace, so nothing was started.",
    );
  }

  const [jobs, settings, searchPreferences] = await Promise.all([
    repository.listSavedJobs(),
    repository.getSettings(),
    repository.getSearchPreferences(),
  ]);

  const uniqueJobIds = [...new Set(jobIds)];
  let completed = 0;
  async function approveSelected(jobId: string) {
    const job = jobs.find((candidate) => candidate.id === jobId) ?? null;
    if (!job) {
      throw new Error(
        "Job Finder could not find a selected application, so nothing was started.",
      );
    }
    if (options?.personApproved) {
      try {
        await approveOneApplicationResume(job, { personApproved: true });
      } catch (error: unknown) {
        heldBack.push({
          jobId: job.id,
          title: job.title,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      options?.onProgress?.(++completed);
      return;
    }
    await approveOneApplicationResume(job, {});
  }
  if (options?.personApproved) {
    await Promise.all(
      uniqueJobIds.map((jobId) =>
        resumeApprovals.run(() => approveSelected(jobId)),
      ),
    );
  } else {
    for (const jobId of uniqueJobIds) await approveSelected(jobId);
  }
  return heldBack;

  async function approveOneApplicationResume(
    job: (typeof jobs)[number],
    approval: { personApproved?: boolean },
  ): Promise<void> {
    const jobId = job.id;
    const usesOriginalResume =
      (job.resumeApplicationMode ??
        settings.resumeApplicationMode ??
        "tailored_per_job") === "original_resume";
    if (usesOriginalResume) return;

    if (approval.personApproved) {
      try {
        await workspaceService.approveCurrentResume(jobId);
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          /still need your decision/iu.test(error.message)
        ) {
          throw new Error(
            `The resume for '${job.title}' has a line waiting for your decision.`,
          );
        }
        throw error;
      }
      return;
    }

    const workspace = await workspaceService.getResumeWorkspace(jobId);
    const approvedExport = workspace.exports.find(
      (artifact) =>
        artifact.id === workspace.draft.approvedExportId &&
        artifact.draftId === workspace.draft.id &&
        artifact.isApproved,
    );
    const alreadyApproved =
      workspace.draft.status === "approved" && approvedExport !== undefined;
    if (alreadyApproved && approvedExport) {
      const exportExists = await access(approvedExport.filePath).then(
        () => true,
        () => false,
      );
      if (exportExists) return;
      // Re-render the same approved draft if its managed PDF was removed.
      // Its existing claim decisions still apply, including Aggressive ones.
    }

    const tailoringMode =
      job.resumeTailoringMode ?? searchPreferences.tailoringMode;
    if (tailoringMode === "aggressive" && !alreadyApproved) {
      holdBack(
        job,
        `Read and approve the Aggressive resume for '${job.title}' before applying.`,
      );
      return;
    }

    try {
      await workspaceService.exportResumePdf(jobId, null);
    } catch (error) {
      if (
        error instanceof Error &&
        /still need your decision/iu.test(error.message)
      ) {
        holdBack(
          job,
          `The resume for '${job.title}' has a line waiting for your decision. Open it, keep or change the line, then apply.`,
        );
        return;
      }
      throw error;
    }
    const exportedWorkspace = await workspaceService.getResumeWorkspace(jobId);
    const exportToApprove = exportedWorkspace.exports
      .filter(
        (artifact) =>
          artifact.jobId === jobId &&
          artifact.draftId === exportedWorkspace.draft.id,
      )
      .sort((left, right) =>
        right.exportedAt.localeCompare(left.exportedAt),
      )[0];
    if (!exportToApprove) {
      throw new Error(
        `Job Finder could not create the application PDF for '${job.title}', so nothing was started.`,
      );
    }
    await workspaceService.approveResume(jobId, exportToApprove.id);
  }
}

/**
 * Starts a batch for `jobIds` in the saved apply mode, exactly as "Try again
 * for all" does: jobs already in a running batch are left out, resumes are
 * approved, the saved mode's permission is issued, and the press returns once
 * the batch runs. Used to carry applications on after the person hands the
 * browser back.
 */
export async function startSavedModeApplyBatch(
  jobIds: readonly string[],
  onBackgroundSettled: () => void,
): Promise<void> {
  const service = await getJobFinderWorkspaceService();
  const repository = getJobFinderRepositoryForWorkspaceService(service);
  if (!repository) return;
  const pendingIds = await listJobsNotInProgress(repository, jobIds);
  if (pendingIds.length === 0) return;
  const heldBack = new Set(
    (
      await approveApplicationResumes(service, pendingIds, {
        holdBackResumesAwaitingPerson: true,
      })
    ).map((entry) => entry.jobId),
  );
  const ids = pendingIds.filter((jobId) => !heldBack.has(jobId));
  if (ids.length === 0) return;
  await syncApplicationAuthorityForSavedMode(service, ids);
  await startApplyBatch({
    service,
    runs: repository,
    jobIds: ids,
    onBackgroundSettled,
  });
}

/**
 * One run of an Apply queue: the same start as "Apply to all" (resumes
 * approved, the mode's permission issued, the press returns once the run is
 * going). Jobs that cannot go now are named with the reason instead of
 * stopping the run: a resume that waits on the person, or one whose PDF
 * could not be made.
 */
async function startApplyQueueRun(
  jobIds: readonly string[],
  mode: ApplicationAutomationMode,
): Promise<ApplyQueueStartedRun> {
  const service = await getJobFinderWorkspaceService();
  const repository = getJobFinderRepositoryForWorkspaceService(service);
  if (!repository) {
    throw new Error(
      "Job Finder could not open the application workspace, so nothing was started.",
    );
  }
  const queue = await repository.getApplyQueue();
  const { assistantQueuePolicy } =
    await import("../services/assistant/assistant-service");
  const policy = queue
    ? await assistantQueuePolicy(queue, jobIds, mode)
    : { mode, refused: [] };
  mode = policy.mode;
  const refused = new Set(policy.refused.map((entry) => entry.jobId));
  const pendingIds = await listJobsNotInProgress(
    repository,
    jobIds.filter((id) => !refused.has(id)),
  );
  const skipped: ApplyQueueSkippedJob[] = [];
  skipped.push(...policy.refused);
  let heldBack: Awaited<ReturnType<typeof approveApplicationResumes>>;
  try {
    heldBack = await approveApplicationResumes(service, pendingIds, {
      holdBackResumesAwaitingPerson: true,
    });
  } catch {
    // One job's resume failed the whole call; find which one by itself.
    heldBack = [];
    for (const jobId of pendingIds) {
      try {
        heldBack.push(
          ...(await approveApplicationResumes(service, [jobId], {
            holdBackResumesAwaitingPerson: true,
          })),
        );
      } catch (error: unknown) {
        skipped.push({
          jobId,
          reason: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 500),
        });
      }
    }
  }
  skipped.push(
    ...heldBack.map((entry) => ({
      jobId: entry.jobId,
      reason: entry.reason.slice(0, 500),
    })),
  );
  const notGoing = new Set(skipped.map((entry) => entry.jobId));
  const ids = pendingIds.filter((jobId) => !notGoing.has(jobId));
  if (ids.length === 0) {
    return {
      runId: null,
      startedJobIds: [],
      skipped,
      settled: Promise.resolve(),
    };
  }
  await syncApplicationAuthorityForSavedMode(service, ids, mode);
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const started = await startApplyBatch({
    service,
    runs: repository,
    jobIds: ids,
    applicationAutomationMode: mode,
    onBackgroundSettled: () => {
      publishJobFinderWorkspaceUpdate();
      markSettled();
    },
  });
  if (started.startedJobIds.length === 0) markSettled();
  return {
    runId: started.runId,
    startedJobIds: started.startedJobIds,
    skipped,
    settled,
  };
}

async function requireApplyQueueRepository() {
  const service = await getJobFinderWorkspaceService();
  const repository = getJobFinderRepositoryForWorkspaceService(service);
  if (!repository) {
    throw new Error("Job Finder could not open the application workspace.");
  }
  return { service, repository };
}

let applyQueueRunner: ApplyQueueRunner | null = null;

/** Shared by the buttons and the registered assistant actions. */
export async function executeApplyQueueAction(
  actionId: string,
  input: unknown,
  options: { onApproveProgress?: (done: number) => void } = {},
) {
  const { service, repository } = await requireApplyQueueRepository();
  if (actionId === "start-apply-queue") {
    const value = JobFinderStartApplyQueueInputSchema.parse(input);
    const mode =
      value.applicationAutomationMode ??
      (await repository.getSettings()).applicationAutomationMode ??
      "prepare_only";
    await getApplyQueueRunner().start(value.jobIds, mode);
  } else if (actionId === "control-apply-queue") {
    const value = JobFinderApplyQueueControlInputSchema.parse(input);
    if (
      !value.queueId ||
      (await repository.getApplyQueue())?.id === value.queueId
    ) {
      await getApplyQueueRunner().control(value.action);
    }
  } else if (actionId === "remove-from-apply-queue") {
    await getApplyQueueRunner().remove(
      JobFinderRemoveFromApplyQueueInputSchema.parse(input).jobIds,
    );
  } else if (actionId === "approve-resumes") {
    await approveApplicationResumes(
      service,
      JobFinderApproveResumesInputSchema.parse(input).jobIds,
      {
        personApproved: true,
        ...(options.onApproveProgress
          ? { onProgress: options.onApproveProgress }
          : {}),
      },
    );
  } else {
    throw new Error("Unknown Apply queue action.");
  }
  return readWorkspaceProjection(service);
}

/** A running queue fills the taskbar button; a finished one says so once. */
function noteApplyQueueOnTaskbar(queue: ApplyQueue | null): void {
  const notices = getFinishedWorkNotifier();
  if (queue?.state === "running") {
    notices.progress(
      "apply",
      queue.jobIds.length > 0
        ? queue.startedJobIds.length / queue.jobIds.length
        : null,
    );
    return;
  }
  notices.end(
    "apply",
    queue?.state === "done" && queue.startedJobIds.length > 0
      ? applyQueueFinishedNotice(
          queue.startedJobIds.length,
          queue.mode === "autonomous_submit",
        )
      : null,
  );
}

/** The one Apply queue (Apply to selected, this page or all ready). */
export function getApplyQueueRunner(): ApplyQueueRunner {
  applyQueueRunner ??= createApplyQueueRunner({
    loadQueue: async () =>
      (await requireApplyQueueRepository()).repository.getApplyQueue(),
    saveQueue: async (queue) => {
      await (
        await requireApplyQueueRepository()
      ).repository.saveApplyQueue(queue);
      noteApplyQueueOnTaskbar(queue);
    },
    readDailyCapacity: async () => {
      const { repository } = await requireApplyQueueRepository();
      const [applyRuns, applyJobResults, applicationRecords, settings] =
        await Promise.all([
          repository.listApplyRuns(),
          repository.listApplyJobResults(),
          repository.listApplicationRecords(),
          repository.getSettings(),
        ]);
      const capacity = deriveGlobalDailyApplicationPreparationCapacity({
        applyRuns,
        applyJobResults,
        applicationRecords,
        limit:
          settings.maxApplicationsPerLocalDay ??
          MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
      });
      return { remaining: capacity.remaining, resetsAt: capacity.resetsAt };
    },
    readSavedMode: async () =>
      (await (await requireApplyQueueRepository()).repository.getSettings())
        .applicationAutomationMode ?? "prepare_only",
    isActivityPaused: async () =>
      (
        await (
          await requireApplyQueueRepository()
        ).repository.getActivityControl()
      ).paused,
    startRun: startApplyQueueRun,
    cancelRun: async (runId) => {
      const { service } = await requireApplyQueueRepository();
      await service.cancelApplyRun(runId);
    },
    publish: () => publishJobFinderWorkspaceUpdate(),
  });
  return applyQueueRunner;
}

/** At launch: a queue that was running or waiting for tomorrow carries on. */
export async function resumeApplyQueueAfterRestart(): Promise<void> {
  await getApplyQueueRunner().resumeAfterRestart();
}

/** Jobs the search that just ended saved for the person to look at. */
function countNewJobsOfLatestRun(snapshot: {
  recentDiscoveryRuns?: readonly {
    startedAt: string;
    summary: { jobsPersisted: number; jobsStaged: number };
  }[];
}): number {
  const latest = [...(snapshot.recentDiscoveryRuns ?? [])].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  )[0];
  return latest ? latest.summary.jobsPersisted + latest.summary.jobsStaged : 0;
}

function parseOptionalRequestId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const requestId = (payload as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }

  return requestId;
}

function parseSourceReadabilityTimeout(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const timeoutMs = (payload as { readabilityTimeoutMs?: unknown })
    .readabilityTimeoutMs;
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? Math.min(Math.trunc(timeoutMs), 15_000)
    : null;
}

function throwIfResumePreviewAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }

  throw new DOMException("Resume preview was superseded.", "AbortError");
}

function sanitizeFileNameSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name the app already gives this document, leading its exported file.
 *
 * A resume nothing could be tailored for is called "Your original resume"
 * everywhere else; the exported file used to carry no document name at all
 * while the screen around it still said "Tailored Resume". One label, derived
 * from one state, reaches the shortlisted row, the documents list and the
 * file on disk.
 */
function buildResumeExportDefaultPath(
  documentLabel: string,
  jobTitle: string,
  company: string,
): string {
  const titleSegment = sanitizeFileNameSegment(jobTitle) || "Resume";
  const companySegment = sanitizeFileNameSegment(company);
  const labelSegment = sanitizeFileNameSegment(documentLabel);
  const fileName = [labelSegment, titleSegment, companySegment]
    .filter((segment) => segment.length > 0)
    .join(" - ");

  return path.join(app.getPath("documents"), `${fileName}.pdf`);
}
function buildApplicationPacketExportDefaultPath(
  jobTitle: string,
  company: string,
): string {
  const titleSegment = sanitizeFileNameSegment(jobTitle) || "Job";
  const companySegment = sanitizeFileNameSegment(company);
  const fileName = companySegment
    ? `Application packet - ${titleSegment} - ${companySegment}.json`
    : `Application packet - ${titleSegment}.json`;

  return path.join(app.getPath("documents"), fileName);
}

/**
 * Mutation responses carry the exact workspace snapshot the service just
 * produced. `getWorkspaceSnapshot` already schema-parses that value inside
 * `@nestor/job-finder`, so re-parsing it in every route handler validated
 * every job, application record, and stored answer a second time on every
 * user action. That cost grows linearly with everything the user has ever
 * discovered — the repository's own scale gate is 5,000 jobs / 1,001
 * records — and it can never reject anything the first parse accepted.
 *
 * Removing the deep parse must not remove the fail-closed guarantee that a
 * malformed main-process value never reaches the renderer, so this keeps a
 * constant-time structural guard: the response must still be recognisably a
 * workspace snapshot, checked without walking a single collection. The
 * compile-time contract is unchanged (the argument must be exactly a
 * `JobFinderWorkspaceSnapshot`), mutation *input* parsing is unchanged, and
 * the genuine integrity boundaries — workspace reset, demo/fixture loading,
 * and native resume-import recovery — keep the full deep parse.
 */
const REQUIRED_WORKSPACE_SNAPSHOT_COLLECTIONS = [
  "discoveryJobs",
  "reviewQueue",
  "applyRuns",
  "applicationRecords",
] as const satisfies readonly (keyof JobFinderWorkspaceSnapshot)[];

async function readWorkspaceProjection(
  service: Awaited<ReturnType<typeof getJobFinderWorkspaceService>>,
): Promise<JobFinderWorkspaceSnapshot> {
  if (!service.getWorkspaceProjection) {
    throw new Error("The interactive workspace view is unavailable.");
  }
  // Main keeps full validated jobs; trim listing evidence at the IPC boundary.
  return service.getWorkspaceProjection();
}

function rendererSnapshotResponse(
  snapshot: JobFinderWorkspaceSnapshot,
  queryLists?: boolean,
): JobFinderRendererWorkspaceSnapshot {
  const candidate = snapshot as unknown;
  const isWorkspaceSnapshotShape =
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { module?: unknown }).module === "job-finder" &&
    typeof (candidate as { generatedAt?: unknown }).generatedAt === "string" &&
    typeof (candidate as { profile?: unknown }).profile === "object" &&
    (candidate as { profile?: unknown }).profile !== null &&
    REQUIRED_WORKSPACE_SNAPSHOT_COLLECTIONS.every((key) =>
      Array.isArray((candidate as Record<string, unknown>)[key]),
    );

  if (!isWorkspaceSnapshotShape) {
    throw new Error(
      "Job Finder produced a workspace response that is not a workspace snapshot.",
    );
  }

  return toRendererWorkspaceSnapshot(snapshot, queryLists);
}

/** Returned to any caller of the retired Profile and Resume chat writes. */
export const RETIRED_CHAT_MESSAGE =
  "The old Profile and Resume chats are retired. Use the assistant in the side chat; old conversations stay readable there.";

const pendingWorkspaceRestores = new Map<
  number | "assistant",
  { token: string; backup: PersonalWorkspaceExport }
>();
let workspaceRestorePending = false;
export async function previewWorkspaceRestore(
  event: IpcMainInvokeEvent | null = null,
) {
  const browserWindow = event
    ? BrowserWindow.fromWebContents(event.sender)
    : null;
  const picker: OpenDialogOptions = {
    title: "Restore from a workspace export",
    properties: ["openFile"],
    filters: [{ name: "Nestor workspace export", extensions: ["json"] }],
  };
  const picked = browserWindow
    ? await dialog.showOpenDialog(browserWindow, picker)
    : await dialog.showOpenDialog(picker);
  pendingWorkspaceRestores.delete(event?.sender.id ?? "assistant");
  if (picked.canceled || !picked.filePaths[0]) return null;
  const backup = parsePersonalWorkspaceExport(
    await readFile(picked.filePaths[0], "utf8"),
  );
  const token = randomUUID();
  pendingWorkspaceRestores.set(event?.sender.id ?? "assistant", {
    token,
    backup,
  });
  return PersonalWorkspaceRestorePreviewSchema.parse({
    token,
    profileName: backup.repositoryState.profile.fullName ?? "Your profile",
    exportedAt: backup.exportedAt,
    jobs: backup.repositoryState.savedJobs.length,
    applications: backup.repositoryState.applicationRecords.length,
    answers:
      backup.repositoryState.applicationAnswerRecords.length +
      backup.repositoryState.profile.answerBank.customAnswers.length,
    documents: backup.files.length,
    chats: backup.assistantHistory.length,
  });
}

export async function confirmWorkspaceRestore(
  payload: unknown,
  event: IpcMainInvokeEvent | null = null,
) {
  const { token } = ConfirmPersonalWorkspaceRestoreSchema.parse(payload);
  const prepared = pendingWorkspaceRestores.get(
    event?.sender.id ?? "assistant",
  );
  if (!prepared || prepared.token !== token)
    throw new Error("Choose the export again before restoring.");
  if (workspaceRestorePending)
    throw new Error(
      "A workspace restore is already running. Wait for it to finish.",
    );
  workspaceRestorePending = true;
  const safetyExportPath = path.join(
    app.getPath("documents"),
    `nestor-before-restore-${Date.now()}-${randomUUID()}.json`,
  );
  try {
    const service = await getJobFinderWorkspaceService();
    const repository = getJobFinderRepositoryForWorkspaceService(service);
    if (!repository)
      throw new Error(
        "Your workspace could not be restored. Nothing was changed.",
      );
    const {
      exportAssistantHistory,
      restoreAssistantHistory,
      stopAssistantForWorkspaceRestore,
    } = await import("../services/assistant/assistant-service");
    await service.withWorkspaceRestore(async () => {
      invalidateUiResumeBatch();
      await stopAssistantForWorkspaceRestore();
      await restorePersonalWorkspace({
        backup: prepared.backup,
        repository,
        roots: new Map([
          ["resumes", getJobFinderDocumentsDirectory()],
          ["attachments", getCandidateAssetsDirectory()],
          ["application-documents", getApplicationDocumentsDirectory()],
        ]),
        safetyExportPath,
        buildSafetyExport: async () =>
          buildPersonalWorkspaceExport({
            workspace: await service.getWorkspaceSnapshot(),
            repositoryState: await repository.exportState(),
            assistantHistory: await exportAssistantHistory(),
            applicationQuestions:
              await repository.listApplicationQuestionRecords(),
            applicationAnswers: await repository.listApplicationAnswerRecords(),
          }),
        beforeReplace: async () => {
          await resetJobFinderBrowser();
        },
        readChats: exportAssistantHistory,
        restoreChats: restoreAssistantHistory,
      });
    });
    pendingWorkspaceRestores.delete(event?.sender.id ?? "assistant");
    await service.setActivityControl({
      paused: true,
      reason: "Workspace restored. Resume activity when you are ready.",
    });
    publishJobFinderWorkspaceUpdate();
    return PersonalWorkspaceRestoreResultSchema.parse({ safetyExportPath });
  } finally {
    workspaceRestorePending = false;
  }
}

export function registerJobFinderRouteHandlers(
  ipcMain: IpcMain,
  options: { includeBootstrapRoutes?: boolean } = {},
) {
  if (options.includeBootstrapRoutes !== false) {
    registerJobFinderBootstrapDesktopRoutes(ipcMain);
  }

  const workspaceDeltaTracker = createJobFinderWorkspaceDeltaTracker();
  // A change a window asked for is answered with what changed since the
  // revision that window shows, not the whole workspace.
  const workspaceMutationResponse = (
    sender: object | null | undefined,
    snapshot: JobFinderWorkspaceSnapshot,
  ): JobFinderWorkspaceSyncResult => {
    const queryLists =
      sender &&
      "id" in sender &&
      typeof sender.id === "number" &&
      usesWorkspaceQueryUpdates(sender.id);
    return workspaceDeltaTracker.respond(
      sender,
      rendererSnapshotResponse(snapshot, queryLists ? true : undefined),
    );
  };
  ipcMain.handle(
    "job-finder:note-workspace-revision",
    (event, payload: unknown) => {
      const { revision } = JobFinderWorkspaceHeldRevisionSchema.parse(payload);
      workspaceDeltaTracker.noteHeldRevision(event.sender, revision);
    },
  );
  const activeResumePreviewRequests = new WeakMap<
    object,
    {
      requestId: string;
      controller: AbortController;
    }
  >();
  const activeResumeImportRequests = new WeakMap<
    object,
    {
      requestId: string;
      cancelled: boolean;
      phase: "picking" | "processing";
    }
  >();

  ipcMain.handle(
    "job-finder:get-job-detail",
    async (_event, payload: unknown) => {
      const input = JobFinderJobDetailQuerySchema.parse(payload);
      return readJobFinderJobDetail(
        getJobFinderRepositoryForWorkspaceService(
          await getJobFinderWorkspaceService(),
        ),
        input,
      );
    },
  );

  ipcMain.handle(
    "job-finder:get-tailored-asset",
    async (_event, payload: unknown) => {
      const { assetId } = JobFinderTailoredAssetQuerySchema.parse(payload);
      const service = await getJobFinderWorkspaceService();
      const repository = getJobFinderRepositoryForWorkspaceService(service);
      if (!repository)
        throw new Error("Resume preview storage is unavailable.");
      return JobFinderTailoredAssetDetailSchema.parse(
        await repository.getTailoredAssetById(assetId),
      );
    },
  );

  /**
   * Registers one protected save channel. The only behavior it adds is the
   * desktop test API's one-shot synthetic save failure, which is inert unless
   * a tester armed that exact surface while NESTOR_ENABLE_TEST_API is set.
   * Production builds run the listener verbatim.
   */
  function handleJobFinderSaveRoute<TResult>(
    channel: JobFinderSaveChannel,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<TResult>,
  ): void {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, payload: unknown) => {
        consumeArmedJobFinderTestSaveFailure(channel);
        return listener(event, payload);
      },
    );
  }

  // Registered actions share their input and service call with the assistant.
  const runRegisteredAction = async (
    name: JobFinderActionId,
    event: IpcMainInvokeEvent,
    payload: unknown,
  ) => {
    const value =
      name === "disable-resume-strategy"
        ? { strategyId: payload }
        : name === "update-appearance-theme"
          ? { appearanceTheme: payload }
          : (payload ?? {});
    const service = await getJobFinderWorkspaceService();
    const run = () => executeJobFinderAction(name, value, { service });
    // Minutes of model calls: keep scores arriving on screen meanwhile.
    const result =
      name === "judge-unjudged-jobs"
        ? await withJobFinderWorkspaceUpdates(event.sender, run)
        : await run();
    if (
      [
        "save-settings",
        "update-application-defaults",
        "set-activity-control",
      ].includes(name)
    )
      applyQueueRunner?.nudge();
    // Some changes answer with their own record (application details, a
    // recommendation); only a workspace snapshot becomes a sync response.
    const isWorkspaceSnapshot =
      typeof result === "object" &&
      result !== null &&
      (result as { module?: unknown }).module === "job-finder";
    // A change answered with its delta needs no second sync of the whole
    // workspace in this window; main's listeners still hear of it. Shortlist
    // starts a draft and Stop ends a search, so those keep the follow-up.
    if (JOB_FINDER_ACTIONS[name].safety !== "read") {
      if (
        !isWorkspaceSnapshot ||
        name === "queue-job-for-review" ||
        name === "cancel-discovery-run"
      )
        publishJobFinderWorkspaceUpdate(event.sender);
      else notifyJobFinderWorkspaceListeners();
    }
    return JOB_FINDER_ACTIONS[name].safety === "read" || !isWorkspaceSnapshot
      ? result
      : workspaceMutationResponse(
          event.sender,
          result as JobFinderWorkspaceSnapshot,
        );
  };
  for (const name of [
    "save-profile",
    "save-search-preferences",
    "save-campaign",
    "save-profile-setup-state",
    "save-settings",
    "update-application-defaults",
    "update-workspace-behavior",
    "update-ai-behavior",
    "update-appearance-theme",
    "update-tracker-crm",
    "save-resume-draft",
    "restore-resume-draft-revision",
    "undo-resume-assistant-edit",
    "apply-resume-patch",
  ] as const) {
    handleJobFinderSaveRoute(`job-finder:${name}`, (event, payload: unknown) =>
      runRegisteredAction(name, event, payload),
    );
  }
  for (const name of [
    "analyze-profile-from-resume",
    "select-campaign",
    "delete-campaign",
    "save-campaign-rule",
    "delete-campaign-rule",
    "toggle-campaign-rule",
    "project-campaign-rule-funnel",
    "set-activity-control",
    "mutate-rapid-review",
    "record-outcome",
    "save-resume-strategy",
    "disable-resume-strategy",
    "select-resume-strategy",
    "recommend-resume-strategy",
    "set-campaign-resume-strategy-default",
    "refresh-company-intelligence",
    "set-company-preference",
    "review-company-merge",
    "mutate-company-intelligence",
    "set-outcome-suggestion-enabled",
    "mutate-safeguards",
    "apply-profile-setup-review-action",
    "apply-resume-timeline-repair-action",
    "undo-profile-revision",
    "judge-unjudged-jobs",
    "cancel-discovery-run",
    "cancel-source-debug",
    "get-source-debug-run",
    "get-source-debug-run-details",
    "save-source-instruction-artifact",
    "list-source-debug-runs",
    "accept-source-instruction-draft",
    "queue-job-for-review",
    "set-job-resume-application-mode",
    "remove-job-from-review",
    "preview-employer-exclusion",
    "remove-employer-exclusion",
    "dismiss-discovery-job",
    "restore-dismissed-discovery-job",
    "get-apply-run-details",
    "clear-application-answer",
    "snooze-grouped-decision",
    "mutate-application-crm",
    "mutate-application-crm-bulk-stage",
    "get-resume-workspace",
    "regenerate-resume-section",
    "approve-resume",
    "clear-resume-approval",
    "set-work-history-review-acknowledgment",
    "set-resume-claim-confirmation",
    "return-application-to-shortlist",
    "undo-return-application-to-shortlist",
  ] as const) {
    ipcMain.handle(`job-finder:${name}`, (event, payload: unknown) =>
      runRegisteredAction(name, event, payload),
    );
  }

  ipcMain.handle(
    "job-finder:sync-workspace",
    async (event, payload: unknown) => {
      const input = JobFinderWorkspaceSyncInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await readWorkspaceProjection(jobFinderWorkspaceService);

      return workspaceDeltaTracker.synchronize(
        input.baseRevision,
        toRendererWorkspaceSnapshot(
          snapshot,
          usesWorkspaceQueryUpdates(event.sender.id) ? true : undefined,
        ),
      );
    },
  );

  ipcMain.handle(
    "job-finder:mutate-workspace-entities",
    async (event, payload: unknown) => {
      const input = JobFinderWorkspaceEntityMutationInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await (async () => {
        switch (input.mutation.type) {
          case "assess_job_listing":
            return jobFinderWorkspaceService.assessJobListing(
              input.mutation.jobId,
            );
          case "queue_job_for_review":
            if (jobFinderWorkspaceService.queueJobsForReview) {
              await jobFinderWorkspaceService.queueJobsForReview([
                input.mutation.jobId,
              ]);
              return readWorkspaceProjection(jobFinderWorkspaceService);
            }
            return jobFinderWorkspaceService.queueJobForReview(
              input.mutation.jobId,
            );
          case "queue_jobs_for_review":
            if (!jobFinderWorkspaceService.queueJobsForReview)
              throw new Error(
                "Bulk shortlisting is unavailable. Restart the app to load the current version.",
              );
            await jobFinderWorkspaceService.queueJobsForReview(
              input.mutation.jobIds,
            );
            return readWorkspaceProjection(jobFinderWorkspaceService);
          case "set_job_resume_application_mode":
            return jobFinderWorkspaceService.setJobResumeApplicationMode(
              input.mutation.jobId,
              input.mutation.resumeApplicationMode,
              input.mutation.resumeTailoringMode,
            );
          case "remove_job_from_review":
            return jobFinderWorkspaceService.removeJobFromReview(
              input.mutation.jobId,
            );
          case "dismiss_discovery_job":
            return jobFinderWorkspaceService.dismissDiscoveryJob({
              jobId: input.mutation.jobId,
              reasons: input.mutation.reasons,
              action: input.mutation.action ?? "hide_job",
              expectedNormalizedCompanyName:
                input.mutation.expectedNormalizedCompanyName ?? null,
            });
          case "restore_dismissed_discovery_job":
            return jobFinderWorkspaceService.restoreDismissedDiscoveryJob(
              input.mutation.jobId,
            );
          case "remove_jobs_from_review":
            if (!jobFinderWorkspaceService.removeJobsFromReview)
              throw new Error(
                "Removing several jobs at once is unavailable. Restart the app to load the current version.",
              );
            await jobFinderWorkspaceService.removeJobsFromReview(
              input.mutation.jobIds,
            );
            return readWorkspaceProjection(jobFinderWorkspaceService);
          case "dismiss_discovery_jobs": {
            if (!jobFinderWorkspaceService.dismissDiscoveryJobs)
              throw new Error(
                "Hiding several jobs at once is unavailable. Restart the app to load the current version.",
              );
            const { reasons } = input.mutation;
            const result = await jobFinderWorkspaceService.dismissDiscoveryJobs(
              [...new Set(input.mutation.jobIds)].map((jobId) => ({
                jobId,
                reasons,
              })),
            );
            const failed = result.outcomes.filter(
              (outcome) => outcome.status !== "hidden",
            ).length;
            if (failed > 0 && failed === result.outcomes.length)
              throw new Error(
                result.outcomes.find((outcome) => "message" in outcome)
                  ?.message ?? "None of the selected jobs could be hidden.",
              );
            return readWorkspaceProjection(jobFinderWorkspaceService);
          }
          default: {
            const unreachable: never = input.mutation;
            throw new Error(
              `Unsupported workspace entity mutation: ${JSON.stringify(unreachable)}`,
            );
          }
        }
      })();
      return workspaceDeltaTracker.synchronize(
        input.baseRevision,
        toRendererWorkspaceSnapshot(
          snapshot,
          usesWorkspaceQueryUpdates(event.sender.id) ? true : undefined,
        ),
      );
    },
  );

  ipcMain.handle(
    "job-finder:open-browser-session",
    async (event, payload: unknown) => {
      const input = JobFinderOpenBrowserSessionInputSchema.parse(payload ?? {});
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot =
        await jobFinderWorkspaceService.openBrowserSession(input);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle("job-finder:check-browser-session", async (event) => {
    const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
    const snapshot = await jobFinderWorkspaceService.checkBrowserSession();

    return workspaceMutationResponse(event.sender, snapshot);
  });

  handleJobFinderSaveRoute(
    "job-finder:save-workspace-inputs",
    async (event, payload: unknown) => {
      const { profile, searchPreferences, settings } =
        SaveJobFinderWorkspaceInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      let snapshot =
        await jobFinderWorkspaceService.saveProfileAndSearchPreferences(
          profile,
          searchPreferences,
        );

      if (settings) {
        await jobFinderWorkspaceService.saveSettings(settings);
        snapshot = await readWorkspaceProjection(jobFinderWorkspaceService);
      }

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:run-campaign-now",
    async (event, payload: unknown) => {
      const input = RunCampaignNowInputSchema.parse(payload ?? {});
      const service = await getJobFinderWorkspaceService();
      // A run that refuses to start still writes a terminal run record — a
      // plan whose sources are gone records a failed run and then throws the
      // reason. Publishing only on success left the renderer holding the
      // snapshot from before the attempt, so the plan card, its history and
      // Home all kept an older run's success as the newest thing the app had
      // said about this plan.
      try {
        const snapshot = await service.runCampaignNow(
          input,
          createSearchProgressPublisher(event.sender),
        );
        return workspaceMutationResponse(event.sender, snapshot);
      } finally {
        publishJobFinderWorkspaceUpdate(event.sender);
      }
    },
  );

  ipcMain.handle(
    "job-finder:mark-campaign-notification-read",
    async (event, payload: unknown) => {
      const { notificationId } = MarkCampaignNotificationReadInputSchema.omit({
        readAt: true,
      }).parse(payload);
      const service = await getJobFinderWorkspaceService();
      const snapshot = await service.markCampaignNotificationRead({
        notificationId,
        readAt: new Date().toISOString(),
      });

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:mark-all-campaign-notifications-read",
    async (event) => {
      const service = await getJobFinderWorkspaceService();
      const snapshot = await service.markAllCampaignNotificationsRead({
        readAt: new Date().toISOString(),
      });

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  // The old chat is retired (ADR 0037): the assistant sidebar is the only
  // writer. Archived histories stay readable through the assistant.
  ipcMain.handle("job-finder:send-profile-copilot-message", () =>
    Promise.reject(new Error(RETIRED_CHAT_MESSAGE)),
  );

  // The old chat is retired (ADR 0037): the assistant sidebar is the only
  // writer. Archived histories stay readable through the assistant.
  ipcMain.handle("job-finder:apply-profile-copilot-patch-group", () =>
    Promise.reject(new Error(RETIRED_CHAT_MESSAGE)),
  );

  // The old chat is retired (ADR 0037): the assistant sidebar is the only
  // writer. Archived histories stay readable through the assistant.
  ipcMain.handle("job-finder:reject-profile-copilot-patch-group", () =>
    Promise.reject(new Error(RETIRED_CHAT_MESSAGE)),
  );

  ipcMain.handle(
    "job-finder:import-resume",
    async (event, payload: unknown) => {
      const importRequest = ImportResumeRequestSchema.parse(payload ?? {});
      const requestId = importRequest.requestId ?? null;
      const abortController = new AbortController();
      const request: {
        requestId: string;
        cancelled: boolean;
        phase: "picking" | "processing";
      } | null = requestId
        ? { requestId, cancelled: false, phase: "picking" }
        : null;
      if (request) {
        activeResumeImportRequests.set(event.sender, request);
      }

      const cancelHandler = request
        ? (cancelEvent: Electron.IpcMainEvent, cancelPayload: unknown) => {
            const cancelRequest =
              CancelResumeImportRequestSchema.safeParse(cancelPayload);
            const activeRequest = activeResumeImportRequests.get(
              cancelEvent.sender,
            );
            if (
              activeRequest === request &&
              cancelRequest.success &&
              cancelRequest.data.requestId === request.requestId &&
              (request.phase === "picking" ||
                cancelRequest.data.stopProcessing === true)
            ) {
              // Ignore a late picker choice, or stop processing before it can
              // apply results. The listener stays installed until this request
              // settles, so manual setup can stop an in-flight model read.
              request.cancelled = true;
              abortController.abort();
            }
          }
        : null;
      if (cancelHandler) {
        ipcMain.on("job-finder:cancel-import-resume", cancelHandler);
      }

      const reportProgress = requestId
        ? (
            progress: Parameters<
              typeof ResumeImportProgressEventSchema.parse
            >[0],
          ) => {
            const parsedProgress =
              ResumeImportProgressEventSchema.parse(progress);

            // A native picker can outlive the renderer that opened it. Do
            // not let a progress notification race turn a successful import
            // into a rejected IPC request after a reload or window close.
            try {
              if (event.sender.isDestroyed()) {
                return;
              }
              event.sender.send(
                `job-finder:resume-import-progress:${requestId}`,
                parsedProgress,
              );
            } catch (error) {
              // The sender may be destroyed between the check and send.
              // Preserve import persistence for that expected lifecycle race,
              // while still surfacing unexpected send failures.
              if (!event.sender.isDestroyed()) {
                throw error;
              }
            }
          }
        : undefined;
      const dialogOptions: OpenDialogOptions = {
        properties: ["openFile"],
        filters: [
          {
            name: "Resume documents",
            extensions: ["pdf", "docx", "txt", "md"],
          },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const parentWindow = BrowserWindow.fromWebContents(event.sender);
      try {
        // Starting a stopped import again reads the working copy it saved,
        // so there is no picker to wait on.
        if (importRequest.retryInterrupted === true) {
          if (request) {
            request.phase = "processing";
          }
          const jobFinderWorkspaceService =
            await getJobFinderWorkspaceService();
          const snapshot = await readWorkspaceProjection(
            jobFinderWorkspaceService,
          );
          return workspaceMutationResponse(
            event.sender,
            await retryInterruptedResumeImport(
              snapshot.latestResumeImportRun ?? null,
              {
                ...(reportProgress ? { onProgress: reportProgress } : {}),
                signal: abortController.signal,
              },
            ),
          );
        }
        const usableParentWindow =
          parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
        if (usableParentWindow) {
          // A hidden or backgrounded renderer can otherwise leave the native
          // picker behind another window where automation and users cannot
          // see Escape/cancel feedback.
          usableParentWindow.show();
          usableParentWindow.focus();
        }
        const selection = usableParentWindow
          ? await dialog.showOpenDialog(usableParentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);

        if (
          request?.cancelled ||
          selection.canceled ||
          selection.filePaths.length === 0
        ) {
          const jobFinderWorkspaceService =
            await getJobFinderWorkspaceService();
          return workspaceMutationResponse(
            event.sender,
            await readWorkspaceProjection(jobFinderWorkspaceService),
          );
        }

        const sourcePath = selection.filePaths[0];

        if (!sourcePath) {
          const jobFinderWorkspaceService =
            await getJobFinderWorkspaceService();
          return workspaceMutationResponse(
            event.sender,
            await readWorkspaceProjection(jobFinderWorkspaceService),
          );
        }

        if (request) {
          // A valid selection transfers ownership from the native picker to
          // the importer synchronously, before any further await can let a
          // route-change cancellation race discard real processing.
          request.phase = "processing";
        }
        return workspaceMutationResponse(
          event.sender,
          await importResumeFromSourcePath(sourcePath, {
            signal: abortController.signal,
            ...(reportProgress ? { onProgress: reportProgress } : {}),
          }),
        );
      } finally {
        if (cancelHandler) {
          ipcMain.removeListener(
            "job-finder:cancel-import-resume",
            cancelHandler,
          );
        }
        if (
          request &&
          activeResumeImportRequests.get(event.sender) === request
        ) {
          activeResumeImportRequests.delete(event.sender);
        }
      }
    },
  );

  ipcMain.handle(
    "job-finder:test-reset-workspace-state",
    async (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      const partialPayload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const state = JobFinderRepositoryStateSchema.parse(partialPayload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await jobFinderWorkspaceService.resetWorkspace(state);

      return toRendererWorkspaceSnapshot(
        JobFinderWorkspaceSnapshotSchema.parse(snapshot),
      );
    },
  );

  ipcMain.handle("job-finder:test-load-resume-workspace-demo", async () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }

    const snapshot = await loadResumeWorkspaceDemoState();

    return toRendererWorkspaceSnapshot(
      JobFinderWorkspaceSnapshotSchema.parse(snapshot),
    );
  });

  ipcMain.handle(
    "job-finder:test-set-resume-preview-mode",
    async (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      const mode = JobFinderResumePreviewModeSchema.parse(payload);
      await setJobFinderWorkspaceServiceTestEnv({
        NESTOR_TEST_RESUME_PREVIEW: mode,
      });

      return DesktopTestOkResponseSchema.parse({ ok: true });
    },
  );

  ipcMain.handle("job-finder:test-load-apply-queue-demo", async () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }

    const snapshot = await loadApplyQueueDemoState();

    return toRendererWorkspaceSnapshot(
      JobFinderWorkspaceSnapshotSchema.parse(snapshot),
    );
  });

  ipcMain.handle("job-finder:test-load-work-history-review-demo", async () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }

    const snapshot = await loadWorkHistoryReviewDriveState();

    return toRendererWorkspaceSnapshot(
      JobFinderWorkspaceSnapshotSchema.parse(snapshot),
    );
  });

  ipcMain.handle(
    "job-finder:test-load-agent-owned-browser-demo",
    async (_event, rawInput: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }
      if (!rawInput || typeof rawInput !== "object") {
        throw new Error("Local browser demo URLs are required.");
      }
      const candidate = rawInput as Record<string, unknown>;
      if (
        typeof candidate.sourceUrl !== "string" ||
        typeof candidate.applicationUrl !== "string"
      ) {
        throw new Error("Local browser demo URLs are required.");
      }
      const parsed = {
        sourceUrl: new URL(candidate.sourceUrl).href,
        applicationUrl: new URL(candidate.applicationUrl).href,
        ...(typeof candidate.secondaryApplicationUrl === "string"
          ? {
              secondaryApplicationUrl: new URL(
                candidate.secondaryApplicationUrl,
              ).href,
            }
          : {}),
        ...(typeof candidate.jobTitle === "string"
          ? { jobTitle: candidate.jobTitle.slice(0, 200) }
          : {}),
        ...(typeof candidate.jobCompany === "string"
          ? { jobCompany: candidate.jobCompany.slice(0, 200) }
          : {}),
        ...(Array.isArray(candidate.foundJobs)
          ? {
              foundJobs: candidate.foundJobs.slice(0, 10).flatMap((entry) => {
                const found = entry as Record<string, unknown>;
                return typeof found.title === "string" &&
                  typeof found.company === "string" &&
                  typeof found.applicationUrl === "string"
                  ? [
                      {
                        title: found.title.slice(0, 200),
                        company: found.company.slice(0, 200),
                        applicationUrl: new URL(found.applicationUrl).href,
                      },
                    ]
                  : [];
              }),
            }
          : {}),
      };
      return loadAgentOwnedBrowserDriveState(parsed);
    },
  );

  ipcMain.handle(
    "job-finder:test-fail-next-save",
    (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      // One-shot and per-surface: the very next save the named surface starts
      // rejects, then the arm clears itself. Nothing else is affected, and no
      // application, browser, or submission authority is involved.
      armJobFinderTestSaveFailure(payload);

      return DesktopTestOkResponseSchema.parse({ ok: true });
    },
  );

  ipcMain.handle("job-finder:get-performance-snapshot", async () => {
    const service = await getJobFinderWorkspaceService();
    const { performance } = await collectJobFinderPerformanceSnapshot({
      service,
      waitingFormMemory: () => getEmbeddedBrowser().reduceWaitingFormMemory(),
    });

    return JobFinderPerformanceSnapshotSchema.parse(performance);
  });

  ipcMain.handle("job-finder:test-get-performance-snapshot", async () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }
    const service = await getJobFinderWorkspaceService();
    const { performance } = await collectJobFinderPerformanceSnapshot({
      service,
      waitingFormMemory: () => getEmbeddedBrowser().reduceWaitingFormMemory(),
    });

    return JobFinderPerformanceSnapshotSchema.parse(performance);
  });

  ipcMain.handle(
    "job-finder:test-run-resume-import-benchmark",
    async (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      const parsed = ResumeImportBenchmarkRequestSchema.partial().parse(
        payload ?? {},
      );
      const options = {
        ...(parsed.benchmarkVersion !== undefined
          ? { benchmarkVersion: parsed.benchmarkVersion }
          : {}),
        ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
        ...(parsed.canaryOnly !== undefined
          ? { canaryOnly: parsed.canaryOnly }
          : {}),
        ...(parsed.useConfiguredAi !== undefined
          ? { useConfiguredAi: parsed.useConfiguredAi }
          : {}),
        ...(parsed.useVision !== undefined
          ? { useVision: parsed.useVision }
          : {}),
      };

      const report = await runDesktopResumeImportBenchmark(options);
      return ResumeImportBenchmarkReportSchema.parse(report);
    },
  );

  ipcMain.handle("job-finder:test-get-resume-import-benchmark-cases", () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }

    return ResumeImportBenchmarkCaseSchema.array().parse(defaultBenchmarkCases);
  });

  ipcMain.handle("job-finder:test-get-resume-import-state", async () => {
    if (!isDesktopTestApiEnabled()) {
      throw new Error(
        "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
      );
    }

    const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
    const state = await jobFinderWorkspaceService.getResumeImportState();

    return {
      resumeImportRuns: ResumeImportRunSchema.array().parse(
        state.resumeImportRuns,
      ),
      resumeImportDocumentBundles: ResumeDocumentBundleSchema.array().parse(
        state.resumeImportDocumentBundles,
      ),
      resumeImportFieldCandidates:
        ResumeImportFieldCandidateSchema.array().parse(
          state.resumeImportFieldCandidates,
        ),
    };
  });

  ipcMain.handle(
    "job-finder:test-run-resume-quality-benchmark",
    async (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      const parsed = ResumeQualityBenchmarkRequestSchema.partial().parse(
        payload ?? {},
      );
      const options = {
        ...(parsed.benchmarkVersion !== undefined
          ? { benchmarkVersion: parsed.benchmarkVersion }
          : {}),
        ...(parsed.caseIds !== undefined ? { caseIds: parsed.caseIds } : {}),
        ...(parsed.templateIds !== undefined
          ? { templateIds: parsed.templateIds }
          : {}),
        ...(parsed.canaryOnly !== undefined
          ? { canaryOnly: parsed.canaryOnly }
          : {}),
        ...(parsed.useConfiguredAi !== undefined
          ? { useConfiguredAi: parsed.useConfiguredAi }
          : {}),
        ...(parsed.persistArtifactsDirectory !== undefined
          ? { persistArtifactsDirectory: parsed.persistArtifactsDirectory }
          : {}),
      };

      const report = await runDesktopResumeQualityBenchmark(options);
      return ResumeQualityBenchmarkReportSchema.parse(report);
    },
  );

  ipcMain.handle(
    "job-finder:test-import-resume-from-path",
    async (_event, payload: unknown) => {
      if (!isDesktopTestApiEnabled()) {
        throw new Error(
          "Desktop test API is disabled. Set NESTOR_ENABLE_TEST_API=1 to enable scripted UI flows.",
        );
      }

      const { sourcePath, useVision } = parseResumeImportPathPayload(payload);
      return importResumeFromSourcePath(
        sourcePath,
        useVision !== undefined ? { useVision } : {},
      );
    },
  );

  ipcMain.handle(
    "job-finder:save-user-action-answer-draft",
    async (_event, payload: unknown) => {
      const service = await getJobFinderWorkspaceService();
      await service.saveUserActionAnswerDraft(
        SaveUserActionAnswerDraftInputSchema.parse(payload),
      );
      scheduleAnswerDraftWorkspaceUpdate();
    },
  );

  ipcMain.handle(
    "job-finder:perform-user-action",
    async (event, payload: unknown) => {
      const command = UserActionCommandSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      // An answer or a "done" moves the step to checking at once, but the
      // check can wait behind another job on the same site. Push the
      // workspace meanwhile, so the card says it is checking instead of
      // showing the question again until the check ends.
      const snapshot = await withJobFinderWorkspaceUpdates(event.sender, () =>
        jobFinderWorkspaceService.performUserAction(command),
      );
      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle("job-finder:run-discovery", async (event) => {
    const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
    const snapshot = await jobFinderWorkspaceService.runDiscovery();

    return workspaceMutationResponse(event.sender, snapshot);
  });

  ipcMain.handle(
    "job-finder:cancel-discovery-run-command",
    async (_event, payload: unknown) => {
      const { runId } =
        JobFinderDiscoveryCancellationInputSchema.parse(payload);
      return (await getJobFinderWorkspaceService()).cancelDiscoveryRunCommand(
        runId,
      );
    },
  );
  ipcMain.handle(
    "job-finder:run-agent-discovery-command",
    async (event, payload: unknown) => {
      const { requestId, targetId, searchRequest } =
        parseAgentDiscoveryRequest(payload);
      const service = await getJobFinderWorkspaceService();
      const release = holdDiscoveryWorkspaceUpdates();
      const notices = getFinishedWorkNotifier();
      notices.progress("search", null);
      let finishedNotice: ReturnType<typeof searchFinishedNotice> | null = null;
      let runId: string | null = null;
      try {
        const result = await service.runAgentDiscoveryCommand(
          (activity) => {
            runId = activity.runId;
            if (!event.sender.isDestroyed?.())
              event.sender.send(
                `job-finder:discovery-activity:${requestId}`,
                DiscoveryActivityEventSchema.parse(activity),
              );
          },
          targetId ?? undefined,
          searchRequest,
        );
        if (result.outcome === "completed")
          finishedNotice = searchFinishedNotice(result.newJobs);
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError")
          return { outcome: "cancelled", runId, newJobs: 0 };
        throw error;
      } finally {
        release();
        notices.end("search", finishedNotice);
      }
    },
  );

  ipcMain.handle(
    "job-finder:run-agent-discovery",
    async (event, payload: unknown) => {
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const window = event.sender;
      const { requestId, targetId, searchRequest } =
        parseAgentDiscoveryRequest(payload);
      const notices = getFinishedWorkNotifier();
      notices.progress("search", null);
      const release = holdDiscoveryWorkspaceUpdates();
      let finishedNotice: ReturnType<typeof searchFinishedNotice> | null = null;
      const publishProgress = createSearchProgressPublisher(window);

      try {
        const snapshot = await jobFinderWorkspaceService.runAgentDiscovery(
          (eventPayload) => {
            window.send(
              `job-finder:discovery-activity:${requestId}`,
              DiscoveryActivityEventSchema.parse(eventPayload),
            );
            publishProgress();
          },
          undefined,
          targetId ?? undefined,
          searchRequest,
        );

        // The service resolves cancelled runs (it finalizes the run record as
        // `cancelled` and persists incrementally committed jobs before
        // returning), so the terminal outcome is read from the authoritative
        // workspace state. Only an AbortError that escaped the pipeline — an
        // abort before the run record existed — is itself proof of
        // cancellation.
        //
        // The window gets what changed since the revision it holds, like any
        // other change it asked for. Parsing and sending the whole workspace
        // here held main for seconds at the end of a large search, and the
        // window's next refresh then sent it all again.
        const reply: JobFinderAgentDiscoveryReply = {
          outcome:
            snapshot.discoveryRunState === "cancelled"
              ? "cancelled"
              : "completed",
          sync: workspaceMutationResponse(window, snapshot),
        };
        if (reply.outcome === "completed") {
          finishedNotice = searchFinishedNotice(
            countNewJobsOfLatestRun(snapshot),
          );
        }
        return reply;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          console.log("[JobFinder] Agent discovery cancelled");
          // Return current workspace snapshot even on abort
          const currentSnapshot = await readWorkspaceProjection(
            jobFinderWorkspaceService,
          );
          const reply: JobFinderAgentDiscoveryReply = {
            outcome: "cancelled",
            sync: workspaceMutationResponse(window, currentSnapshot),
          };
          return reply;
        }
        throw error;
      } finally {
        release();
        notices.end("search", finishedNotice);
      }
    },
  );

  ipcMain.handle(
    "job-finder:run-source-debug",
    async (event, payload: unknown) => {
      const { targetId } = JobFinderSourceDebugActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const requestId = parseOptionalRequestId(payload);
      const readabilityTimeoutMs = parseSourceReadabilityTimeout(payload);
      let snapshot: JobFinderWorkspaceSnapshot;
      try {
        const run = (signal?: AbortSignal) =>
          jobFinderWorkspaceService.runSourceDebug(
            targetId,
            signal,
            requestId
              ? (progressEvent) => {
                  event.sender.send(
                    `job-finder:source-debug-progress:${requestId}`,
                    SourceDebugProgressEventSchema.parse(progressEvent),
                  );
                  publishJobFinderWorkspaceUpdate(event.sender);
                }
              : undefined,
          );
        snapshot = readabilityTimeoutMs
          ? await runBoundedNewSourceReadabilityCheck(
              (signal) => run(signal),
              readabilityTimeoutMs,
            )
          : await run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.name === "AbortError") {
          const interrupted = await readWorkspaceProjection(
            jobFinderWorkspaceService,
          );
          const runningRun = interrupted.recentSourceDebugRuns.find(
            (run) => run.targetId === targetId && run.state === "running",
          );
          snapshot = runningRun
            ? await jobFinderWorkspaceService.cancelSourceDebug(runningRun.id)
            : interrupted;
        } else {
          if (
            !/(?:ApplicationNavigationError|page\.(?:goto|waitFor)|navigation.*(?:failed|timeout)|Timeout \d+ms exceeded|net::ERR_)/iu.test(
              detail,
            )
          ) {
            throw error;
          }
          // The workflow records a screen-safe failed result before this route
          // fallback is reached. Return that durable snapshot instead of letting
          // Electron paint its transport wrapper across the window.
          snapshot = await readWorkspaceProjection(jobFinderWorkspaceService);
        }
      }

      publishJobFinderWorkspaceUpdate(event.sender);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:verify-source-instructions",
    async (event, payload: unknown) => {
      const { targetId, instructionId } =
        JobFinderSourceInstructionActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await jobFinderWorkspaceService.verifySourceInstructions(
        targetId,
        instructionId,
        undefined,
        () => publishJobFinderWorkspaceUpdate(event.sender),
      );

      publishJobFinderWorkspaceUpdate(event.sender);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:save-application-answer",
    async (_event, payload: unknown) => {
      const command = SaveApplicationAnswerCommandSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      return ApplyRunDetailsSchema.parse(
        await jobFinderWorkspaceService.saveApplicationAnswer(command),
      );
    },
  );

  ipcMain.handle(
    "job-finder:project-grouped-manual-answer",
    async (event, payload: unknown) => {
      const command = ProjectGroupedManualAnswerCommandSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot =
        await jobFinderWorkspaceService.projectGroupedManualAnswer(command);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:apply-grouped-manual-answer",
    async (event, payload: unknown) => {
      const input = ApplyGroupedManualAnswerInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await withJobFinderWorkspaceUpdates(event.sender, () =>
        jobFinderWorkspaceService.applyGroupedManualAnswer(input),
      );

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:export-application-packet",
    async (event, payload: unknown) => {
      const { runId, jobId, applicationRecordId } =
        JobFinderApplyRunDetailsQuerySchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const packet = ApplicationPacketSchema.parse(
        await jobFinderWorkspaceService.buildApplicationPacket(
          runId,
          jobId,
          applicationRecordId,
        ),
      );

      if (isDesktopTestApiEnabled()) {
        return JobFinderApplicationPacketExportResultSchema.parse({
          status: "cancelled",
        });
      }

      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const saveDialogOptions: SaveDialogOptions = {
        defaultPath: buildApplicationPacketExportDefaultPath(
          packet.job.title,
          packet.job.company,
        ),
        filters: [{ name: "JSON", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
        title: "Export application packet",
      };
      const saveResult = browserWindow
        ? await dialog.showSaveDialog(browserWindow, saveDialogOptions)
        : await dialog.showSaveDialog(saveDialogOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return JobFinderApplicationPacketExportResultSchema.parse({
          status: "cancelled",
        });
      }

      const outputPath = saveResult.filePath.toLowerCase().endsWith(".json")
        ? saveResult.filePath
        : `${saveResult.filePath}.json`;
      await writeFile(
        outputPath,
        `${JSON.stringify(packet, null, 2)}\n`,
        "utf8",
      );

      return JobFinderApplicationPacketExportResultSchema.parse({
        status: "saved",
      });
    },
  );

  ipcMain.handle(
    "job-finder:run-application-no-response-automation",
    async (event, payload: unknown) => {
      const settings = ApplicationCrmSettingsSchema.optional().parse(
        payload ?? undefined,
      );
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot =
        await jobFinderWorkspaceService.runApplicationNoResponseAutomation(
          settings,
        );

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:export-application-crm",
    async (event, payload: unknown) => {
      const input = ApplicationCrmExportInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const exportResult =
        await jobFinderWorkspaceService.exportApplicationCrm(input);

      if (isDesktopTestApiEnabled()) {
        return ApplicationCrmFileExportResultSchema.parse({
          status: "cancelled",
          exportedCount: exportResult.exportedCount,
          filePath: null,
        });
      }

      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const saveDialogOptions: SaveDialogOptions = {
        defaultPath: path.join(app.getPath("documents"), exportResult.fileName),
        filters: [
          {
            name: exportResult.format === "json" ? "JSON" : "CSV",
            extensions: [exportResult.format],
          },
        ],
        properties: ["createDirectory", "showOverwriteConfirmation"],
        title: "Export application CRM",
      };
      const saveResult = browserWindow
        ? await dialog.showSaveDialog(browserWindow, saveDialogOptions)
        : await dialog.showSaveDialog(saveDialogOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return ApplicationCrmFileExportResultSchema.parse({
          status: "cancelled",
          exportedCount: exportResult.exportedCount,
          filePath: null,
        });
      }

      const outputPath = saveResult.filePath
        .toLowerCase()
        .endsWith(`.${exportResult.format}`)
        ? saveResult.filePath
        : `${saveResult.filePath}.${exportResult.format}`;
      await writeFile(outputPath, exportResult.content, {
        encoding: "utf8",
        mode: 0o600,
      });

      return ApplicationCrmFileExportResultSchema.parse({
        status: "saved",
        exportedCount: exportResult.exportedCount,
        filePath: outputPath,
      });
    },
  );
  ipcMain.handle("job-finder:preview-personal-workspace-restore", (event) =>
    previewWorkspaceRestore(event),
  );
  ipcMain.handle(
    "job-finder:confirm-personal-workspace-restore",
    (event, payload: unknown) => confirmWorkspaceRestore(payload, event),
  );

  ipcMain.handle("job-finder:export-personal-workspace", async (event) => {
    const service = await getJobFinderWorkspaceService();
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = {
      title: "Export personal workspace",
      defaultPath: path.join(
        app.getPath("documents"),
        personalWorkspaceExportFileName(),
      ),
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const result = browserWindow
      ? await dialog.showSaveDialog(browserWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath)
      return ApplicationCrmFileExportResultSchema.parse({
        status: "cancelled",
        exportedCount: 0,
        filePath: null,
      });
    const exported = await buildWorkspaceFileExport(service, "workspace");
    const filePath = result.filePath.toLowerCase().endsWith(".json")
      ? result.filePath
      : `${result.filePath}.json`;
    await writeFile(filePath, exported.content, {
      encoding: "utf8",
      mode: 0o600,
    });
    return ApplicationCrmFileExportResultSchema.parse({
      status: "saved",
      exportedCount: exported.exportedCount,
      filePath,
    });
  });
  ipcMain.handle("job-finder:export-diagnostics", async (event) => {
    const service = await getJobFinderWorkspaceService();
    const diagnostic = await buildWorkspaceFileExport(service, "diagnostics");
    if (isDesktopTestApiEnabled()) {
      return JobFinderDiagnosticExportResultSchema.parse({
        status: "cancelled",
      });
    }
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const options: SaveDialogOptions = {
      defaultPath: "nestor-job-finder-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
      title: "Export Job Finder diagnostics",
    };
    const saveResult = browserWindow
      ? await dialog.showSaveDialog(browserWindow, options)
      : await dialog.showSaveDialog(options);
    if (saveResult.canceled || !saveResult.filePath) {
      return JobFinderDiagnosticExportResultSchema.parse({
        status: "cancelled",
      });
    }
    const outputPath = saveResult.filePath.toLowerCase().endsWith(".json")
      ? saveResult.filePath
      : saveResult.filePath + ".json";
    await writeFile(outputPath, diagnostic.content, "utf8");
    return JobFinderDiagnosticExportResultSchema.parse({ status: "saved" });
  });
  ipcMain.handle(
    "job-finder:preview-resume-draft",
    async (event, payload: unknown) => {
      const { draft, requestId } =
        JobFinderPreviewResumeDraftInputSchema.parse(payload);
      const previousRequest = activeResumePreviewRequests.get(event.sender);
      previousRequest?.controller.abort();
      const request = {
        requestId,
        controller: new AbortController(),
      };
      activeResumePreviewRequests.set(event.sender, request);

      const assertCurrentRequest = () => {
        throwIfResumePreviewAborted(request.controller.signal);
        if (activeResumePreviewRequests.get(event.sender) !== request) {
          throw new DOMException(
            `Resume preview request '${request.requestId}' was superseded.`,
            "AbortError",
          );
        }
      };

      try {
        assertCurrentRequest();
        const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
        assertCurrentRequest();
        const preview = await jobFinderWorkspaceService.previewResumeDraft(
          draft,
          request.controller.signal,
        );
        assertCurrentRequest();

        return JobFinderResumePreviewSchema.parse(preview);
      } finally {
        if (activeResumePreviewRequests.get(event.sender) === request) {
          activeResumePreviewRequests.delete(event.sender);
        }
      }
    },
  );

  ipcMain.handle(
    "job-finder:regenerate-resume-draft",
    async (event, payload: unknown) => {
      const { jobId } = JobFinderJobActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot =
        await jobFinderWorkspaceService.regenerateResumeDraft(jobId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:export-resume-pdf",
    async (event, payload: unknown) => {
      const { intent, jobId } =
        JobFinderExportResumePdfInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      let outputPath: string | null = null;

      if (intent === "download" && !isDesktopTestApiEnabled()) {
        const workspace =
          await jobFinderWorkspaceService.getResumeWorkspace(jobId);
        const browserWindow = BrowserWindow.fromWebContents(event.sender);
        const saveDialogOptions: SaveDialogOptions = {
          defaultPath: buildResumeExportDefaultPath(
            resolveTailoredAssetLabel({
              existingLabel: workspace.tailoredAsset?.label ?? null,
              generationMethod:
                workspace.draft.generationMethod === "ai"
                  ? "ai_assisted"
                  : "deterministic",
              generationReason:
                workspace.tailoredAsset?.generationReason ?? null,
            }),
            workspace.job.title,
            workspace.job.company,
          ),
          filters: [
            {
              name: "PDF",
              extensions: ["pdf"],
            },
          ],
          properties: ["createDirectory", "showOverwriteConfirmation"],
          // Not "tailored": the same dialog opens for a document nothing
          // could be tailored for.
          title: "Export resume PDF",
        };
        const saveResult = browserWindow
          ? await dialog.showSaveDialog(browserWindow, saveDialogOptions)
          : await dialog.showSaveDialog(saveDialogOptions);

        if (saveResult.canceled || !saveResult.filePath) {
          const snapshot = await readWorkspaceProjection(
            jobFinderWorkspaceService,
          );

          // A dismissed dialog wrote nothing. Saying so is the difference
          // between "no dialog, no toast, no error and no file" and a person
          // knowing where they stand.
          return {
            ...JobFinderResumePdfExportOutcomeSchema.parse({
              outcome: "cancelled",
              outputPath: null,
            }),
            workspace: workspaceMutationResponse(event.sender, snapshot),
          } satisfies JobFinderResumePdfExportReply;
        }

        outputPath = saveResult.filePath.toLowerCase().endsWith(".pdf")
          ? saveResult.filePath
          : `${saveResult.filePath}.pdf`;
      }

      const snapshot = await jobFinderWorkspaceService.exportResumePdf(
        jobId,
        outputPath,
      );

      // The workspace goes as a delta, like every other change; parsing and
      // sending the whole of it made each approval over a second slower.
      return {
        ...JobFinderResumePdfExportOutcomeSchema.parse({
          outcome: "saved",
          outputPath,
        }),
        workspace: workspaceMutationResponse(event.sender, snapshot),
      } satisfies JobFinderResumePdfExportReply;
    },
  );

  // Shows a file the app itself wrote in the operating system's file manager.
  // The export already named the path; without this the person had to find it
  // by hand. The OS selects the file — nothing is opened or executed — and a
  // path that no longer exists says so instead of failing silently.
  ipcMain.handle("job-finder:reveal-saved-file", async (_event, payload) => {
    const { path: savedPath } = RevealSavedFileInputSchema.parse(payload);

    try {
      await access(savedPath);
    } catch {
      return RevealSavedFileResultSchema.parse({ outcome: "not_found" });
    }

    if (typeof shell.showItemInFolder !== "function") {
      return RevealSavedFileResultSchema.parse({ outcome: "unsupported" });
    }

    shell.showItemInFolder(savedPath);
    return RevealSavedFileResultSchema.parse({ outcome: "revealed" });
  });

  ipcMain.handle(
    "job-finder:write-clipboard-text",
    (_event, payload: unknown) => {
      const { text } = WriteClipboardTextInputSchema.parse(payload);
      void clipboard.writeText(text);
      return WriteClipboardTextResultSchema.parse({ written: true });
    },
  );

  ipcMain.handle(
    "job-finder:get-resume-assistant-messages",
    async (_event, payload: unknown) => {
      const { jobId } = JobFinderResumeWorkspaceQuerySchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const messages =
        await jobFinderWorkspaceService.getResumeAssistantMessages(jobId);

      return JobFinderResumeWorkspaceSchema.shape.assistantMessages.parse(
        messages,
      );
    },
  );

  // The old chat is retired (ADR 0037): the assistant sidebar is the only
  // writer. Archived histories stay readable through the assistant.
  ipcMain.handle("job-finder:send-resume-assistant-message", () =>
    Promise.reject(new Error(RETIRED_CHAT_MESSAGE)),
  );

  // The old chat is retired (ADR 0037): the assistant sidebar is the only
  // writer. Archived histories stay readable through the assistant.
  ipcMain.handle("job-finder:resolve-resume-assistant-proposal", () =>
    Promise.reject(new Error(RETIRED_CHAT_MESSAGE)),
  );

  ipcMain.handle(
    "job-finder:generate-resume-for-batch",
    async (event, payload: unknown) => {
      const input = ResumeBatchGenerationInputSchema.parse(payload);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.webContents.id !== event.sender.id)
        throw new Error("Resume batches only start from the app window.");
      const shouldStop = () => {
        const batch = readUiResumeBatch();
        return (
          event.sender.isDestroyed() ||
          !batch ||
          batch.id !== input.batchId ||
          batch.stopRequested ||
          !batch.jobIds.includes(input.jobId)
        );
      };
      if (shouldStop())
        return ResumeBatchGenerationResultSchema.parse({
          jobId: input.jobId,
          outcome: "not_started",
        });
      const service = await getJobFinderWorkspaceService();
      try {
        return ResumeBatchGenerationResultSchema.parse(
          await service.generateResumeForBatch(input.jobId, {
            ...(input.regenerate === undefined
              ? {}
              : { regenerate: input.regenerate }),
            shouldStop,
            onProviderBlocked: (block) =>
              blockUiResumeBatch(input.batchId, block),
            onStage: (stage) => {
              if (!event.sender.isDestroyed())
                event.sender.send(
                  "job-finder:resume-batch-progress",
                  ResumeBatchGenerationProgressSchema.parse({
                    batchId: input.batchId,
                    jobId: input.jobId,
                    stage,
                  }),
                );
            },
          }),
        );
      } finally {
        publishJobFinderWorkspaceUpdate(event.sender);
      }
    },
  );

  ipcMain.handle(
    "job-finder:generate-resume",
    async (event, payload: unknown) => {
      const { jobId } = JobFinderJobActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await jobFinderWorkspaceService.generateResume(jobId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:start-apply-copilot-run",
    async (event, payload: unknown) => {
      const {
        jobId,
        applicationRecordId,
        startNewApplication,
        visualCheckpointsEnabled,
      } = JobFinderApplyCopilotActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await approveApplicationResumes(jobFinderWorkspaceService, [jobId]);
      await syncApplicationAuthorityForSavedMode(jobFinderWorkspaceService, [
        jobId,
      ]);
      const snapshot = await withJobFinderWorkspaceUpdates(event.sender, () =>
        jobFinderWorkspaceService.startApplyCopilotRun(
          jobId,
          {
            visualCheckpointsEnabled,
          },
          startNewApplication ? null : applicationRecordId,
        ),
      );

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:start-auto-apply-run",
    async (event, payload: unknown) => {
      const { jobId, applicationRecordId, startNewApplication } =
        JobFinderApplicationStartTargetSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await syncApplicationAuthorityForSavedMode(jobFinderWorkspaceService, [
        jobId,
      ]);
      const snapshot = await withJobFinderWorkspaceUpdates(event.sender, () =>
        jobFinderWorkspaceService.startAutoApplyRun(
          jobId,
          startNewApplication ? null : applicationRecordId,
        ),
      );

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:start-auto-apply-queue-run",
    async (event, payload: unknown) => {
      const { jobIds: requestedJobIds, applicationAutomationMode } =
        JobFinderApplyQueueActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const repository = getJobFinderRepositoryForWorkspaceService(
        jobFinderWorkspaceService,
      );
      // A second press while the batch is running is a no-op for the jobs
      // it already has; their send permission is not re-issued mid-send.
      const pendingJobIds = repository
        ? await listJobsNotInProgress(repository, requestedJobIds)
        : requestedJobIds;
      if (pendingJobIds.length === 0) {
        return workspaceMutationResponse(
          event.sender,
          await readWorkspaceProjection(jobFinderWorkspaceService),
        );
      }
      // A resume that waits on the person holds back its own job only; the
      // ready ones start, and the renderer names the one held back.
      const heldBack = await approveApplicationResumes(
        jobFinderWorkspaceService,
        pendingJobIds,
        { holdBackResumesAwaitingPerson: true },
      );
      const heldBackIds = new Set(heldBack.map((entry) => entry.jobId));
      const jobIds = pendingJobIds.filter((jobId) => !heldBackIds.has(jobId));
      if (jobIds.length === 0) {
        throw new Error(
          heldBack.length === 1
            ? `Nothing was started. ${heldBack[0]!.reason}`
            : `Nothing was started: ${heldBack.length} resumes wait for your review (${heldBack.map((entry) => entry.title).join(", ")}). Open each one, decide its flagged lines, then apply.`,
        );
      }
      await syncApplicationAuthorityForSavedMode(
        jobFinderWorkspaceService,
        jobIds,
        applicationAutomationMode,
      );
      // "Apply to all" is one press (ADR 0022, ADR 0026): the mode chosen in
      // Settings is the permission, so the batch starts at once instead of
      // waiting for a second "Start preparing N jobs" click on Applications.
      // The press returns once the batch is running; a refusal comes back as
      // its own sentence instead of a batch that never moves.
      if (repository) {
        await startApplyBatch({
          service: jobFinderWorkspaceService,
          runs: repository,
          jobIds,
          ...(applicationAutomationMode ? { applicationAutomationMode } : {}),
          onBackgroundSettled: () => {
            publishJobFinderWorkspaceUpdate(event.sender);
          },
        });
      } else {
        await jobFinderWorkspaceService.startAutoApplyQueueRun(
          jobIds,
          applicationAutomationMode,
        );
      }

      return workspaceMutationResponse(
        event.sender,
        await readWorkspaceProjection(jobFinderWorkspaceService),
      );
    },
  );

  // One Apply press over many jobs (ADR 0058): runs of ten back to back,
  // inside the daily limit, carried on after a restart.
  ipcMain.handle(
    "job-finder:start-apply-queue",
    async (event, payload: unknown) => {
      const snapshot = await executeJobFinderAction(
        "start-apply-queue",
        payload,
        {
          service: await getJobFinderWorkspaceService(),
          host: executeApplyQueueAction,
        },
      );
      return workspaceMutationResponse(
        event.sender,
        snapshot as JobFinderWorkspaceSnapshot,
      );
    },
  );

  // "Approve N resumes": the person's press approves each named resume as
  // the single Approve does; a line still to decide keeps its resume out.
  ipcMain.handle(
    "job-finder:approve-resumes",
    async (event, payload: unknown) => {
      // Approvals land on screen ten at a time while the rest finish.
      const onApproveProgress = (done: number) => {
        if (done > 0 && done % 10 === 0)
          publishJobFinderWorkspaceUpdate(event.sender);
      };
      const snapshot = await executeJobFinderAction(
        "approve-resumes",
        payload,
        {
          service: await getJobFinderWorkspaceService(),
          host: (actionId, input) =>
            executeApplyQueueAction(actionId, input, { onApproveProgress }),
        },
      );
      return workspaceMutationResponse(
        event.sender,
        snapshot as JobFinderWorkspaceSnapshot,
      );
    },
  );

  // Takes waiting jobs out of the queue. Nothing starts or is sent; a job a
  // run already took stays with that run.
  ipcMain.handle(
    "job-finder:remove-from-apply-queue",
    async (event, payload: unknown) => {
      const snapshot = await executeJobFinderAction(
        "remove-from-apply-queue",
        payload,
        {
          service: await getJobFinderWorkspaceService(),
          host: executeApplyQueueAction,
        },
      );
      return workspaceMutationResponse(
        event.sender,
        snapshot as JobFinderWorkspaceSnapshot,
      );
    },
  );

  // Applications -> Shortlisted for an application nothing was sent for. Its
  // form closes; nothing is sent or prepared again.

  ipcMain.handle(
    "job-finder:control-apply-queue",
    async (event, payload: unknown) => {
      const snapshot = await executeJobFinderAction(
        "control-apply-queue",
        payload,
        {
          service: await getJobFinderWorkspaceService(),
          host: executeApplyQueueAction,
        },
      );
      return workspaceMutationResponse(
        event.sender,
        snapshot as JobFinderWorkspaceSnapshot,
      );
    },
  );

  ipcMain.handle(
    "job-finder:approve-apply-run",
    async (event, payload: unknown) => {
      const { runId, jobId, applicationRecordId } =
        JobFinderApplyRunActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await jobFinderWorkspaceService.getApplyRunDetails(
        runId,
        jobId,
        applicationRecordId,
      );
      const snapshot = await jobFinderWorkspaceService.approveApplyRun(runId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:cancel-apply-run",
    async (event, payload: unknown) => {
      const { runId, jobId, applicationRecordId } =
        JobFinderApplyRunActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await jobFinderWorkspaceService.getApplyRunDetails(
        runId,
        jobId,
        applicationRecordId,
      );
      const snapshot = await jobFinderWorkspaceService.cancelApplyRun(runId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:resolve-apply-consent-request",
    async (event, payload: unknown) => {
      const { requestId, runId, jobId, applicationRecordId, action } =
        JobFinderApplyConsentActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const details = await jobFinderWorkspaceService.getApplyRunDetails(
        runId,
        jobId,
        applicationRecordId,
      );
      const request = details.consentRequests.find(
        (candidate) => candidate.id === requestId,
      );
      if (!request) {
        throw new Error(
          `Consent request '${requestId}' does not belong to the selected application record.`,
        );
      }
      if (
        action === "approve" &&
        request.kind === "resume_use" &&
        request.status === "pending"
      ) {
        await approveApplicationResumes(jobFinderWorkspaceService, [jobId]);
        const repository = getJobFinderRepositoryForWorkspaceService(
          jobFinderWorkspaceService,
        );
        const record = (await repository?.listApplicationRecords())?.find(
          (candidate) =>
            candidate.id === applicationRecordId && candidate.jobId === jobId,
        );
        await syncApplicationAuthorityForSavedMode(
          jobFinderWorkspaceService,
          [jobId],
          record?.automationMode ?? "prepare_only",
        );
      }
      const snapshot =
        await jobFinderWorkspaceService.resolveApplyConsentRequest(
          requestId,
          action,
        );

      if (
        action === "approve" &&
        request.kind === "resume_use" &&
        request.status === "pending" &&
        details.run.mode === "copilot"
      ) {
        return workspaceMutationResponse(
          event.sender,
          await jobFinderWorkspaceService.startApplyCopilotRun(
            jobId,
            undefined,
            applicationRecordId,
          ),
        );
      }

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:revoke-apply-run-approval",
    async (event, payload: unknown) => {
      const { runId, jobId, applicationRecordId } =
        JobFinderApplyRunActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await jobFinderWorkspaceService.getApplyRunDetails(
        runId,
        jobId,
        applicationRecordId,
      );
      const snapshot =
        await jobFinderWorkspaceService.revokeApplyRunApproval(runId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:get-application-page-states",
    async (_event, payload: unknown) => {
      const input = ApplicationPageStatesInputSchema.parse(payload);
      const service = await getJobFinderWorkspaceService();
      return ApplicationPageStatesSchema.parse(
        await getApplicationPageAccessForWorkspaceService(service).getStates(
          input.resultIds,
        ),
      );
    },
  );
  ipcMain.handle(
    "job-finder:reopen-application-page",
    async (event, payload: unknown) => {
      const requestId = parseOptionalRequestId(payload);
      // requestId is transport metadata, not part of the product command.
      const input = ReopenApplicationPageInputSchema.parse(
        payload && typeof payload === "object" && "resultId" in payload
          ? { resultId: payload.resultId }
          : payload,
      );
      const service = await getJobFinderWorkspaceService();
      return ApplicationPageStateSchema.parse(
        await getApplicationPageAccessForWorkspaceService(service).reopen(
          input.resultId,
          (progress) => {
            if (requestId && !event.sender.isDestroyed())
              event.sender.send(
                `job-finder:application-page-reopen-progress:${requestId}`,
                ApplicationPageReopenProgressSchema.parse(progress),
              );
          },
        ),
      );
    },
  );

  ipcMain.handle(
    "job-finder:focus-prepared-application-page",
    async (event, payload: unknown) => {
      const input = JobFinderPreparedApplicationPageInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot =
        await jobFinderWorkspaceService.focusPreparedApplicationPage(input);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:send-prepared-applications",
    async (event, payload: unknown) => {
      const { jobIds: requestedJobIds } =
        JobFinderSendPreparedApplicationsInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      // Only forms still waiting to be sent. A second press (or a stale
      // screen) used to "send" applications that had already gone out.
      const jobIds = await listJobsStillReadyToSend(
        jobFinderWorkspaceService,
        requestedJobIds,
      );
      if (jobIds.length === 0) {
        throw new Error(
          requestedJobIds.length === 1
            ? "Nothing left to send: this application was already sent or is no longer filled in."
            : "Nothing left to send: these applications were already sent or are no longer filled in.",
        );
      }
      await scopeSendPermissionToPreparedJobs(
        jobFinderWorkspaceService,
        jobIds,
      );
      // Each kept page is sent in turn. One that cannot be sent (its page
      // closed, the site refused) is recorded on that job alone; the rest
      // still go out.
      let snapshot: Awaited<
        ReturnType<typeof jobFinderWorkspaceService.submitPreparedApplication>
      > | null = null;
      let firstError: unknown = null;
      for (const jobId of jobIds) {
        try {
          snapshot =
            await jobFinderWorkspaceService.submitPreparedApplication(jobId);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (!snapshot) {
        throw firstError instanceof Error
          ? firstError
          : new Error("None of these applications could be sent.");
      }
      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:submit-prepared-application",
    async (event, payload: unknown) => {
      const { jobId } = JobFinderJobActionInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      await scopeSendPermissionToPreparedJobs(jobFinderWorkspaceService, [
        jobId,
      ]);
      const snapshot =
        await jobFinderWorkspaceService.submitPreparedApplication(jobId);

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle(
    "job-finder:approve-apply",
    async (event, payload: unknown) => {
      const { jobId, applicationRecordId, startNewApplication } =
        JobFinderApplicationStartTargetSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const snapshot = await jobFinderWorkspaceService.approveApply(
        jobId,
        startNewApplication ? null : applicationRecordId,
      );

      return workspaceMutationResponse(event.sender, snapshot);
    },
  );

  ipcMain.handle("job-finder:reset-browser", async (event) =>
    workspaceMutationResponse(event.sender, await resetJobFinderBrowser()),
  );
  ipcMain.handle("job-finder:reset-workspace", async (event) => {
    return workspaceMutationResponse(
      event.sender,
      await resetJobFinderWorkspace(),
    );
  });

  ipcMain.handle("job-finder:get-startup-reset-recovery", () =>
    JobFinderStartupResetRecoveryFactSchema.parse(
      getJobFinderStartupResetRecoveryFact(),
    ),
  );

  ipcMain.handle("job-finder:get-startup-database-recovery", async () =>
    JobFinderStartupDatabaseRecoveryFactSchema.parse(
      await getJobFinderStartupDatabaseRecoveryFact(),
    ),
  );

  ipcMain.handle(
    "job-finder:dismiss-startup-database-recovery-notice",
    async () =>
      JobFinderStartupDatabaseRecoveryFactSchema.parse(
        await dismissJobFinderStartupDatabaseRecoveryNotice(),
      ),
  );
}
