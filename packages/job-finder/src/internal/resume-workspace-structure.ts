import {
  filterCandidateFacingResumeKeywords,
  type TailoredResumeDraft,
} from "@nestor/ai-providers";
import type {
  CandidateProfile,
  ResumeRenderDocument,
  ResumeDraft,
  ResumeDraftBullet,
  ResumeDraftOrigin,
  ResumeDraftSection,
  ResumeResearchArtifact,
  ResumeDraftSourceRef,
  ResumeTemplateId,
  SavedJob,
  TailoredAsset,
  TailoredResumeCoverageMetadata,
  WorkHistoryReviewAcknowledgment,
} from "@nestor/contracts";
import {
  ResumeDraftSchema,
  buildResumeDraftIdentity,
  buildResumeContactItems,
  buildResumeRenderHeader,
} from "@nestor/contracts";
export { buildResumeDraftIdentity } from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";
import {
  createBullet,
  createEntry,
  createSection,
  createSourceRef,
  safeSnippet,
} from "./resume-workspace-primitives";
import {
  normalizeResumeDraftSectionEntryOrdering,
  normalizeResumeDraftEntryOrdering,
  orderEntriesNewestFirst,
} from "./resume-entry-ordering";
import { projectWorkHistoryReviewSuggestionIdentities } from "./resume-work-history-review-identity";
import { buildJobContextText } from "./resume-workspace-primitives";
import { normalizeText, uniqueStrings } from "./shared";

function joinCompact(
  parts: ReadonlyArray<string | null | undefined>,
  separator: string,
): string | null {
  const values = parts.filter((value): value is string =>
    Boolean(value && value.trim()),
  );
  return values.length > 0 ? values.join(separator) : null;
}

/** "BA (Hons) Graphic Design" already names its field; it is not repeated. */
function formatDegreeLine(
  degree: string | null | undefined,
  fieldOfStudy: string | null | undefined,
): string | null {
  const field = fieldOfStudy?.trim() ?? "";
  const named =
    field.length > 0 &&
    (degree ?? "").toLowerCase().includes(field.toLowerCase());
  return joinCompact([degree, named ? null : field], ", ");
}

/**
 * Mirrors the canonical generated-class origin set used by resume claim
 * assessment: content produced by generation or assistant edits is
 * generated-class and carries a stamped normalized-content hash, while
 * genuinely imported or user-authored content stays unstamped (null).
 */
const generatedClassResumeOrigins: readonly ResumeDraftOrigin[] = [
  "ai_generated",
  "assistant_edited",
  "deterministic_fallback",
];

export function isGeneratedClassResumeOrigin(
  origin: ResumeDraftOrigin,
): boolean {
  return generatedClassResumeOrigins.includes(origin);
}

/**
 * Stamps `lastGeneratedContentHash` as `fnv1a32(normalizeText(text))` for
 * generated-class bullets so confirmation gating can bind confirmations to
 * the exact normalized claim text that generation produced. User-authored and
 * imported bullets are returned untouched (hash stays null/default).
 */
export function stampGeneratedBulletContentHash(
  bullet: ResumeDraftBullet,
): ResumeDraftBullet {
  if (!isGeneratedClassResumeOrigin(bullet.origin)) {
    return bullet;
  }

  return {
    ...bullet,
    lastGeneratedContentHash: fnv1a32(normalizeText(bullet.text)),
  };
}

/**
 * Applies the generated-bullet stamp across a section list, covering both
 * section-level bullets and entry bullets, without touching any other
 * metadata.
 */
export function stampGeneratedSectionBulletHashes(
  sections: readonly ResumeDraftSection[],
): ResumeDraftSection[] {
  return sections.map((section) => ({
    ...section,
    bullets: section.bullets.map(stampGeneratedBulletContentHash),
    entries: section.entries.map((entry) => ({
      ...entry,
      bullets: entry.bullets.map(stampGeneratedBulletContentHash),
    })),
  }));
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

// A listing title only becomes the resume headline when it reads like a
// role. Board marketing ("FULL TIME: Software Engineer Position - React and
// Rest", "URGENT hiring…") printed as the candidate's headline on an exported
// PDF was the single worst defect a blind auditor found.
const POLLUTED_JOB_TITLE_PATTERN =
  /^(?:full|part)[\s-]?time\b|\b(?:urgent|hiring|immediate(?:ly)?|apply|now|position|opening|vacanc(?:y|ies)|wanted|needed|asap)\b|[:!|#()[\]]|\$|\d{2,}|\bhr\b|\bper\s+(?:hour|year)\b/iu;

export function looksLikeCleanRoleTitle(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 60 &&
    !POLLUTED_JOB_TITLE_PATTERN.test(trimmed) &&
    trimmed.split(/\s+/u).length <= 7
  );
}

// The headline names who the candidate is, not what the posting is called.
// Two HR graders, a coach and a UX auditor independently flagged posting
// titles in the identity block as seniority or function misrepresentation
// ("Staff Software Development Engineer SDM" for a senior engineer, an
// employer's team name bolted on). The per-job policy in Resume approaches
// can still opt into a tailored headline explicitly.
function buildJobTargetedHeadline(
  profile: CandidateProfile,
  job: SavedJob,
): string | null {
  const ownHeadline = profile.headline?.trim();
  if (ownHeadline) {
    return ownHeadline;
  }

  const jobTitle = job.title.trim();
  return jobTitle && looksLikeCleanRoleTitle(jobTitle) ? jobTitle : null;
}

function pickProjectLink(
  project: CandidateProfile["projects"][number] | null | undefined,
): string | null {
  return (
    normalizeUrl(project?.caseStudyUrl) ??
    normalizeUrl(project?.projectUrl) ??
    normalizeUrl(project?.repositoryUrl)
  );
}

function formatProjectSummary(input: {
  summary: string | null | undefined;
  outcome: string | null | undefined;
  skills: readonly string[] | undefined;
}): string | null {
  return joinCompact(
    [
      joinCompact([input.summary, input.outcome], " "),
      input.skills && input.skills.length > 0
        ? `Technologies: ${uniqueStrings(input.skills).join(", ")}.`
        : null,
    ],
    " ",
  );
}

/**
 * A degree that ends after today is still under way: "Expected May 2027"
 * says so where a bare future date reads as a mistake.
 */
function formatEducationDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  now = new Date(),
): string | null {
  const range = formatDateRange(start, end);
  const endMatch = /^(\d{4})(?:-(\d{2}))?/u.exec(end?.trim() ?? "");
  if (!range || !endMatch) return range;
  const year = Number(endMatch[1]);
  const month = Number(endMatch[2] ?? 12);
  const endsLater =
    year > now.getFullYear() ||
    (year === now.getFullYear() && month > now.getMonth() + 1);
  if (!endsLater) return range;
  const parts = range.split(" – ");
  parts[parts.length - 1] = `Expected ${parts.at(-1)}`;
  return parts.join(" – ");
}

