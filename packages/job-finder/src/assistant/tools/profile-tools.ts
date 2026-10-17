import { assertPersonAnswerAuthority } from "../person-answer-authority";
import { readAssistantWorkState } from "../work-state";
import { profileProposalPreview } from "../proposal-preview";
import { isResumeImportRunInProgress } from "@nestor/contracts";
import {
  NonEmptyStringSchema,
  ProfileCopilotPatchOperationSchema,
  ProfileSetupReviewActionSchema,
  evaluateProfileSetupReadiness,
  getProfileSetupReadinessBlockers,
  isProfileSetupFinishBlockingReviewItem,
  type AssistantChangeEntry,
  type AssistantChangeReceipt,
  type AssistantChangeTarget,
  type AssistantMessagePart,
  type CandidateProfile,
  type JobSearchPreferences,
  type JobFinderWorkspaceSnapshot,
  type ResumeImportFieldCandidate,
  type ProfileCopilotPatchOperation,
} from "@nestor/contracts";
import { findBulletsOnTwoCards } from "@nestor/ai-providers";
import { z } from "zod";

import {
  AssistantToolError,
  defineTool,
  argText,
  describeZodIssues,
  json,
  type AssistantToolContext,
} from "../tool-kit";
import { plainFieldName } from "../prompt";
import { plural } from "./format";

const Id = NonEmptyStringSchema.max(200);

/**
 * The long editing rules from the old Profile chat, returned with the first
 * profile read in a conversation instead of sitting in every system prompt.
 */
export const PROFILE_EDITING_RULES = [
  "Profile edits are typed operations sent with edit_profile. Each operation names its kind: replace_identity_fields, replace_professional_summary_fields, replace_work_eligibility_fields, replace_profile_list_fields, remove_profile_list_entries, replace_search_preferences_fields, replace_compensation_preferences_fields, set_resume_approach, upsert_/remove_ experience, education, certification, project, link, language records, upsert_/remove_ proof_point and reusable_answer, reorder_education_records, resolve_review_items.",
  "An update to an existing card (experience, education, certification, link, project, language) carries that card's id from read_profile; an upsert without an id creates a new card. Include only the fields that change.",
  "Use the exact fields in edit_profile's operation schema. Experience uses companyName, summary and achievements (not company, description or bullets); education uses schoolName; projects use summary and projectUrl. workModes and seniorityLevels belong in replace_search_preferences_fields, not replace_profile_list_fields. Unknown fields reject the whole request without saving anything; correct the named fields and retry.",
  "Work modes use remote, hybrid, onsite or flexible. Built-in employment types use Full-time, Part-time, Contract, Internship or Temporary, with spaces or hyphens as shown, never invented snake_case codes. Employment types and seniority levels also accept the person's own custom wording; preserve it when they ask for a custom value.",
  "To end a role, update its card with isCurrent false and endDate YYYY-MM. To fix a date, change only the date fields.",
  "To merge two roles, update the card you keep with the combined dates and every bullet from both, then remove the other card by id, in one edit_profile call.",
  "To split one role in two, update the existing card to the earlier title and dates and add one new card for the later one; each bullet ends up on exactly one card.",
  "To reorder skills, target roles or locations send the whole list in the new order with replace_profile_list_fields; to take entries out use remove_profile_list_entries with the exact entries.",
  "When setting a name, include fullName, firstName and lastName (and middleName when supplied) in replace_identity_fields. Basics displays firstName and lastName; fullName alone is not a visible saved name. Use the person's stated name parts; ask only if ambiguous.",
  "Spoken languages live in Profile > Background (a tab, not a section to scroll to). Use upsert_language_record with record.language and proficiency, then read_profile background to verify the saved list. Import success does not prove every collection was saved: read_document and compare work history, education, skills, links and spoken languages with read_profile; add missing facts from the supplied resume before declaring the import complete.",
  "The professional summary shown in Basics is replace_professional_summary_fields with fullSummary. Headline, contact details and location are replace_identity_fields.",
  "Work eligibility (countries, sponsorship, remote eligibility, relocation, notice period) is replace_work_eligibility_fields; record only what the person said or the resume states.",
  "When the person asks you to remember application answers, save the explicit facts with edit_profile before starting applications, then verify the saved answers with read_profile background. Facts with no dedicated field, such as street address and postcode, use upsert_reusable_answer with record fields kind (other), label, question and answer; reuse an existing answer's id when updating it. currentLocation is the city/region/country, never a street address or postcode. record_instruction records application authorization, not saved answer facts, so it cannot justify saying an address or answer was remembered. Save answers for later only when asked, and never guess missing facts.",
  "The resume level for jobs shortlisted from now on is set_resume_approach: original_resume, conservative (Light), balanced (Tailored) or aggressive.",
  "Never invent experience, credentials, dates, pay currency or metrics.",
  "Setup readiness comes from the setup data returned by read_profile and edit_profile. Before saying setup is finished, check its blockers and required review items. Fill a missing headline from the person's stated target focus when setting up their profile; do not invent past experience. Tell them any remaining required step plainly; a phone number is not required when an email is saved. When the person asks to finish a ready setup, call finish_profile_setup; it saves completion without starting a search.",
  "For setup eligibility, ask only for setup.missingWorkEligibilityAnswers: where the person is legally authorized to work and whether employer visa sponsorship is needed. Existing explicit saved answers count; never ask for an answered item again. Relocation, notice period, availability, remote eligibility and work-mode preferences are optional and must never be described as required setup answers.",
  "For a scanned resume, read_profile section review returns the visual extraction's values and evidence for both saved and pending details, even when read_document has no text. Inspect those results before saying the scan is unreadable. Zero pending suggestions means none needs review; inspect the current import outcome counts and saved profile before reporting what was extracted. Use resolve_import_suggestion for explicit authorized, unambiguous confirmations; leave conflicts or uncertain values for the person rather than accepting every scan suggestion automatically.",
  "Resume import supports PDF, DOCX, TXT and Markdown. Scanned image PDFs have no readable text; visual extraction may read them when available but is not guaranteed. Standalone PNG/JPG images are not supported resume imports. For an unsupported or empty import, ask for a supported file or pasted text, not another photo.",
  'Exact shapes (field replacements take a value object of only the fields that change; set_resume_approach takes a scalar string): {"operation":"replace_identity_fields","value":{"headline":"Staff designer"}}; {"operation":"replace_profile_list_fields","value":{"skills":["Figma","Accessibility"]}} (send the whole new list); {"operation":"replace_profile_list_fields","value":{"targetRoles":["Frontend Engineer","Platform Engineer"]}}; {"operation":"remove_profile_list_entries","field":"skills","values":["Sketch"]}; {"operation":"replace_work_eligibility_fields","value":{"requiresVisaSponsorship":false}}; {"operation":"replace_professional_summary_fields","value":{"fullSummary":"…"}}; {"operation":"set_resume_approach","value":"aggressive"}; {"operation":"upsert_reusable_answer","record":{"kind":"other","label":"Street address","question":"What is your street address?","answer":"14 Fiction Lane"}}; {"operation":"upsert_experience_record","record":{"id":"<card id>","endDate":"2024-06","isCurrent":false}}; {"operation":"remove_experience_record","recordId":"<card id>"}.',
].join(" ");

