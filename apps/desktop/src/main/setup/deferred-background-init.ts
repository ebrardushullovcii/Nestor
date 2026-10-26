import type * as InterviewOverlayApi from "./interview-overlay-windows";
import type * as InterviewSessionControlsApi from "./interview-session-controls";

/**
 * How long startup waits after the main window exists before background
 * feature services initialize off Electron's critical path.
 */
export const DEFERRED_BACKGROUND_INIT_DELAY_MS = 500;

export interface DeferredBackgroundInitOptions {
  scheduleDelayMs?: number;
  advancedInterviewSurfacesEnabled: boolean;
  loadJobFinderServices: () => Promise<{
    getJobFinderWorkspaceService: () => PromiseLike<unknown>;
  }>;
  loadCandidateAssetLibraryModule: () => Promise<{
    getCandidateAssetLibrary: () => {
      enforceLifecycle(): PromiseLike<unknown>;
    };
  }>;
  loadLiveAssistantModule: () => Promise<{
    getLiveAssistantService: () => PromiseLike<unknown>;
  }>;
  loadInterviewOverlayModule: () => Promise<typeof InterviewOverlayApi>;
  loadInterviewSessionControlsModule: () => Promise<
    typeof InterviewSessionControlsApi
  >;
  initializeInterviewSurfaces: (
    overlay: typeof InterviewOverlayApi,
    sessionControls: typeof InterviewSessionControlsApi,
  ) => void;
  onDiagnostic: (message: string) => void;
  onError: (message: string, error: unknown) => void;
}

export interface DeferredBackgroundInitController {
  /** Arm the one-shot deferred initialization timer. */
  schedule(): void;

  /**
   * Latch quit teardown early (confirmation phase) and cancel a still
   * pending schedule. Once latched, in-flight initialization chains stop
   * between steps, so quitting can never race a service back into existence
   * during or after teardown.
   */
  beginQuitTeardown(): void;

  /**
   * Commit actual service shutdown: the latch becomes permanent and
   * `releaseQuitLatch` is ignored from here on.
   */
  commitQuitTeardown(): void;

  /**
   * An explicit user cancel aborted the quit while services are intact:
   * unlatch the gate, and if the original deferred run never happened,
   * re-arm it exactly once. Ignored after teardown was committed.
   */
  releaseQuitLatch(): void;

  /** Cancel a pending schedule without latching quit (last window closed). */
  cancelScheduled(): void;
  /**
   * A new main window (macOS reopens one from the dock after the last
   * closed): undo a window-close cancel if the deferred run never happened,
   * so this window can schedule it.
   */
  rearm(): void;

  isQuitTeardownStarted(): boolean;
}

export function createDeferredBackgroundInitController(
  options: DeferredBackgroundInitOptions,
): DeferredBackgroundInitController {
  const scheduleDelayMs =
    options.scheduleDelayMs ?? DEFERRED_BACKGROUND_INIT_DELAY_MS;

  let quitTeardownStarted = false;
  let quitTeardownCommitted = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  // The deferred run is a one-shot: `scheduledOnce` blocks duplicate
  // schedules, `deferredRunCompleted` records that the timer actually fired
  // (so an aborted quit never re-runs finished initialization), and
  // `cancelledByWindowClose` suppresses resurrection of a run whose schedule
  // was torn down with the last window, until a new window re-arms it.
  let scheduledOnce = false;
  let deferredRunCompleted = false;
  let cancelledByWindowClose = false;

  const quitHasBegun = () => quitTeardownStarted;

  const cancelTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const initializeJobFinderWorkspace = () => {
    void options
      .loadJobFinderServices()
      .then(async ({ getJobFinderWorkspaceService }) => {
        if (quitHasBegun()) {
          return;
        }
        await getJobFinderWorkspaceService();
      })
      .catch((error) => {
        options.onError(
          "[Desktop] Failed to initialize Job Finder workspace service.",
          error,
        );
      });
  };

  const enforceCandidateAssetLifecycle = () => {
    void options
      .loadCandidateAssetLibraryModule()
      .then(({ getCandidateAssetLibrary }) => {
        if (quitHasBegun()) {
          return undefined;
        }
        return getCandidateAssetLibrary().enforceLifecycle();
      })
      .catch((error) => {
        options.onError(
          "[Desktop] Failed to enforce Candidate Asset retention.",
          error,
        );
      });
  };

  const initializeLiveAssistant = () => {
    void options
      .loadLiveAssistantModule()
      .then(({ getLiveAssistantService }) => {
        if (quitHasBegun()) {
          return undefined;
        }
        return getLiveAssistantService();
      })
      .catch((error) => {
        options.onError(
          "[Desktop] Failed to initialize Live Assistant service.",
          error,
        );
      });
  };

  const initializeAdvancedInterviewSurfaces = () => {
    if (!options.advancedInterviewSurfacesEnabled) {
      return;
    }
    void Promise.all([
      options.loadInterviewOverlayModule(),
      options.loadInterviewSessionControlsModule(),
    ])
      .then(([overlay, sessionControls]) => {
        if (quitHasBegun()) {
          return;
        }
        options.initializeInterviewSurfaces(overlay, sessionControls);
      })
      .catch((error) => {
        options.onError(
          "[Desktop] Failed to initialize advanced interview surfaces.",
          error,
        );
      });
  };

  const runDeferredInitialization = () => {
    options.onDiagnostic("starting background services");
    initializeJobFinderWorkspace();
    enforceCandidateAssetLifecycle();
    initializeLiveAssistant();
    initializeAdvancedInterviewSurfaces();
  };

  const scheduleRun = () => {
    if (
      timerId !== null ||
      quitTeardownStarted ||
      scheduledOnce ||
      cancelledByWindowClose
    ) {
      return;
    }
    scheduledOnce = true;
    timerId = setTimeout(() => {
      timerId = null;
      deferredRunCompleted = true;
      runDeferredInitialization();
    }, scheduleDelayMs);
  };

  return {
    schedule: scheduleRun,

    beginQuitTeardown() {
      quitTeardownStarted = true;
      cancelTimer();
    },

    commitQuitTeardown() {
      quitTeardownStarted = true;
      quitTeardownCommitted = true;
      cancelTimer();
    },

    releaseQuitLatch() {
      if (quitTeardownCommitted) {
        return;
      }
      quitTeardownStarted = false;
      // The user explicitly cancelled while services were intact: if the
      // deferred run never happened (cancelled pre-fire), allow it exactly
      // once now. A completed or already-pending run is never duplicated,
      // and a window-closed cancel keeps its permanent suppression.
      if (
        !cancelledByWindowClose &&
        !deferredRunCompleted &&
        timerId === null
      ) {
        scheduledOnce = false;
        scheduleRun();
      }
    },

    cancelScheduled() {
      // Window closed: permanently suppress the deferred initialization,
      // even across an aborted quit's latch release.
      cancelledByWindowClose = true;
      scheduledOnce = true;
      cancelTimer();
    },

    rearm() {
      if (deferredRunCompleted || quitTeardownStarted || timerId !== null)
        return;
      cancelledByWindowClose = false;
      scheduledOnce = false;
    },

    isQuitTeardownStarted: () => quitTeardownStarted,
  };
}
