import {
  createSavedAnswersStore,
  readSavedApplicationAnswers,
} from "@nestor/db/applications";
import { createJobSitesStore, createResumeStore } from "@nestor/db/job-store";
import { jobSiteTarget } from "@nestor/contracts";
import { startResumeService } from "../resumes";
import { startApplicationService } from "../applications";
import type { ApplicationService } from "@nestor/job-finder/applications";
import {
  createApplicationPageAccess,
  createPreparedApplicationFormStore,
} from "./prepared-application-forms";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { setJobSearchServiceFactory } from "../job-commands";
import { getJobStore } from "../job-store";
import { installDiscoveryFeedWorkers } from "./discovery-cpu";
import type { Page } from "playwright";
import { publishJobFinderWorkspaceUpdate } from "./workspace-updates";
import {
  publishOnApplyStandingChanges,
  publishOnUserActionChanges,
} from "./user-action-update-push";
import { withEmbeddedBrowserActivity } from "../browser/embedded-browser-runtime";
import {
  type BrowserVisualAnalysisInput,
  type BrowserVisualObservationSet,
  createDeterministicJobFinderAiClient,
  createBrowserVisualAnalysisProviderFromEnvironment,
  createJobFinderAiClientFromEnvironment,
  createDeterministicResumeVisionProvider,
  createResumeVisionProviderFromEnvironment,
} from "@nestor/ai-providers";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createBrowserAgentRuntime,
  createCatalogBrowserSessionRuntime,
} from "@nestor/browser-runtime";
import type {
  BrowserSessionRuntime,
  PreparedApplicationFormStore,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import type { BrowserSessionState } from "@nestor/contracts";
import { JobFinderStartupDatabaseRecoveryFactSchema } from "@nestor/contracts";
import {
  createFileJobFinderRepository,
  WorkspaceDatabaseRecoveryRequiredError,
  type JobFinderRepository,
  type WorkspaceDatabaseRecoveryRequiredDetails,
  type WorkspaceDatabaseRestoreTelemetryEvent,
} from "@nestor/db";
import {
  createDefaultListingHtmlFetcher,
  createJobFinderWorkspaceService,
  createListingSearchEngine,
  createJobSearchRunner,
} from "@nestor/job-finder";
import { createLocalJobFinderDocumentManager } from "../../adapters/job-finder-document-manager";
import { createResumeDraftProcessor } from "../../adapters/resume-draft-processor";
import { createLocalResumeExportFileVerifier } from "../../adapters/job-finder-export-file-verifier";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { prepareWorkspaceWriter } from "../../setup/workspace-database-startup";
import { createDesktopResumeResearchAdapter } from "../../adapters/job-finder-research-adapter";
import {
  ensureJobFinderUserDataDirectory,
  getBrowserAgentProfileDirectory,
  getJobFinderDocumentsDirectory,
  getGeneratedResumeDocumentsDirectory,
  getJobFinderUserDataDirectory,
  getJobFinderWorkspaceFilePath,
} from "./paths";
import {
  getResumePreviewTestMode,
  getTestBrowserSessionDetail,
  getTestBrowserSessionLabel,
  getTestBrowserSessionStatus,
  isBrowserAgentEnabled,
  isBrowserHeadlessEnabled,
  isDesktopTestApiEnabled,
  isEnabled,
} from "./test-api";
import { migrateLegacyResumeSource } from "./migrate-resume-source";
import {
  getJobFinderStartupResetRecoveryFact,
  recoverPendingJobFinderWorkspaceReset,
} from "./reset-workspace";
import { getCandidateAssetLibrary } from "./candidate-asset-library-instance";
import { installAutomaticSourceAccessResume } from "./automatic-source-access-resume";
import {
  createSessionListingHtmlFetcher,
  withBrowserSignInRetry,
} from "./listing-html-with-browser-session";
import type {
  JobFinderStartupDatabaseRecoveryBlockedFact,
  JobFinderStartupDatabaseRecoveryFact,
  JobFinderStartupDatabaseRecoveryRestoredFact,
} from "../../../shared/job-finder-startup-db-recovery";

// The authority manager must use the same repository handle as the workspace
// service. A weak association keeps this accessor scoped to the live service
// instance without retaining a shut-down workspace in process memory.
const pageAccessByWorkspaceService = new WeakMap<
  object,
  ReturnType<typeof createApplicationPageAccess>
>();
export function getApplicationPageAccessForWorkspaceService(service: object) {
  const access = pageAccessByWorkspaceService.get(service);
  if (!access) throw new Error("Application page access is unavailable.");
  return access;
}
const repositoryByWorkspaceService = new WeakMap<object, JobFinderRepository>();
let disposeAutomaticSourceAccessResume: (() => void) | null = null;

export function getJobFinderRepositoryForWorkspaceService(
  workspaceService: object,
): JobFinderRepository | null {
  return repositoryByWorkspaceService.get(workspaceService) ?? null;
}

const deterministicTestTimestamp = "2026-03-20T10:00:00.000Z";

/**
 * Database-only recovery snapshots written next to the live workspace
 * database. Background maintenance rotates `<workspace>.backup` (prior generation
 * preserved as `.backup.prev`); destructive resets snapshot into the
 * dedicated `<workspace>.reset-backup` while they run. A successful reset
 * deletes every snapshot, because the person asked for permanent deletion.
 *
 * Scope limitation: these snapshots recover the SQLite database only. They
 * do NOT include generated resume documents, candidate assets, application
 * documents, or browser profile data, so a full-workspace restore after a
 * destructive reset is not possible from them alone. Snapshot failures are
 * non-fatal and never block shutdown or reset.
 */
export const DESKTOP_AUTOMATIC_DATABASE_BACKUP_OPTIONS = {
  inBackground: true,
  // Copying the whole database at launch competed with the window's first
  // reads; the daily check starts once launch is over.
  firstCheckDelayMs: 2 * 60 * 1000,
  beforeReset: true,
} as const;

const STARTUP_DATABASE_RECOVERY_FACT_VERSION = 1;
const STARTUP_DATABASE_RECOVERY_FACT_FILE_NAME =
  "job-finder-startup-db-recovery.json";

/**
 * Session-scoped disclosure of startup database recovery outcomes. Restored
 * incidents are mirrored into a small app-owned JSON file next to (never
 * inside) the recovered database so the notice survives renderer and app
 * restarts until it is explicitly dismissed. Blocked incidents stay in
 * memory only: they are re-derived on every launch while the retained
 * artifacts still prevent the database from opening.
 */
let startupDatabaseRecoveryFact: JobFinderStartupDatabaseRecoveryFact = {
  status: "idle",
};
let startupDatabaseRecoveryFactHydrated = false;

function getStartupDatabaseRecoveryFactFilePath(): string {
  return path.join(
    getJobFinderUserDataDirectory(),
    STARTUP_DATABASE_RECOVERY_FACT_FILE_NAME,
  );
}

function readPersistedStartupDatabaseRecoveryFact(
  fileContent: string,
): JobFinderStartupDatabaseRecoveryFact | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !==
      STARTUP_DATABASE_RECOVERY_FACT_VERSION
  ) {
    return null;
  }

  const fact = (parsed as { fact?: unknown }).fact;
  const parsedFact = JobFinderStartupDatabaseRecoveryFactSchema.safeParse(fact);
  return parsedFact.success ? parsedFact.data : null;
}

