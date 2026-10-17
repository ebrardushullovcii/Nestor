import { ResumeLanguageTranslationSchema } from "@nestor/contracts";
import { buildResumeSkillContextFilter } from "./resume-skill-context";
import {
  TailoredResumeDraftSchema,
  type TailoredResumeDraft,
  type TailoredResumeGenerationProvenance,
} from "./shared";
import {
  buildDeterministicStructuredResumeDraft,
  composeDeterministicFullText,
  uniqueStrings,
  VISIBLE_ADDITIONAL_SKILL_LIMIT,
  VISIBLE_CORE_SKILL_LIMIT,
} from "./deterministic";
import { parseEvidenceLinkedText } from "./resume-generation-grounding";

// Keep this set in sync with the reference-only identifier fields on the
// structured draft payloads validated through TailoredResumeDraftSchema and the
// related draft entry contracts in packages/contracts/src/resume.ts.
const REFERENCE_ONLY_KEYS = new Set([
  "profileRecordId",
  "sourceId",
  "id",
  "draftId",
  "recordId",
]);

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function sanitizeStructuredEntries<TEntry extends Record<string, unknown>>(
  value: unknown,
  requiredArrayKey?: keyof TEntry,
): TEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const normalizedEntry = entry as Record<string, unknown>;

    if (requiredArrayKey) {
      const candidate = normalizedEntry[String(requiredArrayKey)];
      if (candidate !== undefined && !Array.isArray(candidate)) {
        return [];
      }
    }

    // This predicate intentionally treats only user-visible string content as meaningful.
    // Numeric or boolean fields do not currently count here, so revisit this block if
    // TEntry or TailoredResumeDraftSchema starts relying on non-string visible fields.
    const hasMeaningfulContent = Object.entries(normalizedEntry).some(
      ([fieldKey, fieldValue]) => {
        if (REFERENCE_ONLY_KEYS.has(fieldKey)) {
          return false;
        }

        if (typeof fieldValue === "string") {
          return fieldValue.trim().length > 0;
        }

        if (Array.isArray(fieldValue)) {
          return fieldValue.some((item) => {
            if (typeof item === "string") {
              return item.trim().length > 0;
            }

            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return false;
            }

            const normalizedItem = item as Record<string, unknown>;

            return Object.values(normalizedItem).some(
              (nestedValue) =>
                typeof nestedValue === "string" &&
                nestedValue.trim().length > 0,
            );
          });
        }

        return false;
      },
    );

    if (!hasMeaningfulContent) {
      return [];
    }

    return [normalizedEntry as TEntry];
  });
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type FallbackExperienceEntry = TailoredResumeDraft["experienceEntries"][number];

interface CanonicalExperienceEvidence {
  summary: string | null;
  bullets: readonly string[];
}

interface ResumeGenerationQualityAccumulator {
  proposedRewriteCount: number;
  acceptedRewriteCount: number;
  /** Accepted on the model's wording alone, without a matched line of evidence. */
  unverifiedRewriteCount: number;
  rejectedRewriteCount: number;
  acceptedRewriteCharacters: number;
  acceptedInferredRewriteCount: number;
}

/** What one draft completion counts while it keeps the model's lines. */
interface ResumeRewriteContext {
  quality: ResumeGenerationQualityAccumulator;
}

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalizeComparableDatePart(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (/^present$/i.test(trimmed)) {
    return "present";
  }

  if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
  if (yearMonthMatch) {
    const month = Number(yearMonthMatch[2]);
    return month >= 1 && month <= 12
      ? `${yearMonthMatch[1]}-${yearMonthMatch[2]}`
      : null;
  }

  const monthYearSlashMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (monthYearSlashMatch) {
    const month = Number(monthYearSlashMatch[1]);
    return month >= 1 && month <= 12
      ? `${monthYearSlashMatch[2]}-${String(month).padStart(2, "0")}`
      : null;
  }

  const namedMonthMatch = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(trimmed);
  if (namedMonthMatch) {
    const monthByName: Record<string, number> = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      sept: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const month = monthByName[namedMonthMatch[1]?.toLowerCase() ?? ""] ?? null;
    return month
      ? `${namedMonthMatch[2]}-${String(month).padStart(2, "0")}`
      : null;
  }

  return normalizeComparableText(trimmed) || null;
}

