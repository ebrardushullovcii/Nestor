import { z } from "zod";
import { IsoDateTimeSchema } from "./base";

export const JobFinderActivityControlSchema = z.object({
  paused: z.boolean().default(false),
  pausedAt: IsoDateTimeSchema.nullable().default(null),
  reason: z.string().trim().max(500).nullable().default(null),
  pauseBehavior: z.enum(["finish_current"]).optional(),
});
export type JobFinderActivityControl = z.infer<
  typeof JobFinderActivityControlSchema
>;

export const SetJobFinderActivityControlInputSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(500).nullable().optional(),
  pauseBehavior: z.enum(["finish_current"]).optional(),
});
export type SetJobFinderActivityControlInput = z.infer<
  typeof SetJobFinderActivityControlInputSchema
>;
