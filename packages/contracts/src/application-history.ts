import type { ApplicationRow } from "./applications";
import type { SubmissionOutcomeRecord } from "./application-authority";
import type { TrackerEvent, TrackerStatus } from "./tracker";

/** Recorded history, with its source; missing records do not establish absence. */
export interface CandidateApplicationHistory {
  applications: (ApplicationRow & {
    source: "applications";
    url: string;
    applyUrl: string | null;
    /** The send summary. Full page and network diagnostics stay on the receipt. */
    submissionOutcome:
      | (Omit<SubmissionOutcomeRecord, "browserAction"> & {
          browserAction?: Omit<
            NonNullable<SubmissionOutcomeRecord["browserAction"]>,
            "detail" | "requestsAfterClick"
          >;
        })
      | null;
  })[];
  tracker: {
    source: "tracker";
    jobId: number;
    title: string;
    company: string;
    status: TrackerStatus;
    statusAt: string;
    appliedAt: string | null;
    events: TrackerEvent[];
  }[];
}
