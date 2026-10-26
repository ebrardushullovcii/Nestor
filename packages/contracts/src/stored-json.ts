import type { z } from "zod";

/** Old rows read a safe default; existing writers may continue omitting the new field. */
export function optionalStoredField<T>(
  schema: z.ZodType<T>,
  value: Exclude<T, undefined>,
): z.ZodType<T | undefined> {
  return schema.default(value);
}
