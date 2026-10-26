import { buildDiagnosticsFileExport } from "../services/job-finder/workspace-file-exports";
import { readJobFinderJobDetail } from "../services/job-finder/read-job-detail";
import {
  JOB_FINDER_ACTIONS,
  executeJobFinderAction,
  type JobFinderActionId,
} from "@nestor/job-finder";
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";
import { resetJobFinderBrowser } from "../services/job-finder/reset-workspace";
import { writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { BrowserWindow, clipboard, dialog, shell } from "electron";
import type {
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  SaveDialogOptions,
} from "electron";
import {
  DesktopTestOkResponseSchema,
  JobFinderRepositoryStateSchema,
  JobFinderStartupDatabaseRecoveryFactSchema,
  JobFinderStartupResetRecoveryFactSchema,
  ResumeImportBenchmarkRequestSchema,
  RevealSavedFileInputSchema,
  RevealSavedFileResultSchema,
  JobFinderOpenBrowserSessionInputSchema,
  JobFinderPerformanceSnapshotSchema,
  JobFinderDiagnosticExportResultSchema,
  JobFinderRunSourceDebugInputSchema,
  JobFinderSourceInstructionActionInputSchema,
  SaveJobFinderWorkspaceInputSchema,
  SourceDebugProgressEventSchema,
  JobFinderWorkspaceEntityMutationInputSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobFinderJobDetailQuerySchema,
  JobFinderWorkspaceSyncInputSchema,
  JobFinderWorkspaceHeldRevisionSchema,
  ResumeImportBenchmarkReportSchema,
  ResumeImportBenchmarkCaseSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ImportResumeRequestSchema,
  CancelResumeImportRequestSchema,
  ResumeImportProgressEventSchema,
  ResumeImportRunSchema,
  WriteClipboardTextInputSchema,
  WriteClipboardTextResultSchema,
} from "@nestor/contracts";
import type {
  JobFinderApplyQueueActionInput,
  JobFinderWorkspaceSnapshot,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
} from "@nestor/contracts";

import {
  recordApplicationAuthoritySuccessor,
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "@nestor/job-finder";

import { collectJobFinderPerformanceSnapshot } from "../services/job-finder/collect-performance-snapshot";
import { createJobFinderWorkspaceDeltaTracker } from "../services/job-finder/workspace-delta";
import { toRendererWorkspaceSnapshot } from "../services/job-finder/renderer-workspace-view";
import { usesWorkspaceQueryUpdates } from "../services/job-finder/query-update-mode";
import {
  notifyJobFinderWorkspaceListeners,
  publishJobFinderWorkspaceUpdate,
} from "../services/job-finder/workspace-updates";
import { runBoundedNewSourceReadabilityCheck } from "../services/job-finder/new-source-readability-check";
import {
  getJobFinderApplicationAuthorityService,
  getJobFinderRepositoryForWorkspaceService,
  getJobFinderWorkspaceService,
  importResumeFromSourcePath,
  retryInterruptedResumeImport,
  isDesktopTestApiEnabled,
  loadApplyQueueDemoState,
  loadAgentOwnedBrowserDriveState,
  loadWorkHistoryReviewDriveState,
  parseResumeImportPathPayload,
  resetJobFinderWorkspace,
  getJobFinderStartupResetRecoveryFact,
  dismissJobFinderStartupDatabaseRecoveryNotice,
  getJobFinderStartupDatabaseRecoveryFact,
  runDesktopResumeImportBenchmark,
  defaultBenchmarkCases,
} from "../services/job-finder";
import {
  armJobFinderTestSaveFailure,
  consumeArmedJobFinderTestSaveFailure,
  type JobFinderSaveChannel,
} from "../services/job-finder/test-save-failure";
import { registerJobFinderBootstrapDesktopRoutes } from "../setup/register-job-finder-bootstrap-routes";

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
    modeOverride ??
    settings.applicationAutomationMode ??
    "confirm_before_submit";
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
        Math.max(1, jobIds.length, perRunFloor),
      ),
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
      (latestSettings.applicationAutomationMode ?? "confirm_before_submit") !==
      (settings.applicationAutomationMode ?? "confirm_before_submit")
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
        (currentSettings.applicationAutomationMode ??
          "confirm_before_submit") !==
        (settings.applicationAutomationMode ?? "confirm_before_submit")
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
      name === "update-appearance-theme"
        ? { appearanceTheme: payload }
        : (payload ?? {});
    const service = await getJobFinderWorkspaceService();
    const result = await executeJobFinderAction(name, value, { service });
    // Some changes answer with their own record (application details, a
    // recommendation); only a workspace snapshot becomes a sync response.
    const isWorkspaceSnapshot =
      typeof result === "object" &&
      result !== null &&
      (result as { module?: unknown }).module === "job-finder";
    // A change answered with its delta needs no second sync of the whole
    // workspace in this window; main's listeners still hear of it. Shortlist
    // starts a draft, so it keeps the follow-up.
    if (JOB_FINDER_ACTIONS[name].safety !== "read") {
      if (!isWorkspaceSnapshot || name === "queue-job-for-review")
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
    "save-profile-setup-state",
    "save-settings",
    "update-application-defaults",
    "update-workspace-behavior",
    "update-ai-behavior",
    "update-appearance-theme",
  ] as const) {
    handleJobFinderSaveRoute(`job-finder:${name}`, (event, payload: unknown) =>
      runRegisteredAction(name, event, payload),
    );
  }
  for (const name of [
    "analyze-profile-from-resume",
    "set-activity-control",
    "apply-profile-setup-review-action",
    "apply-resume-timeline-repair-action",
    "undo-profile-revision",
    "cancel-source-debug",
    "get-source-debug-run",
    "get-source-debug-run-details",
    "save-source-instruction-artifact",
    "list-source-debug-runs",
    "accept-source-instruction-draft",
    "queue-job-for-review",
    "remove-job-from-review",
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
          case "remove_job_from_review":
            return jobFinderWorkspaceService.removeJobFromReview(
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
    "job-finder:run-source-debug",
    async (event, payload: unknown) => {
      const input = JobFinderRunSourceDebugInputSchema.parse(payload);
      const { targetId } = input;
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      const requestId = input.requestId?.trim() ? input.requestId : null;
      const readabilityTimeoutMs =
        input.readabilityTimeoutMs === undefined
          ? null
          : Math.min(Math.trunc(input.readabilityTimeoutMs), 15_000);
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

  ipcMain.handle("job-finder:export-diagnostics", async (event) => {
    const service = await getJobFinderWorkspaceService();
    const diagnostic = await buildDiagnosticsFileExport(service);
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
