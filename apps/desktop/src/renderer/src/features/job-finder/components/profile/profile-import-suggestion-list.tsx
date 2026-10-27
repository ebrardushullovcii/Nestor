import type { ResumeImportFieldCandidateSummary } from "@nestor/contracts";
import { ChevronDown } from "lucide-react";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { formatStatusLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import { formatProfileSetupReviewValue } from "./setup/profile-setup-screen-helpers";
import { getProfileImportSuggestionDestination } from "./profile-import-suggestion-navigation";

const recordSectionLabels: Partial<
  Record<ResumeImportFieldCandidateSummary["target"]["section"], string>
> = {
  certification: "Certification",
  education: "Education",
  experience: "Work experience",
  language: "Language",
  link: "Professional link",
  project: "Project",
  proof_point: "Proof point",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function titleCaseLabel(label: string): string {
  const normalized = label
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\brecord\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Imported suggestion";
  }

  if (normalized !== normalized.toUpperCase()) {
    return normalized;
  }

  return normalized
    .toLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function findRecordSubject(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of [
    "language",
    "schoolName",
    "title",
    "role",
    "name",
    "companyName",
    "issuer",
    "label",
  ]) {
    const subject = value[key];
    if (typeof subject === "string" && subject.trim()) {
      return subject.trim();
    }
  }

  return null;
}

function getSuggestionTitle(
  candidate: ResumeImportFieldCandidateSummary,
  structuredValue: unknown,
): string {
  if (
    candidate.target.section === "application_identity" &&
    ["preferredLinkUrls", "preferredLinkIds"].includes(candidate.target.key)
  )
    return "Links to include in applications";
  const sectionLabel = recordSectionLabels[candidate.target.section];
  if (!sectionLabel) {
    return titleCaseLabel(candidate.label);
  }

  const subject = findRecordSubject(structuredValue);
  return subject ? `${sectionLabel} · ${subject}` : sectionLabel;
}

function getRawPayload(value: unknown): string | null {
  if (!isRecord(value) && !Array.isArray(value)) {
    return null;
  }

  return JSON.stringify(value, null, 2);
}

export function ProfileImportSuggestionList(props: {
  candidates: readonly ResumeImportFieldCandidateSummary[];
  onReviewCandidate?: (candidate: ResumeImportFieldCandidateSummary) => void;
}) {
  return (
    <div
      aria-label="Imported suggestions waiting for confirmation"
      className="grid gap-2"
    >
      {props.candidates.map((candidate) => {
        const value = parseStructuredValue(
          candidate.value ?? candidate.valuePreview,
        );
        const summary =
          formatProfileSetupReviewValue(value) ??
          candidate.evidenceText?.trim() ??
          "Review this imported suggestion.";
        const rawPayload = getRawPayload(value);
        const destination = getProfileImportSuggestionDestination(candidate);

        return (
          <article
            className="grid gap-2 rounded-(--radius-field) border border-(--surface-well-border) bg-(--surface-well) p-3.5"
            key={candidate.id}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid min-w-0 gap-1">
                <h3 className="font-semibold text-(--text-headline)">
                  {getSuggestionTitle(candidate, value)}
                </h3>
                <p className="text-sm leading-6 text-foreground-soft">
                  {summary}
                </p>
              </div>
              <Badge variant="outline">
                {formatStatusLabel(candidate.resolution)}
              </Badge>
            </div>

            {rawPayload ? (
              <details className="group border-t border-(--surface-panel-border) pt-2 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-foreground-muted">
                  <ChevronDown
                    aria-hidden="true"
                    className="size-3 transition-transform group-open:rotate-180"
                  />
                  View source value
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-(--radius-field) bg-background/70 p-3 text-xs leading-5 text-foreground-muted">
                  {rawPayload}
                </pre>
              </details>
            ) : null}

            {props.onReviewCandidate ? (
              <div className="flex justify-end border-t border-(--surface-panel-border) pt-2">
                <Button
                  aria-label={`${destination.actionLabel}: ${getSuggestionTitle(candidate, value)}`}
                  onClick={() => props.onReviewCandidate?.(candidate)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {destination.actionLabel}
                </Button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