function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
  isCurrent?: boolean,
): string | null {
  const formatMonthYear = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      return null;
    }

    if (/^(present|current)$/i.test(trimmed)) {
      return "Present";
    }

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
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

    const yearMonthMatch = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(trimmed);
    const monthYearSlashMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
    const dayMonthYearSlashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
      trimmed,
    );
    const namedMonthMatch = /^([a-zA-Z]+)\.?\s+(\d{4})$/.exec(trimmed);

    if (/^\d{4}$/.test(trimmed)) {
      return trimmed;
    }

    const formatByMonth = (monthNumber: number, year: string) => {
      const month = monthNames[monthNumber - 1];
      return month ? `${month} ${year}` : null;
    };

    if (yearMonthMatch) {
      return formatByMonth(Number(yearMonthMatch[2]), yearMonthMatch[1] ?? "");
    }

    if (monthYearSlashMatch) {
      return formatByMonth(
        Number(monthYearSlashMatch[1]),
        monthYearSlashMatch[2] ?? "",
      );
    }

    if (dayMonthYearSlashMatch) {
      const firstToken = dayMonthYearSlashMatch[1] ?? "";
      const secondToken = dayMonthYearSlashMatch[2] ?? "";
      const firstGroup = Number(firstToken);
      const secondGroup = Number(secondToken);
      const month =
        firstGroup > 12
          ? secondGroup
          : secondGroup > 12
            ? firstGroup
            : firstToken.length === 2 && secondToken.length === 2
              ? secondGroup
              : firstGroup;
      return formatByMonth(month, dayMonthYearSlashMatch[3] ?? "");
    }

    if (namedMonthMatch) {
      const month =
        monthByName[namedMonthMatch[1]?.toLowerCase() ?? ""] ?? null;
      return month ? formatByMonth(month, namedMonthMatch[2] ?? "") : trimmed;
    }

    return trimmed;
  };

  const from = formatMonthYear(start);
  const to = isCurrent ? "Present" : formatMonthYear(end);

  if (from && to) {
    return `${from} – ${to}`;
  }

  return from ?? to ?? null;
}

function parseResumeDatePart(value: string | null | undefined): string | null {
  const normalized = formatDateRange(value, null);
  const trimmed = normalized?.trim() ?? "";

  if (!trimmed) {
    return null;
  }

  return /^(?:[A-Z][a-z]{2}\s+\d{4}|\d{4}|Present)$/.test(trimmed)
    ? trimmed
    : null;
}

function isPlausibleResumeDateRange(value: string | null | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }

  const parts = trimmed.split(/\s*[–—]\s*|\s+-\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return Boolean(
      parseResumeDatePart(parts[0]) && parseResumeDatePart(parts[1]),
    );
  }

  return Boolean(parseResumeDatePart(trimmed));
}

function parseResumeDateRange(value: string | null | undefined): {
  endDate: string | null;
  isCurrent: boolean;
  startDate: string | null;
} {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return { endDate: null, isCurrent: false, startDate: null };
  }

  const parts = trimmed.split(/\s*[–—]\s*|\s+-\s+/).filter(Boolean);
  const startPart = parts[0] ?? trimmed;
  const endPart = parts.length >= 2 ? (parts.at(-1) ?? null) : null;
  const endIsCurrent = Boolean(
    endPart && /^(present|current)$/i.test(endPart.trim()),
  );

  return {
    startDate: parseResumeDatePart(startPart),
    endDate: endIsCurrent ? null : parseResumeDatePart(endPart),
    isCurrent: endIsCurrent,
  };
}

function formatEntryDateRange(
  entry: {
    dateRange?: string | null;
    endDate?: string | null;
    isCurrent?: boolean;
    startDate?: string | null;
  },
  preferDisplayedDate = false,
): string | null {
  if (preferDisplayedDate && entry.dateRange) return entry.dateRange;
  return (
    formatDateRange(entry.startDate, entry.endDate, entry.isCurrent) ??
    entry.dateRange ??
    null
  );
}

function toSectionPreviewLines(
  section: ResumeDraftSection,
  preferDisplayedDate = false,
): string[] {
  const lines: string[] = [];
  const orderedSection = normalizeResumeDraftSectionEntryOrdering(section);

  if (orderedSection.text?.trim()) {
    lines.push(orderedSection.text.trim());
  }

  for (const entry of orderedSection.entries
    .filter((item) => item.included)
    .sort((left, right) => left.sortOrder - right.sortOrder)) {
    const entryDateRange = formatEntryDateRange(entry, preferDisplayedDate);
    const heading = joinCompact(
      [
        joinCompact([entry.title, entry.subtitle], " — "),
        joinCompact([entry.location, entryDateRange], " · "),
      ],
      " · ",
    );

    if (heading) {
      lines.push(heading);
    }

    if (entry.summary?.trim()) {
      lines.push(entry.summary.trim());
    }

    lines.push(
      ...entry.bullets
        .filter((bullet) => bullet.included)
        .map((bullet) => bullet.text.trim())
        .filter(Boolean),
    );
  }

  lines.push(
    ...orderedSection.bullets
      .filter((bullet) => bullet.included)
      .map((bullet) => bullet.text.trim())
      .filter(Boolean),
  );

  return lines;
}

export type {
  ResumeRenderDocument,
  ResumeRenderSection,
  ResumeRenderSectionEntry,
} from "@nestor/contracts";

export interface ResumeRenderOptions {
  includePreviewAnchors?: boolean;
}

function buildCoreAndAdditionalSkills(
  profile: Pick<CandidateProfile, "skills" | "skillGroups"> | null | undefined,
  draftSkills: readonly string[],
) {
  const allSkills = uniqueStrings([
    ...draftSkills,
    ...(profile?.skills ?? []),
    ...(profile?.skillGroups.coreSkills ?? []),
    ...(profile?.skillGroups.tools ?? []),
    ...(profile?.skillGroups.languagesAndFrameworks ?? []),
  ]);

  return {
    coreSkills: uniqueStrings(draftSkills),
    additionalSkills: allSkills.filter(
      (skill) =>
        !new Set(
          uniqueStrings(draftSkills).map((entry) => normalizeText(entry)),
        ).has(normalizeText(skill)),
    ),
  };
}

