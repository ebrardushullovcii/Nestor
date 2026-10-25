import { z } from "zod";

import { JobRowSchema } from "./jobs";
import type { ResumeDraft } from "./resume";

/**
 * How far a shortlisted job's resume moves toward the listing. `original`
 * sends the imported file as it is; the others write an editable resume from
 * the profile.
 */
export const resumeLevelValues = [
  "original",
  "light",
  "tailored",
  "aggressive",
] as const;
export const ResumeLevelSchema = z.enum(resumeLevelValues);
export type ResumeLevel = z.infer<typeof ResumeLevelSchema>;

/**
 * Where a shortlisted job's resume is. Approval is not a state: an approved
 * resume is `ready` with `approvedAt` set, and its job is in the `resume`
 * stage, where Apply takes it.
 */
export const resumeStateValues = [
  "queued",
  "writing",
  "ready",
  "failed",
] as const;
export const ResumeStateSchema = z.enum(resumeStateValues);
export type ResumeState = z.infer<typeof ResumeStateSchema>;

/** What a list row shows about its resume. */
export const ResumeStatusSchema = z.object({
  level: ResumeLevelSchema,
  state: ResumeStateSchema,
  approvedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ResumeStatus = z.infer<typeof ResumeStatusSchema>;

/** One Shortlisted row: the job and, once writing has started, its resume. */
export const ShortlistedRowSchema = JobRowSchema.extend({
  resume: ResumeStatusSchema.nullable(),
});
export type ShortlistedRow = z.infer<typeof ShortlistedRowSchema>;

/** A job's resume as the editor opens it. */
export interface StoredResume extends ResumeStatus {
  jobId: number;
  /** Null for `original`, and until the first write finishes. */
  draft: ResumeDraft | null;
  updatedAt: string;
  /** The level the last level change replaced; Undo puts it back. */
  previousLevel: ResumeLevel | null;
  /** The approved PDF Apply attaches. */
  pdfPath: string | null;
}
