import { abortable } from "./async";
import { reportSelfLimitHit } from "@nestor/core";
import { runTraceEnabled, withTraceScope } from "@nestor/core/run-trace";
import {
  fitContextFingerprint,
  fitContextInput,
  fitInputFingerprint,
} from "./fit-input";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import type { JobDetail, JobSearchSettings } from "@nestor/contracts";

/**
 * One fit request: the person's evidence plus listings up to this estimate.
 * The budget bounds each batch, not the pass: a pass-wide budget let one
 * batch spend it, so a 1,800-job backlog went one request at a time with a
 * pause between passes while the other request slots sat idle.
 */
const BATCH_TOKENS = 50_000;
const BATCH_JOBS = 48;

/**
 * A limit on fit scoring is recorded under the sources of the listings it
 * concerns, as their fit calls are, so evidence for a run that shares the
 * trace (an application beside the search) leaves it out.
 */
function reportFitLimit(
  jobs: readonly (JobDetail | null | undefined)[],
  hit: Parameters<typeof reportSelfLimitHit>[0],
): void {
  if (!runTraceEnabled()) return reportSelfLimitHit(hit);
  withTraceScope(
    {
      sourceId: undefined,
      sourceUrl: undefined,
      sourceIds: [
        ...new Set(
          jobs.flatMap(
            (job) => job?.sightings.map((sighting) => sighting.sourceId) ?? [],
          ),
        ),
      ],
    },
    () => reportSelfLimitHit(hit),
  );
}

/**
 * Fit requests that outlive the queue that sent them. A search's Stop, or a
 * new search replacing background scoring, ends what a queue takes next; a
 * request already sent is paid for, so it runs on until `signal` (the app
 * quitting) and its answer is kept when its inputs are unchanged. Every
 * queue sharing these waits for a listing another queue has in flight
 * instead of asking about it a second time, and counts the person's request
 * limit over all of their requests.
 */
export interface FitRequests {
  signal: AbortSignal;
  /** Each listing's request that has not answered yet. */
  inFlight: Map<number, Promise<void>>;
  /** Requests sent and not answered yet, from every queue. */
  sent: Set<Promise<void>>;
  /** Queues waiting for a request to answer and free a place. */
  wake: Set<() => void>;
}

export const createFitRequests = (signal: AbortSignal): FitRequests => ({
  signal,
  inFlight: new Map(),
  sent: new Set(),
  wake: new Set(),
});

