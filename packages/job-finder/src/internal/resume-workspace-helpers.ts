import { resumeComparisonNeedsRefresh } from "@nestor/contracts";
import {
  resumeFactIsCovered,
  resumeSentences,
} from "./resume-content-comparison";
import {
  buildCandidateSkillBank,
  buildResumeSkillContextFilter,
  isSpokenLanguageResumeChrome,
  looksLikeSpokenLanguageSkillEntry,
  skillsAreEquivalent,
  type ResumeGenerationEvidenceItem,
  type TailoredResumeDraft,
} from "@nestor/ai-providers";
import type { ResumeGenerationStrategyPolicy } from "@nestor/ai-providers";
import {
  ResumeAssistantMessageSchema,
  ResumeDraftRevisionSchema,
  ResumeExportArtifactSchema,
  ResumeCoverageComparisonSchema,
  ResumeValidationResultSchema,
  TailoredAssetSchema,
  applyResumeIssueApprovals,
  matchResumeIssueApproval,
  isBlockingResumeClaimAssessment,
  isBlockingResumeValidationIssue,
  ResumeProposalApprovalBlockerSchema,
  type ResumeProposalApprovalBlocker,
  isGeneratedResumeClaimOrigin as isGeneratedResumeClaimOriginContract,
  type CandidateProfile,
  type ResumeAssistantMessage,
  type ResumeClaimAssessment,
  type ResumeCoverageComparison,
  type ResumeDraft,
  type ResumeDraftBullet,
  type ResumeDraftSourceRef,
  type ResumeDraftPatch,
  type ResumeDraftRevision,
  type ResumeDraftRevisionActor,
  type ResumeDraftRevisionMutationKind,
  type ResumeExportArtifact,
  type ResumeResearchArtifact,
  type ResumeTemplateDefinition,
  type ResumeValidationIssue,
  type ResumeValidationResult,
  type SavedJob,
  type TailoredAsset,
  type WorkHistoryReviewAcknowledgment,
  type WorkHistoryReviewSuggestion,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";
import { createLocalKnowledgeIndex } from "@nestor/knowledge-base";
import {
  createUniqueId,
  normalizeText,
  tokenize,
  uniqueStrings,
} from "./shared";
import {
  buildJobContextText,
  buildPriorityJobTerms,
} from "./resume-workspace-primitives";
import {
  buildPreviewSectionsFromResumeDraft as buildStructuredPreviewSectionsFromResumeDraft,
  buildResumeDraftFromTailoredDraft as buildStructuredResumeDraftFromTailoredDraft,
  buildTailoredResumeTextFromResumeDraft as buildStructuredTailoredResumeTextFromResumeDraft,
  isGeneratedClassResumeOrigin,
  seedResumeDraft as seedStructuredResumeDraft,
} from "./resume-workspace-structure";
import {
  buildResumeEntryDateQualityIssues,
  normalizeResumeDraftEntryOrdering,
} from "./resume-entry-ordering";
import { applyPatchToResumeDraft as applyResumeDraftPatch } from "./resume-workspace-patches";
import { projectWorkHistoryReviewSuggestionIdentities } from "./resume-work-history-review-identity";
import {
  findResumeDraftIdentityConflicts,
  resolveResumeIdentity,
  resumeIdentityMismatchMessage,
} from "./resume-identity";

export interface ResumeWorkspaceEvidence {
  summary: readonly string[];
  candidateSummary: readonly string[];
  experience: readonly string[];
  skills: readonly string[];
  keywords: readonly string[];
}

export interface ResumeWorkspaceResearchContext {
  companyNotes: readonly string[];
  domainVocabulary: readonly string[];
  priorityThemes: readonly string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWholePhrase(candidate: string, phrase: string): boolean {
  const desiredTokens = tokenize(phrase);

  if (desiredTokens.length === 0) {
    return false;
  }

  const candidateTokens = new Set(tokenize(candidate));

  if (desiredTokens.length === 1) {
    return candidateTokens.has(desiredTokens[0] ?? "");
  }

  return new RegExp(`(^|\\s)${escapeRegex(normalizeText(phrase))}($|\\s)`).test(
    normalizeText(candidate),
  );
}

export function buildPreviewSectionsFromResumeDraft(
  draft: ResumeDraft,
): Array<{ heading: string; lines: string[] }> {
  return buildStructuredPreviewSectionsFromResumeDraft(draft);
}

export function buildTailoredResumeTextFromResumeDraft(
  profile: CandidateProfile,
  job: SavedJob,
  draft: ResumeDraft,
): string {
  return buildStructuredTailoredResumeTextFromResumeDraft(profile, job, draft);
}

export function buildResumeDraftFromTailoredDraft(input: {
  job: SavedJob;
  templateId: ResumeDraft["templateId"];
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
  return buildStructuredResumeDraftFromTailoredDraft(input);
}

export function seedResumeDraft(input: {
  profile: CandidateProfile;
  job: SavedJob;
  templateId: ResumeDraft["templateId"];
  tailoredAsset?: TailoredAsset | null;
}): ResumeDraft {
  return seedStructuredResumeDraft(input);
}

export function resolveResumeTemplateLabel(input: {
  templateId: ResumeDraft["templateId"];
  templates?: readonly ResumeTemplateDefinition[] | undefined;
  fallbackLabel?: string | null;
}): string {
  return (
    input.templates?.find((template) => template.id === input.templateId)
      ?.label ??
    input.fallbackLabel ??
    input.templateId
  );
}

/**
 * Whether this section is the draft's core-skills list. Read from the draft
 * rather than a label match so a renamed section still counts.
 */
function isSkillsResumeSection(draft: ResumeDraft, sectionId: string): boolean {
  const section = draft.sections.find((entry) => entry.id === sectionId);
  return section?.kind === "skills" || section?.kind === "keywords";
}

function buildCandidateLanguageBank(
  profile: CandidateProfile | null | undefined,
): string[] {
  if (!profile) {
    return [];
  }

  return uniqueStrings(
    profile.spokenLanguages.flatMap((entry) =>
      [
        entry.language,
        [entry.language, entry.proficiency].filter(Boolean).join(" — "),
      ].filter((value): value is string => Boolean(value && value.trim())),
    ),
  );
}

function isGroundedVisibleLanguage(
  content: string,
  candidateLanguageBank: readonly string[],
): boolean {
  const normalized = normalizeText(content);

  if (!normalized) {
    return false;
  }

  return candidateLanguageBank.some((language) => {
    return (
      matchesWholePhrase(language, content) ||
      matchesWholePhrase(content, language)
    );
  });
}

function isLanguageSection(
  section: Pick<ResumeDraft["sections"][number], "kind" | "label"> & {
    id?: string;
  },
): boolean {
  return (
    section.kind === "skills" &&
    (section.id === "section_languages" ||
      normalizeText(section.label).includes("language"))
  );
}

const nearDuplicateStopWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function meaningfulLineTokens(content: string): Set<string> {
  return new Set(
    tokenize(content).filter(
      (token) => token.length > 1 && !nearDuplicateStopWords.has(token),
    ),
  );
}

export function areNearDuplicateResumeLines(
  left: string,
  right: string,
): boolean {
  const leftTokens = meaningfulLineTokens(left);
  const rightTokens = meaningfulLineTokens(right);
  const smallestSize = Math.min(leftTokens.size, rightTokens.size);
  if (smallestSize < 4) {
    return false;
  }

  const sharedCount = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return sharedCount / smallestSize >= 0.8;
}

interface ResumeClaimCandidateEvidence {
  ref: ResumeClaimAssessment["evidenceRefs"][number];
  text: string;
  /**
   * Classifier scope for `classifyResumeClaimGrounding`. The canonical
   * classifier only reads `id` and `text`, but scope keeps the mapped items
   * honest about their candidate-evidence provenance.
   */
  classifierScope: ResumeGenerationEvidenceItem["scope"];
  profileRecordId: string | null;
}

export interface ResumeClaimDescriptor {
  field: ResumeClaimAssessment["field"];
  sectionId: string;
  entryId: string | null;
  bulletId: string | null;
  text: string;
  origin: ResumeDraft["sections"][number]["origin"];
}

export function buildResumeClaimDescriptors(
  draft: ResumeDraft,
): ResumeClaimDescriptor[] {
  return draft.sections
    .filter((section) => section.included)
    .flatMap((section) => {
      const claims: ResumeClaimDescriptor[] = [];
      if (section.text?.trim()) {
        claims.push({
          field: "section_text",
          sectionId: section.id,
          entryId: null,
          bulletId: null,
          text: section.text,
          origin: section.origin,
        });
      }
      for (const bullet of section.bullets.filter((entry) => entry.included)) {
        claims.push({
          field: "section_bullet",
          sectionId: section.id,
          entryId: null,
          bulletId: bullet.id,
          text: bullet.text,
          origin: bullet.origin,
        });
      }
      for (const entry of section.entries.filter(
        (candidate) => candidate.included,
      )) {
        if (entry.summary?.trim()) {
          claims.push({
            field: "entry_summary",
            sectionId: section.id,
            entryId: entry.id,
            bulletId: null,
            text: entry.summary,
            origin: entry.origin,
          });
        }
        for (const bullet of entry.bullets.filter(
          (candidate) => candidate.included,
        )) {
          claims.push({
            field: "entry_bullet",
            sectionId: section.id,
            entryId: entry.id,
            bulletId: bullet.id,
            text: bullet.text,
            origin: bullet.origin,
          });
        }
      }
      return claims;
    });
}

function omitResumeVersionTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitResumeVersionTimestamps);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => key !== "updatedAt" && key !== "lastGeneratedContentHash",
        )
        .map(([key, entry]) => [key, omitResumeVersionTimestamps(entry)]),
    );
  }
  return value;
}

function stringifyResumeVersionState(value: unknown): string {
  return JSON.stringify(omitResumeVersionTimestamps(value));
}

export function buildResumeDraftStateHash(draft: ResumeDraft): string {
  return fnv1a32(
    stringifyResumeVersionState({
      templateId: draft.templateId,
      ...(draft.language ? { language: draft.language } : {}),
      ...(draft.writtenLanguage
        ? { writtenLanguage: draft.writtenLanguage }
        : {}),
      ...(draft.listingLanguage
        ? { listingLanguage: draft.listingLanguage }
        : {}),
      identity: draft.identity,
      sections: draft.sections,
      targetPageCount: draft.targetPageCount,
      generationMethod: draft.generationMethod,
    }),
  );
}

function buildResumeDraftRevisionDiff(before: ResumeDraft, after: ResumeDraft) {
  const beforeSections = new Map(
    before.sections.map((section) => [section.id, section] as const),
  );
  const afterSections = new Map(
    after.sections.map((section) => [section.id, section] as const),
  );
  const addedSectionIds = after.sections
    .filter((section) => !beforeSections.has(section.id))
    .map((section) => section.id)
    .slice(0, 100);
  const removedSectionIds = before.sections
    .filter((section) => !afterSections.has(section.id))
    .map((section) => section.id)
    .slice(0, 100);
  const changedSectionIds = before.sections
    .filter((section) => {
      const nextSection = afterSections.get(section.id);
      return (
        nextSection !== undefined &&
        stringifyResumeVersionState(section) !==
          stringifyResumeVersionState(nextSection)
      );
    })
    .map((section) => section.id)
    .slice(0, 100);

  return {
    templateChanged: before.templateId !== after.templateId,
    identityChanged:
      stringifyResumeVersionState(before.identity) !==
      stringifyResumeVersionState(after.identity),
    sectionOrderChanged:
      before.sections.map((section) => section.id).join("\u0000") !==
      after.sections.map((section) => section.id).join("\u0000"),
    addedSectionIds,
    removedSectionIds,
    changedSectionIds,
  };
}
export function buildResumeDraftContentHash(draft: ResumeDraft): string {
  return fnv1a32(
    buildResumeClaimDescriptors(draft)
      .map((claim) =>
        [
          claim.field,
          claim.origin,
          claim.sectionId,
          claim.entryId ?? "",
          claim.bulletId ?? "",
          normalizeText(claim.text),
        ].join("\u0000"),
      )
      .join("\u0001"),
  );
}

