import type {
  JobDiscoveryTarget,
  SavedJobDiscoveryProvenance,
} from "@nestor/contracts";

function humanizeSourceValue(value: string): string {
  const words = value.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function getSafeHostname(startingUrl: string): string | null {
  try {
    const url = new URL(startingUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.hostname
      .toLowerCase()
      .replace(/^www\./u, "")
      .replace(/\.$/u, "");
  } catch {
    return null;
  }
}

export type SourceAttribution = Pick<
  SavedJobDiscoveryProvenance,
  | "targetId"
  | "sourceLabel"
  | "startingUrl"
  | "resolvedAdapterKind"
  | "adapterKind"
  | "collectionMethod"
>;
type SourceTarget = Pick<JobDiscoveryTarget, "id" | "label">;
function getProvenanceFallbackLabel(provenance: SourceAttribution): string {
  const adapter = provenance.resolvedAdapterKind ?? provenance.adapterKind;
  return `${humanizeSourceValue(adapter)} · ${humanizeSourceValue(provenance.collectionMethod)}`;
}

const targetLabelsByTargetsIdentity = new WeakMap<
  readonly SourceTarget[],
  Map<string, string>
>();

function getTargetLabels(
  discoveryTargets: readonly SourceTarget[],
): Map<string, string> {
  const cached = targetLabelsByTargetsIdentity.get(discoveryTargets);
  if (cached) {
    return cached;
  }

  const targetLabels = new Map(
    discoveryTargets.map((target) => [target.id, target.label.trim()]),
  );
  targetLabelsByTargetsIdentity.set(discoveryTargets, targetLabels);
  return targetLabels;
}

// The same ordering as `localeCompare(right, "en", { sensitivity: "base" })`,
// built once: that call builds a collator every time it runs.
const sourceLabelCollator = new Intl.Collator("en", {
  sensitivity: "base",
});

export function compareSourceLabels(left: string, right: string): number {
  return sourceLabelCollator.compare(left, right);
}

export function getDiscoverySourceLabels(
  provenance: readonly SourceAttribution[],
  discoveryTargets: readonly SourceTarget[],
): readonly string[] {
  const targetLabels = getTargetLabels(discoveryTargets);
  const labels = provenance.map((entry) => {
    const configuredLabel = targetLabels.get(entry.targetId);
    if (configuredLabel) {
      return configuredLabel;
    }

    return (
      entry.sourceLabel ??
      getSafeHostname(entry.startingUrl) ??
      getProvenanceFallbackLabel(entry)
    );
  });

  return [...new Set(labels)].sort(compareSourceLabels);
}
