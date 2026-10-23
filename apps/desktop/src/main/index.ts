import { app, BrowserWindow, Menu, ipcMain, powerMonitor } from "electron";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDesktopEnvironment } from "./setup/env";
import { configureInterviewMediaPermissions } from "./setup/interview-media-permissions";
import { areAdvancedInterviewSurfacesEnabled } from "./setup/interview-surface-mode";
import { registerCoreDesktopRoutes } from "./setup/register-core-routes";
import { getEmbeddedBrowser } from "./services/browser/embedded-browser";
import { migrateLegacyDesktopUserData } from "./setup/legacy-user-data-migration";
import {
  configureDesktopUserDataDirectory,
  getDesktopStartupDiagnosticsPath,
} from "./setup/user-data-directory";
import { resolveBrandIconPaths } from "./setup/brand-icons";
import { createMainWindow } from "./setup/window-shell";
import { registerFinishedWorkWindow } from "./setup/finished-work-notifier-instance";
import { runShutdownWithTimeout } from "./setup/shutdown-with-timeout";
import { createDeferredBackgroundInitController } from "./setup/deferred-background-init";
import { getMainWindowCloseGuard } from "./setup/main-window-close-guard";
import {
  captureStartupWorkspaceView,
  hasStartupWorkspaceView,
} from "./services/job-finder/startup-workspace-view";
import type * as InterviewOverlayApi from "./setup/interview-overlay-windows";
import type * as InterviewSessionControlsApi from "./setup/interview-session-controls";
import type * as CandidateAssetLibraryApi from "./services/job-finder/candidate-asset-library-instance";
import type { CampaignScheduler } from "./services/job-finder/campaign-scheduler";
import type * as CampaignSchedulerApi from "./services/job-finder/campaign-scheduler";
import type * as JobFinderServicesApi from "./services/job-finder";
import type * as LiveAssistantApi from "./services/live-assistant";

