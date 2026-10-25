import { beforeEach, describe, expect, it, vi } from "vitest";

import { getJobFinderWorkspaceService } from "./workspace-service";
import { publishJobFinderWorkspaceUpdate } from "./workspace-updates";

import {
  createCampaignScheduler,
  DEFAULT_CAMPAIGN_SCHEDULER_INTERVAL_MS,
  type CampaignSchedulerTimer,
} from "./campaign-scheduler";

vi.mock("./workspace-service", () => ({
  getJobFinderWorkspaceService: vi.fn(),
}));
vi.mock("./workspace-updates", () => {
  const publishJobFinderWorkspaceUpdate = vi.fn();
  // A search announces its first event to windows; later events go to the
  // change feed (ADR 0075).
  const createSearchProgressPublisher = () => {
    let announced = false;
    return () => {
      if (announced) return;
      announced = true;
      publishJobFinderWorkspaceUpdate();
    };
  };
  return { publishJobFinderWorkspaceUpdate, createSearchProgressPublisher };
});

interface FakeTimerHandle {
  callback: () => void;
  intervalMs: number;
  unrefCalled: boolean;
  cleared: boolean;
}

function createFakeTimerFactory(options: { unref?: boolean } = {}) {
  const handles: FakeTimerHandle[] = [];
  const unrefAvailable = options.unref ?? true;
  return {
    handles,
    createTimer: (
      callback: () => void,
      intervalMs: number,
    ): CampaignSchedulerTimer => {
      const handle: FakeTimerHandle = {
        callback,
        intervalMs,
        unrefCalled: false,
        cleared: false,
      };
      handles.push(handle);
      return {
        clear: () => {
          handle.cleared = true;
        },
        ...(unrefAvailable
          ? {
              unref: () => {
                handle.unrefCalled = true;
              },
            }
          : {}),
      };
    },
    fire: (index: number) => {
      handles[index]?.callback();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("campaign scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not publish an idle tick when the workspace did not change", async () => {
    const factory = createFakeTimerFactory();
    const processDueScheduledCampaigns = vi.fn(() => Promise.resolve(false));
    const runDueScheduledCampaigns = vi.fn();
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
      processDueScheduledCampaigns,
      runDueScheduledCampaigns,
    } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
    const scheduler = createCampaignScheduler({
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();

    expect(processDueScheduledCampaigns).toHaveBeenCalledTimes(1);
    expect(runDueScheduledCampaigns).not.toHaveBeenCalled();
    expect(publishJobFinderWorkspaceUpdate).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("publishes a schedule change and live discovery activity", async () => {
    const factory = createFakeTimerFactory();
    const processDueScheduledCampaigns = vi.fn((
      _now: string | undefined,
      onActivity: () => void,
    ) => {
      onActivity();
      return Promise.resolve(true);
    });
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
      processDueScheduledCampaigns,
    } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
    const scheduler = createCampaignScheduler({
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();

    expect(publishJobFinderWorkspaceUpdate).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("keeps the snapshot-returning service fallback compatible", async () => {
    const factory = createFakeTimerFactory();
    const runDueScheduledCampaigns = vi.fn(() => Promise.resolve());
    vi.mocked(getJobFinderWorkspaceService).mockResolvedValue({
      runDueScheduledCampaigns,
    } as unknown as Awaited<ReturnType<typeof getJobFinderWorkspaceService>>);
    const scheduler = createCampaignScheduler({
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();

    expect(runDueScheduledCampaigns).toHaveBeenCalledTimes(1);
    expect(publishJobFinderWorkspaceUpdate).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("uses a 60s default interval and unrefs the timer when available", () => {
    const factory = createFakeTimerFactory();
    const tick = vi.fn(() => Promise.resolve());
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();

    expect(factory.handles).toHaveLength(1);
    expect(factory.handles[0]?.intervalMs).toBe(
      DEFAULT_CAMPAIGN_SCHEDULER_INTERVAL_MS,
    );
    expect(factory.handles[0]?.unrefCalled).toBe(true);
    expect(tick).not.toHaveBeenCalled();
  });

  it("accepts a custom interval and tolerates timers without unref", () => {
    const factory = createFakeTimerFactory({ unref: false });
    const scheduler = createCampaignScheduler({
      tick: vi.fn(() => Promise.resolve()),
      intervalMs: 5_000,
      createTimer: factory.createTimer,
    });

    scheduler.start();

    expect(factory.handles[0]?.intervalMs).toBe(5_000);
    expect(factory.handles[0]?.unrefCalled).toBe(false);
  });

  it("start is idempotent", () => {
    const factory = createFakeTimerFactory();
    const scheduler = createCampaignScheduler({
      tick: vi.fn(() => Promise.resolve()),
      createTimer: factory.createTimer,
    });

    scheduler.start();
    scheduler.start();

    expect(factory.handles).toHaveLength(1);
  });

  it("runs the tick on the interval and re-arms afterwards", async () => {
    const factory = createFakeTimerFactory();
    const tick = vi.fn(() => Promise.resolve());
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(factory.handles).toHaveLength(2);
  });

  it("enforces single-flight: overlapping timer callbacks are skipped", async () => {
    const factory = createFakeTimerFactory();
    let resolveTick: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);

    // Same timer callback fires again while the first tick is in flight.
    factory.fire(0);
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);

    resolveTick();
    await flush();

    // After completion the interval is re-armed for the next tick.
    expect(factory.handles).toHaveLength(2);
    factory.fire(1);
    await flush();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("suspend suppresses ticks and resume runs an immediate catch-up", async () => {
    const factory = createFakeTimerFactory();
    const tick = vi.fn(() => Promise.resolve());
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    scheduler.suspend();

    // The suspended timer is cleared and its callback is a no-op.
    expect(factory.handles[0]?.cleared).toBe(true);
    factory.fire(0);
    await flush();
    expect(tick).not.toHaveBeenCalled();

    scheduler.resume();
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(factory.handles).toHaveLength(2);
  });

  it("resume during an in-flight tick runs the catch-up immediately after", async () => {
    const factory = createFakeTimerFactory();
    let resolveTick: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();
    scheduler.suspend();
    scheduler.resume();
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);

    resolveTick();
    await flush();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("power seam suppresses a tick while the OS reports suspension", async () => {
    const factory = createFakeTimerFactory();
    let powerSuspended = false;
    const tick = vi.fn(() => Promise.resolve());
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
      isSuspended: () => powerSuspended,
    });

    scheduler.start();
    powerSuspended = true;
    factory.fire(0);
    await flush();
    expect(tick).not.toHaveBeenCalled();

    powerSuspended = false;
    // The suppressed tick re-armed the interval; the next fire runs.
    factory.fire(1);
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stop clears the timer and awaits the in-flight tick", async () => {
    const factory = createFakeTimerFactory();
    let resolveTick: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTick = resolve;
        }),
    );
    const scheduler = createCampaignScheduler({
      tick,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = scheduler.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(factory.handles[0]?.cleared).toBe(true);

    resolveTick();
    await stopPromise;
    expect(stopped).toBe(true);

    // No timer is re-armed after the awaited in-flight tick finishes.
    expect(factory.handles).toHaveLength(1);
  });

  it("reports tick errors through the injected error seam and keeps ticking", async () => {
    const factory = createFakeTimerFactory();
    const onError = vi.fn();
    const tick = vi.fn(() => Promise.reject(new Error("boom")));
    const scheduler = createCampaignScheduler({
      tick,
      onError,
      createTimer: factory.createTimer,
    });

    scheduler.start();
    factory.fire(0);
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    expect(factory.handles).toHaveLength(2);
  });

  it("stop before start is a no-op that resolves immediately", async () => {
    const scheduler = createCampaignScheduler({
      tick: vi.fn(() => Promise.resolve()),
    });

    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