/** Scores queued jobs in parallel batches. Unfinished work stays persisted. */
export function createFitQueue(
  deps: JobSearchRunnerDeps,
  context: JobSearchContext,
  signal: AbortSignal,
  limit: number,
  onScored: (count: number) => void,
  onError: (error: unknown) => void,
  settings?: JobSearchSettings,
  onProgress: () => void = () => {},
  requests: FitRequests = createFitRequests(signal),
) {
  const pending: number[] = [];
  const seen = new Set<number>();
  const inFlight = new Set<number>();
  const active = new Set<Promise<void>>();
  /** Listings this queue is waiting on because another queue asked first. */
  const waiting = new Map<number, Promise<void>>();
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const cutoff =
    !settings || settings.postedWithin === "any"
      ? null
      : Date.now() - (settings.postedWithin === "week" ? 7 : 30) * 86_400_000;
  let scored = 0,
    judging = 0,
    drainers = 0;
  let deferred = false;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  };
  signal.addEventListener("abort", clearTimer, { once: true });
  const liveContext = async () => {
    while (true) {
      requests.signal.throwIfAborted();
      const revision = deps.store.fitRevision();
      const current = await abortable(deps.readContext(), requests.signal);
      if (revision !== deps.store.fitRevision()) continue;
      return {
        ...current,
        remoteCountsAsAnyLocation:
          deps.readRemoteCountsAsAnyLocation?.() ??
          current.remoteCountsAsAnyLocation ??
          context.remoteCountsAsAnyLocation ??
          true,
      };
    }
  };
  const eligible = (job: JobDetail | null): job is JobDetail =>
    Boolean(
      job &&
      (job.fitScore === null || job.fitStale) &&
      !job.stageNote?.startsWith("Closed:") &&
      !(
        job.stage === "hidden" &&
        job.fitScore === null &&
        cutoff !== null &&
        job.postedAt &&
        Date.parse(job.postedAt) < cutoff
      ),
    );
  const overhead =
    Math.ceil(
      JSON.stringify(fitContextInput(context, settings?.note)).length / 3.5,
    ) + 1800;
  const estimate = (job: JobDetail) =>
    Math.ceil(
      (job.description.length + job.title.length + job.location.length) / 3.5,
    ) + 500;

  const judge = async (jobs: JobDetail[]) => {
    let release!: () => void;
    const flight = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const job of jobs) {
      inFlight.add(job.id);
      requests.inFlight.set(job.id, flight);
    }
    requests.sent.add(flight);
    judging += jobs.length;
    onProgress();
    try {
      const current = await liveContext();
      const key = fitContextFingerprint(current, settings?.note);
      const fingerprints = new Map(
        jobs.map((job) => [job.id, fitInputFingerprint(key, job)]),
      );
      const answered = new Set<number>();
      // A stored answer for these exact inputs is the judgment; a stale flag
      // from a change that left them as they were is not a reason to pay again.
      const kept = jobs.flatMap((job) =>
        job.fit &&
        job.fitScore !== null &&
        job.fit.inputFingerprint === fingerprints.get(job.id)
          ? [{ ...job.fit, id: job.id }]
          : [],
      );
      if (kept.length) {
        deps.store.setFit(kept);
        for (const fit of kept) answered.add(fit.id);
      }
      const asked = jobs.filter((job) => !answered.has(job.id));
      if (!asked.length) return;
      const persist = async (
        updates: Awaited<ReturnType<typeof deps.engine.fitJobs>>,
      ) => {
        requests.signal.throwIfAborted();
        const latest = await liveContext();
        requests.signal.throwIfAborted();
        const latestKey = fitContextFingerprint(latest, settings?.note);
        const valid = updates.flatMap((update) => {
          if (answered.has(update.id)) return [];
          const job = deps.store.getJob(update.id);
          const fingerprint = fingerprints.get(update.id);
          if (
            !job ||
            !fingerprint ||
            fingerprint !== fitInputFingerprint(latestKey, job)
          ) {
            deferred = true;
            return [];
          }
          answered.add(update.id);
          return [{ ...update, inputFingerprint: fingerprint }];
        });
        deps.store.setFit(valid);
        scored += valid.length;
        onScored(valid.length);
      };
      let updates: Awaited<ReturnType<typeof deps.engine.fitJobs>>;
      try {
        updates = await abortable(
          deps.engine.fitJobs({
            jobs: asked.map((job) => ({ ...job, fit: null })),
            context: current,
            signal: requests.signal,
            onBatch: (fits) => persist([...fits]),
            ...(settings?.note ? { request: settings.note } : {}),
          }),
          requests.signal,
        );
      } catch (error) {
        requests.signal.throwIfAborted();
        // Provider transports own recoverable failures. Surface a real request
        // error; unscored jobs remain durable in the store for continuation.
        throw error;
      }
      requests.signal.throwIfAborted();
      await persist(updates);
      // Superseded returned judgments are not technical omissions.
      for (const update of updates) answered.add(update.id);
      const missing = asked.filter((job) => !answered.has(job.id));
      if (missing.length)
        throw new Error(
          `Fit response omitted job ids: ${missing.map((job) => job.id).join(", ")}. Their listings remain saved and unscored.`,
        );
    } finally {
      for (const job of jobs) {
        inFlight.delete(job.id);
        if (requests.inFlight.get(job.id) === flight)
          requests.inFlight.delete(job.id);
      }
      requests.sent.delete(flight);
      release();
      judging -= jobs.length;
      onProgress();
      for (const wake of [...requests.wake]) wake();
    }
  };

  /** Takes the listing up again once the other queue's request has answered. */
  const awaitFlight = (id: number, flight: Promise<void>) => {
    if (waiting.has(id)) return;
    waiting.set(
      id,
      flight.then(() => {
        waiting.delete(id);
        if (signal.aborted) return;
        pending.push(id);
        pump();
      }),
    );
  };

  /**
   * The next batch from the front of the queue. A batch short of the budget
   * waits for more listings unless the queue is draining; one unusually long
   * listing is indivisible and goes alone with its full evidence.
   */
  const takeBatch = (draining: boolean): JobDetail[] | null => {
    const jobs: JobDetail[] = [];
    let tokens = overhead,
      full = false;
    for (let index = 0; index < pending.length; ) {
      const id = pending[index]!;
      const flight = requests.inFlight.get(id);
      const job = flight ? null : deps.store.getJobForFit(id);
      if (flight) awaitFlight(id, flight);
      if (!eligible(job)) {
        pending.splice(index, 1);
        continue;
      }
      const cost = estimate(job);
      if (jobs.length && tokens + cost > BATCH_TOKENS) {
        reportFitLimit([...jobs, job], {
          limit: "fit_batch_tokens",
          kind: "input",
          value: BATCH_TOKENS,
          where: "job-finder/fitQueue/takeBatch",
        });
        full = true;
        break;
      }
      jobs.push(job);
      tokens += cost;
      index++;
      if (jobs.length === BATCH_JOBS) {
        if (index < pending.length)
          reportFitLimit(jobs, {
            limit: "fit_batch_jobs",
            kind: "jobs",
            value: BATCH_JOBS,
            where: "job-finder/fitQueue/takeBatch",
          });
        full = true;
        break;
      }
    }
    if (!jobs.length || (!full && !draining)) return null;
    pending.splice(0, jobs.length);
    return jobs;
  };

  const pump = () => {
    if (signal.aborted) {
      clearTimer();
      pending.length = 0;
      requests.wake.delete(pump);
      return;
    }
    if (pending.length && requests.sent.size >= limit)
      reportFitLimit(
        runTraceEnabled()
          ? pending.slice(0, BATCH_JOBS).map((id) => deps.store.getJob(id))
          : [],
        {
          limit: "fit_concurrency",
          kind: "concurrency",
          value: limit,
          where: "job-finder/fitQueue/pump",
        },
      );
    while (requests.sent.size < limit && pending.length) {
      const jobs = takeBatch(drainers > 0);
      if (!jobs) break;
      const task = judge(jobs)
        .catch((error: unknown) => {
          if (!signal.aborted) onError(error);
        })
        .finally(() => {
          active.delete(task);
          pump();
        });
      active.add(task);
    }
    if (pending.length && requests.sent.size >= limit) requests.wake.add(pump);
    else requests.wake.delete(pump);
    if (!pending.length || drainers || deferred) clearTimer();
    else if (!partialTimer) {
      partialTimer = setTimeout(() => {
        partialTimer = null;
        drainers++;
        pump();
        drainers--;
      }, 5000);
      partialTimer.unref();
    }
  };

  const prioritize = (ids: readonly number[]) => {
    if (!ids.length) return;
    const ranks = new Map(ids.map((id, i) => [id, i]));
    pending.sort(
      (a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity),
    );
  };

  return {
    get pendingCount() {
      return pending.length;
    },
    get activeCount() {
      return judging;
    },
    get scored() {
      return scored;
    },
    get needsAnotherPass() {
      return deferred;
    },
    enqueue(ids: readonly number[], priority: readonly number[] = []) {
      if (signal.aborted) return;
      for (const id of ids)
        if (
          !seen.has(id) ||
          (!inFlight.has(id) &&
            !pending.includes(id) &&
            deps.store.getJobForFit(id)?.fitStale)
        ) {
          seen.add(id);
          pending.push(id);
        }
      prioritize(priority);
      pump();
      onProgress();
    },
    prioritize,
    /**
     * Settles when this queue's work has answered, or at once when it is
     * stopped: requests already sent then finish on their own.
     */
    async drain() {
      drainers++;
      try {
        for (;;) {
          pump();
          const work = [...active, ...waiting.values()];
          // Work held back by the request limit waits for any request to answer.
          if (pending.length) work.push(...requests.sent);
          if (signal.aborted || !work.length) break;
          await Promise.race([...work, stopped]);
        }
      } finally {
        drainers--;
      }
    },
  };
}
