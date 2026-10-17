import {
  JobSearchPreferencesSchema,
  type JobSearchPreferences,
} from "@nestor/contracts";

// Preferences hold every source, hundreds of them. One workspace read used to
// validate the same preferences four times on their way through
// normalization, setup state and plan reconciliation.
const validated = new WeakSet<JobSearchPreferences>();

/** Records a value this read just produced from the schema. */
export function markValidatedSearchPreferences(
  value: JobSearchPreferences,
): JobSearchPreferences {
  validated.add(value);
  return value;
}

/** Validates preferences unless this read already produced them validated. */
export function parseSearchPreferencesOnce(
  value: JobSearchPreferences,
): JobSearchPreferences {
  if (validated.has(value)) return value;
  return markValidatedSearchPreferences(JobSearchPreferencesSchema.parse(value));
}