// Imported resume text can be much longer than the first source-ref preview.
// Keep a bounded set of word-packed refs so downstream evidence panels can
// still locate later facts without copying the raw document into every draft.
const RESUME_EVIDENCE_SNIPPET_LENGTH = 220;
const MAX_RESUME_EVIDENCE_REFS = 24;
const MAX_PROFILE_PROVENANCE_REFS = 24;

function splitBoundedEvidenceText(value: string): string[] {
  const chunks: string[] = [];

  for (const line of value.split(/\r?\n+/)) {
    let current = "";
    for (const token of line.trim().split(/\s+/).filter(Boolean)) {
      let remaining = token;
      while (remaining.length > RESUME_EVIDENCE_SNIPPET_LENGTH) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(remaining.slice(0, RESUME_EVIDENCE_SNIPPET_LENGTH));
        remaining = remaining.slice(RESUME_EVIDENCE_SNIPPET_LENGTH);
      }

      if (!remaining) {
        continue;
      }
      const candidate = current ? `${current} ${remaining}` : remaining;
      if (candidate.length > RESUME_EVIDENCE_SNIPPET_LENGTH) {
        chunks.push(current);
        current = remaining;
      } else {
        current = candidate;
      }
    }
    if (current) {
      chunks.push(current);
    }
  }

  return uniqueStrings(chunks);
}

function buildBoundedSourceRefs(
  sourceKind: ResumeDraftSourceRef["sourceKind"],
  sourceId: string,
  values: readonly (string | null | undefined)[],
  maxRefs: number,
): ResumeDraftSourceRef[] {
  return uniqueStrings(
    values.flatMap((value) => (value ? splitBoundedEvidenceText(value) : [])),
  )
    .slice(0, maxRefs)
    .flatMap((snippet) => {
      const boundedSnippet = safeSnippet(snippet);
      return boundedSnippet
        ? [createSourceRef(sourceKind, sourceId, boundedSnippet)]
        : [];
    });
}

function buildProfileSummarySourceRefs(
  profile: CandidateProfile | undefined,
): ResumeDraftSourceRef[] {
  if (!profile) {
    return [];
  }

  return buildBoundedSourceRefs(
    "profile",
    `profile:${profile.id}:summary`,
    [
      profile.headline,
      profile.summary,
      profile.professionalSummary.shortValueProposition,
      profile.professionalSummary.fullSummary,
      ...profile.professionalSummary.careerThemes,
      profile.professionalSummary.leadershipSummary,
      profile.professionalSummary.domainFocusSummary,
      ...profile.professionalSummary.strengths,
      profile.narrative.professionalStory,
      profile.narrative.nextChapterSummary,
      profile.narrative.careerTransitionSummary,
      ...profile.narrative.differentiators,
      ...profile.experiences.flatMap((experience) => [
        experience.summary,
        ...experience.achievements,
      ]),
      ...profile.projects.flatMap((project) => [
        project.summary,
        project.outcome,
      ]),
    ],
    MAX_PROFILE_PROVENANCE_REFS,
  );
}

function buildProfileSkillSourceRefs(
  profile: CandidateProfile | undefined,
): ResumeDraftSourceRef[] {
  if (!profile) {
    return [];
  }

  return buildBoundedSourceRefs(
    "profile",
    `profile:${profile.id}:skills`,
    [
      ...profile.skills,
      ...profile.skillGroups.coreSkills,
      ...profile.skillGroups.tools,
      ...profile.skillGroups.languagesAndFrameworks,
      ...profile.skillGroups.softSkills,
      ...profile.skillGroups.highlightedSkills,
      ...profile.experiences.flatMap((experience) => experience.skills),
      ...profile.projects.flatMap((project) => project.skills),
      ...profile.spokenLanguages.flatMap((language) => [
        language.language,
        language.proficiency,
        language.notes,
      ]),
    ],
    MAX_PROFILE_PROVENANCE_REFS,
  );
}

function selectCanonicalDateRange(input: {
  profileDateRange: string | null;
  generatedDateRange: string | null | undefined;
}): string | null {
  if (input.profileDateRange) {
    return input.profileDateRange;
  }

  return isPlausibleResumeDateRange(input.generatedDateRange)
    ? (input.generatedDateRange?.trim() ?? null)
    : null;
}

function tokenizeResumeDetail(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isProfessionalResumeSummary(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }

  const normalized = normalizeText(trimmed);
  const hasFirstPersonVoice = /\b(?:i|i'm|i've|me|my|mine)\b/i.test(trimmed);
  const hasCareerChangeMeta =
    /\b(?:decid(?:e|ed|ing)|passion|return(?:ed|ing)?|transition(?:ed|ing)?\s+back)\b/i.test(
      trimmed,
    );
  const isLocationOnly =
    /^(?:remote|hybrid|onsite|on-site)(?:(?:\s+in)|\s*,)?\s*[a-z\s,-]+$/i.test(
      trimmed,
    );

  return Boolean(
    normalized &&
    !isLocationOnly &&
    !(hasFirstPersonVoice && hasCareerChangeMeta),
  );
}

function isWeakGeneratedSummary(input: {
  generated: string | null | undefined;
  title: string | null | undefined;
  subtitle: string | null | undefined;
  location: string | null | undefined;
  dateRange: string | null | undefined;
}): boolean {
  const generated = input.generated?.trim() ?? "";
  if (!isProfessionalResumeSummary(generated)) {
    return true;
  }

  const tokens = tokenizeResumeDetail(generated);
  if (tokens.length < 6) {
    return true;
  }

  const normalizedGenerated = normalizeText(generated);
  const metadataValues = [
    input.title,
    input.subtitle,
    input.location,
    input.dateRange,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeText(value));
  const combinedMetadataTokens = new Set(
    metadataValues.flatMap((value) => tokenizeResumeDetail(value)),
  );
  const repeatsMetadataOnly =
    tokens.length <= 10 &&
    tokens.every((token) => combinedMetadataTokens.has(token));

  return metadataValues.includes(normalizedGenerated) || repeatsMetadataOnly;
}

