import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDeferredBackgroundInitController,
  DEFERRED_BACKGROUND_INIT_DELAY_MS,
  type DeferredBackgroundInitOptions,
} from "./deferred-background-init";
import type { CampaignScheduler } from "../services/job-finder/campaign-scheduler";
import type * as InterviewOverlayApi from "./interview-overlay-windows";
import type * as InterviewSessionControlsApi from "./interview-session-controls";

function createManualPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drain pending microtasks under fake timers without advancing real time. */
const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

function createOptions() {
  const calls: string[] = [];
  const startedSchedulerFactories: Array<() => CampaignScheduler> = [];
  const surfaceInitializations: boolean[] = [];
  const errors: Array<{ message: string; error: unknown }> = [];
  const counts = {
    jobFinderServices: 0,
    campaignSchedulerModule: 0,
    candidateAssetLibrary: 0,
    liveAssistant: 0,
    interviewOverlay: 0,
    interviewSessionControls: 0,
  };

  const schedulerFactory =
    (() => ({})) as unknown as () => CampaignScheduler;
  const overlayModuleStub = {} as unknown as typeof InterviewOverlayApi;
  const sessionControlsStub =
    {} as unknown as typeof InterviewSessionControlsApi;

  const options: DeferredBackgroundInitOptions = {
    advancedInterviewSurfacesEnabled: true,
    loadJobFinderServices: () => {
      counts.jobFinderServices += 1;
      return Promise.resolve({
        getJobFinderWorkspaceService: () => {
          calls.push("workspace");
          return Promise.resolve(undefined);
        },
      });
    },
    loadCampaignSchedulerModule: () => {
      counts.campaignSchedulerModule += 1;
      return Promise.resolve({ createCampaignScheduler: schedulerFactory });
    },
    loadCandidateAssetLibraryModule: () => {
      counts.candidateAssetLibrary += 1;
      return Promise.resolve({
        getCandidateAssetLibrary: () => ({
          enforceLifecycle: () => {
            calls.push("asset-lifecycle");
            return Promise.resolve();
          },
        }),
      });
    },
    loadLiveAssistantModule: () => {
      counts.liveAssistant += 1;
      return Promise.resolve({
        getLiveAssistantService: () => {
          calls.push("live-assistant");
          return Promise.resolve(undefined);
        },
      });
    },
    loadInterviewOverlayModule: () => {
      counts.interviewOverlay += 1;
      return Promise.resolve(overlayModuleStub);
    },
    loadInterviewSessionControlsModule: () => {
      counts.interviewSessionControls += 1;
      return Promise.resolve(sessionControlsStub);
    },
    startCampaignScheduler: (createScheduler) => {
      startedSchedulerFactories.push(createScheduler);
    },
    initializeInterviewSurfaces: (overlay, sessionControls) => {
      surfaceInitializations.push(
        Boolean(overlay) && Boolean(sessionControls),
      );
    },
    onDiagnostic: (message) => {
      calls.push(`diagnostic:${message}`);
    },
    onError: (message, error) => {
      errors.push({ message, error });
    },
  };

  return {
    options,
    calls,
    counts,
    startedSchedulerFactories,
    surfaceInitializations,
    errors,
  };
}

