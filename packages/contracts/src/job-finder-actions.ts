import { z } from "zod";
import { NonEmptyStringSchema } from "./base";
import { JobDiscoveryTargetSchema } from "./discovery";

export const JobFinderEmptyActionInputSchema = z.object({}).strict();
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