async function persistStartupDatabaseRecoveryFact(
  fact: JobFinderStartupDatabaseRecoveryRestoredFact,
): Promise<void> {
  const factPath = getStartupDatabaseRecoveryFactFilePath();
  const temporaryFactPath = `${factPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryFactPath,
      `${JSON.stringify({
        version: STARTUP_DATABASE_RECOVERY_FACT_VERSION,
        fact,
      })}\n`,
      "utf8",
    );
    await rename(temporaryFactPath, factPath);
  } catch (error) {
    await rm(temporaryFactPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function recordRestoredStartupDatabaseRecoveryEvent(
  event: WorkspaceDatabaseRestoreTelemetryEvent,
): void {
  const fact: JobFinderStartupDatabaseRecoveryRestoredFact = {
    status: "restored",
    incidentId: event.incidentId,
    restoredFrom: event.restoredFrom,
    lossWindow: {
      detectedAtIso: event.lossWindow.detectedAtIso,
      quarantinedDatabaseModifiedAtIso:
        event.lossWindow.quarantinedDatabaseModifiedAtIso,
      restoredSnapshotModifiedAtIso:
        event.lossWindow.restoredSnapshotModifiedAtIso,
    },
    quarantinedArtifactBasenames: [...event.quarantinedArtifactBasenames],
    restoredAtIso: new Date().toISOString(),
    dismissedAtIso: null,
  };
  startupDatabaseRecoveryFact = fact;
  startupDatabaseRecoveryFactHydrated = true;

  void persistStartupDatabaseRecoveryFact(fact).catch((error) => {
    console.warn(
      "[Desktop] The successful workspace database restore notice could not be persisted; it may not appear after the next app start.",
      error,
    );
  });
}

function recordBlockedStartupDatabaseRecoveryIncident(
  details: WorkspaceDatabaseRecoveryRequiredDetails,
): void {
  const blockedFact: JobFinderStartupDatabaseRecoveryBlockedFact = {
    status: "blocked",
    incidentId: details.incidentId,
    outcome: details.outcome,
    candidates: details.candidates.map((candidate) =>
      candidate.status === "invalid"
        ? {
            kind: candidate.kind,
            status: candidate.status,
            failedStage: candidate.failedStage,
          }
        : { kind: candidate.kind, status: candidate.status, failedStage: null },
    ),
    quarantineBasenames: [...details.quarantineBasenames],
  };
  startupDatabaseRecoveryFact = blockedFact;
  startupDatabaseRecoveryFactHydrated = true;
}

function clearBlockedStartupDatabaseRecoveryIncident(): void {
  if (startupDatabaseRecoveryFact.status === "blocked") {
    startupDatabaseRecoveryFact = { status: "idle" };
  }
}

export async function getJobFinderStartupDatabaseRecoveryFact(): Promise<JobFinderStartupDatabaseRecoveryFact> {
  if (startupDatabaseRecoveryFact.status !== "idle") {
    return startupDatabaseRecoveryFact;
  }

  if (!startupDatabaseRecoveryFactHydrated) {
    startupDatabaseRecoveryFactHydrated = true;
    try {
      const persistedFact = readPersistedStartupDatabaseRecoveryFact(
        await readFile(getStartupDatabaseRecoveryFactFilePath(), "utf8"),
      );
      if (persistedFact && persistedFact.status !== "idle") {
        startupDatabaseRecoveryFact = persistedFact;
      }
    } catch {
      // A missing or unreadable disclosure file leaves the fact idle.
    }
  }

  return startupDatabaseRecoveryFact;
}

export async function dismissJobFinderStartupDatabaseRecoveryNotice(): Promise<JobFinderStartupDatabaseRecoveryFact> {
  const currentFact = await getJobFinderStartupDatabaseRecoveryFact();
  if (
    currentFact.status !== "restored" ||
    currentFact.dismissedAtIso !== null
  ) {
    return currentFact;
  }

  const dismissedFact: JobFinderStartupDatabaseRecoveryRestoredFact = {
    ...currentFact,
    dismissedAtIso: new Date().toISOString(),
  };
  startupDatabaseRecoveryFact = dismissedFact;

  try {
    await persistStartupDatabaseRecoveryFact(dismissedFact);
  } catch (error) {
    console.warn(
      "[Desktop] The dismissed workspace database restore notice could not be persisted; it may reappear after the next app start.",
      error,
    );
  }

  return dismissedFact;
}

function buildCatalogSessionLabel(
  status: BrowserSessionState["status"],
): string {
  switch (status) {
    case "ready":
      return "Browser session ready";
    case "login_required":
      return "Browser session needs sign-in";
    case "blocked":
      return "Browser session blocked";
    case "unknown":
      return "Browser session not started";
  }

  const exhaustiveStatus: never = status;
  throw new Error(
    `Unhandled browser session status: ${String(exhaustiveStatus)}`,
  );
}

function buildCatalogSessionDetail(
  status: BrowserSessionState["status"],
  desktopTestApiEnabled: boolean,
): string {
  switch (status) {
    case "ready":
      return desktopTestApiEnabled
        ? "Deterministic desktop test runtime is ready."
        : "Deterministic catalog runtime is ready.";
    case "login_required":
      return "A saved source needs sign-in before the next search can continue.";
    case "blocked":
      return "The shared browser session is blocked until you resolve the current browser issue.";
    case "unknown":
      return "Open the browser from the Browser button when you want to sign in or prepare a site before the next run.";
  }

  const exhaustiveStatus: never = status;
  throw new Error(
    `Unhandled browser session status: ${String(exhaustiveStatus)}`,
  );
}

function buildCatalogSessionSeed(
  env: NodeJS.ProcessEnv,
  desktopTestApiEnabled: boolean,
): BrowserSessionState {
  const status = desktopTestApiEnabled
    ? (getTestBrowserSessionStatus(env) ?? "ready")
    : "ready";
  const label = desktopTestApiEnabled
    ? (getTestBrowserSessionLabel(env) ?? buildCatalogSessionLabel(status))
    : buildCatalogSessionLabel(status);
  const detail = desktopTestApiEnabled
    ? (getTestBrowserSessionDetail(env) ??
      buildCatalogSessionDetail(status, desktopTestApiEnabled))
    : buildCatalogSessionDetail(status, desktopTestApiEnabled);

  return {
    source: "target_site",
    status,
    driver: "catalog_seed",
    label,
    detail,
    lastCheckedAt: desktopTestApiEnabled
      ? deterministicTestTimestamp
      : new Date().toISOString(),
  };
}

async function analyzeBrowserVisualSnapshotWithProvider(
  input: BrowserVisualAnalysisInput,
  provider: ReturnType<
    typeof createBrowserVisualAnalysisProviderFromEnvironment
  >,
): Promise<BrowserVisualObservationSet> {
  return provider.analyzeBrowserVisualSnapshot(input);
}

export function createDesktopJobFinderAiClient(
  env: NodeJS.ProcessEnv = process.env,
) {
  const desktopTestApiEnabled = isDesktopTestApiEnabled(env);
  const forceLiveAiDuringTestApi = isEnabled(env.NESTOR_TEST_API_USE_LIVE_AI);

  if (desktopTestApiEnabled && !forceLiveAiDuringTestApi) {
    return createDeterministicJobFinderAiClient(
      "Desktop test API forces deterministic AI runtime so scripted UI flows stay stable even when local model credentials exist.",
      { generationReason: "forced_deterministic" },
    );
  }

  const aiClient = createJobFinderAiClientFromEnvironment(env);

  if (aiClient.analyzeBrowserVisualSnapshot) {
    return aiClient;
  }

  const browserVisualProvider =
    createBrowserVisualAnalysisProviderFromEnvironment(env);

  return {
    ...aiClient,
    analyzeBrowserVisualSnapshot: (input: BrowserVisualAnalysisInput) =>
      analyzeBrowserVisualSnapshotWithProvider(input, browserVisualProvider),
  };
}

export function createDesktopResumeVisionProvider(
  env: NodeJS.ProcessEnv = process.env,
) {
  const desktopTestApiEnabled = isDesktopTestApiEnabled(env);
  const forceLiveAiDuringTestApi = isEnabled(env.NESTOR_TEST_API_USE_LIVE_AI);

  if (desktopTestApiEnabled && !forceLiveAiDuringTestApi) {
    return createDeterministicResumeVisionProvider(
      "Desktop test API forces deterministic resume vision runtime so scripted UI flows stay stable even when local vision credentials exist.",
    );
  }

  return createResumeVisionProviderFromEnvironment(env);
}

export function createDesktopBrowserRuntime(
  input: {
    env?: NodeJS.ProcessEnv;
    aiClient?: ReturnType<typeof createDesktopJobFinderAiClient>;
    desktopTestApiEnabled?: boolean;
    preparedFormStore?: PreparedApplicationFormStore;
  } = {},
): BrowserSessionRuntime {
  const env = input.env ?? process.env;
  const desktopTestApiEnabled =
    input.desktopTestApiEnabled ?? isDesktopTestApiEnabled(env);
  const rawPort = env.NESTOR_CHROME_DEBUG_PORT
    ? Number.parseInt(env.NESTOR_CHROME_DEBUG_PORT, 10)
    : null;
  const chromeDebugPort =
    rawPort !== null &&
    Number.isInteger(rawPort) &&
    rawPort > 0 &&
    rawPort <= 65535
      ? rawPort
      : null;

  if (isBrowserAgentEnabled(env)) {
    const aiClient = input.aiClient ?? createDesktopJobFinderAiClient(env);
    const embedded =
      env.NESTOR_BROWSER_HOST === "external" ||
      (desktopTestApiEnabled && env.NESTOR_BROWSER_HOST !== "embedded")
        ? null
        : getEmbeddedBrowser();
    const baseRuntime = createBrowserAgentRuntime({
      ...(input.preparedFormStore
        ? { preparedFormStore: input.preparedFormStore }
        : {}),
      userDataDir: getBrowserAgentProfileDirectory(),
      headless: isBrowserHeadlessEnabled(env),
      ...(env.NESTOR_CHROME_PATH
        ? { chromeExecutablePath: env.NESTOR_CHROME_PATH }
        : {}),
      ...(chromeDebugPort !== null ? { debugPort: chromeDebugPort } : {}),
      jobExtractor: (runtimeInput) =>
        aiClient.extractJobsFromPage(runtimeInput),
      aiClient,
      ...(embedded
        ? {
            onApplicationPageRestored: async (
              key: string,
              page: Page,
              label?: string,
            ) => {
              await embedded.runAutomation(
                "Restoring application",
                undefined,
                async (_signal, _update, claim, tabs) => {
                  claim(page);
                  const claimed = await tabs();
                  if (label)
                    for (const id of claimed)
                      embedded.setApplicationTabLabel(
                        id,
                        "",
                        "",
                        "",
                        key.slice(-6),
                        label,
                      );
                },
                { owner: key },
              );
              embedded.markPreparedForm(key);
            },
            browserHost: {
              connect: () => embedded.connect(),
              getOpenBrowser: () => embedded.getOpenBrowser(),
              close: () => embedded.releaseAutomationSession(),
              assertAutomationSafe: () => embedded.assertAutomationSafe(),
              openTabCount: () => embedded.openTabCount(),
              workingTabCount: () => embedded.workingTabCount(),
              hasAutomationTabCapacity: (reservedTabs?: number) =>
                embedded.hasAutomationTabCapacity(reservedTabs),
            },
          }
        : {}),
    });
    const runtime = embedded
      ? withEmbeddedBrowserActivity(baseRuntime, embedded)
      : baseRuntime;

    if (
      desktopTestApiEnabled &&
      isEnabled(env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES)
    ) {
      return {
        ...runtime,
        executeApplicationFlow: (source, executionInput, executionOptions) => {
          let syntheticOrigin: string | null = null;
          try {
            const candidate = new URL(
              executionInput.job.applicationUrl ??
                executionInput.job.canonicalUrl,
            );
            if (
              candidate.hostname === "localhost" ||
              candidate.hostname === "127.0.0.1" ||
              candidate.hostname === "[::1]"
            ) {
              syntheticOrigin = candidate.origin;
            }
          } catch {
            syntheticOrigin = null;
          }
          return runtime.executeApplicationFlow(
            source,
            syntheticOrigin === null
              ? executionInput
              : {
                  ...executionInput,
                  intermediateMutationsAuthorized: true,
                  intermediateMutationAllowedOrigins: [syntheticOrigin],
                  recheckIntermediateMutationAuthority: (observedOrigin) =>
                    Promise.resolve(observedOrigin === syntheticOrigin),
                  accountCreationAuthorized: false,
                  submitAuthorized: false,
                },
            executionOptions,
          );
        },
      };
    }

    return runtime;
  }

  const runtime = createCatalogBrowserSessionRuntime({
    sessions: [buildCatalogSessionSeed(env, desktopTestApiEnabled)],
    catalog: [],
  });

  return {
    ...runtime,
    async openSession(source, options?: OpenBrowserSessionOptions) {
      const hasTargetId = Boolean(options?.targetId);

      if (options?.targetUrl || hasTargetId) {
        throw new Error(
          "Targeted sign-in requires the browser agent runtime, but it is disabled in this desktop build.",
        );
      }

      return runtime.openSession(source, options);
    },
  };
}

/**
 * Everything Job Finder runs on below the old workspace service: the
 * repository, AI, browser and documents, with the resume writer and Apply
 * started on them. App start runs this after the first screen, so queued
 * resumes and an interrupted send carry on without any old screen loading.
 */
export interface JobFinderRuntime {
  jobFinderRepository: JobFinderRepository;
  aiClient: ReturnType<typeof createDesktopJobFinderAiClient>;
  visionProvider: ReturnType<typeof createDesktopResumeVisionProvider>;
  browserRuntime: ReturnType<typeof createDesktopBrowserRuntime>;
  resumeDraftProcessor: ReturnType<typeof createResumeDraftProcessor>;
  documentManager: ReturnType<typeof createLocalJobFinderDocumentManager>;
  exportFileVerifier: ReturnType<typeof createLocalResumeExportFileVerifier>;
  researchAdapter:
    | ReturnType<typeof createDesktopResumeResearchAdapter>
    | undefined;
  usesEmbeddedBrowser: boolean;
  fetchListingHtml: ReturnType<typeof withBrowserSignInRetry>;
  applicationService: ApplicationService;
}

export async function createJobFinderRuntimeAsync(
  envOverrides?: Partial<NodeJS.ProcessEnv>,
): Promise<JobFinderRuntime> {
  const env = {
    ...process.env,
    ...(envOverrides ?? {}),
  };
  const desktopTestApiEnabled = isDesktopTestApiEnabled(env);
  await ensureJobFinderUserDataDirectory();
  const backgroundEvidenceConversion = await prepareWorkspaceWriter();
  let jobFinderRepository: JobFinderRepository;
  try {
    jobFinderRepository = await createFileJobFinderRepository({
      store: getJobStore(),
      filePath: getJobFinderWorkspaceFilePath(),
      seed: createEmptyJobFinderRepositoryState(),
      deferEvidenceConversion: backgroundEvidenceConversion,
      automaticBackup: DESKTOP_AUTOMATIC_DATABASE_BACKUP_OPTIONS,
      recoveryTelemetry: {
        onRestored: recordRestoredStartupDatabaseRecoveryEvent,
      },
    });
  } catch (error) {
    if (error instanceof WorkspaceDatabaseRecoveryRequiredError) {
      recordBlockedStartupDatabaseRecoveryIncident(error.details);
    }
    throw error;
  }
  // Reconcile any crash-interrupted authority attempt before constructing or
  // exposing the workspace service. The repository transition is durable and
  // idempotent: armed attempts become permanently uncertain, active grants are
  // revoked, and no browser action or submission capability is opened here.
  await jobFinderRepository.recoverArmedSubmissionAttempts({
    now: new Date().toISOString(),
  });
  clearBlockedStartupDatabaseRecoveryIncident();
  await recoverPendingJobFinderWorkspaceReset(jobFinderRepository);
  await migrateLegacyResumeSource({
    documentsDirectory: getJobFinderDocumentsDirectory(),
    repository: jobFinderRepository,
  });
  const aiClient = createDesktopJobFinderAiClient(env);
  const visionProvider = createDesktopResumeVisionProvider(env);
  const browserRuntime = createDesktopBrowserRuntime({
    preparedFormStore: createPreparedApplicationFormStore(
      jobFinderRepository,
      getCandidateAssetLibrary(),
    ),
    env,
    aiClient,
    desktopTestApiEnabled,
  });
  // The new background search (Find jobs) runs on the same browser and AI.
  setJobSearchServiceFactory(() =>
    Promise.resolve(
      createJobSearchRunner({
        store: getJobStore(),
        readRemoteCountsAsAnyLocation: async () =>
          (await jobFinderRepository.getSettings()).aiBehavior?.jobSearch
            .remoteCountsAsAnyLocation ?? true,
        engine: createListingSearchEngine({
          browserRuntime,
          aiClient,
        }),
        readContext: async () => {
          const [
            profile,
            searchPreferences,
            sourceInstructionArtifacts,
            settings,
          ] = await Promise.all([
            jobFinderRepository.getProfile(),
            jobFinderRepository.getSearchPreferences(),
            jobFinderRepository.listSourceInstructionArtifacts(),
            jobFinderRepository.getSettings(),
          ]);
          return {
            profile,
            searchPreferences,
            sources: createJobSitesStore(getJobStore())
              .enabled()
              .map(jobSiteTarget),
            sourceInstructionArtifacts,
            remoteCountsAsAnyLocation:
              settings.aiBehavior?.jobSearch.remoteCountsAsAnyLocation ?? true,
          };
        },
      }),
    ),
  );
  const resumeDraftProcessor = createResumeDraftProcessor();
  const documentManager = createLocalJobFinderDocumentManager({
    renderResumeHtml: (input) => resumeDraftProcessor.render(input),
    inspectPdf: (filePath) => resumeDraftProcessor.inspectPdf(filePath),
    outputDirectory: getGeneratedResumeDocumentsDirectory(),
    // An ambiguous reset preserves its files for recovery. Do not classify
    // unreferenced exports as obsolete while the reset could not be reconciled.
    ...(getJobFinderStartupResetRecoveryFact().status === "degraded"
      ? {}
      : {
          // The job store's resumes and applications use the same folder.
          retainedResumePaths: async () => [
            ...(await jobFinderRepository.listRetainedResumeExportPaths()),
            ...createResumeStore(getJobStore()).pdfPathsInUse(),
          ],
        }),
    previewTestMode: desktopTestApiEnabled
      ? getResumePreviewTestMode(env)
      : "ok",
  });
  const exportFileVerifier = createLocalResumeExportFileVerifier();
  void documentManager.pruneGeneratedResumeFiles?.();
  const researchAdapter = desktopTestApiEnabled
    ? undefined
    : createDesktopResumeResearchAdapter();

  const usesEmbeddedBrowser =
    env.NESTOR_BROWSER_HOST !== "external" &&
    (!desktopTestApiEnabled || env.NESTOR_BROWSER_HOST === "embedded");
  publishOnUserActionChanges(jobFinderRepository, () =>
    publishJobFinderWorkspaceUpdate(),
  );
  publishOnApplyStandingChanges(jobFinderRepository, () =>
    publishJobFinderWorkspaceUpdate(),
  );
  installDiscoveryFeedWorkers();
  // Listing bodies are read over plain HTTP from the main process; the
  // package only reads when a host hands it a reader, so tests stay offline.
  // A source the person signed in to in the Job Finder browser is read
  // again with that sign-in when the plain read meets its sign-in page.
  const fetchListingHtml = withBrowserSignInRetry(
    createDefaultListingHtmlFetcher(),
    usesEmbeddedBrowser
      ? createSessionListingHtmlFetcher(() => getEmbeddedBrowser().getSession())
      : null,
  );
  startResumeService({
    aiClient,
    documentManager,
    fetchListingHtml,
    repository: jobFinderRepository,
  });
  const applicationService = await startApplicationService({
    repository: jobFinderRepository,
    browser: browserRuntime,
    aiClient,
    documentManager,
    isHoldingCurrent: async () => {
      const control = await jobFinderRepository.getActivityControl();
      return control.paused && control.pauseBehavior !== "finish_current";
    },
  });
  return {
    jobFinderRepository,
    aiClient,
    visionProvider,
    browserRuntime,
    resumeDraftProcessor,
    documentManager,
    exportFileVerifier,
    researchAdapter,
    usesEmbeddedBrowser,
    fetchListingHtml,
    applicationService,
  };
}

export async function createJobFinderWorkspaceServiceAsync(
  envOverrides?: Partial<NodeJS.ProcessEnv>,
  started?: JobFinderRuntime,
) {
  const {
    jobFinderRepository,
    aiClient,
    visionProvider,
    browserRuntime,
    resumeDraftProcessor,
    documentManager,
    exportFileVerifier,
    researchAdapter,
    usesEmbeddedBrowser,
    fetchListingHtml,
    applicationService,
  } = started ?? (await createJobFinderRuntimeAsync(envOverrides));
  const workspaceService = createJobFinderWorkspaceService({
    jobSites: createJobSitesStore(getJobStore()),
    savedAnswers: createSavedAnswersStore(getJobStore()),
    readSavedAnswers: () => readSavedApplicationAnswers(getJobStore()),
    resumeDraftProcessor,
    aiClient,
    visionProvider,
    documentManager,
    exportFileVerifier,
    repository: jobFinderRepository,
    browserRuntime,
    candidateAssetResolver: getCandidateAssetLibrary(),
    ...(researchAdapter ? { researchAdapter } : {}),
    fetchListingHtml,
    onDetachedApplyRunFinished: () => publishJobFinderWorkspaceUpdate(),
    onResumeEvidenceFinished: () => publishJobFinderWorkspaceUpdate(),
    onShortlistResumeChanged: () => publishJobFinderWorkspaceUpdate(),
    onListingAssessmentFinished: () => publishJobFinderWorkspaceUpdate(),
    onSavedJobsRescored: () => publishJobFinderWorkspaceUpdate(),
    onFitJudgmentProgress: () => publishJobFinderWorkspaceUpdate(),
    // The embedded browser keeps its own pause flag. Every activity-control
    // change (Home's button, or an explicit click resuming paused work) is
    // mirrored onto it, so a resume never leaves the browser refusing work
    // with "Browser activity is paused".
    ...(usesEmbeddedBrowser
      ? {
          onActivityControlChanged: (control) => {
            applicationService.wake();
            // Home pauses new work at the queue boundary. Keep the browser
            // available to the job already being filled; browser takeover
            // still uses the immediate abort path.
            getEmbeddedBrowser().syncActivityPaused(
              control.paused && control.pauseBehavior !== "finish_current",
            );
          },
          // A deliberate start after the person closed the browser mid-run
          // may open it again.
          onExplicitUserStart: () => getEmbeddedBrowser().clearPersonPause(),
          hasRunJobSearch: () => {
            const latest = getJobStore().searches.latest();
            return latest !== null && latest.state !== "running";
          },
        }
      : {}),
  });
  repositoryByWorkspaceService.set(workspaceService, jobFinderRepository);
  pageAccessByWorkspaceService.set(
    workspaceService,
    createApplicationPageAccess(jobFinderRepository, browserRuntime),
  );
  disposeAutomaticSourceAccessResume?.();
  disposeAutomaticSourceAccessResume = null;
  // A step confirmed by a watcher (the person signed in) runs its whole
  // continuation in this process, with no renderer call to answer. Keep the
  // screens current while it runs and when it ends, as a press would.
  const performWatchedUserAction = async (
    command: Parameters<typeof workspaceService.performUserAction>[0],
  ) => {
    publishJobFinderWorkspaceUpdate();
    const heartbeat = setInterval(
      () => publishJobFinderWorkspaceUpdate(),
      3_000,
    );
    try {
      return await workspaceService.performUserAction(command);
    } finally {
      clearInterval(heartbeat);
      publishJobFinderWorkspaceUpdate();
    }
  };
  if (usesEmbeddedBrowser) {
    const browser = getEmbeddedBrowser();
    const savedControl = await jobFinderRepository.getActivityControl();
    browser.syncActivityPaused(
      savedControl.paused && savedControl.pauseBehavior !== "finish_current",
    );
    browser.setActivityHooks({
      pause: async (reason) => {
        await workspaceService.setActivityControl({ paused: true, reason });
      },
      resume: async () => {
        await workspaceService.setActivityControl({ paused: false });
      },
      // Handing back a tab the person stepped into carries on the
      // applications that stepping in stopped, with no Try again to find.
      handback: (owners) => {
        applicationService.continueBindings(owners);
        publishJobFinderWorkspaceUpdate();
        return Promise.resolve();
      },
    });
    disposeAutomaticSourceAccessResume = installAutomaticSourceAccessResume({
      browser,
      browserRuntime,
      repository: jobFinderRepository,
      performUserAction: performWatchedUserAction,
    });
  }

  return workspaceService;
}
