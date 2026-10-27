import {
  ResumeImportTargetSectionSchema,
  ResumeImportConflictChoiceSchema,
  type AgentProviderStatus,
  type ResumeImportFieldCandidateDraft,
  type ResumeImportJsonValue,
  ResumeImportVisualEvidenceRefSchema,
} from "@nestor/contracts";
import {
  ResumeImportAdjudicationResultSchema,
  ResumeImportStageExtractionResultSchema,
  sanitizeStageCandidates,
  type AdjudicateResumeImportCandidatesInput,
  type ExtractResumeImportStageInput,
  type ResumeImportAdjudicationResult,
  type ResumeImportStageExtractionResult,
} from "./resume-import";
import { buildCandidateConfidenceBreakdown } from "./resume-import-helpers";
import type { OpenAiCompatibleJsonOperation } from "./openai-compatible-request-compaction";
import type { ModelReasoningEffort } from "./openai-compatible-transport";

const ADJUDICATION_BLOCK_LIMIT = 80;
const ADJUDICATION_CANDIDATE_LIMIT = 24;
// Post-adjudication confidence weighting: adjudicated candidates are assigned a lower
// normalization risk and higher conflict risk compared with extract-path defaults,
// reflecting the pro-normalization review pass that produced them.
const POST_ADJ_NORMALIZATION_RISK = 0.1;
const POST_ADJ_CONFLICT_RISK = 0.34;

/** Omitted saved fields mean empty/unknown; explicit false and zero remain facts. */
function compactSavedContext(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const entries = value
      .map(compactSavedContext)
      .filter((entry) => entry !== undefined);
    return entries.length ? entries : undefined;
  }
  if (typeof value === "object") {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      const compact = compactSavedContext(item);
      if (compact !== undefined) entries.push([key, compact]);
    }
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }

    const trimmed = entry.trim();
    return trimmed ? [trimmed] : [];
  });
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }

  return undefined;
}

function normalizeAlternatives(value: unknown): ResumeImportJsonValue[] {
  if (Array.isArray(value)) {
    return value as ResumeImportJsonValue[];
  }

  return value === null || value === undefined
    ? []
    : [value as ResumeImportJsonValue];
}

function normalizeTarget(
  value: unknown,
): ResumeImportFieldCandidateDraft["target"] | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const sectionResult = ResumeImportTargetSectionSchema.safeParse(
      record.section,
    );
    const key = typeof record.key === "string" ? record.key.trim() : "";
    const recordId =
      typeof record.recordId === "string" ? record.recordId.trim() : null;

    if (sectionResult.success && key) {
      return {
        section: sectionResult.data,
        key,
        recordId: recordId || null,
      };
    }
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/^target\s*[:=]\s*/i, "");
  if (!normalized) {
    return undefined;
  }

  const delimiter = normalized.includes("|")
    ? "|"
    : normalized.includes(":")
      ? ":"
      : ".";
  const parts = normalized
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return undefined;
  }

  const sectionResult = ResumeImportTargetSectionSchema.safeParse(parts[0]);
  if (!sectionResult.success) {
    return undefined;
  }

  const key = parts[1] ?? "";
  const recordId = parts.length > 2 ? parts.slice(2).join(delimiter) : null;

  if (!key) {
    return undefined;
  }

  return {
    section: sectionResult.data,
    key,
    recordId: recordId || null,
  };
}

