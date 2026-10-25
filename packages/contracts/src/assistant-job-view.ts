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

export function matchesAssistantJobView(
  actual: AssistantJobView,
  requested: AssistantJobView,
): boolean {
  return (Object.keys(requested) as (keyof AssistantJobView)[]).every((key) => {
    const expected = requested[key];
    const value = actual[key];
    if (!Array.isArray(expected) || !Array.isArray(value))
      return expected === value;
    const ids = [...expected].sort((a, b) => a - b);
    const actualIds = [...value].sort((a, b) => a - b);
    return (
      ids.length === actualIds.length &&
      ids.every((id, index) => id === actualIds[index])
    );
  });
}