/** Keep the model's field names and types tied to the canonical contracts. */
function profileOperationJsonSchema(
  schema: z.ZodType<unknown>,
): Record<string, unknown> {
  if (schema instanceof z.ZodOptional)
    return profileOperationJsonSchema(schema.unwrap() as z.ZodType<unknown>);
  if (schema instanceof z.ZodDefault)
    return profileOperationJsonSchema(
      schema.removeDefault() as z.ZodType<unknown>,
    );
  if (schema instanceof z.ZodEffects)
    return profileOperationJsonSchema(schema.innerType() as z.ZodType<unknown>);
  if (schema instanceof z.ZodNullable)
    return {
      anyOf: [
        profileOperationJsonSchema(schema.unwrap() as z.ZodType<unknown>),
        { type: "null" },
      ],
    };
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType<unknown>>;
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [
          key,
          {
            ...profileOperationJsonSchema(field),
            ...(key === "employmentTypes" || key === "employmentType"
              ? {
                  description:
                    "Built-in labels: Full-time, Part-time, Contract, Internship, Temporary. Use these spellings for standard types, not full_time/part_time. Custom wording is allowed when the person requests it.",
                }
              : {}),
          },
        ]),
      ),
      required: Object.entries(shape)
        .filter(([, field]) => !field.isOptional())
        .map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (schema instanceof z.ZodArray)
    return {
      type: "array",
      items: profileOperationJsonSchema(schema.element as z.ZodType<unknown>),
    };
  if (schema instanceof z.ZodDiscriminatedUnion || schema instanceof z.ZodUnion)
    return {
      anyOf: (schema.options as z.ZodType<unknown>[]).map(
        profileOperationJsonSchema,
      ),
    };
  if (schema instanceof z.ZodEnum)
    return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodNull) return { type: "null" };
  throw new Error(
    `Unsupported profile operation schema: ${schema.constructor.name}`,
  );
}

/** Contract parsing supplies defaults and refinements, but strips extra keys. */
function unknownProfileFields(
  schema: z.ZodType<unknown>,
  value: unknown,
  location: string,
): string[] {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return value === undefined || value === null
      ? []
      : unknownProfileFields(
          schema.unwrap() as z.ZodType<unknown>,
          value,
          location,
        );
  if (schema instanceof z.ZodDefault)
    return unknownProfileFields(
      schema.removeDefault() as z.ZodType<unknown>,
      value,
      location,
    );
  if (schema instanceof z.ZodEffects)
    return unknownProfileFields(
      schema.innerType() as z.ZodType<unknown>,
      value,
      location,
    );
  if (
    schema instanceof z.ZodDiscriminatedUnion &&
    value !== null &&
    typeof value === "object"
  ) {
    const discriminator = (value as Record<string, unknown>)[
      schema.discriminator as string
    ];
    const matching =
      typeof discriminator === "string"
        ? schema.optionsMap.get(discriminator)
        : undefined;
    return matching ? unknownProfileFields(matching, value, location) : [];
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as z.ZodType<unknown>[];
    const matching = options.find((option) => option.safeParse(value).success);
    return matching ? unknownProfileFields(matching, value, location) : [];
  }
  if (schema instanceof z.ZodArray && Array.isArray(value))
    return value.flatMap((entry, index) =>
      unknownProfileFields(
        schema.element as z.ZodType<unknown>,
        entry,
        `${location}[${index}]`,
      ),
    );
  if (
    schema instanceof z.ZodObject &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const shape = schema.shape as Record<string, z.ZodType<unknown>>;
    return Object.entries(value).flatMap(([key, entry]) =>
      Object.hasOwn(shape, key)
        ? unknownProfileFields(shape[key]!, entry, `${location}.${key}`)
        : [
            `${location}.${key}: Unknown field. Allowed fields: ${Object.keys(shape).join(", ")}.`,
          ],
    );
  }
  return [];
}

const SECTIONS = [
  "basics",
  "experience",
  "background",
  "preferences",
  "review",
  "all",
] as const;

function basics(profile: CandidateProfile) {
  return {
    fullName: profile.fullName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    summary: profile.professionalSummary.fullSummary ?? profile.summary,
    shortValueProposition: profile.professionalSummary.shortValueProposition,
    email: profile.email,
    phone: profile.phone,
    currentLocation: profile.currentLocation,
    timeZone: profile.timeZone,
    yearsExperience: profile.yearsExperience,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    portfolioUrl: profile.portfolioUrl,
    personalWebsiteUrl: profile.personalWebsiteUrl,
    skills: profile.skills,
    skillGroups: profile.skillGroups,
    targetRoles: profile.targetRoles,
    locations: profile.locations,
    workEligibility: profile.workEligibility,
  };
}

function experience(profile: CandidateProfile) {
  return {
    experiences: profile.experiences.map((entry) => ({
      id: entry.id,
      title: entry.title,
      companyName: entry.companyName,
      location: entry.location,
      startDate: entry.startDate,
      endDate: entry.endDate,
      isCurrent: entry.isCurrent,
      summary: entry.summary,
      achievements: entry.achievements,
      skills: entry.skills,
    })),
    education: profile.education,
    certifications: profile.certifications,
  };
}

function background(profile: CandidateProfile) {
  return {
    projects: profile.projects,
    links: profile.links,
    spokenLanguages: profile.spokenLanguages,
    proofBank: profile.proofBank,
    narrative: profile.narrative,
    answerBank: {
      ...profile.answerBank,
      customAnswers: profile.answerBank.customAnswers,
    },
    applicationIdentity: profile.applicationIdentity,
  };
}

