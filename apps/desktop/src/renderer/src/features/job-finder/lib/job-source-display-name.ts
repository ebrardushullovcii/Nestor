import type { JobDiscoveryTarget, JobSource } from "@nestor/contracts";

/**
 * Naming for job sources on user-facing surfaces.
 *
 * Internal target ids and the recorded source enum are storage facts, never
 * names a job seeker chose to read. Everything the user sees is either the
 * label they saved for the source or a plain fallback phrase.
 */

/** Used when a source no longer carries the label the user saved. */
export const UNNAMED_JOB_SOURCE_NAME = "A job source";

/**
 * Derives a useful label when the person pastes only a URL. Local replica
 * sites share one host, so include their first path segment to keep sources
 * distinguishable in the source library and search picker.
 */
export function deriveJobSourceLabel(startingUrl: string): string {
  try {
    const url = new URL(startingUrl.trim());
    const hostname = url.hostname.replace(/^www\./, "");
    const firstPathSegment = url.pathname.split("/").filter(Boolean)[0];
    if (firstPathSegment) {
      return `${url.host.replace(/^www\./, "")}/${firstPathSegment}`;
    }
    return hostname || startingUrl.trim() || "URL not set";
  } catch {
    return startingUrl.trim() || "URL not set";
  }
}

/** Recognizes both current labels and older labels that showed only the host. */
export function isGeneratedJobSourceLabel(
  label: string,
  startingUrl: string,
): boolean {
  if (label === deriveJobSourceLabel(startingUrl)) return true;
  try {
    return label === new URL(startingUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * Plain names for the recorded source value on a saved job. The record is
 * exhaustive so a new source kind cannot silently leak its enum name.
 */
const JOB_SOURCE_NAMES: Record<JobSource, string> = {
  target_site: "Job sites you added",
};

/**
 * Resolves a saved source target id to the label the user gave it, falling
 * back to a plain phrase when the source (or its label) is gone.
 */
export function jobSourceLabel(
  sourceTargetId: string,
  targets: readonly (Pick<JobDiscoveryTarget, "id" | "label"> &
    Partial<Pick<JobDiscoveryTarget, "startingUrl">>)[],
): string {
  const id = sourceTargetId.trim();
  const target = targets.find((target) => target.id === id);
  const saved = target?.label.trim() ?? "";
  if (
    target?.startingUrl &&
    isGeneratedJobSourceLabel(saved, target.startingUrl)
  )
    return deriveJobSourceLabel(target.startingUrl);
  if (saved.length > 0) return saved;
  return UNNAMED_JOB_SOURCE_NAME;
}

/**
 * Names the source recorded on an outcome event. Saved jobs record the source
 * kind rather than the individual site, so the name describes that kind in
 * plain language instead of printing the stored value.
 */
export function recordedJobSourceName(recordedSource: string): string {
  const value = recordedSource.trim();
  const known = JOB_SOURCE_NAMES[value as JobSource];
  if (known) return known;
  return UNNAMED_JOB_SOURCE_NAME;
}
