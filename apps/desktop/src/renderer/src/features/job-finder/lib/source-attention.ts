import {
  isEnabledSourceNeedingAttention,
  type DiscoverySourceHealthFields,
  type SourceRuntimeSignals,
} from "@nestor/job-finder/source-health";

/**
 * The one definition of a job source that needs attention, read by Home and
 * by the Job sources filter of the same name. Home used to count only sources
 * with a recorded problem, without the search history ("6 job sources are not
 * working"), while the filter counted every enabled source the shared health
 * check flags (687): two answers about the same sources. Both now pass the
 * signals from `deriveSourceHealthSignals` and count with this.
 */
export const SOURCES_NEEDING_ATTENTION_LABEL = "Needs attention";

/** The `show` value that opens Job sources on that filter. */
export const SOURCES_NEEDING_ATTENTION_FILTER = "needs_attention";

export function isSourceNeedingAttention(
  target: DiscoverySourceHealthFields,
  signals: SourceRuntimeSignals,
): boolean {
  return isEnabledSourceNeedingAttention(target, signals);
}

export function listSourcesNeedingAttention<
  Target extends DiscoverySourceHealthFields,
>(targets: readonly Target[], signals: SourceRuntimeSignals): Target[] {
  return targets.filter((target) => isSourceNeedingAttention(target, signals));
}

/** "1 job source needs attention." / "687 job sources need attention." */
export function describeSourcesNeedingAttention(count: number): string {
  return count === 1
    ? "1 job source needs attention."
    : `${count} job sources need attention.`;
}