function selectEntrySummary(input: {
  generated: string | null | undefined;
  profile: string | null | undefined;
  title: string | null | undefined;
  subtitle: string | null | undefined;
  location: string | null | undefined;
  dateRange: string | null | undefined;
}): string | null {
  const generatedCandidate = input.generated?.trim() || null;
  const profileCandidate = input.profile?.trim() || null;
  const generated = isProfessionalResumeSummary(generatedCandidate)
    ? generatedCandidate
    : null;
  const profile = isProfessionalResumeSummary(profileCandidate)
    ? profileCandidate
    : null;

  if (!profile) {
    return generated;
  }

  if (isWeakGeneratedSummary({ ...input, generated })) {
    return profile;
  }

  return generated;
}

/** Source IDs carry the model's restatements across languages; no wording guess. */
function mergeExperienceBullets(input: {
  entryId: string;
  recordId: string | null;
  tailored: readonly string[];
  sourceIds: readonly string[][] | undefined;
  source: readonly string[];
  updatedAt: string;
  origin: ResumeDraftOrigin;
  sharedRefs: readonly ResumeDraftSourceRef[];
}): ResumeDraftBullet[] {
  const sources = input.source.map((text, index) => ({
    id: `experience:${input.recordId}:achievement:${index}`,
    text,
    index,
  }));
  const covered = new Set<string>();
  const lines = input.tailored.flatMap((text, index) => {
    const refs = sources.filter(
      (source) =>
        input.sourceIds?.[index]?.includes(source.id) ||
        source.text.trim() === text.trim(),
    );
    // Keep source facts once. A partly overlapping combined line is dropped;
    // its uncovered facts are retained below and reach the language writer.
    if (refs.some((source) => covered.has(source.id))) return [];
    refs.forEach((source) => covered.add(source.id));
    return [{ text, refs }];
  });
  // Every saved achievement stays on the draft. The ones the writer chose are
  // shown; the rest are kept hidden for the person to show again, so a long
  // history does not push every resume past its page target.
  const shownCount = lines.length;
  lines.push(
    ...sources
      .filter((source) => !covered.has(source.id))
      .map((source) => ({
        text: source.text,
        refs: [source],
      })),
  );
  return lines.map(({ text, refs }, index) => {
    const bullet = createBullet(
      refs[0]
        ? `${input.entryId}_achievement_${refs[0].index}`
        : `${input.entryId}_bullet_${index + 1}`,
      text,
      input.updatedAt,
      input.origin,
      [
        ...input.sharedRefs,
        ...refs.map((source) =>
          createSourceRef("profile", source.id, source.text),
        ),
      ],
    );
    return shownCount > 0 && index >= shownCount
      ? { ...bullet, included: false }
      : bullet;
  });
}

function resolveCoverageMetadataByRecordId(draft: TailoredResumeDraft) {
  return new Map(
    draft.coverageMetadata.map((metadata) => [
      metadata.profileRecordId,
      metadata,
    ]),
  );
}

