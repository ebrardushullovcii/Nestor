import type {
  ResumeDraftBullet,
  ResumeDraftEntry,
  ResumeDraftSection,
  ResumeDraftSourceRef,
  SavedJob,
} from "@nestor/contracts";
import { createUniqueId, normalizeText, uniqueStrings } from "./shared";

export function createBullet(
  id: string,
  text: string,
  updatedAt: string,
  origin: ResumeDraftBullet["origin"],
  sourceRefs: readonly ResumeDraftSourceRef[] = [],
): ResumeDraftBullet {
  return {
    id,
    text,
    origin,
    locked: false,
    included: true,
    sourceRefs: [...sourceRefs],
    lastGeneratedContentHash: null,
    updatedAt,
  };
}

export function toSectionKind(label: string): ResumeDraftSection["kind"] {
  const normalized = normalizeText(label);

  if (/\bskill(s)?\b/.test(normalized)) {
    return "skills";
  }

  if (/\bproject(s)?\b/.test(normalized)) {
    return "projects";
  }

  if (normalized.includes("keyword")) {
    return "keywords";
  }

  if (normalized.includes("certification")) {
    return "certifications";
  }

  if (normalized.includes("education")) {
    return "education";
  }

  if (normalized.includes("summary")) {
    return "summary";
  }

  return "experience";
}

export function createSection(
  input: {
    id: string;
    kind: ResumeDraftSection["kind"];
    label: string;
    text?: string | null;
    bullets?: readonly string[];
    entries?: readonly ResumeDraftEntry[];
    updatedAt: string;
    origin: ResumeDraftSection["origin"];
    sortOrder: number;
    sourceRefs?: readonly ResumeDraftSourceRef[];
  },
): ResumeDraftSection {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    text: normalizeNullableText(input.text),
    bullets: dedupeLongResumeLines(input.bullets ?? []).map((bullet, index) =>
      createBullet(
        `${input.id}_bullet_${index + 1}`,
        bullet,
        input.updatedAt,
        input.origin,
        input.sourceRefs ?? [],
      ),
    ),
    entries: [...(input.entries ?? [])],
    origin: input.origin,
    locked: false,
    included: true,
    sortOrder: input.sortOrder,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [...(input.sourceRefs ?? [])],
    updatedAt: input.updatedAt,
  };
}

export function createSourceRef(
  sourceKind: ResumeDraftSourceRef["sourceKind"],
  sourceId: string | null,
  snippet: string | null,
): ResumeDraftSourceRef {
  return {
    id: createUniqueId("resume_source"),
    sourceKind,
    sourceId,
    snippet,
  };
}

export function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeText(value).split(" ").filter(Boolean));
}

function tokenOverlap(leftTokens: Set<string>, rightTokens: Set<string>): number {
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let matched = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      matched += 1;
    }
  }

  return matched / Math.min(leftTokens.size, rightTokens.size);
}

function dedupeLongResumeLines(lines: readonly string[]): string[] {
  const kept: Array<{ text: string; tokens: Set<string> }> = [];

  for (const line of uniqueStrings(lines)) {
    const candidateTokens = tokenSet(line);
    const tokenCount = candidateTokens.size;
    const duplicatesExisting = tokenCount >= 7 && kept.some((existing) => {
      const existingTokenCount = existing.tokens.size;
      return existingTokenCount >= 7 && tokenOverlap(candidateTokens, existing.tokens) >= 0.62;
    });

    if (!duplicatesExisting) {
      kept.push({ text: line, tokens: candidateTokens });
    }
  }

  return kept.map((entry) => entry.text);
}

export function createEntry(input: {
  id: string;
  entryType: ResumeDraftEntry["entryType"];
  title?: string | null;
  subtitle?: string | null;
  location?: string | null;
  dateRange?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  summary?: string | null;
  bullets?: readonly string[];
  updatedAt: string;
  origin: ResumeDraftEntry["origin"];
  sortOrder: number;
  profileRecordId?: string | null;
  sourceRefs?: readonly ResumeDraftSourceRef[];
}): ResumeDraftEntry {
  return {
    id: input.id,
    entryType: input.entryType,
    title: normalizeNullableText(input.title),
    subtitle: normalizeNullableText(input.subtitle),
    location: normalizeNullableText(input.location),
    dateRange: normalizeNullableText(input.dateRange),
    startDate: normalizeNullableText(input.startDate),
    endDate: normalizeNullableText(input.endDate),
    isCurrent: input.isCurrent === true,
    summary: normalizeNullableText(input.summary),
    bullets: dedupeLongResumeLines(input.bullets ?? []).map((bullet, index) =>
      createBullet(
        `${input.id}_bullet_${index + 1}`,
        bullet,
        input.updatedAt,
        input.origin,
        input.sourceRefs ?? [],
      ),
    ),
    origin: input.origin,
    locked: false,
    included: true,
    sortOrder: input.sortOrder,
    profileRecordId: input.profileRecordId ?? null,
    sourceRefs: [...(input.sourceRefs ?? [])],
    updatedAt: input.updatedAt,
  };
}

export function safeSnippet(value: string | null | undefined): string | null {
  const normalized = normalizeNullableText(value);
  return normalized ? normalized.slice(0, 220) : null;
}

export function buildJobContextText(job: SavedJob): string {
  return [
    job.title,
    job.company,
    job.location,
    job.applicationUrl,
    job.summary,
    job.description,
    ...job.keySkills,
    ...job.keywordSignals.map((signal) => signal.label),
    ...job.responsibilities,
    ...job.minimumQualifications,
    ...job.preferredQualifications,
    job.seniority,
    job.employmentType,
    job.department,
    job.team,
    job.salaryText,
    job.screeningHints.sponsorshipText,
    job.screeningHints.relocationText,
    job.screeningHints.travelText,
    ...job.screeningHints.remoteGeographies,
    job.atsProvider,
    ...job.benefits,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildPriorityJobTerms(job: SavedJob): string[] {
  return uniqueStrings([
    ...job.keySkills,
    ...job.keywordSignals.map((signal) => signal.label),
    ...job.responsibilities,
    ...job.minimumQualifications,
    ...job.preferredQualifications,
    ...job.benefits,
    ...job.screeningHints.remoteGeographies,
    ...(job.seniority ? [job.seniority] : []),
    ...(job.employmentType ? [job.employmentType] : []),
    ...(job.department ? [job.department] : []),
    ...(job.team ? [job.team] : []),
    ...(job.atsProvider ? [job.atsProvider] : []),
  ]);
}
