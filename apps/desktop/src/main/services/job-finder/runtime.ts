import {
  createJobFinderRepository,
  createJobSitesStore,
  createPreferencesStore,
  createResumeStore,
  createSourceAccessStore,
} from "@nestor/db/job-store";
import { readSavedApplicationAnswers } from "@nestor/db/applications";
import { jobSiteTarget } from "@nestor/contracts";
import type { BrowserSessionState } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { ApplicationService } from "@nestor/job-finder/applications";
import {
  createDefaultListingHtmlFetcher,
  createJobSearchRunner,
  createListingSearchEngine,
  createProfileService,
  type ProfileService,
} from "@nestor/job-finder";
import {
  type BrowserVisualAnalysisInput,
  type BrowserVisualObservationSet,
  createDeterministicJobFinderAiClient,
  createBrowserVisualAnalysisProviderFromEnvironment,
  createJobFinderAiClientFromEnvironment,
  createDeterministicResumeVisionProvider,
  createResumeVisionProviderFromEnvironment,
} from "@nestor/ai-providers";
import {
  createBrowserAgentRuntime,
  createCatalogBrowserSessionRuntime,
} from "@nestor/browser-runtime";
import type {
  BrowserSessionRuntime,
  PreparedApplicationFormStore,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import type { Page } from "playwright";
import { startResumeService, stopResumeService } from "../resumes";
import { startApplicationService } from "../applications";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { withEmbeddedBrowserActivity } from "../browser/embedded-browser-runtime";
import { setJobSearchServiceFactory } from "../job-commands";
import { getJobStore } from "../job-store";
import { getSendGuards } from "../send-guards";
import { createLocalJobFinderDocumentManager } from "../../adapters/job-finder-document-manager";
import { createResumeDraftProcessor } from "../../adapters/resume-draft-processor";
import { createPreparedApplicationFormStore } from "./prepared-application-forms";
import {
  installDiscoveryFeedWorkers,
  shutdownDiscoveryFeedWorkers,
} from "./discovery-cpu";
import {
  ensureJobFinderUserDataDirectory,
  getBrowserAgentProfileDirectory,
  getGeneratedResumeDocumentsDirectory,
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
import {
  getJobFinderStartupResetRecoveryFact,
  recoverPendingJobFinderWorkspaceReset,
} from "./reset-workspace";
import { getCandidateAssetLibrary } from "./candidate-asset-library-instance";
import {
  createSessionListingHtmlFetcher,
  withBrowserSignInRetry,
} from "./listing-html-with-browser-session";

const deterministicTestTimestamp = "2026-03-20T10:00:00.000Z";

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
 * Everything Job Finder runs on: the profile repository, AI, browser and
 * documents, with the resume writer, Apply and profile work started on
 * them. App start runs this after the first screen, so queued resumes and an
 * interrupted send carry on without any screen asking.
 */
export interface JobFinderRuntime {
  repository: JobFinderRepository;
  aiClient: ReturnType<typeof createDesktopJobFinderAiClient>;
  visionProvider: ReturnType<typeof createDesktopResumeVisionProvider>;
  browserRuntime: ReturnType<typeof createDesktopBrowserRuntime>;
  documentManager: ReturnType<typeof createLocalJobFinderDocumentManager>;
  applicationService: ApplicationService;
  profileService: ProfileService;
}

async function createJobFinderRuntime(
  envOverrides?: Partial<NodeJS.ProcessEnv>,
): Promise<JobFinderRuntime> {
  const env = {
    ...process.env,
    ...(envOverrides ?? {}),
  };
  const desktopTestApiEnabled = isDesktopTestApiEnabled(env);
  await ensureJobFinderUserDataDirectory();
  const store = getJobStore();
  const repository = createJobFinderRepository(store);
  // Reconcile any crash-interrupted send before Apply starts. The transition
  // is durable and idempotent: armed attempts become permanently uncertain,
  // active grants are revoked, and no browser action or submission
  // capability is opened here.
  await getSendGuards().recoverArmedSubmissionAttempts({
    now: new Date().toISOString(),
  });
  await recoverPendingJobFinderWorkspaceReset();
  const aiClient = createDesktopJobFinderAiClient(env);
  const visionProvider = createDesktopResumeVisionProvider(env);
  const browserRuntime = createDesktopBrowserRuntime({
    preparedFormStore: createPreparedApplicationFormStore(
      store,
      repository,
      getCandidateAssetLibrary(),
    ),
    env,
    aiClient,
    desktopTestApiEnabled,
  });
  const jobSites = createJobSitesStore(store);
  const searchPreferencesStore = createPreferencesStore(store);
  setJobSearchServiceFactory(() =>
    Promise.resolve(
      createJobSearchRunner({
        store,
        readRemoteCountsAsAnyLocation: () =>
          searchPreferencesStore.settings.read().aiBehavior?.jobSearch
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
            repository.getProfile(),
            repository.getSearchPreferences(),
            repository.listSourceInstructionArtifacts(),
            repository.getSettings(),
          ]);
          return {
            profile,
            searchPreferences,
            sources: jobSites.enabled().map(jobSiteTarget),
            sourceInstructionArtifacts,
            remoteCountsAsAnyLocation:
              settings.aiBehavior?.jobSearch.remoteCountsAsAnyLocation ?? true,
          };
        },
      }),
    ),
  );
  const resumeDraftProcessor = createResumeDraftProcessor();
  const resumes = createResumeStore(store);
  const documentManager = createLocalJobFinderDocumentManager({
    renderResumeHtml: (input) => resumeDraftProcessor.render(input),
    inspectPdf: (filePath) => resumeDraftProcessor.inspectPdf(filePath),
    outputDirectory: getGeneratedResumeDocumentsDirectory(),
    // An ambiguous reset preserves its files for recovery. Do not classify
    // unreferenced exports as obsolete while the reset could not be reconciled.
    ...(getJobFinderStartupResetRecoveryFact().status === "degraded"
      ? {}
      : {
          retainedResumePaths: () => Promise.resolve(resumes.pdfPathsInUse()),
        }),
    previewTestMode: desktopTestApiEnabled
      ? getResumePreviewTestMode(env)
      : "ok",
  });
  void documentManager.pruneGeneratedResumeFiles?.();

  const usesEmbeddedBrowser =
    env.NESTOR_BROWSER_HOST !== "external" &&
    (!desktopTestApiEnabled || env.NESTOR_BROWSER_HOST === "embedded");
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
    repository,
  });
  const applicationService = await startApplicationService({
    repository,
    browser: browserRuntime,
    aiClient,
    documentManager,
    isHoldingCurrent: async () => {
      const control = await repository.getActivityControl();
      return control.paused && control.pauseBehavior !== "finish_current";
    },
  });
  const profileService = createProfileService({
    repository,
    aiClient,
    visionProvider,
    browserRuntime,
    documentManager,
    jobSites,
    sourceAccess: createSourceAccessStore(store),
    readSavedAnswers: () => readSavedApplicationAnswers(store),
    hasRunJobSearch: () => {
      const latest = store.searches.latest();
      return latest !== null && latest.state !== "running";
    },
    approvedResumeJobIds: () => resumes.approvedJobIds().map(String),
    onActivityControlChanged: (control) => {
      applicationService.wake();
      // Home pauses new work at the queue boundary. Keep the browser
      // available to the job already being filled; browser takeover
      // still uses the immediate abort path.
      if (usesEmbeddedBrowser)
        getEmbeddedBrowser().syncActivityPaused(
          control.paused && control.pauseBehavior !== "finish_current",
        );
    },
  });
  if (usesEmbeddedBrowser) {
    const browser = getEmbeddedBrowser();
    const savedControl = await repository.getActivityControl();
    browser.syncActivityPaused(
      savedControl.paused && savedControl.pauseBehavior !== "finish_current",
    );
    browser.setActivityHooks({
      pause: async (reason) => {
        await profileService.setActivityControl({ paused: true, reason });
      },
      resume: async () => {
        await profileService.setActivityControl({ paused: false });
      },
      // Handing back a tab the person stepped into carries on the
      // applications that stepping in stopped, with no Try again to find.
      handback: (owners) => {
        applicationService.continueBindings(owners);
        return Promise.resolve();
      },
    });
  }
  return {
    repository,
    aiClient,
    visionProvider,
    browserRuntime,
    documentManager,
    applicationService,
    profileService,
  };
}