/** Private model-wire form. The stored candidate schema stays unchanged. */
function expandCompactCandidate(
  value: unknown,
  blocks: readonly { id: string; text: string }[],
): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length < 4 || value.length > 5) return undefined;
  const [targetValue, canonical, rawIds, confidence, extra] =
    value as unknown[];
  const target = normalizeTarget(targetValue);
  if (
    !target ||
    !Array.isArray(rawIds) ||
    !rawIds.every(
      (id): id is string => typeof id === "string" && id.length > 0,
    ) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    (extra !== undefined &&
      (!extra || typeof extra !== "object" || Array.isArray(extra)))
  )
    return undefined;
  const metadata = (extra ?? {}) as Record<string, unknown>;
  const sourceBlockIds = [...new Set(rawIds)];
  const byId = new Map(blocks.map((block) => [block.id, block.text]));
  if (sourceBlockIds.some((id) => !byId.has(id))) return undefined;
  const explicitQuote =
    typeof metadata.evidenceText === "string" && metadata.evidenceText.trim()
      ? metadata.evidenceText
      : null;
  if (!sourceBlockIds.length && !explicitQuote) return undefined;
  const labelKey = target.key === "record" ? target.section : target.key;
  const label = labelKey
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/_/gu, " ")
    .toLowerCase();
  return {
    ...metadata,
    target,
    value: canonical,
    label:
      typeof metadata.label === "string"
        ? metadata.label
        : label[0]!.toUpperCase() + label.slice(1),
    confidence,
    sourceBlockIds,
    // Source text is bookkeeping: copy the model-cited blocks verbatim,
    // without parsing their meaning or inventing any candidate value.
    evidenceText:
      explicitQuote ?? sourceBlockIds.map((id) => byId.get(id)!).join("\n"),
  };
}