function splitCandidateEvidence(
  value: string,
  minimumTokenCount = 2,
): string[] {
  return value
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z0-9])/u)
    .map((part) => part.trim())
    .filter((part) => tokenize(part).length >= minimumTokenCount)
    .slice(0, 500);
}

export function buildResumeClaimEvidenceBank(
  profile: CandidateProfile | undefined,
): ResumeClaimCandidateEvidence[] {
  if (!profile) {
    return [];
  }

  const evidence: ResumeClaimCandidateEvidence[] = [];
  const add = (
    sourceKind: ResumeClaimAssessment["evidenceRefs"][number]["sourceKind"],
    sourceId: string,
    value: string | null | undefined,
    minimumTokenCount = 2,
    classifierScope: ResumeGenerationEvidenceItem["scope"] = "profile",
    profileRecordId: string | null = null,
  ) => {
    if (!value?.trim()) {
      return;
    }
    for (const [index, text] of splitCandidateEvidence(
      value,
      minimumTokenCount,
    ).entries()) {
      evidence.push({
        text,
        classifierScope,
        profileRecordId,
        ref: {
          id: `claim_evidence_${sourceKind}_${sourceId}_${index + 1}`,
          sourceKind,
          sourceId,
          snippet: text.slice(0, 320),
        },
      });
    }
  };

  add(
    "resume",
    profile.baseResume.id,
    profile.baseResume.textContent,
    2,
    "import_evidence",
  );
  add("profile", "profile:summary", profile.summary);
  add("profile", "profile:headline", profile.headline);
  add("profile", "profile:current-location", profile.currentLocation);
  // The profile's own years-of-experience figure is candidate evidence the
  // aggressive relaxation rounds up from (10 evidenced years may be stated
  // as 11); without it the verifier could not recognize the rounded figure.
  add(
    "profile",
    "profile:years-experience",
    profile.yearsExperience !== null && profile.yearsExperience > 0
      ? `${profile.yearsExperience} years of professional experience`
      : null,
  );
  for (const [index, role] of profile.targetRoles.entries()) {
    add("profile", `profile:target-role:${index + 1}`, role, 1);
  }
  for (const [index, location] of profile.locations.entries()) {
    add("profile", `profile:location:${index + 1}`, location, 1);
  }
  add(
    "profile",
    "profile:professional-summary",
    profile.professionalSummary.fullSummary,
  );
  add(
    "profile",
    "profile:value-proposition",
    profile.professionalSummary.shortValueProposition,
  );
  const groupedSkills = [
    ...profile.skillGroups.coreSkills,
    ...profile.skillGroups.tools,
    ...profile.skillGroups.languagesAndFrameworks,
    ...profile.skillGroups.softSkills,
    ...profile.skillGroups.highlightedSkills,
  ];
  for (const [index, skill] of groupedSkills.entries()) {
    add("profile", `profile:grouped-skill:${index + 1}`, skill, 1);
  }
  for (const [index, skill] of profile.skills.entries()) {
    add("profile", `profile:skill:${index + 1}`, skill, 1);
  }
  for (const experience of profile.experiences.filter(
    (record) => !record.isDraft,
  )) {
    add(
      "profile",
      `experience:${experience.id}:summary`,
      experience.summary,
      2,
      "experience",
      experience.id,
    );
    for (const [index, skill] of experience.skills.entries()) {
      add(
        "profile",
        `experience:${experience.id}:skill:${index + 1}`,
        skill,
        1,
        "experience",
        experience.id,
      );
    }
    for (const [index, achievement] of experience.achievements.entries()) {
      add(
        "profile",
        `experience:${experience.id}:achievement:${index + 1}`,
        achievement,
        2,
        "experience",
        experience.id,
      );
    }
  }
  for (const project of profile.projects) {
    add(
      "profile",
      `project:${project.id}:summary`,
      project.summary,
      2,
      "project",
      project.id,
    );
    add(
      "profile",
      `project:${project.id}:outcome`,
      project.outcome,
      2,
      "project",
      project.id,
    );
    for (const [index, skill] of project.skills.entries()) {
      add(
        "profile",
        `project:${project.id}:skill:${index + 1}`,
        skill,
        1,
        "project",
        project.id,
      );
    }
  }
  for (const proof of profile.proofBank) {
    add("proof", `proof:${proof.id}:claim`, proof.claim, 2, "proof", proof.id);
    add(
      "proof",
      `proof:${proof.id}:metric`,
      proof.heroMetric,
      2,
      "proof",
      proof.id,
    );
    add(
      "proof",
      `proof:${proof.id}:context`,
      proof.supportingContext,
      2,
      "proof",
      proof.id,
    );
  }
  for (const education of profile.education) {
    add("profile", `education:${education.id}:summary`, education.summary);
  }
  for (const language of profile.spokenLanguages) {
    add(
      "profile",
      `language:${language.id}`,
      [language.language, language.proficiency].filter(Boolean).join(" — "),
    );
  }

  return evidence;
}

function isGeneratedResumeClaimOrigin(
  origin: ResumeDraft["sections"][number]["origin"],
): boolean {
  return isGeneratedResumeClaimOriginContract(origin);
}

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Mirrors the canonical classifier's own exact definition: the trimmed claim
 * appears verbatim at word boundaries inside a normalized support text. The
 * supports are normalized once: normalizing the imported resume and every
 * saved record again for each line cost about 0.1 s per resume.
 */
function createVerbatimSupportCheck(
  supportTexts: readonly string[],
): (claimText: string) => boolean {
  const supports = supportTexts.map((text) => ` ${normalizeComparable(text)} `);
  return (claimText) => {
    const normalizedClaim = normalizeComparable(claimText.trim());
    if (normalizedClaim.length === 0) return false;
    const needle = ` ${normalizedClaim} `;
    return supports.some((support) => support.includes(needle));
  };
}

/**
 * Whether a resume line is the person's own without asking anyone: a line
 * they wrote, a line that repeats their saved records or the resume they
 * imported word for word, or a skill already on their profile. These need no
 * fact check. Built once per draft.
 */
export function buildPersonsOwnResumeClaimMatcher(input: {
  draft: ResumeDraft;
  profile: CandidateProfile | undefined;
}): (
  claim: Pick<ResumeClaimDescriptor, "text" | "origin" | "field" | "sectionId">,
) => boolean {
  const importedResumeText = input.profile?.baseResume.textContent ?? "";
  const evidenceTexts = buildResumeClaimEvidenceBank(input.profile).map(
    (entry) => entry.text,
  );
  const skillBank = buildCandidateSkillBank(input.profile);
  const isVerbatim = createVerbatimSupportCheck([
    importedResumeText,
    ...evidenceTexts,
  ]);
  return (claim) => {
    if (!isGeneratedResumeClaimOrigin(claim.origin)) return true;
    // Long enough that a single shared word cannot pass as the whole line.
    if (claim.text.trim().length >= 16 && isVerbatim(claim.text)) {
      return true;
    }
    // A project line joins the person's own sentences and their skill list
    // for it; each part is checked against their saved records on its own.
    const sentences = splitCandidateEvidence(claim.text, 1);
    if (
      sentences.length > 1 &&
      sentences.every((sentence) => {
        const listed = /^technologies:\s*(.+?)\.?$/iu.exec(sentence)?.[1];
        return listed
          ? listed
              .split(",")
              .map((skill) => skill.trim())
              .every((skill) =>
                skillBank.some((saved) => skillsAreEquivalent(saved, skill)),
              )
          : sentence.length >= 16 && isVerbatim(sentence);
      })
    ) {
      return true;
    }
    const section = input.draft.sections.find(
      (candidate) => candidate.id === claim.sectionId,
    );
    return (
      claim.field === "section_bullet" &&
      isSkillsResumeSection(input.draft, claim.sectionId) &&
      !isLanguageSection(section ?? { kind: "skills", label: "" }) &&
      !looksLikeSpokenLanguageSkillEntry(claim.text) &&
      skillBank.some((skill) => skillsAreEquivalent(skill, claim.text))
    );
  };
}

export function resumeClaimContentHash(text: string): string {
  return fnv1a32(normalizeText(text));
}

/**
 * How each resume line stands against the person's evidence (ADR 0041).
 *
 * The model's fact check decides for generated lines; its verdicts are kept
 * on the draft by the line's content hash, so a reworded line is checked
 * again. A line the model has not checked yet asks for the person's look
 * ("review"); no rule guesses in its place. The person's own lines stand.
 */
function assessResumeClaims(input: {
  draft: ResumeDraft;
  profile: CandidateProfile | undefined;
  assessedAt: string;
}): ResumeClaimAssessment[] {
  const evidenceRefById = new Map(
    buildResumeClaimEvidenceBank(input.profile).map(
      (entry) => [entry.ref.id, entry.ref] as const,
    ),
  );
  const checks = new Map(
    (input.draft.claimChecks ?? []).map(
      (check) => [check.contentHash, check] as const,
    ),
  );

  const isPersonsOwn = buildPersonsOwnResumeClaimMatcher(input);

  return buildResumeClaimDescriptors(input.draft).map((claim) => {
    const contentHash = resumeClaimContentHash(claim.text);
    const check = checks.get(contentHash) ?? null;
    const status: ResumeClaimAssessment["status"] = isPersonsOwn(claim)
      ? "exact"
      : !check
        ? "review"
        : check.verdict === "supported"
          ? "paraphrase"
          : check.verdict === "stretch"
            ? "confirm_needed"
            : "unsupported";
    const locator = [
      claim.field,
      claim.sectionId,
      claim.entryId ?? "",
      claim.bulletId ?? "",
    ].join(":");

    return {
      id: `claim_${fnv1a32(locator).replace(":", "_")}`,
      field: claim.field,
      sectionId: claim.sectionId,
      entryId: claim.entryId,
      bulletId: claim.bulletId,
      claimText: claim.text,
      claimOrigin: claim.origin,
      contentHash,
      status,
      evidenceRefs: (check?.evidenceIds ?? []).flatMap((evidenceId) => {
        const ref = evidenceRefById.get(evidenceId);
        return ref ? [ref] : [];
      }),
      verifier: "model_fact_check_v1",
      assessedAt: input.assessedAt,
    };
  });
}

function hasVisibleEntryContent(input: {
  title?: string | null;
  subtitle?: string | null;
  location?: string | null;
  dateRange?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  isCurrent?: boolean;
  summary?: string | null;
  bullets: readonly { included: boolean }[];
}): boolean {
  return (
    Boolean(input.title) ||
    Boolean(input.subtitle) ||
    Boolean(input.location) ||
    Boolean(input.dateRange) ||
    Boolean(input.startDate) ||
    Boolean(input.endDate) ||
    input.isCurrent === true ||
    Boolean(input.summary) ||
    input.bullets.some((bullet) => bullet.included)
  );
}