function canonicalizeComparableDateRange(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const parts = trimmed
    .split(/\s*[–—]\s*|\s+-\s+/)
    .map((part) => canonicalizeComparableDatePart(part));
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0]}__${parts[1]}`;
  }

  return canonicalizeComparableDatePart(trimmed);
}

function isPlausibleResumeDateRange(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }

  const parts = trimmed
    .split(/\s*[–—]\s*|\s+-\s+/)
    .map((part) => canonicalizeComparableDatePart(part));
  if (parts.length >= 2) {
    return Boolean(parts[0] && parts[1]);
  }

  return Boolean(canonicalizeComparableDatePart(trimmed));
}

function selectCanonicalDateRange(input: {
  fallback: string | null | undefined;
}): string | null {
  if (input.fallback && isPlausibleResumeDateRange(input.fallback)) {
    return input.fallback;
  }

  // Employment dates are candidate identity metadata, not prose. A model may
  // reorder or rewrite supported claims, but it must never fill a missing date
  // from its own output without a field-level evidence contract.
  return null;
}

function findCanonicalProse(
  generated: string | null | undefined,
  canonicalCandidates: readonly string[],
): string | null {
  const normalizedGenerated = normalizeComparableText(generated);
  if (!normalizedGenerated) {
    return null;
  }

  return (
    canonicalCandidates.find((candidate) => {
      const normalizedCandidate = normalizeComparableText(candidate);
      return (
        normalizedCandidate === normalizedGenerated ||
        normalizedCandidate.startsWith(`${normalizedGenerated} `)
      );
    }) ?? null
  );
}

/**
 * The model's line stands as written (ADR 0041). Whether the person's
 * evidence backs it is the fact check's call, made when the draft is
 * previewed and validated; no overlap rule swaps it for the saved wording
 * here. A line the model left out keeps the saved wording.
 */
function selectGroundedResumeText(input: {
  generated: unknown;
  companionEvidenceRefs?: unknown;
  fallback: string | null | undefined;
  canonical: string | null | undefined;
  rewriteContext: ResumeRewriteContext;
  allowedScope?:
    | {
        scope: "experience" | "project";
        profileRecordId: string;
      }
    | undefined;
}): string | null {
  const candidates = uniqueStrings(
    [input.fallback, input.canonical].filter((value): value is string =>
      Boolean(value?.trim()),
    ),
  );
  const parsedGenerated = parseEvidenceLinkedText(
    input.generated,
    input.companionEvidenceRefs,
  );
  const generatedText = parsedGenerated?.text.trim() ?? "";
  if (generatedText && !findCanonicalProse(generatedText, candidates)) {
    input.rewriteContext.quality.proposedRewriteCount += 1;
    input.rewriteContext.quality.acceptedRewriteCount += 1;
    input.rewriteContext.quality.acceptedRewriteCharacters +=
      generatedText.length;
  }
  return (
    (generatedText || null) ??
    normalizeNullableString(input.fallback) ??
    normalizeNullableString(input.canonical)
  );
}

function selectGroundedResumeBullets(
  generatedBullets: unknown,
  generatedBulletEvidenceRefs: unknown,
  fallbackBullets: readonly string[],
  canonicalBullets: readonly string[],
  rewriteContext: ResumeRewriteContext,
  _allowedScope:
    | {
        scope: "experience" | "project";
        profileRecordId: string;
      }
    | undefined,
  maxBullets = 3,
): string[] {
  const canonicalCandidates = uniqueStrings([
    ...fallbackBullets,
    ...canonicalBullets,
  ]);
  const bulletValues = Array.isArray(generatedBullets) ? generatedBullets : [];
  const evidenceRefMatrix = Array.isArray(generatedBulletEvidenceRefs)
    ? generatedBulletEvidenceRefs
    : [];
  const selectedBullets = uniqueStrings(
    bulletValues.flatMap((generatedBullet, index) => {
      const parsedGenerated = parseEvidenceLinkedText(
        generatedBullet,
        evidenceRefMatrix[index],
      );
      const text = parsedGenerated?.text.trim() ?? "";
      if (!text) return [];
      if (!findCanonicalProse(text, canonicalCandidates)) {
        rewriteContext.quality.proposedRewriteCount += 1;
        rewriteContext.quality.acceptedRewriteCount += 1;
        rewriteContext.quality.acceptedRewriteCharacters += text.length;
      }
      return [text];
    }),
  );
  // The model wrote this entry's bullets; the saved ones fill in only when it
  // wrote none.
  return (
    selectedBullets.length > 0
      ? selectedBullets
      : uniqueStrings(fallbackBullets)
  ).slice(0, maxBullets);
}

function selectCanonicalStringList(
  generatedValues: unknown,
  fallbackValues: readonly string[],
): string[] {
  const selectedValues = uniqueStrings(
    sanitizeStringArray(generatedValues).flatMap((generatedValue) => {
      const canonicalValue = findCanonicalProse(generatedValue, fallbackValues);
      return canonicalValue ? [canonicalValue] : [];
    }),
  );

  return selectedValues.length > 0 ? selectedValues : [...fallbackValues];
}

function entryMatchesFallback(
  entry: {
    title?: string | null;
    employer?: string | null;
    dateRange?: string | null;
  },
  fallbackEntry: FallbackExperienceEntry,
): boolean {
  const entryTitle = normalizeComparableText(entry.title);
  const fallbackTitle = normalizeComparableText(fallbackEntry.title);
  const entryEmployer = normalizeComparableText(entry.employer);
  const fallbackEmployer = normalizeComparableText(fallbackEntry.employer);
  const entryDateRange = canonicalizeComparableDateRange(entry.dateRange);
  const fallbackDateRange = canonicalizeComparableDateRange(
    fallbackEntry.dateRange,
  );

  if (
    entryTitle &&
    fallbackTitle &&
    entryEmployer &&
    fallbackEmployer &&
    entryDateRange &&
    fallbackDateRange
  ) {
    return (
      entryTitle === fallbackTitle &&
      entryEmployer === fallbackEmployer &&
      entryDateRange === fallbackDateRange
    );
  }

  if (entryTitle && fallbackTitle && entryEmployer && fallbackEmployer) {
    return entryTitle === fallbackTitle && entryEmployer === fallbackEmployer;
  }

  if (entryTitle && fallbackTitle && entryDateRange && fallbackDateRange) {
    return entryTitle === fallbackTitle && entryDateRange === fallbackDateRange;
  }

  return false;
}

function entryConflictsWithFallback(
  entry: {
    title?: string | null;
    employer?: string | null;
    dateRange?: string | null;
  },
  fallbackEntry: FallbackExperienceEntry,
): boolean {
  const entryTitle = normalizeComparableText(entry.title);
  const fallbackTitle = normalizeComparableText(fallbackEntry.title);
  if (entryTitle && fallbackTitle && entryTitle !== fallbackTitle) {
    return true;
  }

  const entryEmployer = normalizeComparableText(entry.employer);
  const fallbackEmployer = normalizeComparableText(fallbackEntry.employer);
  if (entryEmployer && fallbackEmployer && entryEmployer !== fallbackEmployer) {
    return true;
  }

  const entryDateRange = canonicalizeComparableDateRange(entry.dateRange);
  const fallbackDateRange = canonicalizeComparableDateRange(
    fallbackEntry.dateRange,
  );
  if (
    isPlausibleResumeDateRange(entry.dateRange) &&
    isPlausibleResumeDateRange(fallbackEntry.dateRange) &&
    entryDateRange &&
    fallbackDateRange &&
    entryDateRange !== fallbackDateRange
  ) {
    return true;
  }

  return false;
}

/**
 * The writer decides how much of a role this job needs: the most relevant
 * role can carry more than the built-in three, and the achievements it leaves
 * out stay on the person's draft, hidden.
 */
const WRITER_MAX_BULLETS_PER_ROLE = 6;

/** Record IDs of the roles or projects the writer left off for this job. */
function collectWriterHiddenRecordIds(entries: unknown): Set<string> {
  const hidden = new Set<string>();
  if (!Array.isArray(entries)) return hidden;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { hidden?: unknown; profileRecordId?: unknown };
    if (record.hidden === true && typeof record.profileRecordId === "string") {
      hidden.add(record.profileRecordId.trim());
    }
  }
  return hidden;
}

function normalizeExperienceEntries(
  entries: Array<{
    title?: string | null;
    employer?: string | null;
    location?: string | null;
    dateRange?: string | null;
    summary?: unknown;
    summaryEvidenceRefs?: unknown;
    bullets?: unknown[];
    bulletEvidenceRefs?: unknown;
    profileRecordId?: string | null;
  }>,
  fallbackEntries: ReturnType<
    typeof buildDeterministicStructuredResumeDraft
  >["experienceEntries"],
  canonicalEvidenceByRecordId: ReadonlyMap<string, CanonicalExperienceEvidence>,
  rewriteContext: ResumeRewriteContext,
) {
  const knownFallbackIds = new Set(
    fallbackEntries
      .map((entry) => entry.profileRecordId)
      .filter((value): value is string => Boolean(value)),
  );
  const fallbackEntriesById = new Map(
    fallbackEntries.flatMap((entry) =>
      entry.profileRecordId ? [[entry.profileRecordId, entry] as const] : [],
    ),
  );
  const entriesByFallbackId = new Map<string, (typeof entries)[number]>();
  const usedEntryIndexes = new Set<number>();

  entries.forEach((entry, index) => {
    const entryRecordId = normalizeNullableString(entry.profileRecordId);
    if (!entryRecordId || !knownFallbackIds.has(entryRecordId)) {
      return;
    }

    const fallbackEntry = fallbackEntriesById.get(entryRecordId);
    if (!fallbackEntry || entryConflictsWithFallback(entry, fallbackEntry)) {
      return;
    }

    if (!entriesByFallbackId.has(entryRecordId)) {
      entriesByFallbackId.set(entryRecordId, entry);
      usedEntryIndexes.add(index);
    }
  });

  fallbackEntries.forEach((fallbackEntry) => {
    if (
      !fallbackEntry.profileRecordId ||
      entriesByFallbackId.has(fallbackEntry.profileRecordId)
    ) {
      return;
    }

    const matchedIndex = entries.findIndex((entry, index) => {
      if (usedEntryIndexes.has(index)) {
        return false;
      }

      const entryRecordId = normalizeNullableString(entry.profileRecordId);
      if (entryRecordId && knownFallbackIds.has(entryRecordId)) {
        return false;
      }

      return entryMatchesFallback(entry, fallbackEntry);
    });

    if (matchedIndex >= 0) {
      entriesByFallbackId.set(
        fallbackEntry.profileRecordId,
        entries[matchedIndex]!,
      );
      usedEntryIndexes.add(matchedIndex);
    }
  });

  let nextUnusedEntryIndex = 0;

  return fallbackEntries.map((fallbackEntry, index) => {
    let matchedEntry: (typeof entries)[number] | null;

    if (fallbackEntry.profileRecordId) {
      matchedEntry =
        entriesByFallbackId.get(fallbackEntry.profileRecordId) ?? null;
    } else {
      const directMatch = usedEntryIndexes.has(index)
        ? null
        : (entries[index] ?? null);
      if (directMatch) {
        usedEntryIndexes.add(index);
        matchedEntry = directMatch;
      } else {
        while (
          nextUnusedEntryIndex < entries.length &&
          usedEntryIndexes.has(nextUnusedEntryIndex)
        ) {
          nextUnusedEntryIndex += 1;
        }

        matchedEntry = entries[nextUnusedEntryIndex] ?? null;
        if (matchedEntry) {
          usedEntryIndexes.add(nextUnusedEntryIndex);
          nextUnusedEntryIndex += 1;
        }
      }
    }

    if (!matchedEntry) {
      return fallbackEntry;
    }

    const fallbackDateRange = fallbackEntry.dateRange ?? null;
    const dateRange = selectCanonicalDateRange({
      fallback: fallbackDateRange,
    });
    const canonicalEvidence = fallbackEntry.profileRecordId
      ? canonicalEvidenceByRecordId.get(fallbackEntry.profileRecordId)
      : null;
    const allowedScope = fallbackEntry.profileRecordId
      ? {
          scope: "experience" as const,
          profileRecordId: fallbackEntry.profileRecordId,
        }
      : undefined;
    const bullets = selectGroundedResumeBullets(
      matchedEntry.bullets,
      matchedEntry.bulletEvidenceRefs,
      fallbackEntry.bullets,
      canonicalEvidence?.bullets ?? [],
      rewriteContext,
      allowedScope,
      WRITER_MAX_BULLETS_PER_ROLE,
    );

    return {
      // Identity metadata always comes from the canonical candidate profile.
      // Evidence references currently authorize prose only, so accepting model
      // title, employer, location, or date values here would create an escape
      // hatch around the grounding checks below.
      title: fallbackEntry.title ?? null,
      employer: fallbackEntry.employer ?? null,
      location: fallbackEntry.location ?? null,
      dateRange,
      summary: selectGroundedResumeText({
        generated: matchedEntry.summary,
        companionEvidenceRefs: matchedEntry.summaryEvidenceRefs,
        fallback: fallbackEntry.summary,
        canonical: canonicalEvidence?.summary,
        rewriteContext,
        allowedScope,
      }),
      bullets,
      bulletSourceAchievementIds: bullets.map((text) => {
        const sources = (matchedEntry.bullets ?? []).flatMap((value, index) => {
          const parsed = parseEvidenceLinkedText(
            value,
            Array.isArray(matchedEntry.bulletEvidenceRefs)
              ? matchedEntry.bulletEvidenceRefs[index]
              : undefined,
          );
          return parsed?.text.trim() === text
            ? parsed.sourceAchievementIds
            : [];
        });
        return (canonicalEvidence?.bullets ?? []).flatMap((source, index) => {
          const id = `experience:${fallbackEntry.profileRecordId}:achievement:${index}`;
          return sources.includes(id) || source.trim() === text ? [id] : [];
        });
      }),
      profileRecordId: fallbackEntry.profileRecordId ?? null,
    };
  });
}

type FallbackProjectEntry = TailoredResumeDraft["projectEntries"][number];

function normalizeProjectEntries(
  entries: Array<{
    name?: string | null;
    role?: string | null;
    summary?: unknown;
    summaryEvidenceRefs?: unknown;
    outcome?: unknown;
    outcomeEvidenceRefs?: unknown;
    bullets?: unknown[];
    bulletEvidenceRefs?: unknown;
    profileRecordId?: string | null;
  }>,
  fallbackEntries: readonly FallbackProjectEntry[],
  rewriteContext: ResumeRewriteContext,
): FallbackProjectEntry[] {
  const entriesByProfileRecordId = new Map(
    entries.flatMap((entry) => {
      const profileRecordId = normalizeNullableString(entry.profileRecordId);
      return profileRecordId ? ([[profileRecordId, entry]] as const) : [];
    }),
  );

  return fallbackEntries.map((fallbackEntry) => {
    if (!fallbackEntry.profileRecordId) {
      return fallbackEntry;
    }

    const matchedEntry =
      entriesByProfileRecordId.get(fallbackEntry.profileRecordId) ??
      entries.find(
        (entry) =>
          normalizeComparableText(entry.name) ===
            normalizeComparableText(fallbackEntry.name) &&
          (!entry.role ||
            normalizeComparableText(entry.role) ===
              normalizeComparableText(fallbackEntry.role)),
      );
    if (!matchedEntry) {
      return fallbackEntry;
    }

    const allowedScope = {
      scope: "project" as const,
      profileRecordId: fallbackEntry.profileRecordId,
    };
    return {
      ...fallbackEntry,
      summary: selectGroundedResumeText({
        generated: matchedEntry.summary,
        companionEvidenceRefs: matchedEntry.summaryEvidenceRefs,
        fallback: fallbackEntry.summary,
        canonical: fallbackEntry.summary,
        rewriteContext,
        allowedScope,
      }),
      outcome: selectGroundedResumeText({
        generated: matchedEntry.outcome,
        companionEvidenceRefs: matchedEntry.outcomeEvidenceRefs,
        fallback: fallbackEntry.outcome,
        canonical: fallbackEntry.outcome,
        rewriteContext,
        allowedScope,
      }),
      bullets: selectGroundedResumeBullets(
        matchedEntry.bullets,
        matchedEntry.bulletEvidenceRefs,
        fallbackEntry.bullets,
        uniqueStrings(
          [fallbackEntry.summary, fallbackEntry.outcome].filter(
            (value): value is string => Boolean(value),
          ),
        ),
        rewriteContext,
        allowedScope,
      ),
    };
  });
}

export function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "Unknown error";
}

export function logFallbackError(operation: string, error: unknown): void {
  try {
    console.error(
      `[AI Provider] ${operation} failed. ${summarizeError(error)}`,
    );
  } catch {
    // Logging must never interrupt the caller. This can happen when a
    // detached desktop process outlives its original stdio pipe.
  }
}

export function completeTailoredResumeDraft(
  primary: unknown,
  fallbackInput: Parameters<typeof buildDeterministicStructuredResumeDraft>[0],
) {
  const fallback = buildDeterministicStructuredResumeDraft(fallbackInput);
  const normalizedPrimary =
    primary && typeof primary === "object" && !Array.isArray(primary)
      ? (primary as Record<string, unknown>)
      : {};
  const sanitizedCoreSkills = sanitizeStringArray(normalizedPrimary.coreSkills);
  const sanitizedExperienceEntries = sanitizeStructuredEntries<{
    title?: string | null;
    employer?: string | null;
    location?: string | null;
    dateRange?: string | null;
    summary?: unknown;
    summaryEvidenceRefs?: unknown;
    bullets?: unknown[];
    bulletEvidenceRefs?: unknown;
    profileRecordId?: string | null;
  }>(normalizedPrimary.experienceEntries, "bullets");
  const sanitizedProjectEntries = sanitizeStructuredEntries<{
    name?: string | null;
    role?: string | null;
    summary?: unknown;
    summaryEvidenceRefs?: unknown;
    outcome?: unknown;
    outcomeEvidenceRefs?: unknown;
    bullets?: unknown[];
    bulletEvidenceRefs?: unknown;
    profileRecordId?: string | null;
  }>(normalizedPrimary.projectEntries, "bullets");
  const sanitizedTargetedKeywords = sanitizeStringArray(
    normalizedPrimary.targetedKeywords,
  );
  const sanitizedAdditionalSkills = sanitizeStringArray(
    normalizedPrimary.additionalSkills,
  );
  const quality: ResumeGenerationQualityAccumulator = {
    proposedRewriteCount: 0,
    acceptedRewriteCount: 0,
    unverifiedRewriteCount: 0,
    rejectedRewriteCount: 0,
    acceptedRewriteCharacters: 0,
    acceptedInferredRewriteCount: 0,
  };
  const isCompetency = buildResumeSkillContextFilter(
    fallbackInput.job,
    fallbackInput.profile,
  );
  const rewriteContext: ResumeRewriteContext = { quality };
  const label = fallback.label;
  const summary =
    selectGroundedResumeText({
      generated: normalizedPrimary.summary,
      companionEvidenceRefs: normalizedPrimary.summaryEvidenceRefs,
      fallback: fallback.summary,
      canonical: fallbackInput.profile.summary,
      rewriteContext,
    }) ?? fallback.summary;
  const experienceHighlights = selectGroundedResumeBullets(
    normalizedPrimary.experienceHighlights,
    normalizedPrimary.experienceHighlightEvidenceRefs,
    fallback.experienceHighlights,
    fallback.experienceHighlights,
    rewriteContext,
    undefined,
    Math.max(3, fallback.experienceHighlights.length),
  );
  const coreSkills =
    sanitizedCoreSkills.length > 0 ? sanitizedCoreSkills : fallback.coreSkills;
  // The model's skill lists stand (ADR 0041); a saved strategy can still
  // limit them to the skills it chose. Whether the person's evidence backs a
  // skill the profile does not show is the fact check's call: in aggressive
  // tailoring such a skill becomes a line to confirm.
  const strategyCoreSkills = fallbackInput.strategy
    ? coreSkills.filter((skill) =>
        fallback.coreSkills.some(
          (allowedSkill) => allowedSkill.toLowerCase() === skill.toLowerCase(),
        ),
      )
    : coreSkills;
  const finalCoreSkills = uniqueStrings(strategyCoreSkills)
    .filter(isCompetency)
    .slice(0, VISIBLE_CORE_SKILL_LIMIT);
  const additionalCandidates = fallbackInput.strategy
    ? sanitizedAdditionalSkills.filter((skill) =>
        fallback.additionalSkills.some(
          (allowedSkill) => allowedSkill.toLowerCase() === skill.toLowerCase(),
        ),
      )
    : sanitizedAdditionalSkills.length > 0
      ? sanitizedAdditionalSkills
      : fallback.additionalSkills;
  const targetedKeywords = fallbackInput.strategy
    ? selectCanonicalStringList(
        sanitizedTargetedKeywords.filter((keyword) =>
          fallback.targetedKeywords.some(
            (allowedKeyword) =>
              allowedKeyword.toLowerCase() === keyword.toLowerCase(),
          ),
        ),
        fallback.targetedKeywords,
      )
    : selectCanonicalStringList(
        sanitizedTargetedKeywords,
        fallback.targetedKeywords,
      );
  const groundedAdditionalSkills = uniqueStrings(additionalCandidates)
    .filter(
      (skill) =>
        !finalCoreSkills.some(
          (coreSkill) => coreSkill.toLowerCase() === skill.toLowerCase(),
        ),
    )
    .filter(isCompetency)
    .slice(0, VISIBLE_ADDITIONAL_SKILL_LIMIT);
  const notes = [...fallback.notes];
  const canonicalExperienceEvidenceByRecordId = new Map(
    fallbackInput.profile.experiences.map((experience) => [
      experience.id,
      {
        summary: experience.summary,
        bullets: experience.achievements,
      } satisfies CanonicalExperienceEvidence,
    ]),
  );
  const experienceEntries =
    sanitizedExperienceEntries.length > 0
      ? normalizeExperienceEntries(
          sanitizedExperienceEntries,
          fallback.experienceEntries,
          canonicalExperienceEvidenceByRecordId,
          rewriteContext,
        )
      : fallback.experienceEntries;
  const hiddenProjectIds = collectWriterHiddenRecordIds(
    normalizedPrimary.projectEntries,
  );
  const projectEntries = (
    sanitizedProjectEntries.length > 0
      ? normalizeProjectEntries(
          sanitizedProjectEntries,
          fallback.projectEntries,
          rewriteContext,
        )
      : fallback.projectEntries
  ).filter(
    (entry) =>
      !entry.profileRecordId || !hiddenProjectIds.has(entry.profileRecordId),
  );
  // A role the writer left off stays on the draft, hidden, for the person to
  // show again; it is never removed from the record.
  const hiddenRoleIds = collectWriterHiddenRecordIds(
    normalizedPrimary.experienceEntries,
  );
  const coverageMetadata = fallback.coverageMetadata.map((decision) =>
    hiddenRoleIds.has(decision.profileRecordId) &&
    (decision.classification === "detailed" ||
      decision.classification === "compact")
      ? {
          ...decision,
          classification: "suggested_hidden" as const,
          reasons: [
            ...decision.reasons,
            "The writer left this role off for this job.",
          ],
        }
      : decision,
  );
  const generationProvenance = describeModelDraftProvenance(quality, notes);
  const languages = fallback.languages;
  const fullText = composeDeterministicFullText({
    label,
    summary,
    experienceHighlights,
    coreSkills: finalCoreSkills,
    experienceEntries,
    projectEntries,
    educationEntries: fallback.educationEntries,
    certificationEntries: fallback.certificationEntries,
    additionalSkills: groundedAdditionalSkills,
    languages,
    targetedKeywords,
    notes,
  });

  return TailoredResumeDraftSchema.parse({
    ...fallback,
    languagePresentation:
      "language" in fallbackInput
        ? ResumeLanguageTranslationSchema.parse(
            normalizedPrimary.languagePresentation,
          )
        : normalizedPrimary.languagePresentation,
    label,
    summary,
    experienceHighlights,
    coreSkills: finalCoreSkills,
    targetedKeywords,
    coverageMetadata,
    experienceEntries,
    projectEntries,
    educationEntries: fallback.educationEntries,
    certificationEntries: fallback.certificationEntries,
    additionalSkills: groundedAdditionalSkills,
    languages,
    fullText,
    compatibilityScore:
      typeof normalizedPrimary.compatibilityScore === "number"
        ? normalizedPrimary.compatibilityScore
        : fallback.compatibilityScore,
    generationQuality: {
      strategy:
        quality.acceptedRewriteCount > 0 ? "evidence_linked" : "deterministic",
      ...quality,
    },
    generationProvenance,
    notes,
  });
}

const DETERMINISTIC_TAILORER_NOTE =
  "Used the built-in deterministic resume tailorer.";

function describeModelDraftProvenance(
  quality: ResumeGenerationQualityAccumulator,
  notes: string[],
): TailoredResumeGenerationProvenance {
  const accepted = quality.acceptedRewriteCount;
  if (accepted > 0) {
    const deterministicNoteIndex = notes.indexOf(DETERMINISTIC_TAILORER_NOTE);
    if (deterministicNoteIndex >= 0) {
      notes.splice(deterministicNoteIndex, 1);
    }
    const detail = `Created with AI: ${accepted} ${accepted === 1 ? "line" : "lines"} in the model's own wording, each checked against your saved evidence.`;
    notes.unshift(detail);
    return { method: "ai", reason: null, detail };
  }
  const deterministicNoteIndex = notes.indexOf(DETERMINISTIC_TAILORER_NOTE);
  if (deterministicNoteIndex >= 0) {
    notes.splice(deterministicNoteIndex, 1);
  }
  const detail =
    "AI completed the review without proposing wording changes, so your wording stayed unchanged.";
  notes.unshift(detail);
  return { method: "ai", reason: null, detail };
}
