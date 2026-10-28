import type {
  CandidateProfile,
  JobSearchPreferences,
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
} from "@nestor/contracts";

/** Fill gaps with quoted resume facts as proposals; never save inferred goals. */
const EXPERIENCE_HEADING =
  /^(?:(?:work|professional|relevant|employment|career|industry)\s+)?(?:experience|history|background)$/iu;
const OTHER_SECTION_HEADING =
  /^(?:summary|profile|skills?|education|certifications?|projects?|languages?|awards?|publications?|references|interests?)\b/iu;
const ROLE_HEADER = /^(.{2,80}?)\s+[-–—]\s+(.{2,80})$/u;
const DATE_RANGE =
  /^((?:[A-Za-z]+\s+)?\d{4}|\d{1,2}\/\d{4})\s*[-–—]\s*((?:[A-Za-z]+\s+)?\d{4}|\d{1,2}\/\d{4}|present|current)$/iu;
const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

function normalizeRoleKey(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function parseResumeDate(value: string): {
  date: string | null;
  current: boolean;
} {
  const trimmed = value.trim();
  if (/^(?:present|current|now)$/iu.test(trimmed)) {
    return { date: null, current: true };
  }
  const monthYear = /^([A-Za-z]+)\s+(\d{4})$/u.exec(trimmed);
  if (monthYear) {
    const month = MONTHS[monthYear[1]!.toLowerCase()];
    return { date: month ? `${monthYear[2]}-${month}` : monthYear[2]!, current: false };
  }
  const numericMonth = /^(\d{1,2})\/(\d{4})$/u.exec(trimmed);
  if (numericMonth) {
    return {
      date: `${numericMonth[2]}-${numericMonth[1]!.padStart(2, "0")}`,
      current: false,
    };
  }
  return { date: trimmed, current: false };
}

function sourceLines(bundle: ResumeDocumentBundle): string[] {
  const text =
    bundle.fullText?.trim() ||
    bundle.blocks
      .slice()
      .sort((left, right) => left.readingOrder - right.readingOrder)
      .map((block) => block.text)
      .join("\n");
  return text.split(/\r?\n/u).map((line) => line.trim());
}

function blockIdsFor(
  bundle: ResumeDocumentBundle,
  texts: readonly string[],
): string[] {
  const wanted = texts
    .map((text) => text.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  return bundle.blocks
    .filter((block) =>
      wanted.some((text) => block.text.replace(/\s+/gu, " ").includes(text)),
    )
    .map((block) => block.id);
}

/**
 * The model sometimes stops after the most recent roles. A plain resume with
 * explicit "Title - Employer" headers and date lines can be read directly, so
 * the missing older roles become review candidates instead of disappearing.
 */
function suggestMissingExperienceRoles(input: {
  profile: CandidateProfile;
  bundle: ResumeDocumentBundle;
  candidates: readonly ResumeImportFieldCandidate[];
}): ResumeImportFieldCandidate[] {
  const lines = sourceLines(input.bundle);
  const start = lines.findIndex((line) => EXPERIENCE_HEADING.test(line));
  if (start === -1) return [];
  const end = lines.findIndex(
    (line, index) => index > start && OTHER_SECTION_HEADING.test(line),
  );
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const known = new Set(
    [
      ...input.profile.experiences.map(
        (experience) =>
          `${normalizeRoleKey(experience.title ?? "")}|${normalizeRoleKey(
            experience.companyName ?? "",
          )}`,
      ),
      ...input.candidates.flatMap((candidate) => {
        const value = candidate.value;
        if (
          candidate.target.section !== "experience" ||
          candidate.target.key !== "record" ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          return [];
        }
        const record = value as { title?: unknown; companyName?: unknown };
        return [
          `${normalizeRoleKey(
            typeof record.title === "string" ? record.title : "",
          )}|${normalizeRoleKey(
            typeof record.companyName === "string" ? record.companyName : "",
          )}`,
        ];
      }),
    ].filter((key) => !key.startsWith("|")),
  );

  const suggestions: ResumeImportFieldCandidate[] = [];
  for (let index = 0; index < section.length; index += 1) {
    const header = section[index]!;
    if (/^[-•*]/u.test(header) || DATE_RANGE.test(header)) continue;
    const match = ROLE_HEADER.exec(header);
    if (!match) continue;
    const dateLine = section[index + 1];
    const dates = dateLine ? DATE_RANGE.exec(dateLine) : null;
    if (!dates) continue;
    const title = match[1]!.trim();
    const companyName = match[2]!.trim();
    const key = `${normalizeRoleKey(title)}|${normalizeRoleKey(companyName)}`;
    if (known.has(key)) continue;
    known.add(key);
    const startDate = parseResumeDate(dates[1]!);
    const endDate = parseResumeDate(dates[2]!);
    const achievements: string[] = [];
    for (let bulletIndex = index + 2; bulletIndex < section.length; bulletIndex += 1) {
      const line = section[bulletIndex]!;
      if (ROLE_HEADER.test(line) && DATE_RANGE.test(section[bulletIndex + 1] ?? "")) {
        break;
      }
      const bullet = /^[-•*]\s*(.+)$/u.exec(line)?.[1]?.trim();
      if (bullet) achievements.push(bullet);
    }
    const value = {
      title,
      companyName,
      startDate: startDate.date,
      endDate: endDate.date,
      isCurrent: endDate.current,
      summary: null,
      achievements,
      skills: [],
      domainTags: [],
    };
    const evidenceText = [header, dateLine, ...achievements].join("\n");
    const id = `resume_import_suggested_experience_${suggestions.length + 1}`;
    suggestions.push({
      id,
      runId: input.candidates[0]?.runId ?? "resume_import_completeness",
      target: {
        section: "experience",
        key: "record",
        recordId: `experience_suggested_${suggestions.length + 1}`,
      },
      label: "Work history",
      sourceKind: "parser_literal",
      value,
      normalizedValue: value,
      valuePreview: `${title} at ${companyName}`,
      evidenceText,
      sourceBlockIds: blockIdsFor(input.bundle, [header, dateLine ?? ""]),
      confidence: 0.72,
      notes: [
        "Added from the resume text because the import missed this role. Review and edit before using.",
      ],
      alternatives: [],
      conflictChoices: [],
      visualEvidence: [],
      resolution: "needs_review",
      resolutionReason: "grounded_completeness_suggestion",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
  }
  return suggestions;
}

export function completeResumeImport(input: {
  profile: CandidateProfile;
  preferences: JobSearchPreferences;
  bundle: ResumeDocumentBundle;
  candidates: ResumeImportFieldCandidate[];
}): { candidates: ResumeImportFieldCandidate[]; warnings: string[] } {
  const candidates = [...input.candidates];
  const warnings: string[] = [];
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const source = normalize(input.bundle.fullText ?? "");
  const usable = (candidate: ResumeImportFieldCandidate) =>
    !["rejected", "abstained"].includes(candidate.resolution);
  const has = (section: string, key: string) =>
    candidates.some(
      (candidate) =>
        candidate.target.section === section &&
        candidate.target.key === key &&
        usable(candidate) &&
        (typeof candidate.value === "string"
          ? Boolean(candidate.value.trim())
          : Array.isArray(candidate.value) && candidate.value.length > 0),
    );
  const role = candidates.find((candidate) => {
    if (
      candidate.target.section !== "experience" ||
      candidate.target.key !== "record" ||
      !usable(candidate)
    )
      return false;
    const value = candidate.value;
    return (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.title === "string" &&
      value.title.trim() &&
      source.includes(normalize(value.title))
    );
  });
  const value = role?.value;
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const title = typeof record?.title === "string" ? record.title.trim() : null;
  const quoted = (text: unknown) =>
    typeof text === "string" && text.trim() && source.includes(normalize(text))
      ? text.trim()
      : null;
  const company = quoted(record?.companyName);
  const summary =
    quoted(record?.summary) ??
    (title ? `${title}${company ? ` at ${company}` : ""}.` : null);
  function suggest(
    section: "identity" | "search_preferences",
    key: string,
    proposed: string | string[] | null,
    label: string,
  ) {
    if (has(section, key)) return;
    // A person's earlier rejection is final for this import, including a
    // background visual pass or a cached replay of the same candidates.
    if (
      candidates.some(
        (candidate) =>
          candidate.target.section === section &&
          candidate.target.key === key &&
          candidate.resolution === "rejected" &&
          candidate.resolvedAt,
      )
    )
      return;
    if (!role || !proposed) {
      warnings.push(
        key === "headline"
          ? "Headline is required. Add one in Basics; the resume did not provide enough evidence to suggest one."
          : `Add ${label.toLowerCase()}; the resume did not provide enough evidence to suggest it.`,
      );
      return;
    }
    candidates.push({
      ...role,
      id: `${role.id}_suggested_${key}`,
      target: { section, key, recordId: null },
      label,
      value: proposed,
      normalizedValue: proposed,
      valuePreview: Array.isArray(proposed) ? proposed.join(", ") : proposed,
      resolution: "needs_review",
      resolutionReason: "grounded_completeness_suggestion",
      resolvedAt: null,
      notes: [
        "Suggested from your resume's work history. Review and edit before using; this does not assume your next role.",
      ],
      alternatives: [],
      conflictChoices: [],
    });
  }
  if (!input.profile.headline?.trim())
    suggest("identity", "headline", title, "Headline");
  if (!input.profile.summary?.trim())
    suggest("identity", "summary", summary, "Summary");
  if (
    !input.preferences.targetRoles.length &&
    !input.profile.targetRoles.length
  )
    suggest(
      "search_preferences",
      "targetRoles",
      title ? [title] : null,
      "Target roles",
    );
  const missingRoles = suggestMissingExperienceRoles({
    profile: input.profile,
    bundle: input.bundle,
    candidates,
  });
  if (missingRoles.length > 0) {
    candidates.push(...missingRoles);
    warnings.push(
      `${missingRoles.length} older role${missingRoles.length === 1 ? "" : "s"} in your resume were added for review because the import missed ${missingRoles.length === 1 ? "it" : "them"}.`,
    );
  }
  return { candidates, warnings };
}