// Visible content must keep letters from every script. The matching normalizer
// used elsewhere is ASCII-only and turns non-Latin achievements into empty keys.
function normalizeVisibleResumeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/(^|[^a-z0-9])c\s*\+\s*\+(?=$|[^a-z0-9])/gi, "$1cplusplus")
    .replace(/(^|[^a-z0-9])c\s*#(?=$|[^a-z0-9])/gi, "$1csharp")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

function removeBulletDuplicatesFromSummary(
  summary: string,
  bullets: readonly { included: boolean; text: string }[],
): string | null {
  const visibleBulletLines = bullets
    .filter((bullet) => bullet.included)
    .map((bullet) => bullet.text);
  const sentences = summary
    .split(/(?<=[.!?])\s+(?=[A-Z])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const uniqueSentences = sentences.filter(
    (sentence) => !resumeFactIsCovered(sentence, visibleBulletLines),
  );

  return uniqueSentences.length > 0 ? uniqueSentences.join(" ") : null;
}

const EMPLOYMENT_END_SENTENCE_PATTERN =
  /\b(?:laid off|lay-?offs?|reduction in force|company-wide reduction|workforce reduction|position (?:was )?(?:ended|eliminated)|role (?:was )?(?:ended|eliminated)|let go|terminated|made redundant|redundancy)\b/i;

/** Drops sentences that narrate how a job ended; a summary is not the place for them. */
export function stripEmploymentEndSentences(text: string): string {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !EMPLOYMENT_END_SENTENCE_PATTERN.test(sentence))
    .join(" ")
    .trim();
}

export function sanitizeResumeDraft(input: {
  draft: ResumeDraft;
  job: SavedJob;
  profile?: CandidateProfile;
  sourceSkills?: readonly string[];
}): ResumeDraft {
  const isCompetency = buildResumeSkillContextFilter(input.job, input.profile);
  const candidateLanguageBank = buildCandidateLanguageBank(input.profile);
  const seenLines = new Set<string>();

  const orderedDraft = normalizeResumeDraftEntryOrdering(input.draft);
  const nextSections = orderedDraft.sections.map((section) => {
    const normalizedSectionText = normalizeVisibleResumeText(
      section.text ?? "",
    );
    // A summary the generator wrote badly is replaced by the person's own,
    // never dropped: an export that starts at Experience with no summary is
    // worse than the summary they already approved on their profile.
    const profileSummaryFallback = (): string | null => {
      if (section.kind !== "summary") return null;
      const fallback = input.profile?.summary?.trim() || null;
      if (!fallback || seenLines.has(normalizeVisibleResumeText(fallback)))
        return null;
      seenLines.add(normalizeVisibleResumeText(fallback));
      return fallback;
    };
    const nextText = (() => {
      if (!section.text?.trim()) {
        return profileSummaryFallback();
      }
      if (section.locked) {
        seenLines.add(normalizedSectionText);
        return section.text;
      }
      const canSuppressGeneratedSummary =
        section.kind === "summary" &&
        (section.origin === "ai_generated" ||
          section.origin === "assistant_edited" ||
          section.origin === "deterministic_fallback");
      if (canSuppressGeneratedSummary) {
        // A summary is the pitch. Generators copy "Position ended in a
        // company-wide reduction" from the imported resume into it, which a
        // candidate would never lead with; the work history keeps the dates.
        const withoutEmploymentEnd = stripEmploymentEndSentences(section.text);
        if (withoutEmploymentEnd !== section.text.trim()) {
          if (!withoutEmploymentEnd) {
            return profileSummaryFallback();
          }
          seenLines.add(normalizeVisibleResumeText(withoutEmploymentEnd));
          return withoutEmploymentEnd;
        }
      }
      if (seenLines.has(normalizedSectionText)) {
        return null;
      }
      seenLines.add(normalizedSectionText);
      return section.text;
    })();

    const sanitizeBullets = (
      bullets: typeof section.bullets,
      contextText?: string | null,
    ) =>
      bullets.filter((bullet) => {
        const normalized = normalizeVisibleResumeText(bullet.text);
        if (!normalized) {
          return false;
        }
        // A place or work-authorization phrase is not a skill (N-046). A line
        // the person locked is theirs and stays.
        if (
          (section.kind === "skills" || section.kind === "keywords") &&
          !isLanguageSection(section) &&
          !bullet.locked &&
          isGeneratedResumeClaimOrigin(bullet.origin) &&
          !isCompetency(bullet.text)
        ) {
          return false;
        }
        if (bullet.locked) {
          seenLines.add(normalized);
          return true;
        }
        if (
          contextText &&
          normalizeVisibleResumeText(contextText) === normalized
        ) {
          return false;
        }
        if (seenLines.has(normalized)) {
          return false;
        }
        if (section.kind === "skills" || section.kind === "keywords") {
          if (isLanguageSection(section)) {
            if (
              !bullet.sourceRefs.some((ref) =>
                input.profile?.spokenLanguages.some(
                  (language) => ref.sourceId === `language:${language.id}`,
                ),
              ) &&
              (isSpokenLanguageResumeChrome(bullet.text) ||
                (!input.draft.writtenLanguage &&
                  !isGroundedVisibleLanguage(
                    bullet.text,
                    candidateLanguageBank,
                  )))
            ) {
              return false;
            }
          } else if (looksLikeSpokenLanguageSkillEntry(bullet.text)) {
            return false;
          }
          // A skill the profile does not show stays: the model's fact check
          // says whether the person's evidence backs it (ADR 0041).
        }
        seenLines.add(normalized);
        return true;
      });

    const nextEntries = section.entries
      .filter(
        (entry) =>
          !input.profile?.experiences.some(
            (record) =>
              record.isDraft &&
              (entry.profileRecordId
                ? entry.profileRecordId === record.id
                : entry.title === record.title &&
                  entry.subtitle === record.companyName),
          ),
      )
      .map((entry) => {
        if (entry.locked) {
          if (entry.summary) {
            seenLines.add(normalizeVisibleResumeText(entry.summary));
          }
          for (const bullet of entry.bullets) {
            const normalizedBullet = normalizeVisibleResumeText(bullet.text);
            if (normalizedBullet) {
              seenLines.add(normalizedBullet);
            }
          }
          return entry;
        }

        const deduplicatedSummary = entry.summary
          ? removeBulletDuplicatesFromSummary(entry.summary, entry.bullets)
          : null;
        const nextSummary = (() => {
          if (!deduplicatedSummary?.trim()) {
            return null;
          }
          const normalized = normalizeVisibleResumeText(deduplicatedSummary);
          if (seenLines.has(normalized)) {
            return null;
          }
          seenLines.add(normalized);
          return deduplicatedSummary;
        })();

        const nextBullets = sanitizeBullets(entry.bullets, nextSummary);

        if (
          !hasVisibleEntryContent({
            ...entry,
            summary: nextSummary,
            bullets: nextBullets,
          })
        ) {
          return null;
        }

        return {
          ...entry,
          summary: nextSummary,
          bullets: nextBullets,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const nextBullets = sanitizeBullets(section.bullets, nextText);
    const hasVisibleContent =
      Boolean(nextText) || nextBullets.length > 0 || nextEntries.length > 0;
    const nextIncluded =
      section.kind === "keywords"
        ? false
        : section.locked
          ? true
          : hasVisibleContent && section.included;

    return {
      ...section,
      text: nextText,
      bullets: nextBullets,
      entries: nextEntries,
      included: nextIncluded,
    };
  });

  return {
    ...orderedDraft,
    sections: nextSections,
  };
}

const candidateResumeEvidenceSourceKinds = new Set([
  "resume",
  "profile",
  "proof",
  "user",
]);

function hasCandidateResumeEvidenceRef(
  refs: ReadonlyArray<{ sourceKind: string }>,
): boolean {
  return refs.some((ref) =>
    candidateResumeEvidenceSourceKinds.has(ref.sourceKind),
  );
}

function hasVisibleGeneratedResumeContent(
  section: ResumeDraft["sections"][number],
): boolean {
  return (
    section.included &&
    isGeneratedClassResumeOrigin(section.origin) &&
    (Boolean(section.text?.trim()) ||
      section.bullets.some((bullet) => bullet.included) ||
      section.entries.some(
        (entry) =>
          entry.included &&
          (Boolean(entry.title) ||
            Boolean(entry.summary) ||
            entry.bullets.some((bullet) => bullet.included)),
      ))
  );
}

/**
 * Legacy tailored assets only contain flat preview lines. Those lines cannot
 * be treated as candidate evidence unless they retain a profile record or an
 * explicit candidate-source reference. Keep the preview available for review
 * but fail closed for approval when neither boundary is present.
 */
function hasUntraceableGeneratedResumeContent(draft: ResumeDraft): boolean {
  const generatedSections = draft.sections.filter(
    hasVisibleGeneratedResumeContent,
  );

  if (generatedSections.length === 0) {
    return false;
  }

  return generatedSections.some(
    (section) =>
      !(
        Boolean(section.profileRecordId) ||
        hasCandidateResumeEvidenceRef(section.sourceRefs) ||
        section.entries.some(
          (entry) =>
            Boolean(entry.profileRecordId) ||
            hasCandidateResumeEvidenceRef(entry.sourceRefs) ||
            entry.bullets.some((bullet) =>
              hasCandidateResumeEvidenceRef(bullet.sourceRefs),
            ),
        ) ||
        section.bullets.some((bullet) =>
          hasCandidateResumeEvidenceRef(bullet.sourceRefs),
        )
      ),
  );
}

function hasGeneratedProfileRecordBoundary(draft: ResumeDraft): boolean {
  return draft.sections.some(
    (section) =>
      section.included &&
      isGeneratedClassResumeOrigin(section.origin) &&
      section.entries.some(
        (entry) => entry.included && Boolean(entry.profileRecordId),
      ),
  );
}

export function validateResumeDraft(input: {
  draft: ResumeDraft;
  job: SavedJob;
  profile?: CandidateProfile;
  pageCount?: number | null;
  validatedAt?: string;
  strategy?: Pick<ResumeGenerationStrategyPolicy, "evidenceBoundaries"> | null;
}): ResumeValidationResult {
  const validatedAt = input.validatedAt ?? new Date().toISOString();
  const issues: ResumeValidationIssue[] = [];
  const seenBullets: Array<{
    text: string;
    normalized: string;
    sectionId: string;
    bulletId: string;
  }> = [];
  const includedSections = input.draft.sections.filter(
    (section) => section.included,
  );
  const includedLineCount = buildPreviewSectionsFromResumeDraft(
    input.draft,
  ).flatMap((section) => section.lines).length;
  const hasExperienceContent = includedSections.some(
    (section) =>
      section.kind === "experience" &&
      (section.bullets.some((bullet) => bullet.included) ||
        section.entries.some(
          (entry) =>
            entry.included &&
            (Boolean(entry.summary) ||
              entry.bullets.some((bullet) => bullet.included)),
        )),
  );

  const identityResolution = input.profile
    ? resolveResumeIdentity(input.profile)
    : null;
  const identityMismatchReasons = identityResolution
    ? [
        ...identityResolution.mismatchReasons,
        ...(input.profile
          ? findResumeDraftIdentityConflicts(
              input.profile,
              input.draft.identity,
            )
          : []),
      ]
    : [];
  // A warning, not a gate (N-020): the resume always prints the identity the
  // person chose, and a sample heading read as a name ("Online Resume
  // Sample") used to block generation even after the person confirmed it.
  if (identityMismatchReasons.length > 0) {
    issues.push({
      id: `issue_identity_mismatch_${input.draft.id}`,
      severity: "warning",
      category: "identity_mismatch",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message: resumeIdentityMismatchMessage(identityMismatchReasons),
    });
  }

  function pushBulletIssues(args: {
    bullet: ResumeDraftBullet;
    sectionId: string;
    entryId?: string | null;
    isExperience: boolean;
  }) {
    const normalizedBullet = normalizeText(args.bullet.text);
    const existing = seenBullets.find(
      (entry) =>
        entry.normalized === normalizedBullet ||
        areNearDuplicateResumeLines(entry.text, args.bullet.text),
    );

    if (existing) {
      issues.push({
        id: `issue_duplicate_${args.bullet.id}`,
        severity: "warning",
        category: "duplicate_bullet",
        sectionId: args.sectionId,
        entryId: args.entryId ?? null,
        bulletId: args.bullet.id,
        message: "This bullet duplicates another included bullet.",
      });
    }
    seenBullets.push({
      text: args.bullet.text,
      normalized: normalizedBullet,
      sectionId: args.sectionId,
      bulletId: args.bullet.id,
    });
  }

  for (const section of includedSections) {
    const includedBullets = section.bullets.filter((bullet) => bullet.included);
    const includedEntries = section.entries.filter((entry) => entry.included);
    const includedEntriesWithVisibleContent = includedEntries.filter((entry) =>
      hasVisibleEntryContent(entry),
    );

    if (
      !section.text &&
      includedBullets.length === 0 &&
      includedEntriesWithVisibleContent.length === 0
    ) {
      issues.push({
        id: `issue_empty_${section.id}`,
        severity: "warning",
        category: "empty_section",
        sectionId: section.id,
        entryId: null,
        bulletId: null,
        message: `${section.label} is included but has no content yet.`,
      });
    }

    for (const bullet of includedBullets) {
      pushBulletIssues({
        bullet,
        sectionId: section.id,
        isExperience: section.kind === "experience",
      });
    }

    const seenEntryContent: string[] = [];
    for (const entry of includedEntries) {
      if (!hasVisibleEntryContent(entry)) {
        issues.push({
          id: `issue_empty_entry_${entry.id}`,
          severity: "warning",
          category: "empty_section",
          sectionId: section.id,
          entryId: entry.id,
          bulletId: null,
          message: `${section.label} includes an empty entry that should be removed or filled in.`,
        });
      }

      if (entry.summary) {
        const normalizedSummary = normalizeText(entry.summary);
        const repeatedSummary = seenEntryContent.some(
          (summary) =>
            normalizeText(summary) === normalizedSummary ||
            areNearDuplicateResumeLines(summary, entry.summary ?? ""),
        );
        if (repeatedSummary) {
          issues.push({
            id: `issue_duplicate_entry_${entry.id}`,
            severity: "warning",
            category: "duplicate_section_content",
            sectionId: section.id,
            entryId: entry.id,
            bulletId: null,
            message: `${section.label} repeats the same supporting content more than once.`,
          });
        }
        seenEntryContent.push(entry.summary);
      }

      for (const bullet of entry.bullets.filter((bullet) => bullet.included)) {
        pushBulletIssues({
          bullet,
          sectionId: section.id,
          entryId: entry.id,
          isExperience: entry.entryType === "experience",
        });
      }
    }
  }

  if (input.profile) {
    const allExperienceEntries = input.draft.sections
      .filter((section) => section.kind === "experience")
      .flatMap((section) =>
        section.entries
          .filter(
            (entry) =>
              entry.entryType === "experience" && entry.profileRecordId,
          )
          .map((entry) => ({
            profileRecordId: entry.profileRecordId as string,
            visible: section.included && entry.included,
          })),
      );
    const visibleExperienceIds = new Set(
      allExperienceEntries
        .filter((entry) => entry.visible)
        .map((entry) => entry.profileRecordId),
    );

    for (const experience of input.profile.experiences.filter(
      (record) => !record.isDraft,
    )) {
      const isCanonicalRole = Boolean(
        experience.companyName ||
        experience.title ||
        experience.summary ||
        experience.achievements.length > 0,
      );
      if (!isCanonicalRole || visibleExperienceIds.has(experience.id)) {
        continue;
      }

      const isRepresented = allExperienceEntries.some(
        (entry) => entry.profileRecordId === experience.id,
      );
      issues.push({
        id: `issue_work_history_${experience.id}`,
        severity: "warning",
        category: "work_history_review",
        sectionId: null,
        entryId: null,
        bulletId: null,
        message: isRepresented
          ? "A canonical work-history role is hidden from the visible resume."
          : "A canonical work-history role is missing from the resume draft.",
      });
    }
  }

  const visibleText = normalizeText(
    buildPreviewSectionsFromResumeDraft(input.draft)
      .flatMap((section) => section.lines)
      .join(" "),
  );
  const keywordTargets = buildPriorityJobTerms(input.job);
  const matchingKeywords = keywordTargets.filter((skill) =>
    matchesWholePhrase(visibleText, skill),
  );

  if (keywordTargets.length > 0 && matchingKeywords.length === 0) {
    issues.push({
      id: `issue_keywords_${input.draft.id}`,
      severity: "info",
      category: "poor_keyword_coverage",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message: "The current draft does not yet echo the saved job keywords.",
    });
  }

  if (
    includedLineCount < 5 ||
    !hasExperienceContent ||
    includedSections.length < 2
  ) {
    issues.push({
      id: `issue_thin_${input.draft.id}`,
      severity: "warning",
      category: "thin_output",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message:
        "The current resume is still too thin for submission and needs grounded factual review.",
    });
  }

  const isThinOutput =
    includedLineCount < 5 ||
    !hasExperienceContent ||
    includedSections.length < 2;
  const hasGeneratedResumeContent = input.draft.sections.some(
    hasVisibleGeneratedResumeContent,
  );

  // Checks the person cannot act on are quiet notes, never blockers.
  if (hasUntraceableGeneratedResumeContent(input.draft)) {
    issues.push({
      id: `issue_traceability_${input.draft.id}`,
      severity: "info",
      category: "low_confidence_fact",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message:
        "This preview-derived resume contains untraceable candidate content and needs factual review before approval.",
    });
  }

  if (
    isThinOutput &&
    hasGeneratedResumeContent &&
    !hasGeneratedProfileRecordBoundary(input.draft)
  ) {
    issues.push({
      id: `issue_thin_fallback_${input.draft.id}`,
      severity: "info",
      category: "low_confidence_fact",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message:
        "This fallback resume is too thin and needs factual review before approval. Add grounded candidate evidence before export.",
    });
  }

  // Length is advice, never a block: the person decides whether a longer
  // resume is right for the job.
  if (input.pageCount && input.pageCount > input.draft.targetPageCount) {
    issues.push({
      id: `issue_page_overflow_${input.draft.id}`,
      severity: "info",
      category: "page_overflow",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message: `The resume runs to ${input.pageCount} pages; the target is ${input.draft.targetPageCount}. Hide lines you do not need, or keep it as it is.`,
    });
  }

  if (input.draft.status === "stale" || input.draft.staleReason) {
    issues.push({
      id: `issue_stale_${input.draft.id}`,
      severity: "warning",
      category: "stale_approval",
      sectionId: null,
      entryId: null,
      bulletId: null,
      message:
        input.draft.staleReason ??
        "This approved resume is stale and should be re-reviewed.",
    });
  }

  issues.push(
    ...buildResumeEntryDateQualityIssues(input.draft, new Date(validatedAt)),
  );

  const claimAssessments = assessResumeClaims({
    draft: input.draft,
    profile: input.profile,
    assessedAt: validatedAt,
  });
  // The checker's note on a generated line that is not finished resume
  // writing (a keyword list, a fragment, filler); no word rule decides it
  // (ADR 0041). The person's own lines are theirs and get no note.
  const styleNotes = new Map(
    (input.draft.claimChecks ?? []).flatMap((check) =>
      check.style ? [[check.contentHash, check.style] as const] : [],
    ),
  );
  for (const assessment of claimAssessments) {
    const generatedClaim = isGeneratedResumeClaimOrigin(assessment.claimOrigin);
    const styleNote =
      assessment.status !== "exact" && assessment.contentHash
        ? styleNotes.get(assessment.contentHash)
        : undefined;
    if (generatedClaim && styleNote) {
      issues.push({
        id: `issue_style_${assessment.id}`,
        severity: "info",
        category: "vague_filler",
        sectionId: assessment.sectionId,
        entryId: assessment.entryId,
        bulletId: assessment.bulletId,
        message: styleNote,
      });
    }
    // A stretch was accepted by choosing Aggressive; it is not a chore.
    const blocksExport = isBlockingResumeClaimAssessment({
      assessment,
      draft: input.draft,
    });
    // A note the person already approved no longer stands in for the claim
    // row; otherwise the line kept blocking with nothing left to click.
    const alreadyReported = issues.some(
      (issue) =>
        issue.sectionId === assessment.sectionId &&
        issue.entryId === assessment.entryId &&
        issue.bulletId === assessment.bulletId &&
        (issue.category === "unsupported_claim" ||
          issue.category === "invented_metric" ||
          issue.category === "job_description_bleed") &&
        !matchResumeIssueApproval({ issue, draft: input.draft }),
    );
    if (input.strategy && assessment.claimOrigin === "ai_generated") {
      const boundary = input.strategy.evidenceBoundaries;
      // The reference cap bounds the generator's own citations (it is in
      // its prompt); the fact check's citations are not the writer's to trim.
      const boundaryViolation =
        (assessment.status === "exact" && !boundary.allowExactClaims) ||
        (assessment.status === "paraphrase" &&
          !boundary.allowParaphrasedClaims);
      if (boundaryViolation) {
        // The writer repairs this while it writes (see the generation
        // preview); it never holds the person back.
        issues.push({
          id: `issue_strategy_evidence_boundary_${assessment.id}`,
          severity: "warning",
          category: "unsupported_claim",
          sectionId: assessment.sectionId,
          entryId: assessment.entryId,
          bulletId: assessment.bulletId,
          message:
            "This AI-generated claim exceeds the selected resume strategy's evidence boundary and must be rewritten or removed before export.",
          flaggedText: assessment.claimText,
        });
      }
    }

    if (!blocksExport || alreadyReported) {
      continue;
    }

    issues.push({
      id: `issue_claim_grounding_${assessment.id}`,
      severity: "error",
      category: "unsupported_claim",
      sectionId: assessment.sectionId,
      entryId: assessment.entryId,
      bulletId: assessment.bulletId,
      message:
        assessment.status === "review"
          ? "The AI has not checked this generated line against your saved evidence yet. Read it, and approve it as accurate if you can stand behind it."
          : generatedClaim
            ? "Your saved evidence does not back this generated claim. Rewrite it, or approve it as accurate if you can stand behind it."
            : "Your saved evidence does not back this line you wrote. Edit it, or approve it as accurate if you can stand behind it.",
      // Name the exact flagged sentence so the blocker surface can quote it and
      // offer a one-click restore of the text it replaced.
      flaggedText: assessment.claimText,
    });
  }

  return ResumeValidationResultSchema.parse({
    id: `resume_validation_${input.draft.id}`,
    draftId: input.draft.id,
    // Blockers the person approved as accurate stay listed as notes.
    issues: applyResumeIssueApprovals({ issues, draft: input.draft }),
    draftContentHash: buildResumeDraftContentHash(input.draft),
    claimAssessments,
    coverageComparison: input.profile
      ? buildResumeCoverageComparison({
          profile: input.profile,
          draft: input.draft,
          pageCount: input.pageCount ?? null,
          validationIssues: issues,
          claimAssessments,
        })
      : null,
    pageCount: input.pageCount ?? null,
    validatedAt,
  });
}

/**
 * Single confirmation-aware gate over persisted resume claim assessments for
 * export, approve, and validate call sites. A draft has a blocking claim when:
 *
 * - the assessment was produced by the stale v1 verifier (fail-closed
 *   currency: generated claims must be revalidated under v2 before they can
 *   gate-pass, while user-authored rows keep their legacy semantics where
 *   only hard unsupported verdicts blocked), or
 * - the claim is unsupported — including every hard integrity gap regardless
 * of claim origin — so origin flips alone can never clear the block, or
 * - the claim needs confirmation (`confirm_needed`) and no stored
 *   confirmation matches the exact draft id, locator (field, section, entry,
 *   bullet), and confirmed normalized-content hash. Reworded claims change
 *   the content hash and block again.
 *
 * Review-status user-authored prose stays informational here, matching the
 * assessment mapping; review-status generated claims keep gating until they
 * are rewritten, confirmed, or reclassified by a fresh validation.
 */
export function hasBlockingResumeClaimAssessment(input: {
  validation: Pick<ResumeValidationResult, "claimAssessments">;
  draft: Pick<ResumeDraft, "id" | "claimConfirmations">;
}): boolean {
  return input.validation.claimAssessments.some((assessment) =>
    isBlockingResumeClaimAssessment({ assessment, draft: input.draft }),
  );
}

/**
 * One export blocker, named by locator and by the exact flagged sentence.
 */
export type ResumeExportBlocker = {
  sectionId: string | null;
  entryId: string | null;
  bulletId: string | null;
  flaggedText: string | null;
  message: string;
  /**
   * `needs_confirmation` when the line is a stretch the person keeps or
   * removes under Lines to confirm; `unsupported` for everything else.
   */
  kind?: "needs_confirmation" | "unsupported";
};

function buildResumeExportBlockerKey(blocker: ResumeExportBlocker): string {
  return [
    blocker.sectionId ?? "",
    blocker.entryId ?? "",
    blocker.bulletId ?? "",
    blocker.flaggedText === null ? "" : normalizeText(blocker.flaggedText),
    blocker.message,
  ].join("|");
}

/**
 * Everything that would stop this exact draft from being exported or approved,
 * derived from the same validation result and the same claim rule the export
 * and approval gates use. Blocking validation issues and blocking claim
 * assessments are folded into one deduplicated list so no surface has to
 * re-derive "is this grounded" with its own local rule.
 */
export function collectResumeExportBlockers(input: {
  draft: Pick<ResumeDraft, "id" | "claimConfirmations">;
  validation: Pick<ResumeValidationResult, "claimAssessments" | "issues">;
}): ResumeExportBlocker[] {
  const blockers: ResumeExportBlocker[] = [];
  const seen = new Set<string>();

  const push = (blocker: ResumeExportBlocker): void => {
    const key = buildResumeExportBlockerKey(blocker);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    blockers.push(blocker);
  };

  const confirmNeededIssueIds = new Set(
    input.validation.claimAssessments
      .filter((assessment) => assessment.status === "confirm_needed")
      .map((assessment) => `issue_claim_grounding_${assessment.id}`),
  );

  for (const issue of input.validation.issues) {
    if (!isBlockingResumeValidationIssue(issue)) {
      continue;
    }

    push({
      sectionId: issue.sectionId,
      entryId: issue.entryId,
      bulletId: issue.bulletId,
      flaggedText: issue.flaggedText ?? null,
      message: issue.message,
      kind: confirmNeededIssueIds.has(issue.id)
        ? "needs_confirmation"
        : "unsupported",
    });
  }

  for (const assessment of input.validation.claimAssessments) {
    if (!isBlockingResumeClaimAssessment({ assessment, draft: input.draft })) {
      continue;
    }

    push({
      kind:
        assessment.status === "confirm_needed"
          ? "needs_confirmation"
          : "unsupported",
      sectionId: assessment.sectionId,
      entryId: assessment.entryId,
      bulletId: assessment.bulletId,
      flaggedText: assessment.claimText,
      message: isGeneratedResumeClaimOrigin(assessment.claimOrigin)
        ? "Your saved evidence does not back this generated claim. Rewrite it, or approve it as accurate if you can stand behind it."
        : "This claim conflicts with candidate evidence and must be corrected before export.",
    });
  }

  return blockers;
}

/**
 * The shared grounded-ness rule for a proposed resume edit. A proposal is only
 * "grounded" when the exact draft that would result from accepting it clears
 * the same export gate: it runs `validateResumeDraft` plus
 * `collectResumeExportBlockers` over the candidate draft and reports every
 * blocker the proposal itself would introduce (baseline blockers the user
 * already had are not attributed to the proposal).
 */
export function evaluateResumeProposalExportGate(input: {
  baselineDraft: ResumeDraft;
  candidateDraft: ResumeDraft;
  job: SavedJob;
  profile?: CandidateProfile;
  evaluatedAt?: string;
  strategy?: Pick<ResumeGenerationStrategyPolicy, "evidenceBoundaries"> | null;
}): { accepted: boolean; blockers: ResumeExportBlocker[] } {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const validationInput = {
    job: input.job,
    validatedAt: evaluatedAt,
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
  };
  const baselineBlockers = collectResumeExportBlockers({
    draft: input.baselineDraft,
    validation: validateResumeDraft({
      ...validationInput,
      draft: input.baselineDraft,
    }),
  });
  const candidateBlockers = collectResumeExportBlockers({
    draft: input.candidateDraft,
    validation: validateResumeDraft({
      ...validationInput,
      draft: input.candidateDraft,
    }),
  });
  const baselineKeys = new Set(
    baselineBlockers.map(buildResumeExportBlockerKey),
  );
  const blockers = candidateBlockers.filter(
    (blocker) => !baselineKeys.has(buildResumeExportBlockerKey(blocker)),
  );

  return { accepted: blockers.length === 0, blockers };
}

/**
 * Which proposed change a flagged line belongs to. An inserted bullet gets
 * its id only when applied, so it matched no patch by target and fell to the
 * first change in the same section: a skill move was blamed for the new
 * "Performance" skill while the insert itself read as clean. Matching the
 * flagged text to the change that wrote it comes before that fallback.
 */
export function findResumeProposalPatchForBlocker(
  patches: readonly ResumeDraftPatch[],
  blocker: {
    sectionId: string | null;
    entryId: string | null;
    bulletId: string | null;
    flaggedText?: string | null;
  },
): string | null {
  const sameTarget = patches.find(
    (patch) =>
      patch.targetSectionId === blocker.sectionId &&
      (patch.targetEntryId ?? null) === blocker.entryId &&
      (patch.targetBulletId ?? null) === blocker.bulletId,
  );
  if (sameTarget) {
    return sameTarget.id;
  }
  const flagged = normalizeText(blocker.flaggedText ?? "");
  const wroteFlaggedText = flagged
    ? patches.find(
        (patch) =>
          patch.targetSectionId === blocker.sectionId &&
          normalizeText(patch.newText ?? "") === flagged,
      )
    : undefined;
  return (
    wroteFlaggedText?.id ??
    patches.find((patch) => patch.targetSectionId === blocker.sectionId)?.id ??
    null
  );
}

/**
 * Applies a pending proposal to a throwaway copy of the current draft and runs
 * the export gate over the result. This is the one call every proposal
 * producer uses to decide whether it may describe its own edits as grounded:
 * "grounded" means the export/approval classifier accepts the resulting text.
 * A patch that cannot be applied at all rethrows to the caller.
 */
export function evaluateResumeProposalGrounding(input: {
  baselineDraft: ResumeDraft;
  patches: readonly ResumeDraftPatch[];
  job: SavedJob;
  profile?: CandidateProfile;
  evaluatedAt: string;
  strategy?: Pick<ResumeGenerationStrategyPolicy, "evidenceBoundaries"> | null;
  /**
   * The model's verdicts on the edited draft's lines (ADR 0041), from
   * evaluateCheckedResumeProposalGrounding. Without them, new generated
   * lines read as not yet checked.
   */
  candidateClaimChecks?: ResumeDraft["claimChecks"];
}): {
  accepted: boolean;
  approvalBlockers: ResumeProposalApprovalBlocker[];
} {
  if (input.patches.length === 0) {
    return { accepted: true, approvalBlockers: [] };
  }

  let candidateDraft = input.baselineDraft;
  for (const patch of input.patches) {
    candidateDraft = applyResumeDraftPatch({
      draft: candidateDraft,
      patch,
      updatedAt: input.evaluatedAt,
    });
  }

  candidateDraft = sanitizeResumeDraft({
    draft: candidateDraft,
    job: input.job,
    ...(input.profile ? { profile: input.profile } : {}),
  });
  if (input.candidateClaimChecks) {
    candidateDraft = {
      ...candidateDraft,
      claimChecks: input.candidateClaimChecks,
    };
  }

  const gate = evaluateResumeProposalExportGate({
    baselineDraft: input.baselineDraft,
    candidateDraft,
    job: input.job,
    evaluatedAt: input.evaluatedAt,
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.strategy ? { strategy: input.strategy } : {}),
  });

  const approvalBlockers = gate.blockers.map((blocker) =>
    ResumeProposalApprovalBlockerSchema.parse({
      patchId: findResumeProposalPatchForBlocker(input.patches, blocker),
      sectionId: blocker.sectionId,
      entryId: blocker.entryId,
      bulletId: blocker.bulletId,
      flaggedText: blocker.flaggedText,
      message:
        blocker.kind === "needs_confirmation"
          ? "This wording stretches past your saved evidence. After you accept, it is listed under Lines to confirm, where you keep it or remove it."
          : blocker.message,
      kind: blocker.kind ?? "unsupported",
    }),
  );

  return { accepted: approvalBlockers.length === 0, approvalBlockers };
}

/**
 * One assistant reply line for a proposal, so both proposal producers describe
 * the same gate verdict identically: only a gate-accepted proposal may be
 * called grounded, and a gate-rejected proposal says up front that accepting
 * it would block approval.
 */
export function buildResumeProposalReplyContent(input: {
  approvalBlockers: readonly ResumeProposalApprovalBlocker[];
  changeCount: number;
  scopeLabel?: string | null;
  /**
   * The model's own note about the request, kept when it says something the
   * standard line does not: typically which part of the request it did not
   * do and why ("no evidence for a 60% AWS saving"). The user asked for that
   * part and deserves the answer, not silence.
   */
  assistantNote?: string | null;
}): string {
  const scope = input.scopeLabel
    ? ` for the '${input.scopeLabel}' section`
    : "";
  const plural = input.changeCount === 1 ? "" : "s";
  const note = selectAssistantNote(input.assistantNote);

  // A blocker tied to no change and no section is about the whole draft, not
  // the proposed wording; saying "the new wording is not supported" for it
  // blamed an edit the card itself called clean.
  const draftLevelBlocker = input.approvalBlockers.find(
    (blocker) => blocker.patchId === null && blocker.sectionId === null,
  );
  const wordingBlockers = input.approvalBlockers.filter(
    (blocker) => blocker !== draftLevelBlocker,
  );
  const confirmCount = wordingBlockers.filter(
    (blocker) => blocker.kind === "needs_confirmation",
  ).length;
  const unsupportedCount = wordingBlockers.length - confirmCount;

  if (unsupportedCount > 0) {
    // The model saw this same verdict before it finished (the approval check
    // is one of its tools), so its note usually says why it kept the wording:
    // the person stated the fact themselves. A note that still calls the edit
    // grounded contradicts the gate and is left out.
    const blockedNote =
      /\bgrounded\b|\b(?:is|are|fully) (?:supported|backed)\b/iu.test(note)
        ? ""
        : note;
    return `I prepared ${input.changeCount} resume edit${plural}${scope}, but ${unsupportedCount === 1 ? "1 of them would block approval" : `${unsupportedCount} of them would block approval`}: your saved evidence does not back the new wording. Nothing changed yet. If it is true, accept it and approve it as accurate in the resume checks; otherwise ask me to reword it from your saved evidence.${blockedNote}`;
  }

  if (confirmCount > 0) {
    return `I prepared ${input.changeCount} resume edit${plural}${scope} for your review. ${confirmCount === 1 ? "1 of them stretches" : `${confirmCount} of them stretch`} past your saved evidence, so after you accept, ${confirmCount === 1 ? "it is" : "they are"} listed under Lines to confirm for you to keep or remove. Nothing changed yet.${note}`;
  }

  if (draftLevelBlocker) {
    return `I prepared ${input.changeCount} resume edit${plural}${scope} for your review. The edit${plural} add${input.changeCount === 1 ? "s" : ""} nothing that blocks approval, but the resume as a whole still does: ${draftLevelBlocker.message} Nothing changed yet; select the changes you want and accept them explicitly.`;
  }

  return `I prepared ${input.changeCount} grounded resume edit${plural}${scope} for your review. Nothing changed yet; select the changes you want and accept them explicitly.${note}`;
}

const ASSISTANT_NOTE_MAX_LENGTH = 420;
const ASSISTANT_NOTE_BOILERPLATE =
  /^(?:i (?:am|'m) reviewing|i prepared|i (?:have )?(?:proposed|updated|added|drafted)[^.]*\.?$|done\.?$|ok(?:ay)?\.?$)/iu;

function selectAssistantNote(note: string | null | undefined): string {
  const trimmed = note?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed || ASSISTANT_NOTE_BOILERPLATE.test(trimmed)) {
    return "";
  }
  const clipped =
    trimmed.length > ASSISTANT_NOTE_MAX_LENGTH
      ? `${trimmed.slice(0, ASSISTANT_NOTE_MAX_LENGTH).replace(/\s+\S*$/u, "")}…`
      : trimmed;
  return ` ${clipped}`;
}

function compareResumeTextSets(
  baseline: readonly string[],
  current: readonly string[],
): string[] {
  const key = (value: string) =>
    normalizeText(value)
      .replace(/\s*[—–:-]\s*/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  const currentKeys = new Set(current.map(key));
  return uniqueStrings(baseline).filter(
    (value) => !currentKeys.has(key(value)),
  );
}

export function buildResumeCoverageComparison(input: {
  profile: CandidateProfile;
  draft: ResumeDraft;
  pageCount?: number | null;
  validationIssues?: readonly ResumeValidationIssue[];
  claimAssessments?: readonly ResumeClaimAssessment[];
  translatedRoleIds?: ReadonlySet<string>;
  coverageMetadata?: TailoredResumeDraft["coverageMetadata"];
}): ResumeCoverageComparison {
  const experienceSection =
    input.draft.sections.find((section) => section.kind === "experience") ??
    null;
  const experienceEntries = [...(experienceSection?.entries ?? [])].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
  const entriesByRecordId = new Map(
    experienceEntries.flatMap((entry, index) =>
      entry.profileRecordId
        ? ([[entry.profileRecordId, { entry, index }]] as const)
        : [],
    ),
  );
  const coverageByRecordId = new Map(
    (input.coverageMetadata ?? []).map((metadata) => [
      metadata.profileRecordId,
      metadata,
    ]),
  );
  const roles = input.profile.experiences
    .filter(
      (experience) =>
        !experience.isDraft &&
        Boolean(experience.id) &&
        Boolean(experience.title?.trim()),
    )
    .map((experience, originalIndex) => {
      const match = entriesByRecordId.get(experience.id) ?? null;
      const entry = match?.entry ?? null;
      const metadata = coverageByRecordId.get(experience.id) ?? null;
      const isVisible = Boolean(experienceSection?.included && entry?.included);
      const originalClaims = uniqueStrings(
        [experience.summary, ...experience.achievements]
          .filter((value): value is string => Boolean(value?.trim()))
          .flatMap(resumeSentences),
      );
      const tailoredClaims =
        entry && isVisible
          ? uniqueStrings(
              [
                entry.summary,
                ...entry.bullets
                  .filter((bullet) => bullet.included)
                  .map((bullet) => bullet.text),
              ].filter((value): value is string => Boolean(value?.trim())),
            )
          : [];
      const removedClaimText = compareResumeTextSets(
        originalClaims,
        tailoredClaims.flatMap(resumeSentences),
      );
      const addedClaimText = compareResumeTextSets(
        tailoredClaims,
        originalClaims,
      );
      const sourceAchievementIds = (text: string) => [
        ...resumeSentences(experience.summary ?? "").flatMap((line, index) =>
          normalizeText(line) === normalizeText(text)
            ? [`experience:${experience.id}:summary:${index}`]
            : [],
        ),
        ...experience.achievements.flatMap((achievement, index) =>
          resumeSentences(achievement).some(
            (line) => normalizeText(line) === normalizeText(text),
          )
            ? [`experience:${experience.id}:achievement:${index}`]
            : [],
        ),
      ];
      const restatedSourceIds = (text: string) => {
        const refs =
          entry?.summary && resumeSentences(entry.summary).includes(text)
            ? entry.sourceRefs
            : (entry?.bullets
                .filter((bullet) => bullet.included && bullet.text === text)
                .flatMap((bullet) => bullet.sourceRefs) ?? []);
        // The fact check links the actual current wording to original fields.
        // Older comparison rows may carry a stale positional link instead.
        const evidenceRefs = (input.claimAssessments ?? [])
          .filter(
            (assessment) =>
              assessment.sectionId === experienceSection?.id &&
              assessment.entryId === entry?.id &&
              assessment.claimText === text,
          )
          .flatMap((assessment) => assessment.evidenceRefs);
        const originalFieldIds = (
          sourceRefs: readonly ResumeDraftSourceRef[],
        ) =>
          uniqueStrings(
            sourceRefs.flatMap((ref) => {
              if (ref.sourceId === `experience:${experience.id}:summary`)
                return resumeSentences(experience.summary ?? "").flatMap(
                  sourceAchievementIds,
                );
              if (
                ref.sourceId?.startsWith(`experience:${experience.id}:summary:`)
              )
                return resumeSentences(experience.summary ?? "")
                  .flatMap(sourceAchievementIds)
                  .filter((id) => id === ref.sourceId);
              return experience.achievements.some(
                (_, index) =>
                  ref.sourceId ===
                  `experience:${experience.id}:achievement:${index}`,
              )
                ? [ref.sourceId!]
                : [];
            }),
          );
        // The evidence bank numbers achievements from one; comparison and
        // draft field IDs number them from zero. Prefer the quoted original
        // wording, then convert only the evidence bank's field coordinate.
        const evidenceIds = uniqueStrings(
          evidenceRefs.flatMap((ref) => {
            const quotedIds = sourceAchievementIds(ref.snippet);
            if (quotedIds.length) return quotedIds;
            const prefix = `experience:${experience.id}:achievement:`;
            if (ref.sourceId.startsWith(prefix)) {
              const index = Number(ref.sourceId.slice(prefix.length)) - 1;
              return Number.isInteger(index) &&
                index >= 0 &&
                experience.achievements[index]
                ? [`${prefix}${index}`]
                : [];
            }
            return originalFieldIds([ref]);
          }),
        );
        if (evidenceIds.length) return evidenceIds;
        const linkedIds = uniqueStrings(
          refs.flatMap((ref) => {
            if (
              ref.sourceId?.startsWith("draft:") &&
              ref.sourceId.includes(":field:")
            )
              return resumeSentences(ref.snippet ?? "").flatMap(
                sourceAchievementIds,
              );
            if (ref.sourceId === `experience:${experience.id}:summary`)
              return resumeSentences(experience.summary ?? "").flatMap(
                sourceAchievementIds,
              );
            return experience.achievements.some(
              (_, index) =>
                ref.sourceId ===
                `experience:${experience.id}:achievement:${index}`,
            )
              ? [ref.sourceId!]
              : [];
          }),
        );
        if (
          linkedIds.length ||
          !entry ||
          !(
            input.translatedRoleIds?.has(experience.id) ||
            input.draft.writtenLanguage ||
            input.draft.language ||
            input.draft.listingLanguage
          )
        )
          return linkedIds;
        // Legacy language drafts predate original-field links. The language
        // writer preserves section/entry/line order; recover that identity
        // from the original field, never from translated word overlap.
        if (text === entry.summary)
          return resumeSentences(experience.summary ?? "").flatMap(
            sourceAchievementIds,
          );
        const bulletIndex = entry.bullets.findIndex(
          (bullet) => bullet.text === text,
        );
        return bulletIndex >= 0 && experience.achievements[bulletIndex]
          ? [`experience:${experience.id}:achievement:${bulletIndex}`]
          : [];
      };
      const originalSummaryKey = normalizeText(experience.summary ?? "");
      const removedClaims = removedClaimText.map((text) => ({
        ...(sourceAchievementIds(text).length
          ? { sourceAchievementIds: sourceAchievementIds(text) }
          : {}),
        field:
          originalSummaryKey && normalizeText(text) === originalSummaryKey
            ? ("summary" as const)
            : ("bullet" as const),
        text,
        restorable: Boolean(entry && experienceSection && isVisible),
      }));
      const addedClaims = addedClaimText.map((text) => ({
        ...(restatedSourceIds(text).length
          ? { sourceAchievementIds: restatedSourceIds(text) }
          : {}),
        field:
          entry?.summary && normalizeText(text) === normalizeText(entry.summary)
            ? ("summary" as const)
            : ("bullet" as const),
        text,
        restorable: false,
      }));
      const reordered = match ? match.index !== originalIndex : false;
      const retainedClaimCount = originalClaims.filter(
        (claim) =>
          sourceAchievementIds(claim).some((id) =>
            tailoredClaims.some((text) => restatedSourceIds(text).includes(id)),
          ) || resumeFactIsCovered(claim, tailoredClaims),
      ).length;
      const status = !entry
        ? ("missing" as const)
        : !isVisible
          ? ("hidden" as const)
          : addedClaims.length === 0 && removedClaims.length === 0
            ? ("unchanged" as const)
            : metadata?.classification === "compact" ||
                (originalClaims.length > 0 &&
                  tailoredClaims.length < originalClaims.length)
              ? ("compacted" as const)
              : addedClaims.length > 0 || removedClaims.length > 0
                ? ("rewritten" as const)
                : ("unchanged" as const);
      const reasons = uniqueStrings([
        ...(metadata?.reasons ?? []),
        ...(metadata?.reviewGuidance ?? []),
        ...(status === "hidden"
          ? [
              "This role is saved in the draft but hidden from the exported resume.",
            ]
          : []),
        ...(status === "missing"
          ? ["This canonical role is not represented in the current draft."]
          : []),
        ...(reordered
          ? ["This role moved from its original chronological position."]
          : []),
      ]);

      return {
        profileRecordId: experience.id,
        title: experience.title as string,
        employer: experience.companyName ?? "",
        sectionId: experienceSection?.id ?? null,
        entryId: entry?.id ?? null,
        status,
        included: isVisible,
        reordered,
        originalIndex,
        tailoredIndex: match?.index ?? null,
        originalClaimCount: originalClaims.length,
        retainedClaimCount,
        addedClaims,
        removedClaims,
        reasons,
      };
    });
  const originalKeywords = [
    ...buildCandidateSkillBank(input.profile),
    ...input.profile.spokenLanguages.map((entry) =>
      [entry.language, entry.proficiency].filter(Boolean).join(" — "),
    ),
    ...input.profile.certifications
      .filter((entry) => !entry.isDraft)
      .flatMap((entry) => (entry.name ? [entry.name] : [])),
  ];
  const originalFieldText = (
    text: string,
    fieldId: string,
    refs: readonly ResumeDraftSourceRef[],
  ) =>
    refs.find(
      (ref) =>
        ref.sourceId?.startsWith("draft:") &&
        ref.sourceId.endsWith(`:field:${fieldId}`),
    )?.snippet ??
    refs.find((ref) => ref.sourceId?.startsWith("language:"))?.snippet ??
    text;
  const tailoredKeywords = uniqueStrings(
    input.draft.sections
      .filter(
        (section) =>
          section.included &&
          (section.kind === "skills" ||
            section.kind === "keywords" ||
            section.kind === "certifications"),
      )
      .flatMap((section) => [
        ...(section.text
          ? [
              originalFieldText(
                section.text,
                `${section.id}:text`,
                section.sourceRefs,
              ),
            ]
          : []),
        ...section.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) =>
            originalFieldText(bullet.text, bullet.id, bullet.sourceRefs),
          ),
        ...section.entries
          .filter((entry) => entry.included)
          .flatMap((entry) => [
            ...(entry.title
              ? [
                  section.kind === "certifications"
                    ? (input.profile.certifications.find(
                        (record) => record.id === entry.profileRecordId,
                      )?.name ??
                      originalFieldText(
                        entry.title,
                        `${entry.id}:title`,
                        entry.sourceRefs,
                      ))
                    : originalFieldText(
                        entry.title,
                        `${entry.id}:title`,
                        entry.sourceRefs,
                      ),
                ]
              : []),
            ...(entry.summary
              ? [
                  originalFieldText(
                    entry.summary,
                    `${entry.id}:summary`,
                    entry.sourceRefs,
                  ),
                ]
              : []),
            ...entry.bullets
              .filter((bullet) => bullet.included)
              .map((bullet) =>
                originalFieldText(bullet.text, bullet.id, bullet.sourceRefs),
              ),
          ]),
      ]),
  );
  const pageCount = input.pageCount ?? null;

  return ResumeCoverageComparisonSchema.parse({
    originalRoleCount: roles.length,
    representedRoleCount: roles.filter((role) => role.entryId).length,
    visibleRoleCount: roles.filter((role) => role.included).length,
    rewrittenRoleCount: roles.filter((role) => role.status === "rewritten")
      .length,
    compactedRoleCount: roles.filter((role) => role.status === "compacted")
      .length,
    hiddenRoleCount: roles.filter((role) => role.status === "hidden").length,
    missingRoleCount: roles.filter((role) => role.status === "missing").length,
    reorderedRoleCount: roles.filter((role) => role.reordered).length,
    addedClaimCount: roles.reduce(
      (count, role) => count + role.addedClaims.length,
      0,
    ),
    removedClaimCount: roles.reduce(
      (count, role) => count + role.removedClaims.length,
      0,
    ),
    duplicateIssueCount: (input.validationIssues ?? []).filter(
      (issue) =>
        issue.category === "duplicate_bullet" ||
        issue.category === "duplicate_section_content",
    ).length,
    addedKeywords: resumeComparisonNeedsRefresh(input.draft)
      ? []
      : compareResumeTextSets(tailoredKeywords, originalKeywords),
    removedKeywords: resumeComparisonNeedsRefresh(input.draft)
      ? []
      : compareResumeTextSets(originalKeywords, tailoredKeywords),
    pageImpact:
      pageCount === null
        ? "unknown"
        : pageCount > input.draft.targetPageCount
          ? "over_target"
          : "within_target",
    pageCount,
    targetPageCount: input.draft.targetPageCount,
    roles,
  });
}

export function buildWorkHistoryReviewSuggestions(input: {
  draft: ResumeDraft;
  tailoredDraft: TailoredResumeDraft;
}): WorkHistoryReviewSuggestion[] {
  const experienceSection =
    input.draft.sections.find((section) => section.kind === "experience") ??
    null;
  const entriesByRecordId = new Map(
    (experienceSection?.entries ?? [])
      .filter((entry) => entry.profileRecordId)
      .map((entry) => [entry.profileRecordId as string, entry]),
  );

  return projectWorkHistoryReviewSuggestionIdentities(
    input.tailoredDraft.coverageMetadata,
  ).map((identity) => {
    const isHiddenRecommendation = identity.action === "consider_showing";
    const entry = entriesByRecordId.get(identity.profileRecordId) ?? null;

    return {
      id: identity.id,
      profileRecordId: identity.profileRecordId,
      sectionId: experienceSection?.id ?? null,
      entryId: isHiddenRecommendation ? null : (entry?.id ?? null),
      kind: identity.kind,
      action: identity.action,
      severity: "info",
      message: identity.message,
      messageContentHash: identity.messageContentHash,
    } satisfies WorkHistoryReviewSuggestion;
  });
}

export function isWorkHistoryOmissionReviewSuggestion(
  suggestion: Pick<WorkHistoryReviewSuggestion, "kind" | "action">,
): boolean {
  return (
    (suggestion.kind === "weak_fit" || suggestion.kind === "gap_coverage") &&
    suggestion.action === "consider_showing"
  );
}

/**
 * Exact-match lookup of the stored acknowledgment that satisfies a projected
 * work-history review suggestion. Every identity field must match the current
 * projection, including the FNV-1a hash of the exact canonical message, so a
 * stale or cross-draft acknowledgment never satisfies a review gate.
 */
export function matchWorkHistoryReviewAcknowledgment(input: {
  draftId: string;
  suggestion: Pick<
    WorkHistoryReviewSuggestion,
    "profileRecordId" | "kind" | "action" | "message"
  >;
  acknowledgments: readonly WorkHistoryReviewAcknowledgment[];
}): WorkHistoryReviewAcknowledgment | null {
  return (
    input.acknowledgments.find(
      (acknowledgment) =>
        acknowledgment.draftId === input.draftId &&
        acknowledgment.profileRecordId === input.suggestion.profileRecordId &&
        acknowledgment.kind === input.suggestion.kind &&
        acknowledgment.action === input.suggestion.action &&
        acknowledgment.messageContentHash === fnv1a32(input.suggestion.message),
    ) ?? null
  );
}

export function listUnresolvedWorkHistoryOmissionSuggestions(input: {
  draftId: string;
  suggestions: readonly WorkHistoryReviewSuggestion[];
  acknowledgments: readonly WorkHistoryReviewAcknowledgment[];
}): WorkHistoryReviewSuggestion[] {
  return input.suggestions.filter(
    (suggestion) =>
      isWorkHistoryOmissionReviewSuggestion(suggestion) &&
      !matchWorkHistoryReviewAcknowledgment({
        draftId: input.draftId,
        suggestion,
        acknowledgments: input.acknowledgments,
      }),
  );
}

export { applyPatchToResumeDraft } from "./resume-workspace-patches";

export function buildResumeDraftRevision(input: {
  draft: ResumeDraft;
  resultingDraft: ResumeDraft;
  createdAt: string;
  parentRevisionId?: string | null;
  actor: ResumeDraftRevisionActor;
  mutationKind: ResumeDraftRevisionMutationKind;
  restoredFromRevisionId?: string | null;
  reason?: string | null;
}): ResumeDraftRevision {
  if (input.draft.id !== input.resultingDraft.id) {
    throw new Error("Resume revision drafts must share the same draft id.");
  }

  return ResumeDraftRevisionSchema.parse({
    id: createUniqueId(`resume_revision_${input.draft.id}`),
    draftId: input.draft.id,
    parentRevisionId: input.parentRevisionId ?? null,
    actor: input.actor,
    mutationKind: input.mutationKind,
    snapshotDraft: input.draft,
    snapshotIdentity: input.draft.identity ?? null,
    snapshotSections: input.draft.sections,
    beforeHash: buildResumeDraftStateHash(input.draft),
    afterHash: buildResumeDraftStateHash(input.resultingDraft),
    diff: buildResumeDraftRevisionDiff(input.draft, input.resultingDraft),
    restoredFromRevisionId: input.restoredFromRevisionId ?? null,
    createdAt: input.createdAt,
    reason: input.reason ?? null,
  });
}
export function buildResumeExportArtifact(input: {
  draft: ResumeDraft;
  job: SavedJob;
  filePath: string;
  format?: ResumeExportArtifact["format"];
  exportedAt: string;
  pageCount?: number | null;
  sha256?: string | null;
  isApproved?: boolean;
}): ResumeExportArtifact {
  return ResumeExportArtifactSchema.parse({
    id: createUniqueId(`resume_export_${input.job.id}`),
    draftId: input.draft.id,
    jobId: input.job.id,
    format: input.format ?? "pdf",
    filePath: input.filePath,
    sha256: input.sha256 ?? null,
    pageCount: input.pageCount ?? null,
    templateId: input.draft.templateId,
    exportedAt: input.exportedAt,
    isApproved: input.isApproved ?? false,
  });
}

export const TAILORED_RESUME_ASSET_LABEL = "Tailored Resume";

/**
 * What a document whose listing text was never captured is actually called.
 *
 * Nothing could be tailored for it, so the draft keeps the person's own
 * wording. The preview panel already said so while the shortlisted row, the
 * documents list and the exported file still read "Tailored Resume": the name
 * is derived from the same state everywhere now.
 */
export const UNTAILORABLE_RESUME_ASSET_LABEL = "Your original resume";

export function resolveTailoredAssetLabel(input: {
  existingLabel?: string | null;
  generationMethod: "ai_assisted" | "deterministic";
  generationReason?: string | null;
}): string {
  const isUntailorable =
    input.generationMethod === "deterministic" &&
    (input.generationReason === "listing_text_missing" ||
      input.generationReason === "listing_text_not_distinguishing");

  if (isUntailorable) {
    return UNTAILORABLE_RESUME_ASSET_LABEL;
  }

  const existingLabel = input.existingLabel?.trim();
  // A draft that has since been written against real listing text stops being
  // the person's untouched resume, so the carried-forward name goes back.
  if (!existingLabel || existingLabel === UNTAILORABLE_RESUME_ASSET_LABEL) {
    return TAILORED_RESUME_ASSET_LABEL;
  }

  return existingLabel;
}

export function buildTailoredAssetBridge(input: {
  draft: ResumeDraft;
  job: SavedJob;
  profile: CandidateProfile;
  existingAsset?: TailoredAsset | null;
  storagePath?: string | null;
  clearStoragePath?: boolean;
  pageCount?: number | null;
  notes?: readonly string[];
  compatibilityScore?: number | null;
  templates?: readonly ResumeTemplateDefinition[];
}): TailoredAsset {
  const updatedAt = input.draft.updatedAt;
  const shouldClearStoragePath =
    (input.clearStoragePath ?? false) || input.draft.status === "stale";
  const resolvedStoragePath = shouldClearStoragePath
    ? null
    : (input.storagePath ?? input.existingAsset?.storagePath ?? null);
  // A cleared or missing export file is a review state, not a generation
  // outcome: the tailored draft still exists, so the nearest recovery is a
  // fresh review plus export, never an invented "failed" claim. Real
  // generation failures stay owned by generateResume's failure handler, which
  // writes status "failed" together with a sanitized failureMessage; such a
  // durable failure row is carried forward unchanged until a successful
  // generation or export supersedes it.
  const preservedFailure =
    resolvedStoragePath === null && input.existingAsset?.status === "failed"
      ? input.existingAsset
      : null;
  const generationMethod =
    input.draft.generationMethod === "ai" ? "ai_assisted" : "deterministic";
  const generationReason =
    input.draft.generationMethod === "ai"
      ? null
      : (input.existingAsset?.generationReason ?? null);

  return TailoredAssetSchema.parse({
    id: input.existingAsset?.id ?? `resume_${input.job.id}`,
    jobId: input.job.id,
    kind: "resume",
    status: preservedFailure ? "failed" : "ready",
    label: resolveTailoredAssetLabel({
      existingLabel: input.existingAsset?.label ?? null,
      generationMethod,
      generationReason,
    }),
    version: input.existingAsset?.version ?? "v1",
    templateName: resolveResumeTemplateLabel({
      templateId: input.draft.templateId,
      templates: input.templates,
      fallbackLabel: input.existingAsset?.templateName ?? null,
    }),
    compatibilityScore:
      input.compatibilityScore ??
      input.existingAsset?.compatibilityScore ??
      input.job.matchAssessment.score,
    progressPercent: preservedFailure
      ? (input.existingAsset?.progressPercent ?? 0)
      : 100,
    updatedAt,
    storagePath: resolvedStoragePath,
    contentText: buildTailoredResumeTextFromResumeDraft(
      input.profile,
      input.job,
      input.draft,
    ),
    previewSections: buildPreviewSectionsFromResumeDraft(input.draft),
    generationMethod,
    // The structured reason and detail describe how the *first* draft was
    // written. Every save, patch, and export rebuilds the asset through this
    // bridge, and dropping them here made the studio's disclosure degrade
    // from the specific, debuggable verifier sentence to the generic
    // note-derived fallback line the moment the user touched the draft.
    // They are carried forward while the draft is still deterministic and
    // cleared once the draft itself becomes AI-written.
    ...(input.draft.generationMethod === "ai"
      ? { generationReason: null, generationDetail: null }
      : {
          generationReason,
          generationDetail: input.existingAsset?.generationDetail ?? null,
        }),
    notes: uniqueStrings([
      ...(input.existingAsset?.notes ?? []),
      ...(input.notes ?? []),
      ...(input.pageCount
        ? [`Generated PDF page count: ${input.pageCount}.`]
        : []),
    ]),
    // A ready or review-pending asset supersedes any earlier failure detail,
    // mirroring the authoritative clear after a successful generation.
    failureMessage: preservedFailure?.failureMessage ?? null,
    failedAt: preservedFailure?.failedAt ?? null,
  });
}

export { buildResumeRenderDocument } from "./resume-workspace-structure";

export function buildUnavailableAssistantReply(
  jobId: string,
): ResumeAssistantMessage {
  return ResumeAssistantMessageSchema.parse({
    id: createUniqueId(`resume_message_assistant_${jobId}`),
    jobId,
    role: "assistant",
    content:
      "Resume assistant editing is not available in this workspace yet. Save manual edits or regenerate the draft instead.",
    patches: [],
    createdAt: new Date().toISOString(),
  });
}

export function buildAssistantReplyMessage(input: {
  jobId: string;
  content: string;
  patches: readonly ResumeDraftPatch[];
  approvalBlockers?: readonly ResumeProposalApprovalBlocker[];
  baseDraftUpdatedAt?: string | null;
  proposalError?: string | null;
  executionAttribution?: ResumeAssistantMessage["executionAttribution"];
  createdAt?: string;
}): ResumeAssistantMessage {
  return ResumeAssistantMessageSchema.parse({
    id: createUniqueId(`resume_message_assistant_${input.jobId}`),
    jobId: input.jobId,
    role: "assistant",
    content: input.content,
    patches: [...input.patches],
    approvalBlockers: [...(input.approvalBlockers ?? [])],
    proposalStatus: input.patches.length > 0 ? "pending" : "none",
    baseDraftUpdatedAt: input.baseDraftUpdatedAt ?? null,
    proposalError: input.proposalError ?? null,
    executionAttribution: input.executionAttribution ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function collectResumeWorkspaceEvidence(input: {
  profile: CandidateProfile;
  job: SavedJob;
  research: readonly ResumeResearchArtifact[];
}): ResumeWorkspaceEvidence {
  const index = createLocalKnowledgeIndex();
  const candidateSummaryEvidence = uniqueStrings([
    input.profile.professionalSummary.fullSummary ?? "",
    input.profile.professionalSummary.shortValueProposition ?? "",
    input.profile.summary ?? "",
    input.profile.narrative.professionalStory ?? "",
    input.profile.narrative.nextChapterSummary ?? "",
    input.profile.narrative.careerTransitionSummary ?? "",
    ...input.profile.narrative.differentiators,
    ...input.profile.experiences
      .map((experience) => experience.summary ?? "")
      .filter(Boolean),
  ]).slice(0, 4);

  const highlightedProofs = input.profile.proofBank.slice(0, 6);

  if (input.profile.baseResume.textContent) {
    index.addDocument(
      input.profile.baseResume.id,
      input.profile.baseResume.textContent,
      {
        tags: ["resume"],
        title: "Base Resume",
        section: "resume",
        sourceId: input.profile.baseResume.id,
      },
    );
  }

  input.profile.experiences.forEach((experience) => {
    const text = [
      experience.title,
      experience.companyName,
      experience.summary,
      ...experience.achievements,
      ...experience.skills,
    ]
      .filter(Boolean)
      .join(" ");
    if (text.trim()) {
      index.addDocument(experience.id, text, {
        tags: ["profile"],
        title: experience.title,
        section: "experience",
        sourceId: experience.id,
      });
    }
  });

  if (
    input.profile.narrative.professionalStory ||
    input.profile.narrative.nextChapterSummary ||
    input.profile.narrative.careerTransitionSummary ||
    input.profile.narrative.differentiators.length > 0 ||
    input.profile.narrative.motivationThemes.length > 0
  ) {
    index.addDocument(
      "profile_narrative",
      [
        input.profile.narrative.professionalStory,
        input.profile.narrative.nextChapterSummary,
        input.profile.narrative.careerTransitionSummary,
        ...input.profile.narrative.differentiators,
        ...input.profile.narrative.motivationThemes,
      ]
        .filter(Boolean)
        .join(" "),
      {
        tags: ["profile"],
        title: "Candidate Narrative",
        section: "narrative",
        sourceId: "profile_narrative",
      },
    );
  }

  highlightedProofs.forEach((proof) => {
    index.addDocument(
      proof.id,
      [
        proof.title,
        proof.claim,
        proof.heroMetric,
        proof.supportingContext,
        ...proof.roleFamilies,
      ]
        .filter(Boolean)
        .join(" "),
      {
        tags: ["profile"],
        title: proof.title,
        section: "proof",
        sourceId: proof.id,
      },
    );
  });

  input.profile.projects.forEach((project) => {
    const text = [
      project.name,
      project.summary,
      project.role,
      project.outcome,
      ...project.skills,
    ]
      .filter(Boolean)
      .join(" ");

    if (text.trim()) {
      index.addDocument(project.id, text, {
        tags: ["profile"],
        title: project.name,
        section: "project",
        sourceId: project.id,
      });
    }
  });

  input.profile.links.forEach((link) => {
    if (!link.label && !link.url) {
      return;
    }

    index.addDocument(
      link.id,
      [link.label, link.url, link.kind].filter(Boolean).join(" "),
      {
        tags: ["profile"],
        title: link.label ?? link.url ?? "Profile link",
        section: "link",
        sourceId: link.id,
      },
    );
  });

  const skillText = uniqueStrings([
    ...input.profile.skills,
    ...input.profile.skillGroups.coreSkills,
    ...input.profile.skillGroups.tools,
    ...input.profile.skillGroups.languagesAndFrameworks,
  ]).join(" ");
  if (skillText.trim()) {
    index.addDocument("profile_skills", skillText, {
      tags: ["profile"],
      title: "Profile Skills",
      section: "skills",
      sourceId: "profile_skills",
    });
  }

  index.addDocument(input.job.id, buildJobContextText(input.job), {
    tags: ["job"],
    title: input.job.title,
    section: "job",
    sourceId: input.job.id,
  });

  input.research.forEach((artifact) => {
    const text = [
      artifact.pageTitle,
      artifact.companyNotes,
      artifact.extractedText,
      ...artifact.domainVocabulary,
      ...artifact.priorityThemes,
    ]
      .filter(Boolean)
      .join(" ");
    if (text.trim()) {
      index.addDocument(artifact.id, text, {
        tags: ["research"],
        title: artifact.pageTitle,
        section: "research",
        sourceId: artifact.id,
      });
    }
  });

  return {
    summary: index
      .search(`${input.job.title} ${input.job.company} summary`, { limit: 3 })
      .map((entry: { text: string }) => entry.text),
    candidateSummary: candidateSummaryEvidence,
    experience: index
      .search(
        `${input.job.title} ${buildPriorityJobTerms(input.job).join(" ")} achievements`,
        {
          limit: 6,
          tags: ["profile", "resume"],
        },
      )
      .map((entry: { text: string }) => entry.text),
    skills: index
      .search(
        `${buildPriorityJobTerms(input.job).join(" ")} ${input.job.title} skills`,
        {
          limit: 6,
          tags: ["profile", "job"],
        },
      )
      .map((entry: { text: string }) => entry.text),
    keywords: uniqueStrings([
      ...buildPriorityJobTerms(input.job),
      ...input.research.flatMap((artifact) => artifact.domainVocabulary),
      ...highlightedProofs.flatMap((proof) => proof.roleFamilies),
    ]).slice(0, 8),
  };
}

export function collectResearchContext(
  research: readonly ResumeResearchArtifact[],
): ResumeWorkspaceResearchContext {
  return {
    companyNotes: research
      .map((artifact) => artifact.companyNotes)
      .filter((value): value is string => Boolean(value))
      .slice(0, 3),
    domainVocabulary: uniqueStrings(
      research.flatMap((artifact) => artifact.domainVocabulary),
    ).slice(0, 8),
    priorityThemes: uniqueStrings(
      research.flatMap((artifact) => artifact.priorityThemes),
    ).slice(0, 6),
  };
}