let runtimePromise: Promise<JobFinderRuntime> | undefined;
let overrideEnv: Partial<NodeJS.ProcessEnv> | null = null;
let closing = false;

/** Starts Job Finder's runtime once; every caller shares it. */
export function startJobFinderRuntime(): Promise<JobFinderRuntime> {
  if (runtimePromise) return runtimePromise;
  if (closing) return Promise.reject(new Error("Job Finder is closing."));
  const starting = createJobFinderRuntime(overrideEnv ?? undefined);
  runtimePromise = starting;
  void starting.catch(() => {
    if (runtimePromise === starting) runtimePromise = undefined;
  });
  return starting;
}

export async function getProfileService(): Promise<ProfileService> {
  return (await startJobFinderRuntime()).profileService;
}

export function beginJobFinderShutdown(): void {
  closing = true;
}

export async function setJobFinderRuntimeTestEnv(
  env: Partial<NodeJS.ProcessEnv> | null,
) {
  await shutdownJobFinderRuntime();
  overrideEnv = env;
  closing = false;
}

/** Stops a running site check, the resume writer and Apply. */
export async function shutdownJobFinderRuntime() {
  const starting = runtimePromise;
  runtimePromise = undefined;
  if (!starting) return;
  const runtime = await starting.catch((error: unknown) => {
    console.warn("[Desktop] Job Finder did not start before shutdown.", error);
    return undefined;
  });
  await runtime?.profileService.stop();
  runtime?.applicationService.stop();
  stopResumeService();
  await shutdownDiscoveryFeedWorkers();
}
