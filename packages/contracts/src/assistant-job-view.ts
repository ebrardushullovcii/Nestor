import { z } from "zod";
import { JobIdSchema, JobSortSchema, JobStageSchema } from "./jobs";
import { NeedsYouKindSchema } from "./applications";

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

export const AssistantNeedsViewSchema = z
  .object({
    tab: z.enum(["tasks", "saved"]).optional(),
    kind: NeedsYouKindSchema.nullable().optional(),
    text: z.string().max(200).optional(),
    focusId: z.number().int().positive().optional(),
    selectedIds: z.array(z.number().int().positive()).max(50).optional(),
    all: z.boolean().optional(),
  })
  .strict();
export type AssistantNeedsView = z.infer<typeof AssistantNeedsViewSchema>;

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