function preferences(searchPreferences: JobSearchPreferences) {
  return {
    targetRoles: searchPreferences.targetRoles,
    jobFamilies: searchPreferences.jobFamilies,
    locations: searchPreferences.locations,
    excludedLocations: searchPreferences.excludedLocations,
    workModes: searchPreferences.workModes,
    seniorityLevels: searchPreferences.seniorityLevels,
    employmentTypes: searchPreferences.employmentTypes,
    targetIndustries: searchPreferences.targetIndustries,
    targetCompanyStages: searchPreferences.targetCompanyStages,
    companyBlacklist: searchPreferences.companyBlacklist,
    companyWhitelist: searchPreferences.companyWhitelist,
    compensation: searchPreferences.compensation,
    tailoringMode: searchPreferences.tailoringMode,
  };
}

function setupReadiness(snapshot: JobFinderWorkspaceSnapshot) {
  const readiness = evaluateProfileSetupReadiness(
    snapshot.profile,
    snapshot.searchPreferences,
  );
  const blockers = getProfileSetupReadinessBlockers(readiness);
  const missingWorkEligibilityAnswers = [
    ...(!snapshot.profile.workEligibility.authorizedWorkCountries.some(
      (country) => country.trim().length > 0,
    ) && !snapshot.profile.answerBank.workAuthorization?.trim()
      ? [
          {
            field: "authorizedWorkCountries",
            label:
              "countries or regions where you are legally authorized to work",
          },
        ]
      : []),
    ...(snapshot.profile.workEligibility.requiresVisaSponsorship === null &&
    !snapshot.profile.answerBank.visaSponsorship?.trim()
      ? [
          {
            field: "requiresVisaSponsorship",
            label: "whether employer visa sponsorship is needed",
          },
        ]
      : []),
  ];
  const requiredReviewItems = snapshot.profileSetupState.reviewItems
    .filter(isProfileSetupFinishBlockingReviewItem)
    .map((item) => ({
      id: item.id,
      label: item.label,
      reason: item.reason,
      step: item.step,
    }));
  return {
    status: snapshot.profileSetupState.status,
    canFinish: blockers.length === 0 && requiredReviewItems.length === 0,
    blockers,
    missingWorkEligibilityAnswers,
    requiredReviewItems: requiredReviewItems.slice(0, 40),
    requiredReviewItemCount: requiredReviewItems.length,
    note: "Only these canonical blockers and critical review items prevent finishing guided setup. The only eligibility answers that can block Finish are the missing authorization and sponsorship answers listed here. Relocation, notice period, availability, remote eligibility and work-mode preferences are optional. Search and application readiness are separate.",
  };
}

function importCandidateEvidence(candidate: ResumeImportFieldCandidate) {
  return {
    candidateId: candidate.id,
    runId: candidate.runId,
    target: candidate.target,
    value: candidate.normalizedValue ?? candidate.value,
    confidence: candidate.confidence,
    confidenceBreakdown: candidate.confidenceBreakdown ?? null,
    evidenceText: candidate.evidenceText?.slice(0, 2400) ?? null,
    visualEvidence: candidate.visualEvidence?.slice(0, 8) ?? [],
    notes: candidate.notes.slice(0, 8).map((note) => note.slice(0, 500)),
    resolution: candidate.resolution,
  };
}

/** Stay below the host's result limit while retaining explicit page progress. */
function paginateProfileReview(
  data: Record<string, unknown>,
  input: {
    reviewOffset?: number | undefined;
    importOffset?: number | undefined;
    limit?: number | undefined;
  },
) {
  const reviewRows = data.reviewItems as Record<string, unknown>[];
  const importRows = data.importCandidates as Record<string, unknown>[];
  const limit = input.limit ?? 40;
  const offsets = {
    reviewItems: Math.min(input.reviewOffset ?? 0, reviewRows.length),
    importCandidates: Math.min(input.importOffset ?? 0, importRows.length),
  };
  const rows = { reviewItems: reviewRows, importCandidates: importRows };
  const pages: Record<keyof typeof rows, Record<string, unknown>[]> = {
    reviewItems: [],
    importCandidates: [],
  };
  function update() {
    for (const key of ["reviewItems", "importCandidates"] as const) {
      data[key] = pages[key];
      data[key === "reviewItems" ? "reviewPage" : "importPage"] = {
        offset: offsets[key],
        returned: pages[key].length,
        total: rows[key].length,
        nextOffset:
          offsets[key] + pages[key].length < rows[key].length
            ? offsets[key] + pages[key].length
            : null,
      };
    }
    const nextReview = offsets.reviewItems + pages.reviewItems.length;
    const nextImport = offsets.importCandidates + pages.importCandidates.length;
    data.nextRead =
      nextReview < reviewRows.length || nextImport < importRows.length
        ? {
            section: "review",
            reviewOffset: nextReview,
            importOffset: nextImport,
            limit,
          }
        : null;
  }
  function fits() {
    return JSON.stringify(data).length < 11_000;
  }
  function add(key: keyof typeof rows, compact = false) {
    const index = offsets[key] + pages[key].length;
    if (index >= rows[key].length || pages[key].length >= limit) return false;
    const row = rows[key][index]!;
    const next = compact
      ? {
          ...row,
          ...(key === "importCandidates"
            ? {
                value: JSON.stringify(row.value).slice(0, 1800),
                valueTruncated: true,
                evidenceText:
                  typeof row.evidenceText === "string"
                    ? row.evidenceText.slice(0, 600)
                    : null,
                visualEvidence: Array.isArray(row.visualEvidence)
                  ? (row.visualEvidence as unknown[])
                      .slice(0, 1)
                      .map((entry) => {
                        const evidence = entry as Record<string, unknown>;
                        return {
                          branch: evidence.branch,
                          sourceFileKind: evidence.sourceFileKind,
                          pageNumber: evidence.pageNumber,
                          confidence: evidence.confidence,
                          regionHint:
                            typeof evidence.regionHint === "string"
                              ? evidence.regionHint.slice(0, 200)
                              : null,
                          uncertaintyNotes: Array.isArray(
                            evidence.uncertaintyNotes,
                          )
                            ? (evidence.uncertaintyNotes as unknown[])
                                .slice(0, 2)
                                .map((note) =>
                                  typeof note === "string"
                                    ? note.slice(0, 100)
                                    : note,
                                )
                            : [],
                        };
                      })
                  : [],
                notes: Array.isArray(row.notes)
                  ? (row.notes as unknown[])
                      .slice(0, 2)
                      .map((note) =>
                        typeof note === "string" ? note.slice(0, 200) : note,
                      )
                  : [],
              }
            : {
                proposedValue:
                  typeof row.proposedValue === "string"
                    ? row.proposedValue.slice(0, 800)
                    : null,
                reason:
                  typeof row.reason === "string"
                    ? row.reason.slice(0, 400)
                    : null,
                sourceSnippet:
                  typeof row.sourceSnippet === "string"
                    ? row.sourceSnippet.slice(0, 500)
                    : null,
              }),
        }
      : row;
    pages[key].push(next);
    update();
    if (fits()) return true;
    pages[key].pop();
    update();
    return false;
  }
  update();
  for (const key of ["importCandidates", "reviewItems"] as const) {
    if (offsets[key] >= rows[key].length) continue;
    if (
      !add(key) &&
      pages.importCandidates.length + pages.reviewItems.length === 0
    ) {
      // First-read rules must never prevent advancing through actual evidence.
      delete data.editingRules;
      if (!add(key)) add(key, true);
    }
  }
  while (true) {
    const addedImport = add("importCandidates");
    const addedReview = add("reviewItems");
    if (!addedImport && !addedReview) break;
  }
  update();
}