describe("deferred background initialization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs the background loads only after the schedule delay elapses", async () => {
    vi.useFakeTimers();
    const {
      options,
      calls,
      counts,
      startedSchedulerFactories,
      surfaceInitializations,
      errors,
    } = createOptions();
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS - 1);
    expect(counts.jobFinderServices).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(counts.jobFinderServices).toBe(1);
    expect(calls).toContain("workspace");
    expect(calls).toContain("asset-lifecycle");
    expect(calls).toContain("live-assistant");
    expect(startedSchedulerFactories).toHaveLength(1);
    expect(surfaceInitializations).toEqual([true]);
    expect(errors).toEqual([]);
  });

  test("never initializes when quit begins before the delayed run fires", async () => {
    vi.useFakeTimers();
    const { options, counts } = createOptions();
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    controller.beginQuitTeardown();
    await vi.runAllTimersAsync();

    expect(counts.jobFinderServices).toBe(0);
    expect(counts.candidateAssetLibrary).toBe(0);
    expect(counts.liveAssistant).toBe(0);
    expect(controller.isQuitTeardownStarted()).toBe(true);
  });

  test("cancelling a scheduled run does not latch quit", async () => {
    vi.useFakeTimers();
    const { options, counts } = createOptions();
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    controller.cancelScheduled();
    await vi.runAllTimersAsync();

    expect(counts.jobFinderServices).toBe(0);
    expect(controller.isQuitTeardownStarted()).toBe(false);
  });

  test("stops an in-flight chain between steps once quit begins", async () => {
    vi.useFakeTimers();
    const { options, counts } = createOptions();
    const servicesLoad = createManualPromise<{
      getJobFinderWorkspaceService: () => Promise<void>;
    }>();
    options.loadJobFinderServices = () => servicesLoad.promise;
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    await flushMicrotasks();

    // Quit wins the race against the still-initializing chain.
    controller.beginQuitTeardown();
    servicesLoad.resolve({
      getJobFinderWorkspaceService: () =>
        Promise.reject(
          new Error("workspace service must not be created during quit"),
        ),
    });
    await flushMicrotasks();

    expect(counts.campaignSchedulerModule).toBe(0);
  });

  test("does not start or recreate the scheduler when quit begins after the workspace exists", async () => {
    vi.useFakeTimers();
    const { options, startedSchedulerFactories } = createOptions();
    const schedulerLoad =
      createManualPromise<{ createCampaignScheduler: () => CampaignScheduler }>();
    options.loadCampaignSchedulerModule = () => schedulerLoad.promise;
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    await flushMicrotasks();

    // The chain reached the scheduler step before quit began.
    expect(schedulerLoad.promise).toBeDefined();
    controller.beginQuitTeardown();
    schedulerLoad.resolve({
      createCampaignScheduler:
        (() => ({})) as unknown as () => CampaignScheduler,
    });
    await flushMicrotasks();

    expect(startedSchedulerFactories).toHaveLength(0);
  });

  test("gates candidate-asset retention enforcement behind quit too", async () => {
    vi.useFakeTimers();
    const { options, calls } = createOptions();
    const assetLoad = createManualPromise<{
      getCandidateAssetLibrary: () => { enforceLifecycle(): Promise<void> };
    }>();
    options.loadCandidateAssetLibraryModule = () => assetLoad.promise;
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    controller.beginQuitTeardown();
    assetLoad.resolve({
      getCandidateAssetLibrary: () => ({
        enforceLifecycle: () => {
          calls.push("asset-lifecycle");
          return Promise.resolve();
        },
      }),
    });
    await flushMicrotasks();

    expect(calls).not.toContain("asset-lifecycle");
  });

  test("gates interview surfaces behind quit and honors the enabled flag", async () => {
    vi.useFakeTimers();
    const disabled = createOptions();
    disabled.options.advancedInterviewSurfacesEnabled = false;
    const disabledController = createDeferredBackgroundInitController(
      disabled.options,
    );
    disabledController.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    await flushMicrotasks();

    expect(disabled.counts.interviewOverlay).toBe(0);
    expect(disabled.surfaceInitializations).toEqual([]);

    const { options, surfaceInitializations } = createOptions();
    const overlayLoad = createManualPromise<unknown>();
    options.loadInterviewOverlayModule = () =>
      overlayLoad.promise as Promise<typeof InterviewOverlayApi>;
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    controller.beginQuitTeardown();
    overlayLoad.resolve({});
    await flushMicrotasks();

    expect(surfaceInitializations).toEqual([]);
  });

  test("reports chain failures through the error hook instead of crashing", async () => {
    vi.useFakeTimers();
    const { options, errors } = createOptions();
    const failure = new Error("workspace unavailable");
    options.loadJobFinderServices = () => Promise.reject(failure);
    const controller = createDeferredBackgroundInitController(options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
    await flushMicrotasks();

    expect(errors).toEqual([
      {
        message: "[Desktop] Failed to initialize Job Finder workspace service.",
        error: failure,
      },
    ]);
  });

  describe("aborted quit latch release", () => {
    test("an early-startup cancel releases the latch and runs initialization exactly once", async () => {
      vi.useFakeTimers();
      const {
        options,
        counts,
        startedSchedulerFactories,
        errors,
      } = createOptions();
      const controller = createDeferredBackgroundInitController(options);

      // Quit begins during the startup window, before the timer ever fires.
      controller.schedule();
      controller.beginQuitTeardown();
      await vi.runAllTimersAsync();
      expect(counts.jobFinderServices).toBe(0);

      // The user explicitly cancels: services are intact, so the latch
      // releases and the still-needed deferred run is allowed once.
      controller.releaseQuitLatch();
      expect(controller.isQuitTeardownStarted()).toBe(false);
      await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
      await flushMicrotasks();

      expect(counts.jobFinderServices).toBe(1);
      expect(startedSchedulerFactories).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    test("a repeated cancel cycle never duplicates the initialization", async () => {
      vi.useFakeTimers();
      const { options, counts, startedSchedulerFactories } = createOptions();
      const controller = createDeferredBackgroundInitController(options);

      controller.schedule();
      controller.beginQuitTeardown();
      controller.releaseQuitLatch(); // first abort re-arms the pending run
      controller.releaseQuitLatch(); // second release must not double-arm
      await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS);
      await flushMicrotasks();

      expect(counts.jobFinderServices).toBe(1);
      expect(startedSchedulerFactories).toHaveLength(1);

      // A later quit/abort cycle after completion re-arms nothing.
      controller.beginQuitTeardown();
      controller.releaseQuitLatch();
      await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS * 2);
      await flushMicrotasks();

      expect(counts.jobFinderServices).toBe(1);
      expect(startedSchedulerFactories).toHaveLength(1);
    });

    test("release is ignored once actual teardown has committed", async () => {
      vi.useFakeTimers();
      const { options, counts } = createOptions();
      const controller = createDeferredBackgroundInitController(options);

      controller.schedule();
      controller.beginQuitTeardown();
      // Shutdown actually starts: the latch becomes permanent.
      controller.commitQuitTeardown();
      controller.releaseQuitLatch();

      expect(controller.isQuitTeardownStarted()).toBe(true);
      await vi.runAllTimersAsync();
      expect(counts.jobFinderServices).toBe(0);
    });

    test("a window-closed cancel keeps suppressing initialization across a latch release", async () => {
      vi.useFakeTimers();
      const { options, counts } = createOptions();
      const controller = createDeferredBackgroundInitController(options);

      // Last window closed on macOS: historical behavior is that the
      // deferred run never happens afterwards.
      controller.schedule();
      controller.cancelScheduled();

      controller.beginQuitTeardown();
      controller.releaseQuitLatch();
      await vi.advanceTimersByTimeAsync(DEFERRED_BACKGROUND_INIT_DELAY_MS * 2);
      await flushMicrotasks();

      expect(controller.isQuitTeardownStarted()).toBe(false);
      expect(counts.jobFinderServices).toBe(0);
    });
  });
});