function buildDraftSectionsFromStructuredTailoredDraft(input: {
  createdAt: string;
  draft: TailoredResumeDraft;
  origin: ResumeDraftOrigin;
  profile: CandidateProfile | undefined;
  sharedRefs: readonly ResumeDraftSourceRef[];
  importedResumeEvidenceRefs?: readonly ResumeDraftSourceRef[];
}): ResumeDraftSection[] {
  const {
    createdAt,
    draft,
    origin,
    profile,
    sharedRefs,
    importedResumeEvidenceRefs = [],
  } = input;
  const summarySourceRefs = [
    ...sharedRefs,
    ...importedResumeEvidenceRefs,
    ...buildProfileSummarySourceRefs(profile),
  ];
  const skillSourceRefs = [
    ...sharedRefs,
    ...buildProfileSkillSourceRefs(profile),
  ];
  const draftSkills = buildCoreAndAdditionalSkills(profile, draft.coreSkills);
  const candidateFacingTargetedKeywords = filterCandidateFacingResumeKeywords(
    draft.targetedKeywords,
  );
  const coverageMetadataByRecordId = resolveCoverageMetadataByRecordId(draft);
  const sections: ResumeDraftSection[] = [];

  sections.push(
    createSection({
      id: "section_summary",
      kind: "summary",
      label: "Summary",
      // The person's own summary stands in for one the generator did not
      // write. Basics promises generated resumes start from it.
      text: draft.summary?.trim() ? draft.summary : (profile?.summary ?? null),
      // A target role, preferred location, or tool list describes the search
      // request, not the candidate. Keep thin generations visibly thin until
      // grounded evidence is available instead of turning those fields into
      // candidate claims.
      bullets: [],
      updatedAt: createdAt,
      origin,
      sortOrder: 0,
      sourceRefs: summarySourceRefs,
    }),
  );

  const visibleExperienceEntries = draft.experienceEntries.map(
    (entry, index) => {
      const profileExperience = entry.profileRecordId
        ? profile?.experiences.find(
            (experience) => experience.id === entry.profileRecordId,
          )
        : null;
      const profileDateRange = profileExperience
        ? formatDateRange(
            profileExperience.startDate,
            profileExperience.endDate,
            profileExperience.isCurrent,
          )
        : null;
      const canonicalDateRange = selectCanonicalDateRange({
        profileDateRange,
        generatedDateRange: entry.dateRange,
      });
      const generatedDates = parseResumeDateRange(entry.dateRange);
      const canonicalTitle = profileExperience
        ? profileExperience.title
        : entry.title;
      const canonicalEmployer = profileExperience
        ? profileExperience.companyName
        : entry.employer;
      const canonicalLocation = profileExperience
        ? profileExperience.location
        : (entry.location ?? null);
      const createdEntry = createEntry({
        id: entry.profileRecordId
          ? `experience_${entry.profileRecordId}`
          : `experience_entry_${index + 1}`,
        entryType: "experience",
        title: canonicalTitle,
        subtitle: canonicalEmployer,
        location: canonicalLocation,
        dateRange: canonicalDateRange,
        startDate: profileExperience?.startDate ?? generatedDates.startDate,
        endDate: profileExperience?.endDate ?? generatedDates.endDate,
        isCurrent: profileExperience?.isCurrent ?? generatedDates.isCurrent,
        summary: selectEntrySummary({
          generated: entry.summary,
          profile: profileExperience?.summary,
          title: canonicalTitle,
          subtitle: canonicalEmployer,
          location: canonicalLocation,
          dateRange: canonicalDateRange ?? entry.dateRange,
        }),
        bullets: [],
        updatedAt: createdAt,
        origin,
        sortOrder: index,
        profileRecordId: entry.profileRecordId,
        sourceRefs: sharedRefs,
      });
      createdEntry.bullets = mergeExperienceBullets({
        entryId: createdEntry.id,
        recordId: entry.profileRecordId,
        tailored: entry.bullets,
        sourceIds: entry.bulletSourceAchievementIds,
        source: profileExperience?.achievements ?? [],
        updatedAt: createdAt,
        origin,
        sharedRefs,
      });
      const coverage = entry.profileRecordId
        ? coverageMetadataByRecordId.get(entry.profileRecordId)
        : null;

      return coverage?.classification === "suggested_hidden"
        ? { ...createdEntry, included: false }
        : createdEntry;
    },
  );
  const visibleExperienceRecordIds = new Set(
    visibleExperienceEntries
      .map((entry) => entry.profileRecordId)
      .filter((value): value is string => Boolean(value)),
  );
  const hiddenProfileEntries = (profile?.experiences ?? [])
    .filter((experience) => !visibleExperienceRecordIds.has(experience.id))
    .map((profileExperience, index) => {
      const entryId = `experience_${profileExperience.id}`;
      return {
        ...createEntry({
          id: `experience_${profileExperience.id}`,
          entryType: "experience",
          title: profileExperience.title,
          subtitle: profileExperience.companyName,
          location: profileExperience.location,
          dateRange: formatDateRange(
            profileExperience.startDate,
            profileExperience.endDate,
            profileExperience.isCurrent,
          ),
          startDate: profileExperience.startDate,
          endDate: profileExperience.endDate,
          isCurrent: profileExperience.isCurrent,
          summary: profileExperience.summary,
          bullets: profileExperience.achievements,
          updatedAt: createdAt,
          origin,
          sortOrder: visibleExperienceEntries.length + index,
          profileRecordId: profileExperience.id,
          sourceRefs: sharedRefs,
        }),
        bullets: mergeExperienceBullets({
          entryId,
          recordId: profileExperience.id,
          tailored: [],
          sourceIds: undefined,
          source: profileExperience.achievements,
          updatedAt: createdAt,
          origin,
          sharedRefs,
        }),
        included: !["suggested_hidden", "omitted"].includes(
          coverageMetadataByRecordId.get(profileExperience.id)
            ?.classification ?? "",
        ),
      };
    });
  const experienceEntries = orderEntriesNewestFirst([
    ...visibleExperienceEntries,
    ...hiddenProfileEntries,
  ]);

  if (experienceEntries.length > 0 || draft.experienceHighlights.length > 0) {
    sections.push(
      createSection({
        id: "section_experience",
        kind: "experience",
        label: "Experience",
        bullets: draft.experienceHighlights,
        entries: experienceEntries,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: sharedRefs,
      }),
    );
  }

  if (draftSkills.coreSkills.length > 0) {
    sections.push(
      createSection({
        id: "section_skills",
        kind: "skills",
        label: "Core Skills",
        bullets: draftSkills.coreSkills,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: skillSourceRefs,
      }),
    );
  }

  const projectEntries = orderEntriesNewestFirst(
    draft.projectEntries.map((entry, index) => {
      const profileProject = profile?.projects.find(
        (project) => project.id === entry.profileRecordId,
      );

      return createEntry({
        id: entry.profileRecordId
          ? `project_${entry.profileRecordId}`
          : `project_entry_${index + 1}`,
        entryType: "project",
        title: entry.name,
        subtitle: entry.role,
        location: pickProjectLink(profileProject),
        startDate: null,
        endDate: null,
        isCurrent: false,
        summary: formatProjectSummary({
          summary: entry.summary,
          outcome: entry.outcome,
          skills: profileProject?.skills,
        }),
        bullets: entry.bullets,
        updatedAt: createdAt,
        origin,
        sortOrder: index,
        profileRecordId: entry.profileRecordId,
        sourceRefs: sharedRefs,
      });
    }),
  );

  if (projectEntries.length > 0) {
    sections.push(
      createSection({
        id: "section_projects",
        kind: "projects",
        label: "Projects",
        entries: projectEntries,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: sharedRefs,
      }),
    );
  }

  const educationEntries = orderEntriesNewestFirst(
    draft.educationEntries.map((entry, index) => {
      const profileEducation = entry.profileRecordId
        ? profile?.education.find(
            (education) => education.id === entry.profileRecordId,
          )
        : null;
      const profileDateRange = profileEducation
        ? formatEducationDateRange(
            profileEducation.startDate,
            profileEducation.endDate,
          )
        : null;
      const parsedDates = parseResumeDateRange(entry.dateRange);
      return createEntry({
        id: entry.profileRecordId
          ? `education_${entry.profileRecordId}`
          : `education_entry_${index + 1}`,
        entryType: "education",
        title: entry.school,
        subtitle: formatDegreeLine(entry.degree, entry.fieldOfStudy),
        location: entry.location,
        dateRange: selectCanonicalDateRange({
          profileDateRange,
          generatedDateRange: entry.dateRange,
        }),
        startDate: profileEducation
          ? profileEducation.startDate
          : parsedDates.endDate || parsedDates.isCurrent
            ? parsedDates.startDate
            : null,
        endDate: profileEducation
          ? profileEducation.endDate
          : (parsedDates.endDate ?? parsedDates.startDate),
        isCurrent: parsedDates.isCurrent,
        summary: entry.summary,
        updatedAt: createdAt,
        origin,
        sortOrder: index,
        profileRecordId: entry.profileRecordId,
        sourceRefs: sharedRefs,
      });
    }),
  );

  if (educationEntries.length > 0) {
    sections.push(
      createSection({
        id: "section_education",
        kind: "education",
        label: "Education",
        entries: educationEntries,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: sharedRefs,
      }),
    );
  }

  const certificationEntries = orderEntriesNewestFirst(
    draft.certificationEntries.map((entry, index) => {
      const profileCertification = entry.profileRecordId
        ? profile?.certifications.find(
            (certification) => certification.id === entry.profileRecordId,
          )
        : null;
      const profileDateRange = profileCertification
        ? formatDateRange(
            profileCertification.issueDate,
            profileCertification.expiryDate,
          )
        : null;
      const parsedDates = parseResumeDateRange(entry.dateRange);
      return createEntry({
        id: entry.profileRecordId
          ? `certification_${entry.profileRecordId}`
          : `certification_entry_${index + 1}`,
        entryType: "certification",
        title: entry.name,
        subtitle: entry.issuer,
        dateRange: selectCanonicalDateRange({
          profileDateRange,
          generatedDateRange: entry.dateRange,
        }),
        startDate: profileCertification?.issueDate ?? parsedDates.startDate,
        endDate: profileCertification?.expiryDate ?? parsedDates.endDate,
        isCurrent: parsedDates.isCurrent,
        updatedAt: createdAt,
        origin,
        sortOrder: index,
        profileRecordId: entry.profileRecordId,
        sourceRefs: sharedRefs,
      });
    }),
  );

  if (certificationEntries.length > 0) {
    sections.push(
      createSection({
        id: "section_certifications",
        kind: "certifications",
        label: "Certifications",
        entries: certificationEntries,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: sharedRefs,
      }),
    );
  }

  const additionalSkills = uniqueStrings([
    ...draft.additionalSkills,
    ...draftSkills.additionalSkills,
  ]);
  if (additionalSkills.length > 0) {
    // Every saved skill stays visible. Hiding the ones the writer did not pick
    // removed real languages and frameworks from the export, especially in
    // Aggressive where the writer chooses harder. The cap keeps a very long
    // skills list from crowding the page; the person's own skills come first.
    const visibleAdditionalSkills = additionalSkills.slice(0, 30);
    sections.push(
      createSection({
        id: "section_additional_skills",
        kind: "skills",
        label: "Additional Skills",
        bullets: visibleAdditionalSkills,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: skillSourceRefs,
      }),
    );
  }

  const languages = profile?.spokenLanguages.length
    ? profile.spokenLanguages
        .map((language) =>
          joinCompact([language.language, language.proficiency], " — "),
        )
        .filter((value): value is string => Boolean(value))
    : draft.languages;
  if (languages.length > 0) {
    const languageSection = createSection({
      id: "section_languages",
      kind: "skills",
      label: "Languages",
      bullets: uniqueStrings(languages),
      updatedAt: createdAt,
      origin,
      sortOrder: sections.length,
      sourceRefs: skillSourceRefs,
    });
    languageSection.bullets.forEach((bullet, index) => {
      const language = profile?.spokenLanguages[index];
      if (language)
        bullet.sourceRefs.push(
          createSourceRef("profile", `language:${language.id}`, bullet.text),
        );
    });
    sections.push(languageSection);
  }

  if (candidateFacingTargetedKeywords.length > 0) {
    sections.push({
      ...createSection({
        id: "section_keywords",
        kind: "keywords",
        label: "Targeted Keywords",
        bullets: candidateFacingTargetedKeywords,
        updatedAt: createdAt,
        origin,
        sortOrder: sections.length,
        sourceRefs: sharedRefs,
      }),
      included: false,
    });
  }

  return stampGeneratedSectionBulletHashes(
    sections.filter(
      (section) =>
        Boolean(section.text) ||
        section.bullets.length > 0 ||
        section.entries.length > 0,
    ),
  );
}

