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
import type { IpcMain, IpcMainInvokeEvent, SaveDialogOptions } from "electron";
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
  JobFinderWorkspaceEntityMutationInputSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobFinderJobDetailQuerySchema,
  JobFinderWorkspaceSyncInputSchema,
  JobFinderWorkspaceHeldRevisionSchema,
  ResumeImportBenchmarkReportSchema,
  ResumeImportBenchmarkCaseSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  WriteClipboardTextInputSchema,
  WriteClipboardTextResultSchema,
} from "@nestor/contracts";
import type {
  JobFinderWorkspaceSnapshot,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
} from "@nestor/contracts";

import { collectJobFinderPerformanceSnapshot } from "../services/job-finder/collect-performance-snapshot";
import { createJobFinderWorkspaceDeltaTracker } from "../services/job-finder/workspace-delta";
import { toRendererWorkspaceSnapshot } from "../services/job-finder/renderer-workspace-view";
import { usesWorkspaceQueryUpdates } from "../services/job-finder/query-update-mode";
import {
  notifyJobFinderWorkspaceListeners,
  publishJobFinderWorkspaceUpdate,
} from "../services/job-finder/workspace-updates";
import {
  getJobFinderRepositoryForWorkspaceService,
  getJobFinderWorkspaceService,
  importResumeFromSourcePath,
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
import {
  checkSiteForRequest,
  importResumeForRequest,
  readWorkspaceProjection,
} from "./profile-workflow-requests";

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
] as const satisfies readonly (keyof JobFinderWorkspaceSnapshot)[];

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
      const imported = await importResumeForRequest(
        ipcMain,
        event,
        payload,
        async () =>
          (await readWorkspaceProjection(await getJobFinderWorkspaceService()))
            .latestResumeImportRun ?? null,
      );
      return workspaceMutationResponse(
        event.sender,
        imported ??
          (await readWorkspaceProjection(await getJobFinderWorkspaceService())),
      );
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
      return workspaceMutationResponse(
        event.sender,
        await checkSiteForRequest(event, {
          targetId: input.targetId,
          requestId: input.requestId?.trim() ? input.requestId : null,
          readabilityTimeoutMs:
            input.readabilityTimeoutMs === undefined
              ? null
              : Math.min(Math.trunc(input.readabilityTimeoutMs), 15_000),
        }),
      );
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
