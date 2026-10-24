import type { SavedJob } from "./discovery";

/** Observations that do not change posting facts or a model's assessment. */
export type SavedJobSightingPatch = Pick<SavedJob, "id"> &
  Partial<
    Pick<SavedJob, "firstSeenAt" | "lastSeenAt" | "lastVerifiedActiveAt">
  >;

/** Null removes one verdict; no other plan or posting field changes. */
export type SavedJobPlanAssessmentPatch = {
  jobId: SavedJob["id"];
  planId: string;
  assessment: SavedJob["matchAssessment"] | null;
};
