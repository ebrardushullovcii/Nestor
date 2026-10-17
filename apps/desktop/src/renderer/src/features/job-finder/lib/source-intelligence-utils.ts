import type {
  SourceInstructionArtifact,
  SourceIntelligenceArtifact,
} from "@nestor/contracts";

export interface LearnedInstructionIntelligenceSummaryItem {
  label: string;
  value: string;
}

export interface LearnedInstructionIntelligenceSummary {
  title: string;
  items: LearnedInstructionIntelligenceSummaryItem[];
}

function formatProviderSummary(
  intelligence: SourceIntelligenceArtifact,
): LearnedInstructionIntelligenceSummary | null {
  const provider = intelligence.provider;

  if (!provider) {
    return null;
  }

  const items: LearnedInstructionIntelligenceSummaryItem[] = [
    { label: "Provider", value: provider.label },
    { label: "Confidence", value: `${Math.round(provider.confidence * 100)}%` },
    { label: "API", value: provider.apiAvailability.replace(/_/g, " ") },
  ];

  if (provider.boardToken) {
    items.push({ label: "Board token", value: provider.boardToken });
  }

  if (
    provider.providerIdentifier &&
    provider.providerIdentifier !== provider.boardToken
  ) {
    items.push({ label: "Identifier", value: provider.providerIdentifier });
  }

  return {
    title: "Provider intelligence",
    items,
  };
}

function formatCollectionSummary(
  intelligence: SourceIntelligenceArtifact,
): LearnedInstructionIntelligenceSummary | null {
  const collection = intelligence.collection;
  const bestRoute =
    collection.startingRoutes[0]?.url ??
    collection.searchRouteTemplates[0]?.url ??
    null;
  const items: LearnedInstructionIntelligenceSummaryItem[] = [
    {
      label: "Preferred method",
      value: collection.preferredMethod.replace(/_/g, " "),
    },
  ];

  if (collection.rankedMethods.length > 0) {
    items.push({
      label: "Method order",
      value: collection.rankedMethods.join(" -> ").replace(/_/g, " "),
    });
  }

  if (bestRoute) {
    items.push({ label: "Best start route", value: bestRoute });
  }

  if (collection.detailRoutePatterns[0]?.pattern) {
    items.push({
      label: "Detail pattern",
      value: collection.detailRoutePatterns[0].pattern,
    });
  }

  if (collection.listingMarkers.length > 0) {
    items.push({
      label: "Listing markers",
      value: collection.listingMarkers.slice(0, 3).join(", "),
    });
  }

  return items.length > 1 || bestRoute
    ? {
        title: "Discovery strategy",
        items,
      }
    : null;
}

function formatApplySummary(
  intelligence: SourceIntelligenceArtifact,
): LearnedInstructionIntelligenceSummary | null {
  const apply = intelligence.apply;
  const items: LearnedInstructionIntelligenceSummaryItem[] = [];

  if (apply.applyPath !== "unknown") {
    items.push({
      label: "Apply path",
      value: apply.applyPath.replace(/_/g, " "),
    });
  }

  if (apply.authMarkers.length > 0) {
    items.push({
      label: "Auth markers",
      value: apply.authMarkers.slice(0, 2).join(", "),
    });
  }

  if (apply.questionSurfaceHints.length > 0) {
    items.push({
      label: "Question hints",
      value: apply.questionSurfaceHints.slice(0, 2).join(", "),
    });
  }

  if (apply.resumeUploadHints.length > 0) {
    items.push({
      label: "Resume hints",
      value: apply.resumeUploadHints.slice(0, 2).join(", "),
    });
  }

  return items.length > 0
    ? {
        title: "Apply hints",
        items,
      }
    : null;
}

export function buildIntelligenceSummaries(
  intelligence: SourceIntelligenceArtifact | null,
): LearnedInstructionIntelligenceSummary[] {
  if (!intelligence) {
    return [];
  }

  return [
    formatProviderSummary(intelligence),
    formatCollectionSummary(intelligence),
    formatApplySummary(intelligence),
  ].filter(
    (summary): summary is LearnedInstructionIntelligenceSummary =>
      summary !== null,
  );
}

export function buildLearnedInstructionIntelligenceSummaries(
  artifact: SourceInstructionArtifact | null,
): LearnedInstructionIntelligenceSummary[] {
  return buildIntelligenceSummaries(artifact?.intelligence ?? null);
}
