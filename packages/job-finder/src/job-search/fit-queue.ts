import { abortable } from "./async";
import { reportSelfLimitHit } from "@nestor/core";
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
) {
  const pending: number[] = [];
  const seen = new Set<number>();
  const inFlight = new Set<number>();
  const active = new Set<Promise<void>>();
  const cutoff =
    !settings || settings.postedWithin === "any"
      ? null
      : Date.now() - (settings.postedWithin === "week" ? 7 : 30) * 86_400_000;
  let scored = 0,
    judging = 0,
    drainers = 0,
    // A batch with no answers (usually the provider's rate limit) halves the
    // requests in flight; each answered batch adds one back, up to the limit.
    ceiling = limit;
  let deferred = false;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  };
  signal.addEventListener("abort", clearTimer, { once: true });
  const liveContext = async () => {
    while (true) {
      signal.throwIfAborted();
      const revision = deps.store.fitRevision();
      const current = await abortable(deps.readContext(), signal);
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

  /** Unanswered listings stay queued until the model supplies their scores. */
  const retry = (jobs: readonly JobDetail[], nothingAnswered: boolean) => {
    if (nothingAnswered) ceiling = Math.max(1, Math.ceil(ceiling / 2));
    pending.push(...jobs.map((job) => job.id));
  };

  const judge = async (jobs: JobDetail[]) => {
    for (const job of jobs) inFlight.add(job.id);
    judging += jobs.length;
    onProgress();
    try {
      const current = await liveContext();
      const key = fitContextFingerprint(current, settings?.note);
      const fingerprints = new Map(
        jobs.map((job) => [job.id, fitInputFingerprint(key, job)]),
      );
      const answered = new Set<number>();
      const persist = async (
        updates: Awaited<ReturnType<typeof deps.engine.fitJobs>>,
      ) => {
        signal.throwIfAborted();
        const latest = await liveContext();
        signal.throwIfAborted();
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
            jobs: jobs.map((job) => ({ ...job, fit: null })),
            context: current,
            signal,
            onBatch: (fits) => persist([...fits]),
            ...(settings?.note ? { request: settings.note } : {}),
          }),
          signal,
        );
      } catch (error) {
        signal.throwIfAborted();
        // Provider transports own recoverable failures. Surface a real request
        // error; unscored jobs remain durable in the store for continuation.
        throw error;
      }
      signal.throwIfAborted();
      await persist(updates);
      if (updates.length && ceiling < limit) ceiling++;
      // Superseded returned judgments are not technical omissions.
      for (const update of updates) answered.add(update.id);
      // A superseded input is normal background work, not a model failure.
      retry(
        jobs.filter((job) => !answered.has(job.id)),
        updates.length === 0,
      );
    } finally {
      for (const job of jobs) inFlight.delete(job.id);
      judging -= jobs.length;
      onProgress();
    }
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
      const job = deps.store.getJob(pending[index]!);
      if (!eligible(job)) {
        pending.splice(index, 1);
        continue;
      }
      const cost = estimate(job);
      if (jobs.length && tokens + cost > BATCH_TOKENS) {
        reportSelfLimitHit({
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
          reportSelfLimitHit({
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
      return;
    }
    if (pending.length && active.size >= Math.min(limit, ceiling))
      reportSelfLimitHit({
        limit: "fit_concurrency",
        kind: "concurrency",
        value: Math.min(limit, ceiling),
        where: "job-finder/fitQueue/pump",
      });
    while (active.size < Math.min(limit, ceiling) && pending.length) {
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
    enqueue(ids: readonly number[]) {
      if (signal.aborted) return;
      for (const id of ids)
        if (
          !seen.has(id) ||
          (!inFlight.has(id) &&
            !pending.includes(id) &&
            deps.store.getJob(id)?.fitStale)
        ) {
          seen.add(id);
          pending.push(id);
        }
      pump();
      onProgress();
    },
    prioritize(ids: readonly number[]) {
      const ranks = new Map(ids.map((id, i) => [id, i]));
      pending.sort(
        (a, b) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity),
      );
    },
    async drain() {
      drainers++;
      try {
        pump();
        while (active.size) await Promise.all([...active]);
      } finally {
        drainers--;
      }
    },
  };
}
