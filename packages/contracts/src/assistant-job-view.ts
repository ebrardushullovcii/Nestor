import { z } from "zod";
import { JobIdSchema, JobSortSchema, JobStageSchema } from "./jobs";

/** Navigation changes the screen's own filter and selection, without loading all jobs. */
export const AssistantJobViewSchema = z
  .object({
    stage: JobStageSchema.optional(),
    text: z.string().max(200).optional(),
    minFit: z.number().int().min(0).max(100).nullable().optional(),
    sort: JobSortSchema.optional(),
    /** With all=true these are the exceptions; otherwise these are the selected jobs. */
    selectedIds: z.array(JobIdSchema).max(50).optional(),
    all: z.boolean().optional(),
  })
  .strict();
export type AssistantJobView = z.infer<typeof AssistantJobViewSchema>;

export function matchesAssistantListView(
  actual: object,
  requested: object,
): boolean {
  return Object.entries(requested).every(([key, expected]) => {
    const value = (actual as Record<string, unknown>)[key];
    return Array.isArray(expected) && Array.isArray(value)
      ? JSON.stringify((expected as unknown[]).slice().sort()) ===
          JSON.stringify((value as unknown[]).slice().sort())
      : expected === value;
  });
}
