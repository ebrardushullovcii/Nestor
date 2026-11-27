import type { ApplicationRow } from "./applications";
import type {
  SubmissionOutcomeEvidenceEntry,
  SubmissionOutcomeRecord,
} from "./application-authority";
import type { TrackerEvent, TrackerStatus } from "./tracker";

/** Recorded history, with its source; missing records do not establish absence. */
export interface CandidateApplicationHistory {
  applications: (ApplicationRow & {
    source: "applications";
    url: string;
    applyUrl: string | null;
    /** Send facts for comparing postings. The full receipt is stored separately. */
    submissionOutcome:
      | (Pick<
          SubmissionOutcomeRecord,
          "outcome" | "attemptedAt" | "verifiedAt"
        > & {
          evidence: Pick<
            SubmissionOutcomeEvidenceEntry,
            "kind" | "observedAt" | "destination" | "summary"
          >[];
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
