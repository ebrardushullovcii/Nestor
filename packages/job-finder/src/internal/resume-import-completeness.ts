import type {
  CandidateProfile,
  JobSearchPreferences,
  ResumeDocumentBundle,
  ResumeImportFieldCandidate,
} from "@nestor/contracts";

/** Fill gaps with quoted resume facts as proposals; never save inferred goals. */
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
  return { candidates, warnings };
}