export const readProfileTool = defineTool({
  name: "read_profile",
  group: "profile",
  description:
    "Reads the saved profile and setup readiness by section: basics, experience, background (including saved answers), preferences, review, or all. Review provides byte-bounded pages of current imported values and text/visual evidence, for both saved and pending details including scans. Follow returned nextRead arguments until null before claiming every section or imported detail was checked. all returns counts and points to dedicated review pages for evidence.",
  parameters: json.object({
    section: json.enumOf(SECTIONS),
    reviewOffset: {
      type: "integer",
      minimum: 0,
      description: "Pending review offset from nextRead.",
    },
    importOffset: {
      type: "integer",
      minimum: 0,
      description: "Current import evidence offset from nextRead.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 40,
      description: "Maximum rows per list; the byte budget may return fewer.",
    },
  }),
  input: z.object({
    section: z.enum(SECTIONS).default("all"),
    reviewOffset: z.number().int().nonnegative().optional(),
    importOffset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  label: (input) =>
    input.section && input.section !== "all"
      ? `Reading your profile (${argText(input.section)})`
      : "Reading your profile",
  effect: "read",
  async execute(input, { service, session, ports }) {
    const snapshot = await service.getWorkspaceSnapshot();
    const work = readAssistantWorkState(ports, snapshot);
    const { profile, searchPreferences } = snapshot;
    const pendingReview = snapshot.profileSetupState.reviewItems.filter(
      (item) => item.status === "pending",
    );
    const data: Record<string, unknown> = {
      setup: setupReadiness(snapshot),
      resumeImport: work.resumeImport,
    };
    if (input.section === "review" || input.section === "all") {
      const importState = await service.getResumeImportState();
      const currentRun =
        snapshot.latestResumeImportRun ??
        [...importState.resumeImportRuns].sort((left, right) =>
          right.startedAt.localeCompare(left.startedAt),
        )[0];
      const runCandidates = importState.resumeImportFieldCandidates.filter(
        (candidate) => candidate.runId === currentRun?.id,
      );
      const currentCandidates = runCandidates.filter(
        (candidate) => candidate.resolution === "needs_review",
      );
      data.importOutcome = currentRun
        ? {
            runId: currentRun.id,
            sourceResumeId: currentRun.sourceResumeId,
            sourceFileName: currentRun.sourceResumeFileName,
            status: currentRun.status,
            isStillImporting:
              work.resumeImport.active ||
              importState.activeVisionRunIds.includes(currentRun.id) ||
              isResumeImportRunInProgress(currentRun),
            totalDetailCount: runCandidates.length,
            savedDetailCount: runCandidates.filter(
              (candidate) => candidate.resolution === "auto_applied",
            ).length,
            pendingDetailCount: currentCandidates.length,
            rejectedDetailCount: runCandidates.filter(
              (candidate) => candidate.resolution === "rejected",
            ).length,
            abstainedDetailCount: runCandidates.filter(
              (candidate) => candidate.resolution === "abstained",
            ).length,
            note: "Pending suggestions are only unresolved details. Use these counts and the saved profile to describe extraction; zero pending suggestions does not mean no extracted values. Candidate evidence includes saved details, labeled by resolution.",
          }
        : null;
      const currentReview = pendingReview.filter(
        (item) =>
          item.sourceRunId === null || item.sourceRunId === currentRun?.id,
      );
      data.reviewItems = currentReview.map((item) => ({
        id: item.id,
        label: item.label,
        reason: item.reason,
        proposedValue: item.proposedValue,
        step: item.step,
        severity: item.severity,
        sourceCandidateId: item.sourceCandidateId,
        sourceRunId: item.sourceRunId,
        sourceSnippet: item.sourceSnippet?.slice(0, 2400) ?? null,
      }));
      data.importCandidates = runCandidates.map(importCandidateEvidence);
      data.pendingReviewCount = currentReview.length;
      data.pendingImportCandidateCount = currentCandidates.length;
      data.reviewGuidance =
        "Evidence and review items are separate lists joined by sourceCandidateId/candidateId and sourceRunId/runId. Follow nextRead until null for a full cross-check. Saved candidates remain readable; zero pending suggestions means none needs review. If a value is marked truncated, inspect the corresponding saved profile section before claiming a full comparison.";
      if (input.section === "all") {
        data.reviewItems = [];
        data.importCandidates = [];
        data.nextRead = { section: "review", reviewOffset: 0, importOffset: 0 };
      }
    }
    if (input.section === "basics" || input.section === "all")
      data.basics = basics(profile);
    if (input.section === "experience" || input.section === "all")
      data.experience = experience(profile);
    if (input.section === "background" || input.section === "all")
      data.background = background(profile);
    if (input.section === "preferences" || input.section === "all") {
      data.preferences = preferences(searchPreferences);
      data.resumeApproach =
        snapshot.settings.resumeApplicationMode === "original_resume"
          ? "original_resume"
          : searchPreferences.tailoringMode;
    }
    const editor = session.context?.editor;
    if (editor?.editor === "profile" && editor.dirtyFields.length > 0) {
      data.unsavedInEditor = {
        fields: editor.dirtyFields,
        ...(input.section === "review" ? {} : { values: editor.unsavedValues }),
        note: "The person has edited these fields on screen without saving. Treat the on-screen values as what they see; do not overwrite these fields unless they ask you to.",
      };
    }
    if (await session.firstProfileRead()) {
      data.editingRules = PROFILE_EDITING_RULES;
    }
    if (input.section === "review") {
      const setup = data.setup as ReturnType<typeof setupReadiness>;
      data.setup = {
        ...setup,
        requiredReviewItems: setup.requiredReviewItems
          .slice(0, 4)
          .map((item) => ({
            ...item,
            label: item.label.slice(0, 200),
            reason: item.reason.slice(0, 400),
          })),
      };
      paginateProfileReview(data, input);
    }
    return {
      summary: `Profile for ${profile.fullName || "the person"}: ${plural(profile.experiences.length, "role")}, ${plural(profile.skills.length, "skill")}, ${plural(pendingReview.length, "import suggestion")} waiting.`,
      data,
    };
  },
});

export const finishProfileSetupTool = defineTool({
  name: "finish_profile_setup",
  group: "profile",
  description:
    "Finishes guided setup when the person asks, using the same saved readiness and required review checks as the Finish control. Reports remaining requirements without changing anything when blocked. Does not start a search or application.",
  parameters: json.object({}),
  input: z.object({}).strict(),
  label: () => "Finishing profile setup",
  effect: "local_write",
  async execute(_input, { service, session, ports }) {
    const snapshot = await service.getWorkspaceSnapshot();
    const setup = setupReadiness(snapshot);
    if (setup.status === "completed") {
      return {
        summary: "Setup is already finished. No search or application started.",
        data: { setup },
      };
    }
    const editor = session.context?.editor;
    if (editor?.editor === "profile" && editor.dirtyFields.length > 0) {
      throw new AssistantToolError(
        "conflict",
        "Save the unsaved profile fields before finishing setup.",
        { unsavedFields: editor.dirtyFields, setup },
      );
    }
    if (!setup.canFinish) {
      const labels: Record<string, string> = {
        identity_contact: "name and one contact method",
        discovery_source: "an enabled job source",
        work_eligibility_answers: setup.missingWorkEligibilityAnswers
          .map((answer) => answer.label)
          .join(" and "),
      };
      const remaining = [
        ...setup.blockers.map((blocker) => labels[blocker.id] ?? blocker.id),
        ...setup.requiredReviewItems.map((item) => item.label),
      ];
      throw new AssistantToolError(
        "missing_information",
        `Setup cannot finish yet. Still needed: ${remaining.join("; ")}. Nothing changed.`,
        { setup },
      );
    }
    session.assertCurrent();
    const now = new Date().toISOString();
    const updated = await service.saveProfileSetupState({
      ...snapshot.profileSetupState,
      status: "completed",
      currentStep: "targeting",
      completedAt: snapshot.profileSetupState.completedAt ?? now,
      lastResumedAt: now,
    });
    ports.publishWorkspaceUpdate();
    const savedSetup = setupReadiness(updated);
    if (savedSetup.status !== "completed") {
      throw new AssistantToolError(
        "missing_information",
        "Setup still has required details or reviews after refreshing the saved profile.",
        { setup: savedSetup },
      );
    }
    return {
      summary:
        "Setup finished. Ready to find jobs; no search or application started.",
      data: { setup: savedSetup },
    };
  },
});

/** Top-level profile fields an operation writes, in the editor's field names. */
export function fieldsTouchedByOperation(
  operation: ProfileCopilotPatchOperation,
): string[] {
  switch (operation.operation) {
    case "replace_identity_fields":
      return Object.keys(operation.value).flatMap((key) =>
        key === "summary" ? ["summary", "professionalSummary"] : [key],
      );
    case "replace_work_eligibility_fields":
      return ["workEligibility"];
    case "replace_professional_summary_fields":
      return ["professionalSummary", "summary"];
    case "replace_narrative_fields":
      return ["narrative"];
    case "replace_answer_bank_fields":
    case "upsert_reusable_answer":
    case "remove_reusable_answer":
      return ["answerBank"];
    case "replace_application_identity_fields":
      return ["applicationIdentity"];
    case "replace_skill_group_fields":
      return ["skillGroups"];
    case "replace_profile_list_fields":
      return Object.keys(operation.value);
    case "remove_profile_list_entries":
      return [operation.field];
    case "replace_search_preferences_fields":
      return Object.keys(operation.value);
    case "replace_compensation_preferences_fields":
      return ["compensation"];
    case "set_resume_approach":
      return ["tailoringMode"];
    case "upsert_experience_record":
    case "remove_experience_record":
      return ["experiences"];
    case "upsert_education_record":
    case "remove_education_record":
    case "reorder_education_records":
      return ["education"];
    case "upsert_certification_record":
    case "remove_certification_record":
      return ["certifications"];
    case "upsert_project_record":
    case "remove_project_record":
      return ["projects"];
    case "upsert_link_record":
    case "remove_link_record":
      return ["links"];
    case "upsert_language_record":
    case "remove_language_record":
      return ["spokenLanguages"];
    case "upsert_proof_point":
    case "remove_proof_point":
      return ["proofBank"];
    case "resolve_review_items":
      return [];
  }
}

function parseOperations(
  raw: readonly unknown[],
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
): ProfileCopilotPatchOperation[] {
  const operations: ProfileCopilotPatchOperation[] = [];
  const problems: string[] = [];
  let discovery = searchPreferences.discovery;
  raw.forEach((entry, index) => {
    const unknownFields = unknownProfileFields(
      ProfileCopilotPatchOperationSchema,
      entry,
      `operations[${index}]`,
    );
    // Merge before schema defaults can turn an omitted source list into [].
    let candidate = entry;
    if (
      entry &&
      typeof entry === "object" &&
      "operation" in entry &&
      entry.operation === "replace_search_preferences_fields" &&
      "value" in entry &&
      entry.value &&
      typeof entry.value === "object" &&
      "discovery" in entry.value &&
      entry.value.discovery &&
      typeof entry.value.discovery === "object" &&
      !Array.isArray(entry.value.discovery)
    ) {
      if (
        unknownFields.length === 0 &&
        Object.hasOwn(entry.value.discovery, "targets")
      ) {
        problems.push(
          "Source lists cannot be replaced through edit_profile. Use update_sources to add or enable/disable only the requested sources; omit discovery.targets here.",
        );
        return;
      }
      candidate = {
        ...entry,
        value: {
          ...entry.value,
          discovery: {
            ...discovery,
            ...entry.value.discovery,
          },
        },
      };
    }
    const parsed = ProfileCopilotPatchOperationSchema.safeParse(candidate);
    if (
      parsed.success &&
      parsed.data.operation === "replace_identity_fields" &&
      parsed.data.value.fullName &&
      (parsed.data.value.fullName !== profile.fullName || !profile.firstName) &&
      (parsed.data.value.firstName === undefined ||
        parsed.data.value.lastName === undefined)
    ) {
      problems.push(
        "A name change must include firstName and, when present, lastName alongside fullName so Basics shows the saved name. Use the person's stated name; do not guess ambiguous name parts.",
      );
      return;
    }
    if (unknownFields.length > 0) problems.push(...unknownFields);
    else if (parsed.success) {
      operations.push(parsed.data);
      if (
        parsed.data.operation === "replace_search_preferences_fields" &&
        parsed.data.value.discovery
      ) {
        discovery = parsed.data.value.discovery;
      }
    } else
      problems.push(`operations[${index}]: ${describeZodIssues(parsed.error)}`);
  });
  if (problems.length > 0) {
    throw new AssistantToolError("invalid_input", problems.join(" | "));
  }
  const bulletIssues = findBulletsOnTwoCards(profile, [
    {
      id: "assistant_check",
      summary: "check",
      applyMode: "needs_review",
      operations,
      createdAt: new Date(0).toISOString(),
    },
  ]);
  if (bulletIssues.length > 0) {
    throw new AssistantToolError(
      "invalid_input",
      bulletIssues.map((issue) => issue.message).join(" "),
    );
  }
  return operations;
}

async function recordEditChanges(
  context: AssistantToolContext,
  changes: readonly {
    target: AssistantChangeTarget;
    targetId: string | null;
    entries: AssistantChangeEntry[];
  }[],
  summary: string,
): Promise<{
  parts: AssistantMessagePart[];
  receiptIds: string[];
  fields: string[];
}> {
  const parts: AssistantMessagePart[] = [];
  const receiptIds: string[] = [];
  const fields: string[] = [];
  // One receipt for the whole request: profile, preference and settings
  // halves undo together, the way the person asked for them.
  const entries = changes.flatMap((change) =>
    change.entries.map((entry) => ({
      ...entry,
      path: [change.target, ...entry.path],
    })),
  );
  if (entries.length === 0) return { parts, receiptIds, fields };
  const recorded = await context.session.recordChange({
    target: changes[0]!.target,
    targetId: changes[0]!.targetId,
    summary,
    entries,
  });
  parts.push(recorded.part);
  receiptIds.push(recorded.receipt.id);
  fields.push(...recorded.receipt.fieldLabels);
  return { parts, receiptIds, fields };
}

export const editProfileTool = defineTool({
  name: "edit_profile",
  group: "profile",
  description:
    "Changes the saved profile or search preferences with typed operations (see the editing rules returned by read_profile). mode apply commits at once with a per-change Undo, for what the person asked you to change; mode suggest leaves the changes as a proposal the person accepts or rejects, for improvements they did not ask for. Returns the exact fields changed.",
  parameters: json.object(
    {
      summary: json.string("What this change does, in a few plain words."),
      operations: json.array(
        profileOperationJsonSchema(ProfileCopilotPatchOperationSchema),
      ),
      mode: json.enumOf(["apply", "suggest"]),
    },
    ["summary", "operations"],
  ),
  input: z.object({
    summary: z.string().trim().min(1).max(300),
    operations: z.array(z.unknown()).min(1).max(40),
    mode: z.enum(["apply", "suggest"]).default("apply"),
  }),
  label: (input) =>
    input.mode === "suggest"
      ? "Preparing suggested profile changes"
      : `Updating your profile: ${argText(input.summary).slice(0, 80)}`,
  effect: "local_write",
  async execute(input, context) {
    const { service, session } = context;
    const snapshot = await service.getWorkspaceSnapshot();
    const operations = parseOperations(
      input.operations,
      snapshot.profile,
      snapshot.searchPreferences,
    );

    const editor = session.context?.editor;
    if (editor?.editor === "profile" && editor.dirtyFields.length > 0) {
      const dirtyTop = new Set(
        editor.dirtyFields.map((field) => field.split(/[.[]/u)[0] ?? field),
      );
      const clashes = [
        ...new Set(operations.flatMap(fieldsTouchedByOperation)),
      ].filter((field) => dirtyTop.has(field));
      if (clashes.length > 0 && input.mode === "apply") {
        throw new AssistantToolError(
          "conflict",
          `The person has unsaved edits on screen in ${clashes.map(plainFieldName).join(", ")}. Ask whether to replace them or leave those fields out.`,
          { unsavedFields: clashes, unsavedValues: editor.unsavedValues },
        );
      }
    }

    if (input.mode === "suggest") {
      const { proposal, part } = await session.createProposal({
        kind: "profile_operations",
        targetId: null,
        summary: input.summary,
        items: operations.map((operation, index) => ({
          id: `item_${index + 1}`,
          ...profileProposalPreview(operation, snapshot),
          payload: operation,
        })),
        baseRevision: snapshot.generatedAt,
      });
      return {
        summary: `Suggested ${plural(operations.length, "change")}; nothing changes until the person accepts.`,
        data: { proposalId: proposal.id },
        parts: [part],
      };
    }

    const savedAnswers = operations.flatMap((operation) => {
      if (operation.operation === "upsert_reusable_answer") {
        const existing = snapshot.profile.answerBank.customAnswers.find(
          (answer) => answer.id === operation.record.id,
        );
        if (
          operation.record.answer === undefined ||
          existing?.answer === operation.record.answer
        )
          return [];
        const question =
          operation.record.question ??
          operation.record.label ??
          existing?.question ??
          existing?.label;
        const answer = operation.record.answer ?? existing?.answer;
        return question && answer ? [{ question, answer }] : [];
      }
      if (operation.operation === "replace_answer_bank_fields")
        return Object.entries(operation.value).flatMap(([question, answer]) =>
          typeof answer === "string" && answer.trim()
            ? [{ question, answer }]
            : [],
        );
      return [];
    });
    if (savedAnswers.length)
      await assertPersonAnswerAuthority(session, {
        answers: savedAnswers,
        saveForFuture: true,
      });
    session.assertCurrent();
    const result = await service.applyAssistantProfileOperations({
      operations,
      summary: input.summary,
      messageId: session.sourceMessage?.id ?? null,
    });
    const savedSnapshot = await service.getWorkspaceSnapshot();
    const setup = setupReadiness(savedSnapshot);
    const recorded = await recordEditChanges(
      context,
      result.changes,
      input.summary,
    );
    context.ports.publishWorkspaceUpdate();
    if (recorded.receiptIds.length === 0) {
      return {
        summary: "Nothing changed: the profile already says that.",
        status: "done",
        data: { setup },
      };
    }
    return {
      summary: `Saved: ${input.summary}. Changed ${recorded.fields.join(", ")}.${
        result.invalidatedApprovedResumeJobIds.length > 0
          ? ` This cleared approval on ${plural(result.invalidatedApprovedResumeJobIds.length, "resume")}; those resumes are now stale and need refreshing and fresh review before they can be sent.`
          : ""
      }`,
      data: {
        receiptId: recorded.receiptIds[0],
        changedFields: recorded.fields,
        savedIdentity: basics(savedSnapshot.profile),
        savedLanguages: savedSnapshot.profile.spokenLanguages,
        savedSearchPreferences: preferences(savedSnapshot.searchPreferences),
        savedSourceCount:
          savedSnapshot.searchPreferences.discovery.targets.length,
        invalidatedApprovedResumeJobIds: result.invalidatedApprovedResumeJobIds,
        setup,
      },
      parts: recorded.parts,
    };
  },
});

export const undoChangeTool = defineTool({
  name: "undo_change",
  group: "profile",
  description:
    "Undoes one earlier assistant change by its receipt id (from a change you made, or 'undo that'). Later edits by the person or by you are kept; fields changed again since are named and left alone.",
  parameters: json.object({ receiptId: json.string() }, ["receiptId"]),
  input: z.object({ receiptId: Id }),
  label: () => "Undoing a change",
  effect: "local_write",
  async execute(input, context) {
    const receipt = await context.session.getReceipt(input.receiptId);
    if (!receipt) {
      throw new AssistantToolError(
        "not_found",
        "No change with that receipt id in this conversation.",
      );
    }
    context.session.assertCurrent();
    const outcome = await undoReceipt(context, receipt.id);
    return {
      summary: outcome.message,
      data: { status: outcome.receipt.status },
    };
  },
});

/**
 * Undo of one receipt, shared by the tool and the Undo button. Profile,
 * preference and settings entries are routed to their own stores.
 */
export async function undoReceipt(
  context: Pick<AssistantToolContext, "service" | "session" | "ports">,
  receiptId: string,
): Promise<{
  receipt: AssistantChangeReceipt;
  message: string;
}> {
  const { service, session } = context;
  const receipt = await session.getReceipt(receiptId);
  if (!receipt)
    throw new AssistantToolError("not_found", "That change is gone.");
  if (receipt.status === "undone") {
    return { receipt, message: "That change was already undone." };
  }
  const strip = (target: string) =>
    receipt.entries
      .filter((entry) => entry.path[0] === target)
      .map((entry) => ({ ...entry, path: entry.path.slice(1) }));
  let undone: string[] = [];
  let conflicts: string[] = [];
  if (receipt.target === "search_plan") {
    const { undoSearchPlanChange } = await import("./search-plan-tools");
    const result = await undoSearchPlanChange(context, receipt);
    undone = result.undoneLabels;
    conflicts = result.conflictLabels;
  } else if (receipt.target === "resume_draft") {
    const result = await service.undoAssistantResumeChange({
      jobId: receipt.targetId ?? "",
      entries: receipt.entries,
      reason: `Undid assistant change: ${receipt.summary}`,
    });
    undone = result.undoneLabels;
    conflicts = result.conflictLabels;
  } else {
    const profileEntries = strip("profile");
    const preferenceEntries = strip("search_preferences");
    const settingsEntries = strip("settings");
    if (profileEntries.length > 0 || preferenceEntries.length > 0) {
      const result = await service.undoAssistantProfileChange({
        profileEntries,
        searchPreferencesEntries: preferenceEntries,
        reason: `Undid assistant change: ${receipt.summary}`,
      });
      undone.push(...result.undoneLabels);
      conflicts.push(...result.conflictLabels);
    }
    if (settingsEntries.length > 0) {
      const result = await service.undoAssistantSettingsChange({
        entries: settingsEntries,
      });
      undone.push(...result.undoneLabels);
      conflicts.push(...result.conflictLabels);
    }
  }
  const status =
    conflicts.length === 0
      ? ("undone" as const)
      : undone.length === 0
        ? receipt.status
        : ("partially_undone" as const);
  const next = {
    ...receipt,
    status,
    undoneAt: status === "applied" ? receipt.undoneAt : session.now(),
    undoConflicts: [...new Set(conflicts)].slice(0, 60),
  };
  await session.saveReceipt(next);
  context.ports.publishWorkspaceUpdate();
  const conflictText =
    conflicts.length > 0
      ? ` ${[...new Set(conflicts)].join(", ")} ${conflicts.length === 1 ? "was" : "were"} changed again since, so ${conflicts.length === 1 ? "it was" : "they were"} left as ${conflicts.length === 1 ? "it is" : "they are"}.`
      : "";
  const message =
    undone.length > 0
      ? `Undid "${receipt.summary}".${conflictText}`
      : `Nothing was undone.${conflictText}`;
  return { receipt: next, message };
}

export const reviewImportSuggestionsTool = defineTool({
  name: "resolve_import_suggestion",
  group: "profile",
  description:
    "Acts on one suggestion left by a resume import (from read_profile section review): confirm keeps the proposed value, dismiss drops it, clear_value empties the field.",
  parameters: json.object(
    {
      reviewItemId: json.string(),
      action: json.enumOf(["confirm", "dismiss", "clear_value"]),
    },
    ["reviewItemId", "action"],
  ),
  input: z.object({
    reviewItemId: Id,
    action: ProfileSetupReviewActionSchema,
  }),
  label: () => "Resolving an import suggestion",
  effect: "local_write",
  async execute(input, { service, session, ports }) {
    session.assertCurrent();
    await service.applyProfileSetupReviewAction(
      input.reviewItemId,
      input.action,
    );
    ports.publishWorkspaceUpdate();
    return {
      summary: `Suggestion ${input.action === "confirm" ? "kept" : input.action === "dismiss" ? "dismissed" : "cleared"}.`,
    };
  },
});

export const listDocumentsTool = defineTool({
  name: "list_documents",
  group: "files",
  description:
    "Lists the person's files (resumes, cover letters, portfolios, transcripts) with ids. Refer to files only by these ids, never by path. original_resume is the imported resume (what Original sends); approved_resume_<jobId> is the approved resume for that one job. Files the person attached in this chat or added under Documents are used by applications: when Job Finder fills a form, it uploads the matching file (portfolio, transcript, cover letter, other) to that form's file field, so no extra step is needed to use them.",
  parameters: json.object({}),
  input: z.object({}).passthrough(),
  label: () => "Listing your files",
  effect: "read",
  async execute(_input, { ports }) {
    const documents = await ports.listDocuments();
    return {
      summary: `${plural(documents.length, "file")}. Applications upload the matching one to a form's file field (portfolio, transcript, cover letter), so these can be used for an application without any other step.`,
      data: documents.slice(0, 60).map((document) => ({
        id: document.id,
        kind: document.kind,
        name: document.originalName,
        bytes: document.byteSize,
        addedAt: document.createdAt,
        ...(document.forJob
          ? {
              forJob: `${document.forJob.title} at ${document.forJob.company} (job ${document.forJob.jobId}); only for that job`,
            }
          : {}),
      })),
    };
  },
});

export const readDocumentTool = defineTool({
  name: "read_document",
  group: "files",
  description:
    "Reads the text of one of the person's files by id (bounded). Resume import supports PDF, DOCX, TXT and Markdown. Scanned image PDFs have no readable text; visual extraction may be available in read_profile section review, but is not guaranteed. Standalone PNG/JPG images are not supported resume imports; recommend a text-based file, pasted text or manual entry when unreadable.",
  parameters: json.object({ documentId: json.string() }, ["documentId"]),
  input: z.object({ documentId: Id }),
  label: () => "Reading a file",
  effect: "read",
  async execute(input, { ports }) {
    const text = await ports.readDocumentText(input.documentId);
    if (text === null) {
      throw new AssistantToolError(
        "not_found",
        "That file has no readable text. For an imported scanned PDF, inspect read_profile section review for extracted values and visual evidence. Resume import supports PDF, DOCX, TXT and Markdown; standalone PNG/JPG images are unsupported. If no usable extraction exists, use a supported file or pasted text.",
      );
    }
    return {
      summary: `Read ${text.length} characters.`,
      data: { text: text.slice(0, 12_000), truncated: text.length > 12_000 },
    };
  },
});

export const importResumeTool = defineTool({
  name: "import_resume",
  group: "files",
  description:
    "Imports a PDF, DOCX, TXT or Markdown file by id as the person's resume: usable details fill the profile, with suggestions left for review. Scanned image PDFs have no readable text; visual extraction may read them when available, but success is not guaranteed. Check the result before claiming anything was extracted. Standalone PNG/JPG images are unsupported resume imports. Empty or unsupported imports need a text-based file, pasted text or manual entry. Only when the person asks to use the file for their profile.",
  parameters: json.object({ documentId: json.string() }, ["documentId"]),
  input: z.object({ documentId: Id }),
  label: () => "Importing the resume into your profile",
  effect: "local_write",
  async execute(input, { ports, service, session }) {
    session.assertCurrent();
    const before = await service.getResumeImportState();
    const existingRunIds = new Set(
      before.resumeImportRuns.map((run) => run.id),
    );
    await ports.importResumeDocument(input.documentId, {
      signal: session.signal,
    });
    session.assertCurrent();
    const [snapshot, imported] = await Promise.all([
      service.getWorkspaceSnapshot(),
      service.getResumeImportState(),
    ]);
    const matchingRun = imported.resumeImportRuns
      .filter(
        (run) =>
          !existingRunIds.has(run.id) &&
          run.sourceResumeId === snapshot.profile.baseResume.id,
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    const candidates = imported.resumeImportFieldCandidates.filter(
      (candidate) => candidate.runId === matchingRun?.id,
    );
    const saved = candidates.filter(
      (candidate) => candidate.resolution === "auto_applied",
    ).length;
    const review = candidates.filter(
      (candidate) => candidate.resolution === "needs_review",
    ).length;
    ports.publishWorkspaceUpdate();
    const terminal =
      matchingRun &&
      !imported.activeVisionRunIds.includes(matchingRun.id) &&
      (matchingRun.status === "applied" ||
        matchingRun.status === "review_ready");
    if (!terminal || saved + review === 0) {
      return {
        summary:
          "The file was saved, but this import produced no usable new profile details. Existing profile facts were kept. Do not say the profile was filled from this file; offer a PDF, DOCX or TXT file or pasted text.",
        data: { runId: matchingRun?.id ?? null, outcome: "no_usable_details" },
      };
    }
    return {
      summary: `The resume import finished: ${plural(saved, "detail")} saved and ${plural(review, "suggestion")} left for review. Read the profile before describing what was filled or resolving those suggestions.`,
      data: {
        runId: matchingRun.id,
        outcome: "completed",
        savedDetailCount: saved,
        reviewSuggestionCount: review,
        savedIdentity: basics(snapshot.profile),
        savedCollections: {
          experiences: snapshot.profile.experiences.length,
          education: snapshot.profile.education.length,
          skills: snapshot.profile.skills.length,
          links: snapshot.profile.links.length,
          spokenLanguages: snapshot.profile.spokenLanguages,
        },
        completenessNote:
          "These are stored facts. Compare the supplied document with read_profile, add any missing languages or other supported records with edit_profile, and read back before claiming all details were imported.",
      },
    };
  },
});

export const profileTools = [
  readProfileTool,
  editProfileTool,
  finishProfileSetupTool,
  undoChangeTool,
  reviewImportSuggestionsTool,
];

export const fileTools = [
  listDocumentsTool,
  readDocumentTool,
  importResumeTool,
];