loadDesktopEnvironment();
const configuredUserDataDirectory = configureDesktopUserDataDirectory(app);
try {
  // Before the single-instance lock, the first thing that touches userData.
  migrateLegacyDesktopUserData(app, {
    configuredDirectory: configuredUserDataDirectory,
  });
} catch (error) {
  // A failed rename leaves the old directory whole; the app still opens.
  console.warn("Could not move the pre-rename user data directory.", error);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (hasSingleInstanceLock) {
  // Before anything opens the workspace database (see the module).
  captureStartupWorkspaceView();
}
const startupDiagnosticsPath = getDesktopStartupDiagnosticsPath();

function recordStartupDiagnostic(message: string, error?: unknown) {
  if (!startupDiagnosticsPath || process.env.ELECTRON_ENABLE_LOGGING !== "1") {
    return;
  }

  try {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
        : "";
    appendFileSync(
      startupDiagnosticsPath,
      `${new Date().toISOString()} ${message} ${detail}\n`,
      "utf8",
    );
  } catch {
    // Startup diagnostics must never prevent the app from opening.
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const jobFinderShutdownTimeoutMs = 15_000;
const advancedInterviewSurfacesEnabled = areAdvancedInterviewSurfacesEnabled();

type JobFinderServices = typeof JobFinderServicesApi;
type CampaignSchedulerModule = typeof CampaignSchedulerApi;
type CandidateAssetLibraryModule = typeof CandidateAssetLibraryApi;
type LiveAssistantModule = typeof LiveAssistantApi;
type InterviewOverlayModule = typeof InterviewOverlayApi;
type InterviewSessionControlsModule = typeof InterviewSessionControlsApi;

let jobFinderServicesPromise: Promise<JobFinderServices> | null = null;
let campaignSchedulerModulePromise: Promise<CampaignSchedulerModule> | null =
  null;
let candidateAssetLibraryModulePromise: Promise<CandidateAssetLibraryModule> | null =
  null;
let liveAssistantModulePromise: Promise<LiveAssistantModule> | null = null;
let interviewOverlayModulePromise: Promise<InterviewOverlayModule> | null =
  null;
let interviewSessionControlsModulePromise: Promise<InterviewSessionControlsModule> | null =
  null;

function loadJobFinderServices() {
  jobFinderServicesPromise ??= import("./services/job-finder");
  return jobFinderServicesPromise;
}

function loadCampaignSchedulerModule() {
  campaignSchedulerModulePromise ??=
    import("./services/job-finder/campaign-scheduler");
  return campaignSchedulerModulePromise;
}

function loadCandidateAssetLibraryModule() {
  candidateAssetLibraryModulePromise ??=
    import("./services/job-finder/candidate-asset-library-instance");
  return candidateAssetLibraryModulePromise;
}

function loadLiveAssistantModule() {
  liveAssistantModulePromise ??= import("./services/live-assistant");
  return liveAssistantModulePromise;
}

function loadInterviewOverlayModule() {
  interviewOverlayModulePromise ??= import("./setup/interview-overlay-windows");
  return interviewOverlayModulePromise;
}

function loadInterviewSessionControlsModule() {
  interviewSessionControlsModulePromise ??=
    import("./setup/interview-session-controls");
  return interviewSessionControlsModulePromise;
}

let closeInterviewOverlayWindows = () => {};
let disposeInterviewSessionControls = () => {};

// The 500ms deferred service initialization owns the background eager loads.
// It is gated on quit: `beginQuitTeardown()` latches before any confirmation
// or shutdown work runs so a late timer can never recreate a service during
// teardown, and in-flight chains re-check the gate between steps. An
// explicitly cancelled quit releases the latch (re-arming the still-needed
// run exactly once, since services were never torn down); once actual
// shutdown commits, the latch is permanent. Feature routes also lazily load
// their own services on demand.
const deferredBackgroundInit = createDeferredBackgroundInitController({
  // Counted from the window's page load, not its creation; see below.
  scheduleDelayMs: 150,
  advancedInterviewSurfacesEnabled,
  loadJobFinderServices,
  loadCampaignSchedulerModule,
  loadCandidateAssetLibraryModule,
  loadLiveAssistantModule,
  loadInterviewOverlayModule,
  loadInterviewSessionControlsModule,
  startCampaignScheduler,
  initializeInterviewSurfaces: (overlay, sessionControls) => {
    closeInterviewOverlayWindows = overlay.closeInterviewOverlayWindows;
    disposeInterviewSessionControls =
      sessionControls.disposeInterviewSessionControls;
    overlay.initializeInterviewOverlayWindows(currentDir);
    sessionControls.initializeInterviewSessionControls();
  },
  onDiagnostic: recordStartupDiagnostic,
  onError: (message, error) => console.error(message, error),
});

function loadJobFinderRoutes(): Promise<void> {
  return import("./setup/register-job-finder-routes").then(
    ({ registerJobFinderDesktopRoutes }) => {
      registerJobFinderDesktopRoutes(ipcMain);
      recordStartupDiagnostic("Job Finder routes registered");
    },
  );
}

function loadJobFinderBootstrapRoutes(): Promise<void> {
  return import("./setup/register-job-finder-bootstrap-routes").then(
    ({ registerJobFinderBootstrapDesktopRoutes }) => {
      registerJobFinderBootstrapDesktopRoutes(ipcMain);
      recordStartupDiagnostic("Job Finder bootstrap routes registered");
    },
  );
}

function loadJobFinderAssetRoutes(): Promise<void> {
  return import("./setup/register-job-finder-asset-routes").then(
    ({ registerJobFinderAssetDesktopRoutes }) => {
      registerJobFinderAssetDesktopRoutes(ipcMain);
      recordStartupDiagnostic("Job Finder asset routes registered");
    },
  );
}

function loadLiveAssistantRoutes(): Promise<void> {
  return import("./setup/register-live-assistant-routes").then(
    ({ registerLiveAssistantDesktopRoutes }) => {
      registerLiveAssistantDesktopRoutes(ipcMain);
      recordStartupDiagnostic("Live Assistant routes registered");
    },
  );
}

function createMainWindowSafely(): BrowserWindow | null {
  try {
    const window = createMainWindow(currentDir);
    getEmbeddedBrowser().attachWindow(window);
    registerFinishedWorkWindow(window);
    return window;
  } catch (error) {
    recordStartupDiagnostic("main window creation failed", error);
    console.error("[Desktop] Failed to create the main window.", error);
    app.quit();
    return null;
  }
}

// Keep the large feature-route graph off Electron's critical path to the first
// window. The core IPC surface is registered synchronously; the preload bridge
// waits on the readiness channel before invoking any deferred feature route.
// Loading begins on the first feature call, after the renderer has had an
// opportunity to paint its honest loading state, without exposing an IPC race.
let jobFinderBootstrapRoutesPromise: Promise<void> | null = null;
let jobFinderRoutesPromise: Promise<void> | null = null;
let jobFinderAssetRoutesPromise: Promise<void> | null = null;
let liveAssistantRoutesPromise: Promise<void> | null = null;

function ensureJobFinderBootstrapRoutesReady(): Promise<void> {
  jobFinderBootstrapRoutesPromise ??= hasSingleInstanceLock
    ? loadJobFinderBootstrapRoutes()
    : Promise.resolve();
  return jobFinderBootstrapRoutesPromise;
}

function ensureJobFinderRoutesReady(): Promise<void> {
  jobFinderRoutesPromise ??= hasSingleInstanceLock
    ? loadJobFinderRoutes()
    : Promise.resolve();
  return jobFinderRoutesPromise;
}

function ensureJobFinderAssetRoutesReady(): Promise<void> {
  jobFinderAssetRoutesPromise ??= hasSingleInstanceLock
    ? loadJobFinderAssetRoutes()
    : Promise.resolve();
  return jobFinderAssetRoutesPromise;
}

function ensureLiveAssistantRoutesReady(): Promise<void> {
  liveAssistantRoutesPromise ??= hasSingleInstanceLock
    ? loadLiveAssistantRoutes()
    : Promise.resolve();
  return liveAssistantRoutesPromise;
}

if (hasSingleInstanceLock) {
  registerCoreDesktopRoutes(
    ipcMain,
    ensureJobFinderBootstrapRoutesReady,
    ensureJobFinderRoutesReady,
    ensureJobFinderAssetRoutesReady,
    ensureLiveAssistantRoutesReady,
  );
}

recordStartupDiagnostic("main module loaded");
if (!hasSingleInstanceLock) {
  recordStartupDiagnostic("secondary app instance exiting");
  app.quit();
}

app.on("second-instance", () => {
  const existingWindow = BrowserWindow.getAllWindows()[0];
  if (!existingWindow) {
    return;
  }

  if (existingWindow.isMinimized()) {
    existingWindow.restore();
  }
  existingWindow.show();
  existingWindow.focus();
});

void app
  .whenReady()
  .then(() => {
    if (!hasSingleInstanceLock) {
      return;
    }
    recordStartupDiagnostic("app ready");
    if (process.platform === "darwin" && !app.isPackaged) {
      const brandIcons = resolveBrandIconPaths(app.getAppPath());
      if (brandIcons) app.dock?.setIcon(brandIcons.appIcon);
    }
    Menu.setApplicationMenu(null);
    recordStartupDiagnostic("creating main window");
    const mainWindow = createMainWindowSafely();
    if (!mainWindow) {
      return;
    }
    recordStartupDiagnostic("main window created");
    // Electron's browser thread is this JavaScript thread, so loading the
    // feature services holds the window's own page load (about 0.7 s). With
    // a saved startup view the window needs nothing from them to show the
    // workspace: start them once the page has loaded. Without one, the
    // window waits for them anyway, so they start early and overlap the
    // page's script compile.
    let backgroundInitScheduled = false;
    const scheduleBackgroundInit = () => {
      if (backgroundInitScheduled) return;
      backgroundInitScheduled = true;
      clearTimeout(backgroundInitFallback);
      deferredBackgroundInit.schedule();
    };
    const backgroundInitFallback = setTimeout(
      scheduleBackgroundInit,
      hasStartupWorkspaceView() ? 3_000 : 350,
    );
    mainWindow.webContents.once("did-finish-load", scheduleBackgroundInit);
    mainWindow.on("closed", () => {
      clearTimeout(backgroundInitFallback);
      deferredBackgroundInit.cancelScheduled();
      closeInterviewOverlayWindows();
    });

    configureInterviewMediaPermissions();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindowSafely();
      }
    });
  })
  .catch((error) => {
    recordStartupDiagnostic("startup failed", error);
    console.error(
      "[Desktop] Startup failed before the main window was ready.",
      error,
    );
    app.quit();
  });

