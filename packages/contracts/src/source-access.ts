import { z } from "zod";

/** A Needs you access item for one configured site, independent of applications. */
export const SourceAccessReferenceSchema = z.object({
  id: z.number().int().positive(),
  label: z.string(),
  url: z.string().url(),
});
export type SourceAccessReference = z.infer<typeof SourceAccessReferenceSchema>;
export const RetrySourceInputSchema = z
  .object({ id: z.number().int().positive() })
  .strict();
export type RetrySourceInput = z.infer<typeof RetrySourceInputSchema>;
