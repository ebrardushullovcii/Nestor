import { z } from "zod";
import type { ApplicationRow } from "./applications";
import type {
  SubmissionOutcomeEvidenceEntry,
  SubmissionOutcomeRecord,
} from "./application-authority";
import type { TrackerEvent, TrackerStatus } from "./tracker";

/** Last observed application page and form activity before a run ended. */
export const ApplicationAttemptProgressSchema = z.object({
  pageUrl: z.string().url(),
  step: z.object({
    label: z.string().nullable(),
    index: z.number().int().nullable(),
    total: z.number().int().nullable(),
  }),
  filledFields: z.array(z.string()),
  uploadedFiles: z.array(
    z.object({
      field: z.string(),
      fileName: z.string(),
      documentId: z.string(),
    }),
  ),
});

export type ApplicationAttemptProgress = z.infer<
  typeof ApplicationAttemptProgressSchema
>;

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