let jobFinderShutdownInFlight = false;
let quitApprovedByCloseGuard = false;

let campaignScheduler: CampaignScheduler | null = null;
const onPowerSuspend = () => campaignScheduler?.suspend();
const onPowerResume = () => campaignScheduler?.resume();

function startCampaignScheduler(
  createScheduler: CampaignSchedulerModule["createCampaignScheduler"],
): void {
  if (campaignScheduler) {
    return;
  }
  campaignScheduler = createScheduler();
  powerMonitor.on("suspend", onPowerSuspend);
  powerMonitor.on("resume", onPowerResume);
  campaignScheduler.start();
  // An Apply queue that was running or waiting for tomorrow carries on.
  void import("./routes/job-finder")
    .then((routes) => routes.resumeApplyQueueAfterRestart())
    .catch((error: unknown) => {
      console.error("Could not carry on the Apply queue.", error);
    });
}

async function stopCampaignScheduler(): Promise<void> {
  const scheduler = campaignScheduler;
  campaignScheduler = null;
  if (!scheduler) {
    return;
  }
  powerMonitor.removeListener("suspend", onPowerSuspend);
  powerMonitor.removeListener("resume", onPowerResume);
  await scheduler.stop();
}

async function shutdownJobFinderServicesIfLoaded(): Promise<void> {
  if (!jobFinderServicesPromise) {
    return;
  }

  const { shutdownJobFinderWorkspaceService } = await jobFinderServicesPromise;
  // The assistant's running turns are marked interrupted before the
  // workspace they work on closes.
  const { shutdownAssistantHost } =
    await import("./services/assistant/assistant-service");
  await shutdownAssistantHost();
  await shutdownJobFinderWorkspaceService({ saveStartupView: true });
}

