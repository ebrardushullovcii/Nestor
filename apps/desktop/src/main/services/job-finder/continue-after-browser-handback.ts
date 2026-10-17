import type { ApplyJobResult, ApplyRun } from "@nestor/contracts";
import { PERSON_TOOK_OVER_SUMMARY } from "@nestor/job-finder";

export interface HandbackRepository {
  listApplyRuns(): Promise<readonly ApplyRun[]>;
  listApplyJobResults(): Promise<readonly ApplyJobResult[]>;
}

const BUSY_RUN_STATES = new Set<ApplyRun["state"]>([
  "running",
  "awaiting_submit_approval",
]);

/**
 * The person stepped into the tab of an application being filled, then
 * handed the browser back. Carries each of those applications on in the saved
 * mode, as the Try again they would otherwise have to find and press.
 *
 * Only applications recorded as stopped because the person took over, and
 * still the newest attempt for their record, are carried on. One still inside
 * a batch that is working through other jobs waits for that batch to finish,
 * because a job can be in only one running batch.
 */
export async function continueApplicationsAfterHandback(input: {
  resultIds: readonly string[];
  repository: HandbackRepository;
  startBatch: (jobIds: string[]) => Promise<unknown>;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<string[]> {
  const pollMs = input.pollMs ?? 1_000;
  const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000);
  const wanted = new Set(input.resultIds);
  if (wanted.size === 0) return [];

  for (;;) {
    const [runs, results] = await Promise.all([
      input.repository.listApplyRuns(),
      input.repository.listApplyJobResults(),
    ]);
    const newestByRecord = new Map<string, ApplyJobResult>();
    for (const result of results) {
      if (!result.applicationRecordId) continue;
      const previous = newestByRecord.get(result.applicationRecordId);
      if (!previous || previous.updatedAt < result.updatedAt)
        newestByRecord.set(result.applicationRecordId, result);
    }
    const mine = results.filter((result) => wanted.has(result.id));
    // The stopped attempt is written a moment after the tab is taken; wait
    // for it rather than guess.
    const stillWriting = mine.some(
      (result) =>
        ![
          "failed",
          "skipped",
          "cancelled",
          "submitted",
          "awaiting_review",
          "blocked",
        ].includes(result.state),
    );
    const carryOn = mine.filter(
      (result) =>
        (result.state === "failed" || result.state === "skipped") &&
        result.summary === PERSON_TOOK_OVER_SUMMARY &&
        (!result.applicationRecordId ||
          newestByRecord.get(result.applicationRecordId)?.id === result.id),
    );
    const busyJobIds = new Set(
      runs
        .filter((run) => BUSY_RUN_STATES.has(run.state))
        .flatMap((run) => run.jobIds),
    );
    const jobIds = [...new Set(carryOn.map((result) => result.jobId))];
    if (!stillWriting && jobIds.every((jobId) => !busyJobIds.has(jobId))) {
      if (jobIds.length > 0) await input.startBatch(jobIds);
      return jobIds;
    }
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