function normalizeCandidate(
  raw: unknown,
  blocks: readonly { id: string; text: string }[],
): ResumeImportFieldCandidateDraft | undefined {
  const value = expandCompactCandidate(raw, blocks);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const target = normalizeTarget(record.target);

  if (!target) {
    return undefined;
  }

  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : `${target.section}.${target.key}${target.recordId ? `.${target.recordId}` : ""}`;
  const confidence = normalizeConfidence(record.confidence) ?? 0.5;

  return {
    target,
    label,
    value: (record.value ?? null) as ResumeImportJsonValue,
    normalizedValue: (record.normalizedValue ?? null) as ResumeImportJsonValue,
    valuePreview:
      typeof record.valuePreview === "string" ? record.valuePreview : null,
    evidenceText:
      typeof record.evidenceText === "string" ? record.evidenceText : null,
    sourceBlockIds: toStringArray(record.sourceBlockIds),
    confidence,
    confidenceBreakdown: null,
    notes: toStringArray(record.notes),
    alternatives: normalizeAlternatives(record.alternatives),
    conflictChoices: Array.isArray(record.conflictChoices)
      ? record.conflictChoices.flatMap((entry) => {
          const parsed = ResumeImportConflictChoiceSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    visualEvidence: Array.isArray(record.visualEvidence)
      ? record.visualEvidence.flatMap((entry) => {
          const parsed = ResumeImportVisualEvidenceRefSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
  };
}

export function buildResumeImportStageInstructions(
  stage: ExtractResumeImportStageInput["stage"],
): string {
  switch (stage) {
    case "identity_summary":
      return [
        "Return only identity, contact, location, search-preference and work-eligibility candidates.",
        "Valid target sections: identity, contact, location, search_preferences, work_eligibility.",
        "Use keys such as fullName, firstName, lastName, middleName, headline, summary, currentLocation, timeZone, yearsExperience, email, phone, portfolioUrl, linkedinUrl, githubUrl, personalWebsiteUrl, targetRoles, locations, workModes, employmentTypes, compensation, salaryCurrency.",
        "Read the whole resume, not only its header: a work authorization or work preferences line can sit anywhere.",
        'When the resume states work authorization outright, return work_eligibility.authorizedWorkCountries (an array of the countries or regions named, such as "European Union") and work_eligibility.requiresVisaSponsorship (true or false). Never infer either from where the person lives, studied or worked. Conditional study, training, internship or part-time permits belong in work_eligibility.limitedWorkPermissions: an array of {country, conditions, requiresFutureSponsorship: true|false|null}. Preserve all stated hours, date limits, permitted work and future sponsorship in conditions; never invent legal conditions or put a limited permit in authorizedWorkCountries. A permit can allow some jobs without granting unrestricted authorization.',
        'When the resume states the employment type it wants, return search_preferences.employmentTypes using "Full-time", "Part-time", "Contract", "Temporary" or "Internship". When it states a minimum pay, return search_preferences.compensation as {"minimum": number, "maximum": number or null, "interval": "year", "month", "week", "day" or "hour", "currency": a three-letter code or null, "currencyStatus": "explicit" when a currency code or unambiguous symbol is written, otherwise "needs_clarification"}; a bare "$" is not a currency.',
        "Read work preferences anywhere in the resume. Preserve all stated alternatives: local onsite work or remote dispatching means both onsite and remote, never remote alone. Return search_preferences.workModes as an array of remote, hybrid, onsite or flexible; abstain when the preference is unclear. Do not infer remote-only from a remote option or a past remote job.",
        "Offer explicit role goals as search_preferences.targetRoles. If no explicit goal is stated, offer clear professional headline roles as editable suggestions, separating distinct roles into their own strings. Do not substitute a degree, employer or seniority alone for a target role. Leave unclear goals absent.",
        "Prefer literal values from the document over inferred rewrites.",
        "Identify the person from the contact header beside their email, phone or address, before considering later sections. A job title, volunteer role, degree or section heading is never a person name. Use the contact-header name as evidence for fullName, firstName and lastName; abstain if it is unclear.",
        "Only return currentLocation when the blocks show an address or a short location label, not a narrative sentence. Also return location.currentCity, location.currentRegion and location.currentCountry separately, using null for an absent region. A country is not a state or region. Normalize country names to English, for example Deutschland to Germany; Copenhagen, Denmark has city Copenhagen, region null and country Denmark.",
        'Write targets as "section.key" or "section.key.recordId", for example "identity.fullName". Keep any record id exactly as supplied for an existing record.',
      ].join(" ");
    case "experience":
      return [
        "Return only experience record candidates.",
        "Valid target section: experience.",
        "Use target.key = 'record' and a stable recordId like experience_1, experience_2. Compare each role with existingProfile.experiences, including partial records with missing title or dates. When the employer and available details identify the same role, use that saved record's id as target.recordId so review can complete it without creating a duplicate. Missing details are not contradictions; if multiple saved roles could match, abstain from choosing one and explain the ambiguity in notes.",
        "Each value must be a structured object matching one resume experience record with exactly these keys: companyName, companyUrl, title, employmentType, location, workMode (array), startDate, endDate, isCurrent (boolean), summary, achievements (array of strings), skills (array), domainTags (array).",
        "Write startDate and endDate as YYYY-MM, or as YYYY when the resume gives only the year; never add a month the resume does not state. When the role is ongoing set isCurrent true and endDate null.",
        "Put each achievement under that role into achievements as a separate complete sentence. Respect section boundaries: education, degrees and certifications are not job achievements, even when adjacent to a role. Never attach a qualification earned later to an earlier employer unless the source explicitly states an achievement there.",
        "Use the nearest explicit company marker or inline company segment when the resume shows one, and populate companyName separately from title.",
        "When a role header has no employer on the same line, take the employer from the nearest company marker, section heading, or employer line that governs that role, even if it sits a few lines away; leave companyName null only when the resume never names an employer for that role.",
        "If title, company, and location appear on one header line, split them into the correct fields instead of embedding company or location inside title.",
        "Merge wrapped PDF continuation lines so summaries and achievements read as complete sentences. Rejoin a split number only when the source context supports it, preserving decimal places and units. Use the same supported metric consistently in every derived field; abstain and explain ambiguity rather than inventing digits.",
        "Populate workMode only when the record explicitly says remote, hybrid, onsite, or flexible. Use employmentType Freelance or Self-employed when explicitly stated, preserving that distinction rather than leaving it blank or changing it to Contract.",
        "Include skills only when that specific role header, summary, or achievement explicitly names the skill or directly demonstrates a skill that is also declared in the resume skills section.",
        "Do not copy unrelated global skills onto every experience record.",
        "Do not create an experience record unless the blocks contain an explicit role header or date range.",
        'For record candidates, target must be an object like {"section":"experience","key":"record","recordId":"experience_1"}.',
      ].join(" ");
    case "background":
      return [
        "Return only background candidates for skills, education, certifications, links, projects, and languages.",
        "Read the languages section even when it is below projects or labelled Spoken languages. Return one language record per language with its stated proficiency; a mention in notes is not an imported record. Preserve parenthesized software levels word for word, including advanced, basic or learning, in skill values.",
        "Valid target sections: skill, education, certification, link, project, language.",
        'Use target {"section":"skill","key":"skills","recordId":null} for a complete skills array, and optional skillGroups.coreSkills, skillGroups.tools, skillGroups.languagesAndFrameworks, skillGroups.softSkills, or skillGroups.highlightedSkills for grouped skill arrays.',
        'Use target {"section":"education","key":"record","recordId":"education_1"} for each education object with schoolName, degree, fieldOfStudy, location, startDate, endDate, and summary fields.',
        "Preserve the named qualification and completion date or year in degree and endDate; leave dates absent from the document null rather than inventing months or years.",
        "Do not emit education.institution, education.startDate, education.graduationDate, or education.education scalar targets; fold those values into an education record object.",
        "Use key 'record' for certification, link, project, and language object records.",
        "Keep every explicitly labelled public URL, including Dribbble, as a link record with label, kind, url and notes. Preserve the source label; use kind other when no supported kind applies. A link saved in a contact field can also be a public link; do not drop other labelled links.",
        "For project records use name, projectType, summary, role, skills (array), outcome, projectUrl, repositoryUrl and caseStudyUrl. Preserve the full description and stated research, participant counts, prototypes, tools and testing in summary and outcome. Keep training, personal and volunteer context in projectType and role; a project is not employment. If details cannot be mapped, name the project and the unresolved details in notes with a plain sentence starting Could not import.",
      ].join(" ");
    case "shared_memory":
      return [
        "Return only conservative shared-memory suggestions.",
        "Valid target sections: narrative, proof_point, answer_bank, application_identity.",
        "Never invent sensitive facts such as work authorization, sponsorship, relocation, notice period, availability, or salary expectations.",
        "For application_identity, prefer keys preferredEmail, preferredPhone, or preferredLinkIds.",
        "For proof_point records, use value objects with title, claim, heroMetric, supportingContext, roleFamilies, projectIds, and linkIds. Offer stated achievements, including numbered sales achievements, as reusable evidence for review. Education, degrees and certifications belong in their own sections, never in employer proof points. Attribute a claim to a role only when the source states that achievement for that role.",
        "Give each proof point a meaningful title describing its achievement, never punctuation such as a slash. Rejoin PDF line breaks in metrics only when supported by the source, and use the same number and units as the work-history achievement. Prefer concise reusable narratives grounded in multiple resume lines over clipped fragments from a single wrapped sentence.",
      ].join(" ");
    default:
      return "Return conservative grounded candidates only.";
  }
}

export async function extractOpenAiCompatibleResumeImportStage(input: {
  stageInput: ExtractResumeImportStageInput;
  status: AgentProviderStatus;
  fetchModelJson: (
    operation: OpenAiCompatibleJsonOperation,
    systemPrompt: string,
    userPayload: unknown,
    options?: {
      timeoutMs?: number;
      reasoningEffort?: ModelReasoningEffort | undefined;
    },
  ) => Promise<unknown>;
  timeoutMs: number;
  /** Extraction is read-and-structure work; callers pass a low read effort. */
  reasoningEffort?: ModelReasoningEffort | undefined;
}): Promise<ResumeImportStageExtractionResult> {
  // Section hints are parser guesses; each model read needs the complete document.
  const blocks = [...input.stageInput.documentBundle.blocks].sort(
    (left, right) =>
      left.pageNumber - right.pageNumber ||
      left.readingOrder - right.readingOrder,
  );
  const payload = await input.fetchModelJson(
    "extractResumeImportStage",
    [
      "You extract structured resume import candidates from parsed document blocks.",
      'Return JSON only, as one object: {"candidates":[...],"notes":[...]}. Never return a bare candidate or a bare array.',
      "Use only the provided document as evidence.",
      "Return each candidate as [target, value, sourceBlockIds, confidence], with an optional fifth metadata object. Target is section.key or section.key.recordId; confidence is between 0 and 1. Existing candidate objects remain accepted.",
      "Return the grounded canonical value once. Cite the exact sourceBlockIds; their complete text is retained verbatim as evidence, so do not repeat it. Metadata can supply evidenceText for a more precise quote or when the document has no blocks, a helpful label, meaningful normalizedValue, notes, alternatives, conflictChoices or visualEvidence. Retain every real ambiguity and alternative. Omit empty metadata and duplicate normalizedValue. Record values need only their id and evidenced fields; absent fields receive the existing schema defaults.",
      'Example response: {"candidates":[["identity.fullName","Jane Doe",["block_1"],0.98]]}. With no blocks, use an object candidate with an exact evidenceText quote, or metadata.evidenceText; never guess source ids.',
      "Omitted saved profile/preference fields are empty or unknown, never new evidence. Explicit false and zero are preserved. Compare all provided saved facts before proposing replacements.",
      "Only use sourceBlockIds that exist in the input block list.",
      "Confidence must be a number between 0 and 1.",
      buildResumeImportStageInstructions(input.stageInput.stage),
      "Abstain instead of guessing.",
    ].join(" "),
    {
      stage: input.stageInput.stage,
      existingProfile: compactSavedContext({
        ...input.stageInput.existingProfile,
        baseResume: {
          ...input.stageInput.existingProfile.baseResume,
          textContent: null,
        },
      }),
      existingSearchPreferences: compactSavedContext(
        input.stageInput.existingSearchPreferences,
      ),
      documentBundle: {
        id: input.stageInput.documentBundle.id,
        sourceResumeId: input.stageInput.documentBundle.sourceResumeId,
        ...(blocks.length === 0
          ? { fullText: input.stageInput.documentBundle.fullText }
          : {}),
        parserKinds: input.stageInput.documentBundle.parserKinds,
        warnings: input.stageInput.documentBundle.warnings,
        blocks: blocks.map((block) => ({
          id: block.id,
          pageNumber: block.pageNumber,
          sectionHint: block.sectionHint,
          kind: block.kind,
          text: block.text,
        })),
      },
    },
    { timeoutMs: input.timeoutMs, reasoningEffort: input.reasoningEffort },
  );

  // Models sometimes answer with one bare candidate (or a bare array)
  // instead of the {"candidates":[...]} envelope — observed verbatim from
  // the production route, where a complete experience record was dropped
  // for its wrapping alone. Accept all three shapes.
  const normalizedPayload: Record<string, unknown> = Array.isArray(payload)
    ? { candidates: normalizeTarget(payload[0]) ? [payload] : payload }
    : payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rawCandidates: unknown[] = Array.isArray(normalizedPayload.candidates)
    ? normalizeTarget(normalizedPayload.candidates[0])
      ? [normalizedPayload.candidates]
      : normalizedPayload.candidates
    : normalizedPayload.candidates &&
        typeof normalizedPayload.candidates === "object"
      ? [normalizedPayload.candidates]
      : "target" in normalizedPayload
        ? [normalizedPayload]
        : [];

  return sanitizeStageCandidates(
    input.stageInput,
    ResumeImportStageExtractionResultSchema.parse({
      stage: input.stageInput.stage,
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: input.status.label,
      candidates: rawCandidates
        .map((candidate) =>
          normalizeCandidate(candidate, input.stageInput.documentBundle.blocks),
        )
        .filter((candidate): candidate is ResumeImportFieldCandidateDraft =>
          Boolean(candidate),
        )
        .map((candidate) => ({
          ...candidate,
          confidenceBreakdown: buildCandidateConfidenceBreakdown({
            candidate: {
              target: candidate.target,
              confidence: candidate.confidence,
              sourceBlockIds: candidate.sourceBlockIds,
            },
            bundle: input.stageInput.documentBundle,
          }),
        })),
      notes: toStringArray(normalizedPayload.notes),
    }),
  );
}

export async function adjudicateOpenAiCompatibleResumeImportCandidates(input: {
  adjudicationInput: AdjudicateResumeImportCandidatesInput;
  status: AgentProviderStatus;
  fetchModelJson: (
    operation: OpenAiCompatibleJsonOperation,
    systemPrompt: string,
    userPayload: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
  timeoutMs: number;
}): Promise<ResumeImportAdjudicationResult> {
  const payload = await input.fetchModelJson(
    "adjudicateResumeImportCandidates",
    [
      "You adjudicate conflicting resume import candidates produced by document text extraction and visual scan extraction.",
      "Return JSON only with candidates, notes, and warnings arrays.",
      "Use Pro-style normalization only: produce validated import candidate drafts when a safer normalized value can be grounded in the supplied candidates and document blocks.",
      "Do not invent values. Do not write to the canonical profile. If the conflict is still ambiguous, return no candidates and explain the review need in notes.",
      "Each candidate must include target, label, value, normalizedValue when useful, evidenceText, sourceBlockIds, confidence, notes, alternatives, and may include visualEvidence.",
      "Each candidate target must be an object, not a string.",
      'Example candidate: {"target":{"section":"experience","key":"record","recordId":"experience_1"},"label":"Current role","value":{"title":"Engineer"},"confidence":0.9,"evidenceText":"Senior Engineer at Acme","sourceBlockIds":["b1"],"notes":[],"alternatives":[],"conflictChoices":[{"id":"c1","sourceLabel":"Text extraction","sourceKind":"document_text","confidence":0.85,"valuePreview":"Engineer","recommended":true}],"visualEvidence":[]}',
    ].join(" "),
    {
      existingProfile: input.adjudicationInput.existingProfile,
      existingSearchPreferences:
        input.adjudicationInput.existingSearchPreferences,
      documentBundle: {
        id: input.adjudicationInput.documentBundle.id,
        sourceFileKind: input.adjudicationInput.documentBundle.sourceFileKind,
        quality: input.adjudicationInput.documentBundle.quality ?? null,
        warnings: input.adjudicationInput.documentBundle.warnings,
        blocks: input.adjudicationInput.documentBundle.blocks
          .slice(0, ADJUDICATION_BLOCK_LIMIT)
          .map((block) => ({
            id: block.id,
            pageNumber: block.pageNumber,
            sectionHint: block.sectionHint,
            kind: block.kind,
            text: block.text,
          })),
      },
      candidates: input.adjudicationInput.candidates.slice(
        0,
        ADJUDICATION_CANDIDATE_LIMIT,
      ),
    },
    { timeoutMs: input.timeoutMs },
  );

  const truncationWarnings: string[] = [];
  if (
    input.adjudicationInput.documentBundle.blocks.length >
    ADJUDICATION_BLOCK_LIMIT
  ) {
    truncationWarnings.push(
      `Adjudication input truncated: ${input.adjudicationInput.documentBundle.blocks.length} blocks (>${ADJUDICATION_BLOCK_LIMIT} limit)`,
    );
  }
  if (
    input.adjudicationInput.candidates.length > ADJUDICATION_CANDIDATE_LIMIT
  ) {
    truncationWarnings.push(
      `Adjudication input truncated: ${input.adjudicationInput.candidates.length} candidates (>${ADJUDICATION_CANDIDATE_LIMIT} limit)`,
    );
  }

  const normalizedPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const candidates = Array.isArray(normalizedPayload.candidates)
    ? normalizedPayload.candidates
        .map((candidate) =>
          normalizeCandidate(
            candidate,
            input.adjudicationInput.documentBundle.blocks,
          ),
        )
        .filter((candidate): candidate is ResumeImportFieldCandidateDraft =>
          Boolean(candidate),
        )
        .map((candidate) => ({
          ...candidate,
          confidenceBreakdown: buildCandidateConfidenceBreakdown({
            candidate: {
              target: candidate.target,
              confidence: candidate.confidence,
              sourceBlockIds: candidate.sourceBlockIds,
            },
            bundle: input.adjudicationInput.documentBundle,
            normalizationRisk: POST_ADJ_NORMALIZATION_RISK,
            conflictRisk: POST_ADJ_CONFLICT_RISK,
          }),
        }))
    : [];

  return ResumeImportAdjudicationResultSchema.parse({
    candidates,
    notes: toStringArray(normalizedPayload.notes),
    warnings: [
      ...truncationWarnings,
      ...toStringArray(normalizedPayload.warnings),
    ],
  });
}
