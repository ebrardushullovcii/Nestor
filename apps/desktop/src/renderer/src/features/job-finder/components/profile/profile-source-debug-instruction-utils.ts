import type {
  EditableSourceInstructionArtifact,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
export { buildLearnedInstructionIntelligenceSummaries } from "../../lib/source-intelligence-utils";
export type { LearnedInstructionIntelligenceSummary } from "../../lib/source-intelligence-utils";

export type LearnedInstructionField =
  | "navigationGuidance"
  | "searchGuidance"
  | "detailGuidance"
  | "applyGuidance"
  | "warnings";

export interface LearnedInstructionSection {
  field: LearnedInstructionField;
  label: string;
  lines: Array<{
    displayText: string;
    normalizedKey: string;
    sourceText: string;
  }>;
}

export function normalizeLearnedInstructionLine(value: string): string {
  return value
    .replace(
      /^(Reliable control|Filter note|Navigation note|Apply note|Validated behavior|Validated navigation|Verification):\s*/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const interactionLogPatterns = [
  /^(clicked|filled|selected|link|button|searchbox|textbox|combobox)\b/,
  /^click failed /,
  /locator click/,
  /call log/,
  /waiting for getbyrole/,
  /element is not visible/,
  /retrying click action/,
];

const phaseBoilerplatePatterns = [
  /^stay within /,
  /^verify whether the site is reachable/,
  /^find search controls or filters/,
  /^open multiple job details/,
  /^check whether discovered jobs expose/,
  /^inspected discovered jobs for apply entry points/,
  /^observed canonical job detail url /,
  /^no reliable apply path was confirmed for /,
  /^replay verification reached /,
];

const authObservationPatterns = [
  /^reliable control: no login or consent wall detected/,
  /fully accessible without login or consent walls/,
  /fully accessible without login or consent barriers/,
  /no authentication required/,
  /without auth required/,
  /loads without auth/,
  /loads without login/,
  /without login or consent barriers/,
  /accessible without login barriers/,
  /no auth or consent blockers detected/,
  /no auth consent blockers detected/,
  /no auth consent popups/,
];

const toolOutputPatterns = [
  /job extraction tool confirmed/,
  /extract jobs tool/,
  /extract_jobs tool/,
  /extract_jobs returned/,
  /get interactive elements/,
  /get_interactive_elements/,
  /interactive elements detection was unreliable/,
  /interactive elements were unreliable/,
];

const siteObservationPatterns = [
  /site title is in albanian/,
  /site is a job board/,
  /page language is /,
  /job listings appear to be in /,
  /means find jobs/,
  /page is scrollable with substantial content/,
];

const timingPatterns = [
  /interactive elements not detected/,
  /interaction timed out/,
  /multiple timeouts observed/,
  /requires longer timeout/,
  /different extraction timing/,
  /different extraction approach/,
  /different interaction method/,
  /manual dom inspection/,
  /pointer events/,
  /pointer event interception/,
  /javascript enabled interaction/,
  /current extraction/,
];

const failurePatterns = [
  /no jobs matching target roles/,
  /apply process not yet verified/,
  /apply mechanism not yet verified/,
  /job details not extracted/,
  /job details and apply flow not fully verified/,
  /llm call failed/,
  /discovery encountered an error/,
  /unknown error/,
];

function matchesAnyPattern(
  value: string,
  patterns: readonly RegExp[],
): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

export function isRenderableLearnedInstructionLine(line: string): boolean {
  const normalized = line.toLowerCase().replace(/\s+/g, " ").trim();
  const isUrlLiteral =
    normalized.includes("http://") || normalized.includes("https://");
  const isOnlyStartingUrlRestatement =
    (normalized.startsWith("start from ") ||
      normalized.startsWith("started from ")) &&
    (isUrlLiteral || normalized.includes("the starting url"));

  if (isOnlyStartingUrlRestatement || isUrlLiteral) {
    return false;
  }

  if (matchesAnyPattern(normalized, interactionLogPatterns)) {
    return false;
  }

  if (matchesAnyPattern(normalized, phaseBoilerplatePatterns)) {
    return false;
  }

  if (matchesAnyPattern(normalized, authObservationPatterns)) {
    return false;
  }

  if (normalized.includes("no login auth or consent blockers detected")) {
    return false;
  }

  if (matchesAnyPattern(normalized, toolOutputPatterns)) {
    return false;
  }

  if (matchesAnyPattern(normalized, siteObservationPatterns)) {
    return false;
  }

  if (matchesAnyPattern(normalized, timingPatterns)) {
    return false;
  }

  if (matchesAnyPattern(normalized, failurePatterns)) {
    return false;
  }

  if (normalized.startsWith("verification: ")) {
    return false;
  }

  if (normalized.includes("produced no candidate jobs")) {
    return false;
  }

  return !/produced \d+ candidate job result/.test(normalized);
}

export function describeLearnedInstructionUsage(
  artifact: SourceInstructionArtifact | null,
  latestRun?: SourceDebugRunRecord | null,
): string {
  if (!artifact) {
    return "Saved from the latest source check.";
  }

  if (latestRun?.state === "failed" && artifact.basedOnRunId !== latestRun.id) {
    const checkedAt = latestRun.completedAt ?? latestRun.updatedAt;
    return `This retained guidance comes from an earlier successful check. The latest check failed${checkedAt ? ` on ${new Date(checkedAt).toLocaleString()}` : ""} and did not re-verify or replace it.`;
  }

  if (artifact.status === "validated") {
    return "This saved guidance is used automatically for searches and supported apply flows on this source.";
  }

  if (artifact.status === "draft") {
    return "This draft guidance came from the latest source check and is already used automatically until you replace or re-check it.";
  }

  return "Saved from the latest source check.";
}

export function buildLearnedInstructionSections(
  artifact: SourceInstructionArtifact | null,
): LearnedInstructionSection[] {
  if (!artifact) {
    return [];
  }

  const seen = new Set<string>();
  const buildSection = (
    field: LearnedInstructionField,
    label: string,
    values: readonly string[],
    formatValue: (value: string) => string = (value) => value,
  ): LearnedInstructionSection | null => {
    const lines = values
      .map((sourceText) => ({
        sourceText,
        displayText: normalizeLearnedInstructionLine(formatValue(sourceText)),
      }))
      .filter((line) => line.displayText.length > 0)
      .filter((line) => isRenderableLearnedInstructionLine(line.displayText))
      .filter((line) => {
        const key = line.displayText.toLowerCase();

        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .map((line) => ({
        ...line,
        normalizedKey: line.displayText.toLowerCase(),
      }));

    return lines.length > 0 ? { field, label, lines } : null;
  };

  return [
    buildSection(
      "navigationGuidance",
      "Best entry paths",
      artifact.navigationGuidance,
    ),
    buildSection(
      "searchGuidance",
      "Search and filters",
      artifact.searchGuidance,
    ),
    buildSection(
      "detailGuidance",
      "Job detail behavior",
      artifact.detailGuidance,
    ),
    buildSection("applyGuidance", "Apply behavior", artifact.applyGuidance),
    buildSection(
      "warnings",
      "Warnings",
      artifact.warnings,
      (warning) => `Warning: ${warning}`,
    ),
  ].filter((section): section is LearnedInstructionSection => section !== null);
}

export function normalizeEditableInstructionInput(
  field: LearnedInstructionField,
  value: string,
): string {
  const trimmed = value.trim();

  if (field === "warnings") {
    return trimmed.replace(/^warning:\s*/i, "").trim();
  }

  return trimmed;
}

export function hasValidAbsoluteStartingUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value.trim());
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

export function updateArtifactInstructionSection(
  artifact: SourceInstructionArtifact,
  field: LearnedInstructionField,
  normalizedKey: string,
  nextValue: string | null,
): EditableSourceInstructionArtifact {
  const currentValues = [...artifact[field]];
  const replacement =
    nextValue === null
      ? null
      : normalizeEditableInstructionInput(field, nextValue);
  const nextValues = currentValues.flatMap((value) => {
    const valueKey = normalizeLearnedInstructionLine(
      field === "warnings" ? `Warning: ${value}` : value,
    ).toLowerCase();

    if (valueKey !== normalizedKey) {
      return [value];
    }

    return replacement ? [replacement] : [];
  });

  return {
    ...artifact,
    [field]: nextValues,
  };
}
