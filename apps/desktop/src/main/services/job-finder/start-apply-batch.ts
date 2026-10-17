import type {
  ApplicationAutomationMode,
  ApplyRun,
  ApplyJobResult,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

/**
 * The parts of the workspace service "Apply to all" and "Try again for all"
 * use. A batch is staged, approved by the saved mode, and then runs for
 * minutes; the press only has to wait until it is running or refused.
 */
export interface ApplyBatchService {
  getWorkspaceSnapshot?(): Promise<JobFinderWorkspaceSnapshot>;
  startAutoApplyQueueRun(
    jobIds: string[],
    applicationAutomationMode?: ApplicationAutomationMode,
  ): Promise<JobFinderWorkspaceSnapshot>;
  approveApplyRun(runId: string): Promise<JobFinderWorkspaceSnapshot>;
  cancelApplyRun(runId: string): Promise<JobFinderWorkspaceSnapshot>;
}

export interface ApplyBatchRunReader {
  listApplyRuns(): Promise<readonly ApplyRun[]>;
  listApplyJobResults?(): Promise<readonly ApplyJobResult[]>;
}

const IN_PROGRESS_BATCH_STATES = new Set<ApplyRun["state"]>([
  "running",
  "awaiting_submit_approval",
]);

type Settled = { ok: true } | { ok: false; error: unknown };

/**
 * Waits until `work` settles or `isRunning` says the batch is under way,
 * whichever comes first. A refusal (a pending safeguard review, a job that
 * is already being filled in, paused activity) reaches the caller as the
 * error it is instead of a batch that "started" and never moved.
 */
async function waitUntilRunningOrSettled(input: {
  work: Promise<unknown>;
  isRunning: () => Promise<boolean>;
  pollMs: number;
  timeoutMs: number;
}): Promise<{ result: Settled; workSettled: boolean }> {
  let settled: Settled | null = null;
  void input.work.then(
    () => {
      settled = { ok: true };
    },
    (error: unknown) => {
      settled = { ok: false, error };
    },
  );
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    // Let an already-settled promise land before the first read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = settled as Settled | null;
    if (current) return { result: current, workSettled: true };
    if (await input.isRunning().catch(() => false)) {
      return { result: { ok: true }, workSettled: false };
    }
    if (Date.now() >= deadline) {
      return { result: { ok: true }, workSettled: false };
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
}

/**
 * Jobs not already in a running or staged batch. A second press for the same
 * jobs must not stage another batch, and must not re-issue their send
 * permission while the first batch is using it.
 */
export async function listJobsNotInProgress(
  runs: ApplyBatchRunReader,
  jobIds: readonly string[],
): Promise<string[]> {
  const busyJobIds = new Set(
    (await runs.listApplyRuns())
      .filter((run) => IN_PROGRESS_BATCH_STATES.has(run.state))
      .flatMap((run) => run.jobIds),
  );
  const verified = new Set(
    ((await runs.listApplyJobResults?.()) ?? [])
      .filter(
        (result) =>
          result.privacyReceipt?.finalSubmitOccurred === true &&
          (result.privacyReceipt.submissionOutcome === null ||
            result.privacyReceipt.submissionOutcome.outcome === "submitted"),
      )
      .map((result) => result.jobId),
  );
  return [...new Set(jobIds)].filter(
    (jobId) => !busyJobIds.has(jobId) && !verified.has(jobId),
  );
}

function sameJobs(run: ApplyRun, jobIds: readonly string[]): boolean {
  const requested = new Set(jobIds);
  return (
    run.jobIds.length === requested.size &&
    run.jobIds.every((jobId) => requested.has(jobId))
  );
}

/**
 * One press for a batch (ADR 0022, ADR 0026).
 *
 * - Jobs already in a running or staged batch are left out, so a double
 *   press never stages a second batch that its approval then refuses.
 * - The press returns once the batch is running; the rest runs in the
 *   background and `onBackgroundSettled` fires when it ends.
 * - A refusal is thrown with its own sentence, and a staged batch it left
 *   behind is cancelled so no orphan keeps offering a second approval press.
 */
export async function startApplyBatch(input: {
  service: ApplyBatchService;
  runs: ApplyBatchRunReader;
  jobIds: readonly string[];
  applicationAutomationMode?: ApplicationAutomationMode;
  onBackgroundSettled: () => void;
  pollMs?: number;
  startTimeoutMs?: number;
}): Promise<{ startedJobIds: string[] }> {
  const pollMs = input.pollMs ?? 150;
  const timeoutMs = input.startTimeoutMs ?? 20_000;
  const jobIds = await listJobsNotInProgress(input.runs, input.jobIds);
  if (jobIds.length === 0) {
    return { startedJobIds: [] };
  }

  const knownRunIds = new Set(
    (await input.runs.listApplyRuns()).map((run) => run.id),
  );
  const findNewBatch = async (): Promise<ApplyRun | null> =>
    [...(await input.runs.listApplyRuns())]
      .filter(
        (run) =>
          !knownRunIds.has(run.id) &&
          run.mode === "queue_auto" &&
          sameJobs(run, jobIds),
      )
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      )[0] ?? null;

  // A batch the person already approved runs straight from staging (a
  // "Try again for all" of that batch's jobs), so staging itself can be the
  // whole run.
  const work = (async () => {
    await input.service.startAutoApplyQueueRun(
      jobIds,
      input.applicationAutomationMode,
    );
    const stagedRun = await findNewBatch();
    if (!stagedRun || stagedRun.state !== "awaiting_submit_approval") return;

    try {
      await input.service.approveApplyRun(stagedRun.id);
    } catch (error: unknown) {
      await input.service.cancelApplyRun(stagedRun.id).catch(() => undefined);
      throw error;
    }
  })();
  // Keep staging and approval in the same background operation. Reaching the
  // foreground deadline must not abandon the approval of a slow staging call.
  const started = await waitUntilRunningOrSettled({
    work,
    isRunning: async () => (await findNewBatch())?.state === "running",
    pollMs,
    timeoutMs,
  });
  if (!started.result.ok) throw started.result.error;
  void work
    .catch((error: unknown) => {
      console.error("Apply to all stopped.", error);
    })
    .finally(input.onBackgroundSettled);
  return { startedJobIds: jobIds };
}