async function shutdownLiveAssistantIfLoaded(): Promise<void> {
  if (!liveAssistantModulePromise) {
    return;
  }

  const { shutdownLiveAssistantService } = await liveAssistantModulePromise;
  await shutdownLiveAssistantService();
}

app.on("before-quit", (event) => {
  if (jobFinderShutdownInFlight) {
    return;
  }

  // Quit begins here, before any confirmation or shutdown work: latch the
  // gate so the 500ms deferred service initialization can never fire (or
  // continue mid-flight) and recreate a service during teardown.
  deferredBackgroundInit.beginQuitTeardown();

  // Phase zero of quitting: an app-level quit (macOS Dock quit, OS session
  // end, internal app.quit() callers) lets the renderer confirm unsaved work
  // BEFORE any service shutdown starts, so cancelling can never leave the app
  // running with its services already torn down. A watchdog expiry proceeds
  // with the quit, so a hung renderer cannot deadlock shutdown; forced
  // process termination remains uninterceptable and stays owned by local
  // persistence. Plain window closes are handled independently by the window
  // close guard bound in createMainWindow.
  const mainWindowCloseGuard = getMainWindowCloseGuard();
  if (
    !quitApprovedByCloseGuard &&
    mainWindowCloseGuard.needsQuitConfirmation()
  ) {
    event.preventDefault();
    void mainWindowCloseGuard.confirmQuit().then((proceed) => {
      if (!proceed) {
        // Explicit user cancel: services were never torn down, so release
        // the latch and re-arm any still-needed deferred initialization.
        deferredBackgroundInit.releaseQuitLatch();
        return;
      }
      quitApprovedByCloseGuard = true;
      app.quit();
    });
    return;
  }

  // Actual service shutdown begins: the deferred-init latch is permanent
  // from here on, so no cancel or late release can resurrect it mid-teardown.
  deferredBackgroundInit.commitQuitTeardown();
  jobFinderShutdownInFlight = true;
  event.preventDefault();
  void runShutdownWithTimeout(
    async () => {
      // The assistant or scheduler may itself be waiting for the opening view.
      // Cancel that wait before awaiting either service's shutdown.
      if (jobFinderServicesPromise) {
        const { beginJobFinderWorkspaceShutdown } =
          await jobFinderServicesPromise;
        beginJobFinderWorkspaceShutdown();
      }
      await Promise.all([
        stopCampaignScheduler().then(shutdownJobFinderServicesIfLoaded),
        shutdownLiveAssistantIfLoaded(),
      ]);
    },
    jobFinderShutdownTimeoutMs,
    () => {
      console.warn(
        `[Desktop] Desktop service shutdown exceeded ${jobFinderShutdownTimeoutMs}ms; continuing quit.`,
      );
    },
  ).then((result) => {
    if (result.status === "failed") {
      console.warn(
        "[Desktop] Failed to shut down Job Finder workspace service before quit.",
        result.error,
      );
    }
    app.quit();
  });
});

app.on("window-all-closed", () => {
  closeInterviewOverlayWindows();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  disposeInterviewSessionControls();
});