export function buildPreviewSectionsFromResumeDraft(
  draft: ResumeDraft,
): Array<{ heading: string; lines: string[] }> {
  const orderedDraft = normalizeResumeDraftEntryOrdering(draft);

  return [...orderedDraft.sections]
    .filter((section) => section.included)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((section) => ({
      heading: section.label,
      lines: toSectionPreviewLines(section, Boolean(draft.writtenLanguage)),
    }))
    .filter((section) => section.lines.length > 0);
}

export function buildTailoredResumeTextFromResumeDraft(
  profile: CandidateProfile,
  job: SavedJob,
  draft: ResumeDraft,
): string {
  const identity = draft.identity ?? buildResumeDraftIdentity(profile);
  const sections = buildPreviewSectionsFromResumeDraft(draft)
    .map((section) => `${section.heading}\n${section.lines.join("\n")}`)
    .join("\n\n");

  return [
    identity.fullName ?? profile.fullName,
    identity.headline ?? profile.headline,
    joinCompact(
      [
        identity.location,
        ...buildResumeContactItems(identity).map((item) => item.text),
      ],
      " | ",
    ),
    "",
    `${job.title} at ${job.company}`,
    "",
    sections,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");
}

export function buildResumeRenderDocument(
  profile: CandidateProfile,
  draft: ResumeDraft,
  options?: ResumeRenderOptions,
): ResumeRenderDocument {
  const orderedDraft = normalizeResumeDraftEntryOrdering(draft);
  const includePreviewAnchors = options?.includePreviewAnchors ?? false;

  return {
    ...buildResumeRenderHeader(profile, orderedDraft),
    ...(includePreviewAnchors ? { includePreviewAnchors } : {}),
    sections: [...orderedDraft.sections]
      .filter((section) => section.included)
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((section) => ({
        id: section.id,
        kind: section.kind,
        label: section.label,
        text: section.text?.trim() || null,
        bullets: section.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) => ({
            id: bullet.id,
            text: bullet.text.trim(),
          }))
          .filter((bullet) => Boolean(bullet.text)),
        entries: section.entries
          .filter((entry) => entry.included)
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map((entry) => {
            const dateRange = formatEntryDateRange(
              entry,
              Boolean(draft.writtenLanguage),
            );

            return {
              id: entry.id,
              title: entry.title?.trim() || null,
              subtitle: entry.subtitle?.trim() || null,
              location: entry.location?.trim() || null,
              dateRange,
              startDate: entry.startDate?.trim() || null,
              endDate: entry.endDate?.trim() || null,
              isCurrent: entry.isCurrent,
              heading: joinCompact(
                [
                  joinCompact([entry.title, entry.subtitle], " — "),
                  joinCompact([entry.location, dateRange], " · "),
                ],
                " · ",
              ),
              summary: entry.summary?.trim() || null,
              bullets: entry.bullets
                .filter((bullet) => bullet.included)
                .map((bullet) => ({
                  id: bullet.id,
                  text: bullet.text.trim(),
                }))
                .filter((bullet) => Boolean(bullet.text)),
            };
          }),
      }))
      .filter(
        (section) =>
          Boolean(section.text) ||
          section.bullets.length > 0 ||
          section.entries.length > 0,
      ),
  };
}

/**
 * Keeps prior work-history review acknowledgments alive across a full resume
 * regeneration. An acknowledgment survives only when it still exactly matches
 * a freshly projected suggestion identity — the same field set
 * `matchWorkHistoryReviewAcknowledgment` requires (draft, profile record,
 * kind, action, and the FNV-1a hash of the exact canonical message) — so
 * unchanged omissions stay acknowledged while changed or removed suggestions
 * reset to unacknowledged and re-enter the review gate.
 */
