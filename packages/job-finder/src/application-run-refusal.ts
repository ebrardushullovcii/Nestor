import type { ApplyQueueSkippedJob } from "@nestor/contracts";

/** No run started. These named jobs are held by the employer overlap check. */
export class SameCompanyApplicationConflictError extends Error {
  constructor(
    message: string,
    readonly skipped: readonly ApplyQueueSkippedJob[],
  ) {
    super(message);
    this.name = "SameCompanyApplicationConflictError";
  }
}
