import type { JobSearchStatus } from "@nestor/contracts";

export interface PausedSearch {
  /** Why it stopped, in one short line ("Nestor sent an invalid AI request"). */
  reason: string;
  /** What happens next, and whose move it is. */
  next: string;
  /** Nestor's own error: the person may press Try again without waiting. */
  retry: boolean;
  /** The person's AI account refused: Needs you holds their step. */
  accountStep: boolean;
}

/**
 * A search that stopped on an AI refusal and kept its queue. Home and Find
 * jobs both say it, with its reason and what happens next, instead of a
 * quiet "Nothing is waiting on you" or rows that never arrive.
 */
export function pausedSearch(
  status: Pick<JobSearchStatus, "search" | "parked"> | null | undefined,
): PausedSearch | null {
  const parked = status?.parked;
  if (!parked || status?.search?.state !== "running") return null;
  if (parked.requestRejected)
    return {
      reason: "Nestor sent an invalid AI request",
      next: "That is Nestor's error, not yours. The search and every site it had left are saved; it tries again when Nestor restarts, or press Try again now.",
      retry: true,
      accountStep: false,
    };
  if (parked.owner === "nestor")
    return {
      reason: "Nestor's AI service is paused",
      next: "The search and every site it had left are saved, and it carries on by itself when the service is back. Nothing for you to do.",
      retry: false,
      accountStep: false,
    };
  return {
    reason: "your AI account refused the search",
    next: "The search and every site it had left are saved, and it carries on by itself once your AI account answers again. Needs you shows what the account needs.",
    retry: false,
    accountStep: true,
  };
}