function carryForwardWorkHistoryReviewAcknowledgments(input: {
  nextDraftId: string;
  coverageMetadata: readonly TailoredResumeCoverageMetadata[];
  previousAcknowledgments: readonly WorkHistoryReviewAcknowledgment[];
}): WorkHistoryReviewAcknowledgment[] {
  if (input.previousAcknowledgments.length === 0) {
    return [];
  }

  const freshIdentities = projectWorkHistoryReviewSuggestionIdentities(
    input.coverageMetadata,
  );

  return input.previousAcknowledgments.filter((acknowledgment) =>
    freshIdentities.some(
      (identity) =>
        acknowledgment.draftId === input.nextDraftId &&
        acknowledgment.profileRecordId === identity.profileRecordId &&
        acknowledgment.kind === identity.kind &&
        acknowledgment.action === identity.action &&
        acknowledgment.messageContentHash === identity.messageContentHash,
    ),
  );
}

export function buildResumeDraftFromTailoredDraft(input: {
  job: SavedJob;
  templateId: ResumeTemplateId;
  draft: TailoredResumeDraft;
  createdAt: string;
  updatedAt?: string;
  existingDraftId?: string | null;
  generationMethod: ResumeDraft["generationMethod"];
  profile?: CandidateProfile;
  research?: readonly ResumeResearchArtifact[];
  headline?: string | null | undefined;
  previousWorkHistoryReviewAcknowledgments?: readonly WorkHistoryReviewAcknowledgment[];
}): ResumeDraft {
  const {
    createdAt,
    draft,
    existingDraftId,
    generationMethod,
    job,
    templateId,
  } = input;
  const updatedAt = input.updatedAt ?? createdAt;
  const jobRef = createSourceRef(
    "job",
    job.id,
    safeSnippet(job.description || job.summary || buildJobContextText(job)),
  );
  const importedResumeEvidenceRefs = input.profile?.baseResume.textContent
    ? buildBoundedSourceRefs(
        "resume",
        input.profile.baseResume.id,
        [input.profile.baseResume.textContent],
        MAX_RESUME_EVIDENCE_REFS,
      )
    : [];
  const resumeRef = importedResumeEvidenceRefs[0] ?? null;
  const firstResearch =
    input.research?.find((artifact) => artifact.fetchStatus === "success") ??
    null;
  const researchRef = firstResearch
    ? createSourceRef(
        "research",
        firstResearch.id,
        safeSnippet(firstResearch.companyNotes),
      )
    : null;
  const sharedRefs = [jobRef, resumeRef, researchRef].filter(
    (value): value is ResumeDraftSourceRef => value !== null,
  );
  const origin =
    generationMethod === "ai" ? "ai_generated" : "deterministic_fallback";
  const nextDraftId = existingDraftId ?? `resume_draft_${job.id}`;
  const workHistoryReviewAcknowledgments =
    carryForwardWorkHistoryReviewAcknowledgments({
      nextDraftId,
      coverageMetadata: draft.coverageMetadata,
      previousAcknowledgments:
        input.previousWorkHistoryReviewAcknowledgments ?? [],
    });

  return ResumeDraftSchema.parse(
    normalizeResumeDraftEntryOrdering({
      id: nextDraftId,
      jobId: job.id,
      status: "needs_review",
      templateId,
      identity: input.profile
        ? {
            ...buildResumeDraftIdentity(input.profile),
            headline:
              input.headline === undefined
                ? buildJobTargetedHeadline(input.profile, job)
                : input.headline,
          }
        : null,
      sections: buildDraftSectionsFromStructuredTailoredDraft({
        createdAt: updatedAt,
        draft,
        origin,
        profile: input.profile,
        sharedRefs,
        importedResumeEvidenceRefs: importedResumeEvidenceRefs.slice(1),
      }),
      targetPageCount: (input.profile?.yearsExperience ?? 0) >= 5 ? 2 : 1,
      generationMethod,
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments,
      claimConfirmations: [],
      issueApprovals: [],
      createdAt,
      updatedAt,
    }),
  );
}

function hasStructuredProfileResumeEvidence(
  profile: CandidateProfile,
): boolean {
  return [
    profile.experiences,
    profile.projects,
    profile.education,
    profile.certifications,
  ].some((records) => records.length > 0);
}

