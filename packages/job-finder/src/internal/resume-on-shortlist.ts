import type { ResumeBatchGenerationResult } from "@nestor/contracts";

/**
 * Resumes start writing the moment a job is shortlisted (ADR 0072), so one is
 * ready by the time the person opens it.
 *
 * This owns no writer of its own: every job goes through the same generation
 * as "Create N missing resumes", with its admission, writer and processing
 * limits. What it adds is the person's request, kept durably as a list of
 * job ids until each job's resume is written or the request is withdrawn
 * (moved back, hidden, Undo of the shortlist), so a restart carries on.
 * Pause holds the list; nothing starts while the workspace is paused.
 */
export interface ResumeOnShortlistDeps {
  /** The person's switch and a configured AI; checked on every request. */
  isEnabled: () => Promise<boolean>;
  isPaused: () => Promise<boolean>;
  /** Of these jobs, the ones still shortlisted, without a resume, not Original. */
  needingResume: (jobIds: readonly string[]) => Promise<readonly string[]>;
  readQueue: () => Promise<readonly string[]>;
  updateQueue: (
    change: (current: readonly string[]) => readonly string[],
  ) => Promise<void>;
  /** The batch generation path; `shouldStop` is read before work starts. */
  generate: (
    jobId: string,
    shouldStop: () => boolean,
  ) => Promise<ResumeBatchGenerationResult>;
  /** Stops a job that is being written now; its draft is never saved. */
  cancelInFlight: (jobId: string) => void;
  /** Something the screens show changed (queued, written, withdrawn). */
  onChange: () => void;
  /** Waits before trying again when the AI service turned work away. */
  retryLater: (run: () => void) => void;
}

export interface ResumeOnShortlist {
  request: (jobIds: readonly string[]) => Promise<void>;
  withdraw: (jobIds: readonly string[]) => Promise<void>;
  /** Starts what is waiting: after a restart and when work continues. */
  continue: () => Promise<void>;
  /** Pause holds jobs not started yet; Continue starts them. */
  pauseChanged: (paused: boolean) => void;
}

export function createResumeOnShortlist(
  deps: ResumeOnShortlistDeps,
): ResumeOnShortlist {
  const active = new Set<string>();
  const withdrawn = new Set<string>();
  let paused = false;
  let starting: Promise<void> | null = null;
  let startAgain = false;

  const finish = async (jobId: string, keep: boolean) => {
    active.delete(jobId);
    if (withdrawn.delete(jobId) || !keep)
      await deps.updateQueue((ids) => ids.filter((id) => id !== jobId));
    deps.onChange();
  };

  const run = async (jobId: string) => {
    let result: ResumeBatchGenerationResult | null = null;
    try {
      result = await deps.generate(
        jobId,
        () => withdrawn.has(jobId) || paused,
      );
    } catch {
      // A failed resume is recorded on the job as today ("Needs a resume").
    }
    // Not started: paused, or the AI service was busy. The request stays.
    const keep = result?.outcome === "not_started" && !withdrawn.has(jobId);
    await finish(jobId, keep);
    if (keep && !paused) deps.retryLater(() => void start());
  };

  const startWaiting = async () => {
    paused = await deps.isPaused();
    if (paused) return;
    for (const jobId of await deps.readQueue()) {
      if (active.has(jobId)) continue;
      active.add(jobId);
      void run(jobId);
    }
  };

  const start = (): Promise<void> => {
    if (starting) {
      startAgain = true;
      return starting;
    }
    starting = startWaiting().finally(() => {
      starting = null;
      if (startAgain) {
        startAgain = false;
        void start();
      }
    });
    return starting;
  };

  return {
    async request(jobIds) {
      if (jobIds.length === 0 || !(await deps.isEnabled())) return;
      const needed = await deps.needingResume(jobIds);
      if (needed.length === 0) return;
      for (const jobId of needed) withdrawn.delete(jobId);
      await deps.updateQueue((ids) => [
        ...ids,
        ...needed.filter((id) => !ids.includes(id)),
      ]);
      deps.onChange();
      await start();
    },
    async withdraw(jobIds) {
      const ids = new Set(jobIds);
      let changed = false;
      for (const jobId of ids)
        if (active.has(jobId)) {
          withdrawn.add(jobId);
          deps.cancelInFlight(jobId);
        }
      await deps.updateQueue((current) => {
        const next = current.filter((id) => !ids.has(id));
        changed = next.length !== current.length;
        return next;
      });
      if (changed) deps.onChange();
    },
    continue: start,
    pauseChanged(next) {
      paused = next;
      if (!next) void start();
    },
  };
}
