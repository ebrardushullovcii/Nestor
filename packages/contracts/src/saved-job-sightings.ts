import type { SavedJob } from "./discovery";

/** Observations that do not change posting facts or a model's assessment. */
export type SavedJobSightingPatch = Pick<SavedJob, "id"> & Partial<
  Pick<SavedJob, "firstSeenAt" | "lastSeenAt" | "lastVerifiedActiveAt">
>;
