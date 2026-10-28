import { z } from "zod";
import { JobListPageSchema, JobRowSchema, JobStageCountsSchema } from "./jobs";

/** Compact job rows for chat, independent of the Shortlisted screen DTO. */
export const AssistantJobListPageSchema = JobListPageSchema.extend({
  rows: z.array(
    JobRowSchema.pick({
      id: true,
      stage: true,
      title: true,
      company: true,
      location: true,
      fitScore: true,
    }).extend({
      resumeStatus: z.enum(["none", "writing", "to_review", "approved"]),
      resumeError: z.string().max(300).nullable(),
    }),
  ),
  counts: JobStageCountsSchema.omit({ resume: true }).extend({
    /** All jobs on Shortlisted, including the approved subset. */
    shortlisted: z.number().int().nonnegative(),
    approvedResumes: z.number().int().nonnegative(),
  }),
});
export type AssistantJobListPage = z.infer<typeof AssistantJobListPageSchema>;
