import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

/** A queued job the Apply queue set aside before it started (ADR 0058). */
export interface ApplicationQueueHold {
  /** The queue's own sentence about the overlap. */
  reason: string;
  /** The person has not chosen yet for this employer in Safeguards. */
  waitingForChoice: boolean;
}

/**
 * The jobs the Apply queue set aside, by job id. A same-company overlap holds
 * a job before any attempt, so its record has no apply result; without this
 * it read as "Preparing" and "stopped before finishing" (STAB-005).
 */
export function buildApplicationQueueHolds(input: {
  applyQueue: JobFinderRendererWorkspaceSnapshot["applyQueue"] | undefined;
}): ReadonlyMap<string, ApplicationQueueHold> {
  const holds = new Map<string, ApplicationQueueHold>();
  for (const skipped of input.applyQueue?.skipped ?? []) {
    if (holds.has(skipped.jobId)) continue;
    holds.set(skipped.jobId, {
      reason: skipped.reason,
      waitingForChoice: false,
    });
  }
  return holds;
}

/** The row's word for a set-aside job. */
export function describeApplicationQueueHold(
  hold: ApplicationQueueHold,
  company: string,
): string {
  return hold.waitingForChoice
    ? `Not started: waiting for your choice on ${company}`
    : "Not started";
}
