import { z } from "zod";

import { NonEmptyStringSchema } from "./base";
import { JobDiscoveryTargetSchema } from "./discovery";

export const JobFinderEmptyActionInputSchema = z.object({})
  .strict();
export const JobFinderThemeActionInputSchema = z
  .object({
    appearanceTheme: z.enum(["light", "dark", "system"]),
  })
  .strict();
export const JobFinderRegisteredActionInputSchema = z
  .object({
    actionId: NonEmptyStringSchema.max(100),
    input: z.unknown(),
  })
  .strict();
export type JobFinderRegisteredActionInput = z.infer<
  typeof JobFinderRegisteredActionInputSchema
>;

export const JobFinderEditSourceInputSchema = z
  .object({
    sourceId: NonEmptyStringSchema,
    changes: JobDiscoveryTargetSchema.pick({
      label: true,
      startingUrl: true,
      enabled: true,
      adapterKind: true,
    }).partial(),
  })
  .strict();
export const JobFinderRemoveSourceInputSchema = z
  .object({ sourceId: NonEmptyStringSchema })
  .strict();
export const JobFinderReadActionStateInputSchema = z
  .object({
    scope: z.enum([
      "search_rules",
      "notifications",
      "apply_queue",
      "tracker_settings",
    ]),
    id: NonEmptyStringSchema.optional(),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const JobFinderAssistantSearchInputSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
  breadth: z.enum(["best_only", "wide"]).optional(),
  freshness: z.enum(["any", "recent"]).default("any"),
  sourceIds: z.array(NonEmptyStringSchema.max(200)).min(1).max(1000).optional(),
  campaignId: NonEmptyStringSchema.max(200).optional(),
});
export const JobFinderZoomInputSchema = z
  .object({ command: z.enum(["in", "out", "reset"]) })
  .strict();
export const JobFinderSourceQueryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .passthrough();
