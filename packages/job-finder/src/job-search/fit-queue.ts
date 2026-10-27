import { abortable } from "./async";
import {
  fitContextFingerprint,
  fitContextInput,
  fitInputFingerprint,
} from "./fit-input";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import type { JobDetail, JobSearchSettings } from "@nestor/contracts";

const PASS_TOKENS = 50_000;

/** A bounded pass. Unfinished work remains persisted for the next pass. */
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
    spent = 0,
    drainers = 0;
  let deferred = false;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  };
  signal.addEventListener("abort", clearTimer, { once: true });
  const liveContext = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
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
    deferred = true;
    throw new Error(
      "Your profile is changing; fit will be checked again shortly.",
    );
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

  const judge = async (jobs: JobDetail[], reserved: number) => {
    for (const job of jobs) inFlight.add(job.id);
    judging += jobs.length;
    onProgress();
    try {
      const current = await liveContext();
      const key = fitContextFingerprint(current, settings?.note);
      const fingerprints = new Map(
        jobs.map((job) => [job.id, fitInputFingerprint(key, job)]),
      );
      let actual = 0;
      const updates = await abortable(
        deps.engine.fitJobs({
          jobs: jobs.map((job) => ({ ...job, fit: null })),
          context: current,
          signal,
          ...(settings?.note ? { request: settings.note } : {}),
          onUsage: (usage) => {
            actual +=
              usage.inputTokens +
              usage.outputTokens +
              (usage.estimated?.inputTokens ?? 0) +
              (usage.estimated?.outputTokens ?? 0);
          },
        }),
        signal,
      );
      if (actual) spent += actual - reserved;
      signal.throwIfAborted();
      const latest = await liveContext();
      const latestKey = fitContextFingerprint(latest, settings?.note);
      const valid = updates.flatMap((update) => {
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
        return [{ ...update, inputFingerprint: fingerprint }];
      });
      deps.store.setFit(valid);
      scored += valid.length;
      onScored(valid.length);
      if (valid.length < jobs.length)
        onError(
          new Error("Some jobs are still waiting for a current fit score."),
        );
    } finally {
      for (const job of jobs) inFlight.delete(job.id);
      judging -= jobs.length;
      onProgress();
    }
  };

  const pump = () => {
    if (signal.aborted) {
      clearTimer();
      pending.length = 0;
      return;
    }
    while (
      active.size < limit &&
      pending.length &&
      (pending.length >= 48 || drainers > 0)
    ) {
      const jobs: JobDetail[] = [];
      let reserved = overhead;
      while (pending.length && jobs.length < 48) {
        const job = deps.store.getJob(pending[0]!);
        if (!eligible(job)) {
          pending.shift();
          continue;
        }
        const tokens = estimate(job);
        // One unusually long listing is indivisible: preserve its full evidence.
        if (
          spent + reserved + tokens > PASS_TOKENS &&
          (spent > 0 || jobs.length > 0)
        )
          break;
        pending.shift();
        jobs.push(job);
        reserved += tokens;
      }
      if (!jobs.length) {
        deferred = pending.length > 0;
        break;
      }
      spent += reserved;
      const task = judge(jobs, reserved)
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