export function seedResumeDraft(input: {
  profile: CandidateProfile;
  job: SavedJob;
  templateId: ResumeTemplateId;
  tailoredAsset?: TailoredAsset | null;
}): ResumeDraft {
  const now = input.tailoredAsset?.updatedAt ?? new Date().toISOString();
  const tailoredAsset = input.tailoredAsset;

  // Preview sections are a legacy flat projection and carry no record
  // boundaries. Once structured profile records exist, rebuild from those
  // canonical records so edits and review decisions retain their IDs. A
  // preview-only profile may still be shown, but remains explicitly review
  // pending and is blocked by validation until it is grounded.
  if (
    tailoredAsset?.previewSections.length &&
    !hasStructuredProfileResumeEvidence(input.profile)
  ) {
    const seededSections = tailoredAsset.previewSections
      .map((section, index) => {
        const normalizedHeading = normalizeText(section.heading);
        const kind = normalizedHeading.includes("skill")
          ? "skills"
          : normalizedHeading.includes("project")
            ? "projects"
            : normalizedHeading.includes("education")
              ? "education"
              : normalizedHeading.includes("certification")
                ? "certifications"
                : normalizedHeading.includes("keyword")
                  ? "keywords"
                  : normalizedHeading.includes("summary")
                    ? "summary"
                    : "experience";
        const seededSection = createSection({
          id: `section_seeded_${normalizeText(section.heading).replaceAll(" ", "_") || index + 1}`,
          kind,
          label: section.heading,
          text: normalizedHeading.includes("summary")
            ? (section.lines[0] ?? null)
            : null,
          bullets: normalizedHeading.includes("summary")
            ? section.lines.slice(1)
            : section.lines,
          updatedAt: now,
          origin:
            tailoredAsset.generationMethod === "ai_assisted"
              ? "ai_generated"
              : "deterministic_fallback",
          sortOrder: index,
        });
        return kind === "keywords"
          ? { ...seededSection, included: false }
          : seededSection;
      })
      .filter((section) => section.text || section.bullets.length > 0);

    if (seededSections.length > 0) {
      return ResumeDraftSchema.parse(
        normalizeResumeDraftEntryOrdering({
          id: `resume_draft_${input.job.id}`,
          jobId: input.job.id,
          status: "needs_review",
          templateId: input.templateId,
          identity: buildResumeDraftIdentity(input.profile),
          sections: stampGeneratedSectionBulletHashes(seededSections),
          targetPageCount: 1,
          generationMethod:
            tailoredAsset.generationMethod === "ai_assisted"
              ? "ai"
              : "deterministic",
          approvedAt: null,
          approvedExportId: null,
          staleReason: null,
          workHistoryReviewAcknowledgments: [],
          claimConfirmations: [],
          issueApprovals: [],
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
  }

  const coreSkills = uniqueStrings([
    ...input.profile.skills,
    ...input.profile.skillGroups.coreSkills,
    ...input.profile.skillGroups.tools,
  ]).slice(0, 10);
  const additionalSkills = uniqueStrings([
    ...input.profile.skillGroups.languagesAndFrameworks,
    ...input.profile.skillGroups.highlightedSkills,
  ]).filter(
    (skill) =>
      !coreSkills.some(
        (coreSkill) => normalizeText(coreSkill) === normalizeText(skill),
      ),
  );
  const experienceEntries = orderEntriesNewestFirst(
    input.profile.experiences
      .filter((record) => !record.isDraft)
      .map((experience, index) =>
        createEntry({
          id: `experience_${experience.id}`,
          entryType: "experience",
          title: experience.title,
          subtitle: experience.companyName,
          location: experience.location,
          dateRange: formatDateRange(
            experience.startDate,
            experience.endDate,
            experience.isCurrent,
          ),
          startDate: experience.startDate,
          endDate: experience.endDate,
          isCurrent: experience.isCurrent,
          summary: experience.summary,
          bullets: experience.achievements,
          updatedAt: now,
          origin: "imported",
          sortOrder: index,
          profileRecordId: experience.id,
        }),
      ),
  );
  const projectEntries = orderEntriesNewestFirst(
    input.profile.projects.map((project, index) =>
      createEntry({
        id: `project_${project.id}`,
        entryType: "project",
        title: project.name,
        subtitle: project.role,
        location: pickProjectLink(project),
        startDate: null,
        endDate: null,
        isCurrent: false,
        summary: formatProjectSummary({
          summary: project.summary,
          outcome: project.outcome,
          skills: project.skills,
        }),
        bullets: [],
        updatedAt: now,
        origin: "imported",
        sortOrder: index,
        profileRecordId: project.id,
      }),
    ),
  );
  const educationEntries = orderEntriesNewestFirst(
    input.profile.education
      .filter((record) => !record.isDraft)
      .map((education, index) =>
        createEntry({
          id: `education_${education.id}`,
          entryType: "education",
          title: education.schoolName,
          subtitle: formatDegreeLine(education.degree, education.fieldOfStudy),
          location: education.location,
          dateRange: formatEducationDateRange(
            education.startDate,
            education.endDate,
          ),
          startDate: education.startDate,
          endDate: education.endDate,
          isCurrent: false,
          summary: education.summary,
          updatedAt: now,
          origin: "imported",
          sortOrder: index,
          profileRecordId: education.id,
        }),
      ),
  );
  const certificationEntries = orderEntriesNewestFirst(
    input.profile.certifications
      .filter((record) => !record.isDraft)
      .map((certification, index) =>
        createEntry({
          id: `certification_${index + 1}`,
          entryType: "certification",
          title: certification.name,
          subtitle: certification.issuer,
          dateRange: formatDateRange(
            certification.issueDate,
            certification.expiryDate,
          ),
          startDate: certification.issueDate,
          endDate: certification.expiryDate,
          isCurrent: false,
          updatedAt: now,
          origin: "imported",
          sortOrder: index,
          profileRecordId: certification.id,
        }),
      ),
  );
  const summaryText =
    input.profile.professionalSummary.fullSummary ??
    input.profile.summary ??
    null;

  return ResumeDraftSchema.parse(
    normalizeResumeDraftEntryOrdering({
      id: `resume_draft_${input.job.id}`,
      jobId: input.job.id,
      status: "draft",
      templateId: input.templateId,
      identity: buildResumeDraftIdentity(input.profile),
      sections: [
        createSection({
          id: "section_summary",
          kind: "summary",
          label: "Summary",
          text: summaryText,
          updatedAt: now,
          origin: "imported",
          sortOrder: 0,
        }),
        createSection({
          id: "section_experience",
          kind: "experience",
          label: "Experience",
          entries: experienceEntries,
          updatedAt: now,
          origin: "imported",
          sortOrder: 1,
        }),
        createSection({
          id: "section_skills",
          kind: "skills",
          label: "Core Skills",
          bullets: coreSkills,
          updatedAt: now,
          origin: "imported",
          sortOrder: 2,
        }),
        ...(projectEntries.length > 0
          ? [
              createSection({
                id: "section_projects",
                kind: "projects",
                label: "Projects",
                entries: projectEntries,
                updatedAt: now,
                origin: "imported",
                sortOrder: 3,
              }),
            ]
          : []),
        ...(educationEntries.length > 0
          ? [
              createSection({
                id: "section_education",
                kind: "education",
                label: "Education",
                entries: educationEntries,
                updatedAt: now,
                origin: "imported",
                sortOrder: 4,
              }),
            ]
          : []),
        ...(certificationEntries.length > 0
          ? [
              createSection({
                id: "section_certifications",
                kind: "certifications",
                label: "Certifications",
                entries: certificationEntries,
                updatedAt: now,
                origin: "imported",
                sortOrder: 5,
              }),
            ]
          : []),
        ...(additionalSkills.length > 0
          ? [
              createSection({
                id: "section_additional_skills",
                kind: "skills",
                label: "Additional Skills",
                bullets: additionalSkills,
                updatedAt: now,
                origin: "imported",
                sortOrder: 6,
              }),
            ]
          : []),
        ...(input.profile.spokenLanguages.length > 0
          ? [
              createSection({
                id: "section_languages",
                kind: "skills",
                label: "Languages",
                bullets: input.profile.spokenLanguages
                  .map(
                    (language) =>
                      joinCompact(
                        [language.language, language.proficiency],
                        " — ",
                      ) ??
                      language.language ??
                      "",
                  )
                  .filter(Boolean),
                updatedAt: now,
                origin: "imported",
                sortOrder: 7,
              }),
            ]
          : []),
      ].filter(
        (section) =>
          Boolean(section.text) ||
          section.bullets.length > 0 ||
          section.entries.length > 0,
      ),
      targetPageCount: 1,
      generationMethod: "manual",
      approvedAt: null,
      approvedExportId: null,
      staleReason: null,
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      createdAt: now,
      updatedAt: now,
    }),
  );
}
