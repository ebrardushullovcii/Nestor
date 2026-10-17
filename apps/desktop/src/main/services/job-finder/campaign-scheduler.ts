import { getJobFinderWorkspaceService } from "./workspace-service";
import { publishJobFinderWorkspaceUpdate } from "./workspace-updates";

/**
 * Local campaign scheduler.
 *
 * Drives `runDueScheduledCampaigns` on a fixed interval so persisted campaign
 * schedules fire without any user interaction. The scheduler never performs
 * OS-level or external notifications; it only ticks the workspace service.
 *
 * Guarantees:
 * - Default interval is 60 seconds; the timer is unref'd when available so a
 *   pending tick never keeps the app alive by itself.
 * - Single-flight: overlapping timer callbacks are skipped while a tick is
 *   already running; the next interval retries.
 * - Suspend suppresses ticks (the timer is cleared); resume runs an immediate
 *   catch-up tick and re-arms the interval.
 * - Stop clears the timer, unsubscribes the injected timer, and awaits any
 *   in-flight tick before resolving.
 */

export const DEFAULT_CAMPAIGN_SCHEDULER_INTERVAL_MS = 60_000;

export interface CampaignSchedulerTimer {
  clear(): void;
  unref?(): unknown;
}

export interface CampaignScheduler {
  start(): void;
  suspend(): void;
  resume(): void;
  stop(): Promise<void>;
}

export interface CampaignSchedulerOptions {
  /** Interval between scheduled ticks. Defaults to 60 seconds. */
  intervalMs?: number;
  /** Work performed on each tick. Defaults to the workspace service due-run. */
  tick?: () => Promise<unknown>;
  /** Timer factory seam for tests. Defaults to an unref'd setTimeout. */
  createTimer?: (
    callback: () => void,
    intervalMs: number,
  ) => CampaignSchedulerTimer;
  /** Error reporting seam. Defaults to console.error. */
  onError?: (error: unknown) => void;
  /**
   * Power-state seam consulted at tick time; a tick is suppressed while this
   * returns `true` (the next interval is re-armed instead).
   */
  isSuspended?: () => boolean;
}

function createDefaultTimer(
  callback: () => void,
  intervalMs: number,
): CampaignSchedulerTimer {
  const handle = setTimeout(callback, intervalMs);
  return {
    clear: () => clearTimeout(handle),
  };
}

async function defaultTick(): Promise<void> {
  const service = await getJobFinderWorkspaceService();
  const onActivity = () => publishJobFinderWorkspaceUpdate();
  if (service.processDueScheduledCampaigns) {
    const changed = await service.processDueScheduledCampaigns(
      undefined,
      onActivity,
    );
    if (changed) publishJobFinderWorkspaceUpdate();
    return;
  }
  // Older service implementations still return a snapshot per tick.
  await service.runDueScheduledCampaigns(undefined, onActivity);
  publishJobFinderWorkspaceUpdate();
}

export function createCampaignScheduler(
  options: CampaignSchedulerOptions = {},
): CampaignScheduler {
  const intervalMs =
    options.intervalMs ?? DEFAULT_CAMPAIGN_SCHEDULER_INTERVAL_MS;
  const tick = options.tick ?? defaultTick;
  const createTimer = options.createTimer ?? createDefaultTimer;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(
        "[CampaignScheduler] Scheduled campaign tick failed.",
        error,
      );
    });
  const isSuspended = options.isSuspended ?? (() => false);

  let stopped = false;
  let running = false;
  let suspended = false;
  let inFlight = false;
  let catchUpRequested = false;
  let timer: CampaignSchedulerTimer | null = null;
  let inFlightPromise: Promise<void> | null = null;

  function scheduleNext(): void {
    if (stopped || suspended) return;
    timer?.clear();
    timer = createTimer(() => {
      void runTick();
    }, intervalMs);
    timer.unref?.();
  }

  async function runTick(): Promise<void> {
    if (stopped || suspended) return;
    if (isSuspended()) {
      // Power seam: suppress the tick but keep the cadence re-armed.
      scheduleNext();
      return;
    }
    if (inFlight) {
      // Single-flight: a running tick owns the pipeline; retry next interval.
      return;
    }

    inFlight = true;
    const work = Promise.resolve()
      .then(() => tick())
      .then(
        () => undefined,
        (error: unknown) => {
          onError(error);
        },
      );
    inFlightPromise = work;
    await work;
    inFlightPromise = null;
    inFlight = false;

    if (stopped) return;
    if (catchUpRequested) {
      // A resume arrived while the tick was in flight; catch up immediately.
      catchUpRequested = false;
      void runTick();
      return;
    }
    scheduleNext();
  }

  return {
    start(): void {
      if (stopped || running) return;
      running = true;
      scheduleNext();
    },

    suspend(): void {
      if (stopped || !running) return;
      suspended = true;
      timer?.clear();
      timer = null;
    },

    resume(): void {
      if (stopped || !running) return;
      if (!suspended) return;
      suspended = false;
      if (inFlight) {
        catchUpRequested = true;
        return;
      }
      // Immediate catch-up: run a tick right away instead of waiting for the
      // next interval.
      void runTick();
    },

    async stop(): Promise<void> {
      stopped = true;
      running = false;
      suspended = false;
      catchUpRequested = false;
      timer?.clear();
      timer = null;
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
  };
}
