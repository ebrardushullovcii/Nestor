import {
  AgentTaskExecutionReceiptSchema,
  AgentProviderStatusSchema,
  ProfileCopilotReplySchema,
  ResumeDraftPatchSchema,
  assessJobPostingDetailQuality,
  type ProfileCopilotReply,
} from "@nestor/contracts";
import {
  JobFitAssessmentSchema,
  OpenAiCompatibleJobFinderAiClientOptionsSchema,
  ResumeAssistantReplySchema,
  ResumeProfileExtractionSchema,
  type AgentCapableJobFinderAiClient,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type CreateResumeDraftInput,
  type JobFinderAiClient,
  type OpenAiCompatibleJobFinderAiClientOptions,
  type ResumeGenerationStrategyPolicy,
  type StringMap,
  type TailorResumeInput,
  describeProfileAssistantBehavior,
  PROFILE_RESUME_APPROACH_VOCABULARY,
} from "./shared";
import {
  buildDeterministicResumeProfileExtraction,
  completeResumeExtraction,
  createDeterministicJobFinderAiClient,
  uniqueStrings,
} from "./deterministic";
import {
  completeTailoredResumeDraft,
  logFallbackError,
  summarizeError,
} from "./openai-compatible-shared";
import {
  buildGroundedResumeRewriteModelPayload,
  describeAggressiveResumeEditPolicy,
} from "./resume-generation-grounding";
import {
  buildModelRequestBody,
  buildModelUrl,
  DEFAULT_AGGRESSIVE_RESUME_MODEL,
  DEFAULT_AGGRESSIVE_RESUME_MODEL_API_MODE,
  DEFAULT_AGGRESSIVE_RESUME_MODEL_REASONING_EFFORT,
  DEFAULT_OPENCODE_GO_BASE_URL,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_MODEL_API_MODE,
  DEFAULT_TEXT_MODEL_REASONING_EFFORT,
  extractModelJsonFromPayload,
  parseModelApiMode,
  parseModelReasoningEffort,
  type ModelReasoningEffort,
  type ModelUsagePayload,
} from "./openai-compatible-transport";
import {
  type ModelRequestResilienceOptions,
  ModelRequestTimeoutError,
  parseConfiguredBoolean,
  parseConfiguredPositiveInteger,
  performModelRequest,
} from "./model-request-transport";
import {
  compactOpenAiCompatibleUserPayload,
  FullFitEvidenceBudgetError,
  type OpenAiCompatibleJsonOperation,
} from "./openai-compatible-request-compaction";
import {
  buildFitEvidenceInstructions,
  buildJobFitAssessmentPayload,
  buildJobFitJudgingPayload,
  buildJobFitJudgingPrompt,
  normalizeJobFitJudgments,
} from "./openai-compatible-fit";
import {
  buildResumeClaimCheckPayload,
  buildResumeClaimCheckPrompt,
  normalizeResumeClaimChecks,
} from "./openai-compatible-resume-claims";
import {
  buildJobsExtractionPrompt,
  normalizeExtractedJobs,
} from "./openai-compatible-jobs";
import {
  adjudicateOpenAiCompatibleResumeImportCandidates,
  extractOpenAiCompatibleResumeImportStage,
} from "./openai-compatible-resume-import";
import type { ResumeImportExtractionStage } from "./resume-import";
import { createBrowserVisualAnalysisProviderFromEnvironment } from "./browser-visual-analysis";
import {
  runProfileCopilotAgentTask,
  runResumeEditAgentTask,
  runResumeGenerationAgentTask,
  runResumeImportStageAgentTask,
} from "./agent-capabilities";
import { getAiProviderAccessFailure } from "./ai-provider-access-failure";
import {
  buildModelRequestHeaders,
  createInstanceConversationKey,
  modelConversationKeys,
} from "./model-request-identity";

const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
/**
 * A first tailored draft is the largest structured output the product asks
 * for: every section rewritten against a full listing body with evidence
 * references. Sixty seconds cut real drafts off mid-generation on slower
 * models and reported them as failures; the extraction budget fits the work.
 */
const DEFAULT_RESUME_DRAFT_TIMEOUT_MS = 600_000;
/**
 * One tool-calling turn of the Assistant or Copilot. A turn that inspects the
 * draft and proposes a grounded rewrite is a large structured output too; at
 * sixty seconds slower models were cut off mid-turn and the whole request
 * collapsed into the safe fallback.
 */
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 300_000;
/** Browser-agent turns and page reads think briefly; see `agentReasoningEffort`. */
const DEFAULT_AGENT_TURN_REASONING_EFFORT: ModelReasoningEffort = "low";
const DEFAULT_RESUME_EXTRACTION_TIMEOUT_MS = 600_000;
const DEFAULT_RESUME_IMPORT_STAGE_TIMEOUT_MS: Record<
  Exclude<ResumeImportExtractionStage, "shared_memory">,
  number
> = {
  identity_summary: 300_000,
  experience: 300_000,
  background: 300_000,
};
const SEARCH_RESULTS_EXTRACTION_TIMEOUT_MS = 240_000;
const SEARCH_RESULTS_EXTRACTION_PAGE_TEXT_LIMIT = 8_000;
const JOB_DETAIL_EXTRACTION_PAGE_TEXT_LIMIT = 12_000;
const SEARCH_RESULTS_MAX_MODEL_JOBS = 12;
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 196_000;

/** Token usage in one shape whatever API reported it. */
export function normalizeModelUsage(usage: ModelUsagePayload): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
} {
  const count = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.round(value))
      : 0;
  return {
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    cachedInputTokens: Math.max(
      count(usage.prompt_tokens_details?.cached_tokens),
      count(usage.prompt_cache_hit_tokens),
    ),
    reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
  };
}
function buildResumeRewriteProposalPrompt(
  tailoringMode: "conservative" | "balanced" | "aggressive",
  strategy?: ResumeGenerationStrategyPolicy | null,
): string {
  const modeGuidance =
    tailoringMode === "aggressive"
      ? "Aggressive mode: substantially rewrite, combine, and elaborate the cited candidate evidence into the strongest plausible job-tailored prose. When the cited evidence names the candidate's stack (for example JavaScript, TypeScript, Next.js) or product domain (for example restaurant management SaaS), infer and spell out realistic engineering details around them - typical features, implementation approaches, trade-offs, and effects consistent with that stack and domain - even when the cited wording omits them. You may connect an evidenced metric to plausible supporting work, but every number in your output must come verbatim from the cited evidence. Mark every proposal that elaborates beyond the cited wording with inferred:true. Never introduce employers, dates, titles, credentials, certifications, seniority, team size, or leadership not supported by the cited evidence. Never invent a number, percentage, count, or money. Never name a technology, library, framework, tool, service, or product that appears in neither the cited evidence nor the target job listing. Two permissions apply only when you mark the proposal inferred:true and cite the evidence that anchors the underlying experience: you may round the candidate's evidenced years of experience up to the job's stated years requirement when the evidenced figure is exactly one year below it, and you may name any technology, library, framework, or tool the target job listing itself asks for — required or preferred, including technologies named only in qualifications or preferred lists rather than the structured skill list — whenever the candidate's saved evidence shows professional technical experience (a developer or engineer role, a technical headline, or technical skills), even when your stack or domain does not directly imply it, because a developer with years of evidenced experience can reasonably stand behind the job's own stack; prefer covering the listing's required technologies. The targetJob.listingRequestedSkills array is that requested stack, including technologies named only in qualifications: name those technologies in the prose and you may return them in coreSkills. Never name a technology absent from both the cited evidence and the job listing, never round up by more than one year, and never claim the listing's employer, dates, titles, credentials, seniority, or leadership. You may also return a `coreSkills` array: the candidate's own key skills plus the job's required or preferred technologies they can stand behind, including technologies named only in qualification prose; every skill must come from the cited evidence or the job listing, and Job Finder verifies each against both before showing it."
      : tailoringMode === "conservative"
        ? "Conservative mode: stay very close to the cited wording and propose only clear, low-risk improvements."
        : "Balanced mode: improve structure and relevance while keeping every factual statement directly supported by cited evidence.";

  const strategyGuidance = strategy
    ? [
        `Apply the named resume strategy "${strategy.strategyName}" for the ${strategy.roleFamily} role family.`,
        `Strategy provenance: ${strategy.effectiveSource}; reason: ${strategy.effectiveReason}`,
        `Use the ${strategy.headlinePolicy} headline policy, ${strategy.skillsPolicy} skills policy, and ${strategy.coveragePolicy} coverage policy.`,
        `The selected base resume document is ${strategy.baseResumeDocumentId}; do not invent facts outside the supplied grounding evidence.`,
        `Evidence boundaries: exact claims ${strategy.evidenceBoundaries.allowExactClaims ? "allowed" : "not allowed"}; paraphrased claims ${strategy.evidenceBoundaries.allowParaphrasedClaims ? "allowed" : "not allowed"}; at most ${strategy.evidenceBoundaries.maxEvidenceRefsPerBullet} evidence references per bullet. Each line is fact-checked against the candidate's evidence before approval.`,
      ]
    : [];

  const returnGuidance =
    tailoringMode === "aggressive"
      ? "Compose one sparse proposal of material improvements with compose_resume_proposal. Do not compose {}: name every targetJob.listingRequestedSkills item that is missing from the cited evidence in inferred:true prose and in coreSkills, and round evidenced years up by one on an inferred line when the listing itself states that higher figure."
      : "Compose one sparse proposal containing only material improvements with compose_resume_proposal. Compose {} when the cited evidence is already as clear and professional as you can safely make it.";
  const jobWordingGuidance =
    tailoringMode === "aggressive"
      ? "Use job-description wording for technologies in targetJob.listingRequestedSkills and for work the cited evidence supports. Never copy employer language that is not a technology or a supported skill, and never add target-company claims."
      : "Use job-description wording only when the candidate evidence supports the same skill or work. Never stuff keywords, copy employer language without evidence, or add target-company claims.";

  return [
    'You write the tailored resume for this exact job: evidence-linked prose, and the choice of what to show. The application owns identity metadata, chronology and rendering. You see every role, achievement, project and skill the candidate saved; decide which of them this job needs and how much room each gets. The resume should fit on targetPageCount pages: give the most relevant recent roles the most bullets (up to six), older or unrelated roles one or two or none, mark a role or project the job does not need with "hidden": true, and return the additionalSkills worth listing. Anything you leave off stays on the candidate\'s draft, hidden, for them to show again; it is never deleted.',
    returnGuidance,
    'When targetLanguage is supplied, write the resume in that language in this writing pass. When it is "the language the listing is written in", determine it from the actual listing, following the source resume only if the listing language cannot be determined. Include languagePresentation: {"language":"the language actually written","listingLanguage":"the language of the actual posting, or null if unknown","translations":[{"id":"exact languageFields id","text":"final text"}]}. Translations are sparse display edits for fields that need translation: headings, headline, roles, skills, dates, credentials, and retained source prose. Omit translations for unchanged fields and for prose already written in the target language by your summary, experienceEntries or projectEntries proposal. Keep proper names, every source fact and qualifier. When all displayed fields already use the target language, return an empty translations array; do not reword the resume to translate it into the same language. The preview supplies the assembled languageFields; use those exact IDs to finish any source fields still in another language.',
    'Use this sparse shape: {"summary":{"text":"...","evidenceRefs":["..."]},"experienceEntries":[{"profileRecordId":"...","summary":{"text":"...","evidenceRefs":["..."]},"bullets":[{"text":"...","evidenceRefs":["..."],"inferred":true,"sourceAchievementIds":["experience:record:achievement:0"]}]},{"profileRecordId":"...","hidden":true}],"projectEntries":[{"profileRecordId":"...","summary":{"text":"...","evidenceRefs":["..."]},"outcome":{"text":"...","evidenceRefs":["..."]},"bullets":[{"text":"...","evidenceRefs":["..."]}]}],"additionalSkills":["..."]}. For a role you show, list exactly the bullets it should show. Omit every unchanged field.',
    "Every proposed text must cite exact IDs from groundingEvidence.items. Experience and project proposals may cite items with the same profileRecordId; in aggressive mode they may additionally cite profile-scope items (for example profile:skills, profile:skillGroup:coreSkills, profile:summary) to anchor stack- and domain-aware wording.",
    "Outside aggressive mode, use only claims, numbers, technologies, scope, and outcomes stated in the cited evidence. In every mode, never add dates, titles, employers, credentials, seniority, causality, or absolutes, and never add leadership the cited evidence does not support.",
    "Write for the exact target job. Make the candidate's supported match obvious in the opening lines, and prioritize the job's most important supported skills and accomplishments over generic career description.",
    "When you restate a fact, keep it whole: qualifications and their years, skill proficiency and learning limits, seasonal or partial dates and quantified results. Never replace a source achievement with generic wording that loses its number or outcome. A missing employer does not erase a freelance role or internship; retain the available facts without guessing the missing ones.",
    "Light edits preserve the original summary when rewriting would repeat terms or blur the meaning. Keep every stated skill level and limit, including basic or still learning, seasonal or partial dates, credential years and renewal dates, and quantified results with their exact numbers.",
    "For each experience bullet, return sourceAchievementIds with the exact experience:<profileRecordId>:achievement:<index> IDs of every source achievement it fully restates, including translations. Keep evidenceRefs separately for supporting evidence. sourceAchievementIds declare coverage of the whole source fact, not just inspiration: retain its numbers and qualifiers. Use broader summary or profile references for supporting context only. Restate each source achievement once, combining IDs when one bullet covers several. Any source achievement not listed in sourceAchievementIds stays on the candidate's draft, hidden. Translate generic credential descriptions such as First aid; preserve official credential names. Keep every language name and proficiency. Each achievement and qualification appears once. Merge duplicate or translated duplicate statements while retaining every distinct fact. Do not repeat a degree heading in its description. Summaries lead with supported results and relevant experience in a short paragraph; omit generic filler.",
    "Use concise accomplishment statements: action, specific work, and outcome. Keep distinctive evidence terms and exact metrics unchanged. Do not repeat the same claim or metric in multiple bullets.",
    jobWordingGuidance,
    modeGuidance,
    ...strategyGuidance,
    "Do not compose a full resume, identity metadata, compatibility scores, labels, notes, explanations, or uncited text except the requested languagePresentation display edits. In aggressive mode include coreSkills covering the candidate's key skills plus targetJob.listingRequestedSkills.",
  ].join(" ");
}

function parseConfiguredTimeoutMs(
  value: string | undefined,
): number | undefined {
  const parsedValue = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 1_000) {
    return undefined;
  }

  return parsedValue;
}

function normalizeTimeoutLikeError(error: unknown, timeoutMs: number): Error {
  if (error instanceof ModelRequestTimeoutError) {
    return error;
  }
  const message = error instanceof Error ? error.message.trim() : "";
  const isAbortLikeMessage =
    message === "This operation was aborted" ||
    message === "The operation was aborted" ||
    message === "signal is aborted without reason";

  if (error instanceof DOMException && error.name === "AbortError") {
    return new DOMException(
      `Model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
      "AbortError",
    );
  }

  if (error instanceof Error && error.name === "AbortError") {
    const abortError = new Error(
      `Model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  if (isAbortLikeMessage) {
    const abortError = new Error(
      `Model request timed out after ${Math.floor(timeoutMs / 1000)}s`,
    );
    abortError.name = "AbortError";
    return abortError;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function resumeImportStageTimeoutMs(
  stage: ResumeImportExtractionStage,
  configuredResumeTimeoutMs?: number,
  configuredRequestTimeoutMs?: number,
): number {
  return (
    configuredResumeTimeoutMs ??
    configuredRequestTimeoutMs ??
    (stage === "shared_memory"
      ? DEFAULT_RESUME_EXTRACTION_TIMEOUT_MS
      : DEFAULT_RESUME_IMPORT_STAGE_TIMEOUT_MS[stage])
  );
}

export function createOpenAiCompatibleJobFinderAiClient(
  options: OpenAiCompatibleJobFinderAiClientOptions,
): AgentCapableJobFinderAiClient {
  const configuredOptions =
    OpenAiCompatibleJobFinderAiClientOptionsSchema.safeParse(options);
  const validatedOptions = configuredOptions.success
    ? configuredOptions.data
    : null;
  const agentReasoningEffort =
    validatedOptions?.agentReasoningEffort ?? validatedOptions?.reasoningEffort;
  const status = AgentProviderStatusSchema.parse({
    kind: "openai_compatible",
    ready: configuredOptions.success,
    label: validatedOptions?.label ?? "AI resume agent",
    model: validatedOptions?.model ?? null,
    baseUrl: validatedOptions?.baseUrl ?? null,
    modelContextWindowTokens: configuredOptions.success
      ? (validatedOptions?.contextWindowTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS)
      : null,
    reservedHeadroomTokens: null,
    requestTimeoutMs: configuredOptions.success
      ? (validatedOptions?.requestTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS)
      : null,
    detail: configuredOptions.success
      ? "The configured AI provider handles resume extraction and tailoring. Structured JSON outputs are validated locally before they affect Job Finder state."
      : "The configured AI provider settings are invalid. Check the model and base URL before enabling model-backed resume extraction.",
  });

  // Requests that belong to no product conversation share one id per client
  // instance, so even background work is attributable and cacheable.
  const instanceConversationKey = createInstanceConversationKey();
  const resilience: ModelRequestResilienceOptions = {
    idleTimeoutMs: validatedOptions?.idleTimeoutMs,
    maxAttempts: validatedOptions?.maxAttempts,
    streaming: validatedOptions?.streaming,
    retryBaseDelayMs: validatedOptions?.retryBaseDelayMs,
  };

  async function fetchModelJson(
    operation: OpenAiCompatibleJsonOperation,
    systemPrompt: string,
    userPayload: unknown,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Which conversation this request continues; see model-request-identity. */
      conversationKey?: string;
      /** Overrides the client's effort for this one request. */
      reasoningEffort?: ModelReasoningEffort | undefined;
    },
  ): Promise<unknown> {
    if (!validatedOptions) {
      throw new Error(
        "The configured AI provider settings are invalid. Check the model and base URL before making model requests.",
      );
    }

    const timeoutMs =
      options?.timeoutMs ??
      validatedOptions.requestTimeoutMs ??
      DEFAULT_MODEL_TIMEOUT_MS;
    const compactedUserPayload = compactOpenAiCompatibleUserPayload({
      operation,
      modelContextWindowTokens:
        validatedOptions.contextWindowTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
      systemPrompt,
      userPayload,
    });

    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const apiMode = validatedOptions.apiMode ?? "chat_completions";
    try {
      // Streaming, idle and total deadlines, and retries live in
      // model-request-transport; `timeoutMs` is the total budget.
      const payload = await performModelRequest({
        url: buildModelUrl(validatedOptions.baseUrl, apiMode),
        headers: buildModelRequestHeaders({
          apiKey: validatedOptions.apiKey,
          baseUrl: validatedOptions.baseUrl,
          conversationKey: options?.conversationKey ?? instanceConversationKey,
        }),
        body: buildModelRequestBody({
          apiMode,
          model: validatedOptions.model,
          reasoningEffort:
            options?.reasoningEffort ?? validatedOptions.reasoningEffort,
          reasoningSummary: resilience.streaming !== false,
          jsonOutput: true,
          messages: [
            {
              role: "system",
              content: /\bjson\b/i.test(systemPrompt)
                ? systemPrompt
                : `${systemPrompt}\nReturn JSON only.`,
            },
            {
              role: "user",
              content: JSON.stringify(compactedUserPayload),
            },
          ],
        }),
        apiMode,
        totalTimeoutMs: timeoutMs,
        ...resilience,
        signal: options?.signal,
      });
      return extractModelJsonFromPayload(payload);
    } catch (error) {
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      throw normalizeTimeoutLikeError(error, timeoutMs);
    }
  }

  return {
    getStatus() {
      return status;
    },
    async extractProfileFromResume(input) {
      const payload = await fetchModelJson(
        "extractProfileFromResume",
        [
          "You extract structured candidate details from resume text.",
          "Return JSON only.",
          "The resume text may come from PDF, DOCX, TXT, or Markdown extraction and can contain broken lines, repeated headings, metadata, or messy spacing.",
          "Normalize the output into a clean candidate profile.",
          "Use the resume text as the primary source of truth and only fall back to the provided existing profile when the resume does not contain the field.",
          "Do not invent employers, dates, locations, links, or achievements that are not grounded in the input.",
          "Prefer null instead of guessing for missing contact details.",
          "Keep summary focused on the professional bio, not contact metadata.",
          "Return a concise headline without dates or employment ranges.",
          "Split names into firstName, middleName, lastName when possible.",
          "Return preferredLocations as a clean list of likely target locations, not raw address metadata.",
          "If timezone is not explicitly written but location contains a city or region (not just a country), infer the most likely IANA timezone from the city or region.",
          "If salary currency or regional defaults are not explicitly written but the resume location makes them obvious, infer the most likely value with high confidence.",
          "Return atomic list items only: one skill, one role, one school, one language, or one company per entry.",
          "Return experience achievements, experience skills, project skills, and grouped skills as clean arrays with one item per entry, not one large paragraph or combined newline blob.",
          "Keep single-word or short technical skills split into separate array items instead of grouping many of them into one sentence.",
          "Do not repeat exact duplicates across skills, grouped skills, links, languages, projects, or experience item arrays.",
          "Populate skillGroups with coreSkills, tools, languagesAndFrameworks, softSkills, and highlightedSkills instead of dumping everything into skills.",
          "Populate experiences, education, certifications, links, projects, and spokenLanguages as structured arrays with one record per item whenever the resume contains enough evidence.",
          "For each experience, return workMode as an array such as ['remote'], ['hybrid'], or ['onsite']; do not return a nested object.",
          "Use professionalSummary for narrative rollups such as shortValueProposition, fullSummary, careerThemes, and strengths.",
          "Return notes only when the extraction is uncertain, incomplete, or needs user review; otherwise return an empty array.",
        ].join(" "),
        {
          existingProfile: input.existingProfile,
          existingSearchPreferences: input.existingSearchPreferences,
          resumeText: input.resumeText,
        },
        {
          timeoutMs:
            validatedOptions?.resumeExtractionTimeoutMs ??
            validatedOptions?.requestTimeoutMs ??
            DEFAULT_RESUME_EXTRACTION_TIMEOUT_MS,
          conversationKey: modelConversationKeys.resumeImport(input.resumeText),
        },
      );
      const deterministicSupplement = buildDeterministicResumeProfileExtraction(
        input,
        "deterministic",
        "Built-in deterministic parser supplement",
      );

      // `parseModelJsonResponse` only rejects malformed JSON, so a valid
      // non-object payload (`[]`, `"..."`, `null`) used to normalize to `{}`
      // and ship a purely deterministic extraction stamped as model output
      // with no note. A payload the model cannot be read from is a provider
      // failure, and is reported exactly like the caught one below.
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return ResumeProfileExtractionSchema.parse({
          ...deterministicSupplement,
          notes: uniqueStrings([
            ...deterministicSupplement.notes,
            "Fell back to the deterministic resume parser after the model call failed.",
            "Primary AI extraction failed: the model returned a response that was not a resume extraction object.",
          ]),
        });
      }

      const parsedPrimaryExtraction = ResumeProfileExtractionSchema.parse({
        ...(payload as Record<string, unknown>),
        analysisProviderKind: "openai_compatible",
        analysisProviderLabel: status.label,
      });

      return ResumeProfileExtractionSchema.parse({
        ...completeResumeExtraction(
          parsedPrimaryExtraction,
          deterministicSupplement,
        ),
        analysisProviderKind: "openai_compatible",
        analysisProviderLabel: status.label,
      });
    },
    async extractResumeImportStage(input) {
      const startedAtMs = performance.now();
      const result = await extractOpenAiCompatibleResumeImportStage({
        stageInput: input,
        status,
        fetchModelJson,
        timeoutMs: resumeImportStageTimeoutMs(
          input.stage,
          validatedOptions?.resumeExtractionTimeoutMs,
          validatedOptions?.requestTimeoutMs,
        ),
      });
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - startedAtMs),
      );
      return {
        ...result,
        timing: {
          durationMs,
          primaryProviderMs: durationMs,
          deterministicFallbackMs: null,
        },
      };
    },
    async adjudicateResumeImportCandidates(input) {
      return adjudicateOpenAiCompatibleResumeImportCandidates({
        adjudicationInput: input,
        status,
        fetchModelJson,
        timeoutMs:
          validatedOptions?.resumeExtractionTimeoutMs ??
          validatedOptions?.requestTimeoutMs ??
          DEFAULT_RESUME_EXTRACTION_TIMEOUT_MS,
      });
    },
    async createResumeDraft(input) {
      const payload = await fetchModelJson(
        "createResumeDraft",
        buildResumeRewriteProposalPrompt(
          input.strategy?.tailoringStrength ??
            input.searchPreferences.tailoringMode,
          input.strategy,
        ),
        buildGroundedResumeRewriteModelPayload(input),
        {
          timeoutMs:
            validatedOptions?.requestTimeoutMs ??
            DEFAULT_RESUME_DRAFT_TIMEOUT_MS,
          conversationKey: modelConversationKeys.resumeForJob(input.job),
        },
      );
      return completeTailoredResumeDraft(payload, input);
    },
    async reviseResumeDraft(input) {
      const payload = await fetchModelJson(
        "reviseResumeDraft",
        [
          "You are a resume editing assistant.",
          "Return JSON only with content and typed patches.",
          "Patches must make bounded edits to the supplied draft rather than rewriting the whole resume.",
          "These patches are proposals only. Never claim they were applied; the user must explicitly approve them.",
          describeAggressiveResumeEditPolicy(input.tailoringStrength) ??
            "Do not invent candidate facts.",
          "Avoid touching locked content by leaving it unchanged.",
        ].join(" "),
        input,
        { conversationKey: modelConversationKeys.resumeForJob(input.job) },
      );
      const normalizedPayload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const validatedPatches = Array.isArray(normalizedPayload.patches)
        ? normalizedPayload.patches.flatMap((patch) => {
            const parsedPatch = ResumeDraftPatchSchema.safeParse(patch);
            return parsedPatch.success ? [parsedPatch.data] : [];
          })
        : [];

      return ResumeAssistantReplySchema.parse({
        ...normalizedPayload,
        patches: validatedPatches,
        content:
          typeof normalizedPayload.content === "string" &&
          normalizedPayload.content.trim().length > 0
            ? normalizedPayload.content
            : "I could not turn that request into a safe grounded edit, so no changes were applied.",
      });
    },
    async reviseCandidateProfile(input) {
      const payload = await fetchModelJson(
        "reviseCandidateProfile",
        [
          "You are a profile editing assistant.",
          ...describeProfileAssistantBehavior(input.assistantBehavior),
          PROFILE_RESUME_APPROACH_VOCABULARY,
          "Return JSON only with content and typed patchGroups.",
          "Patch groups must use the provided bounded profile copilot operations only.",
          "Answer grounded factual questions directly when the request is asking what is already in the profile, even if no edit is needed.",
          "If no safe edit is needed, return patchGroups as an empty array and keep the content helpful, specific, and grounded in the provided profile facts.",
          "Do not invent candidate experience, credentials, dates, or metrics.",
          "Prefer no-op guidance over unsafe edits.",
          "If a change is broad, destructive, or ambiguous, mark the patch group applyMode as needs_review.",
          "Interpret natural preference language semantically instead of copying surrounding prose into a field. Salary currency must be a three-letter ISO code such as EUR, never a sentence fragment.",
          "A single request may update multiple bounded scalar fields. For salary requests, distinguish the lowest acceptable amount from the actual target amount and preserve both when explicitly stated.",
          "Represent compensation ranges with replace_compensation_preferences_fields using minimum, maximum, interval (hour, day, week, month, or year), currency, and currencyStatus.",
          "Set currencyStatus to explicit only when the user provides a currency code or unambiguous currency symbol, inherited only when reusing a previously explicit saved currency, and needs_clarification with currency null when the currency is genuinely ambiguous. Never silently assume USD from a location or from a bare dollar sign.",
          "Natural requests such as 'look for jobs around 3-4k a month around New York' may produce both a preferred-location operation and a compensation operation. Preserve 3000-4000 as monthly values rather than converting the user-facing range to annual text.",
        ].join(" "),
        input,
        {
          conversationKey: modelConversationKeys.profileCopilot(input.profile),
        },
      );
      const normalizedPayload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};

      return ProfileCopilotReplySchema.parse({
        ...normalizedPayload,
        content:
          typeof normalizedPayload.content === "string" &&
          normalizedPayload.content.trim().length > 0
            ? normalizedPayload.content
            : "I could not turn that request into a safe structured profile change, so no profile edits were proposed.",
      });
    },
    async tailorResume(input) {
      const payload = await fetchModelJson(
        "tailorResume",
        buildResumeRewriteProposalPrompt(input.searchPreferences.tailoringMode),
        buildGroundedResumeRewriteModelPayload(input),
        { conversationKey: modelConversationKeys.resumeForJob(input.job) },
      );
      return completeTailoredResumeDraft(payload, {
        profile: input.profile,
        searchPreferences: input.searchPreferences,
        settings: input.settings,
        job: input.job,
        resumeText: input.resumeText,
      });
    },
    async assessJobFit(input) {
      const { signal, ...assessmentInput } = input;
      const payload = await fetchModelJson(
        "assessJobFit",
        [
          "You assess how well a job matches a candidate profile.",
          buildFitEvidenceInstructions(),
          "Return JSON only.",
          "Use a 0-100 score, 1-3 reasons, and up to 3 gaps.",
          "Keep explanations specific to the provided profile and job.",
          "Include requirements for every explicit language and level, enrollment or availability window, education, portfolio, experience, and named tool in the full listing. Compare each with the profile; absence is missing or unknown, never support. A conflict needs explicit contradictory evidence. Use assessmentDate for availability windows.",
          "Each requirement has id, category (skill, experience, seniority, location, work_mode, work_authorization, domain), label, importance (required, preferred, inferred), status (supported, partial, missing, unknown, conflict), jobEvidence (quote from the listing), resumeEvidence (array of {sourceKind: profile_skill, experience, project, or profile; sourceId: string or null; label; detail}), and explanation. Use skill for languages and tools, experience for education, enrollment, availability and portfolio. Keep required country restrictions separate from remote work mode.",
          'Also return your verdict: recommendation (strong_fit, apply_with_original, review_before_applying, or skip); role ("exact" when it is the kind of work the person is looking for, "adjacent" for related work they could credibly do, "conflict" for a different occupation or a level far from theirs, "unknown"); roleExplanation (one plain sentence to the person); preferences ("aligned", "mixed", "conflict", "unknown", or "not_configured" against the saved goals for place, work mode, level, employment type and pay); preferencesExplanation (one sentence); and locationReach ("in_area", "remote_preferred", "outside_area", or "unknown"); listingClosed (true only when the listing itself says it is closed, filled or no longer accepting applications) with listingClosedEvidence quoting those words. Your score and recommendation stand as the assessment; nothing recomputes them.',
        ].join(" "),
        buildJobFitAssessmentPayload(assessmentInput),
        {
          conversationKey: modelConversationKeys.jobFit(input.job),
          ...(signal ? { signal } : {}),
        },
      );
      return JobFitAssessmentSchema.parse(payload);
    },
    async judgeJobFits(input) {
      const { signal, ...rest } = input;
      if (rest.jobs.length === 0) {
        return [];
      }
      const payload = await fetchModelJson(
        "judgeJobFits",
        buildJobFitJudgingPrompt(),
        buildJobFitJudgingPayload(rest),
        {
          ...(signal ? { signal } : {}),
          reasoningEffort: agentReasoningEffort,
        },
      );
      return normalizeJobFitJudgments(
        payload,
        new Set(rest.jobs.map((job) => job.jobId)),
      );
    },
    async checkResumeClaims(input) {
      const { signal, timeoutMs, ...rest } = input;
      if (rest.claims.length === 0) {
        return [];
      }
      const payload = await fetchModelJson(
        "checkResumeClaims",
        buildResumeClaimCheckPrompt(),
        buildResumeClaimCheckPayload(rest),
        {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(signal ? { signal } : {}),
          reasoningEffort: agentReasoningEffort,
        },
      );
      return normalizeResumeClaimChecks(payload, rest);
    },
    async extractJobsFromPage(input) {
      const maxJobs = Math.max(0, Math.floor(input.maxJobs));
      const effectiveMaxJobs =
        input.pageType === "job_detail"
          ? Math.min(maxJobs, 1)
          : Math.min(maxJobs, SEARCH_RESULTS_MAX_MODEL_JOBS);
      if (effectiveMaxJobs === 0) {
        return [];
      }

      const pageHostLabel = (() => {
        try {
          return new URL(input.pageUrl).hostname;
        } catch {
          return "the configured job site";
        }
      })();
      const systemPrompt = buildJobsExtractionPrompt({
        pageHostLabel,
        pageType: input.pageType,
        effectiveMaxJobs,
      });
      const pageTextLimit =
        input.pageType === "search_results"
          ? SEARCH_RESULTS_EXTRACTION_PAGE_TEXT_LIMIT
          : JOB_DETAIL_EXTRACTION_PAGE_TEXT_LIMIT;
      const timeoutMs =
        validatedOptions?.requestTimeoutMs ??
        (input.pageType === "search_results"
          ? SEARCH_RESULTS_EXTRACTION_TIMEOUT_MS
          : DEFAULT_MODEL_TIMEOUT_MS);

      const payload = await fetchModelJson(
        "extractJobsFromPage",
        systemPrompt,
        {
          pageUrl: input.pageUrl,
          pageText:
            input.pageType === "job_detail"
              ? input.pageText
              : input.pageText.slice(0, pageTextLimit),
          ...(input.selectionContext
            ? { selectionContext: input.selectionContext }
            : {}),
        },
        {
          timeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
          conversationKey: modelConversationKeys.pageExtraction(input.pageUrl),
          reasoningEffort: agentReasoningEffort,
        },
      );

      return normalizeExtractedJobs({
        payload,
        pageHostLabel,
        pageUrl: input.pageUrl,
        pageType: input.pageType,
        effectiveMaxJobs,
      });
    },
    async chatWithTools(messages, tools, options?: ChatWithToolsOptions) {
      if (!validatedOptions) {
        throw new Error(
          "The configured AI provider settings are invalid. Check the model and base URL before making model requests.",
        );
      }

      const timeoutMs =
        validatedOptions.requestTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS;

      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      try {
        const apiMode = validatedOptions.apiMode ?? "chat_completions";
        const streamingEnabled = resilience.streaming !== false;
        const payload = await performModelRequest({
          url: buildModelUrl(validatedOptions.baseUrl, apiMode),
          headers: buildModelRequestHeaders({
            apiKey: validatedOptions.apiKey,
            baseUrl: validatedOptions.baseUrl,
            conversationKey:
              options?.conversationKey ?? instanceConversationKey,
          }),
          body: buildModelRequestBody({
            apiMode,
            model: validatedOptions.model,
            reasoningEffort: agentReasoningEffort,
            reasoningSummary: streamingEnabled,
            // Usage for the context budget; only asked for where the caller
            // listens to the stream, so older callers send the same body.
            includeStreamUsage:
              streamingEnabled && options?.onStreamEvent !== undefined,
            messages: messages.map((msg) => {
              const base = { role: msg.role, content: msg.content };
              if (msg.role === "assistant" && msg.toolCalls) {
                return {
                  ...base,
                  // Private continuation goes back only to the route that
                  // produced it.
                  ...(msg.continuation?.kind === "reasoning_content" &&
                  msg.continuation.route === validatedOptions.model
                    ? { reasoning_content: msg.continuation.text }
                    : {}),
                  tool_calls: msg.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: tc.type,
                    function: tc.function,
                  })),
                };
              }
              if (msg.role === "tool") {
                return { ...base, tool_call_id: msg.toolCallId };
              }
              return base;
            }),
            tools: tools.map((tool) => ({
              type: tool.type,
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
              },
            })),
            maxOutputTokens: options?.maxOutputTokens,
            parallelToolCalls: options?.parallelToolCalls,
          }),
          apiMode,
          totalTimeoutMs: timeoutMs,
          ...resilience,
          signal: options?.signal,
          onStreamEvent: options?.onStreamEvent,
        });

        const choice = payload.choices?.[0];
        const message = choice?.message;

        const result: ChatWithToolsResult = {};
        const requestedToolNames = new Set(
          tools.map((tool) => tool.function.name),
        );

        if (message?.content) {
          result.content = message.content;
        }
        if (message?.reasoning_content) {
          result.continuation = {
            kind: "reasoning_content",
            route: validatedOptions.model,
            text: message.reasoning_content,
          };
        }
        if (choice?.finish_reason) {
          result.finishReason = choice.finish_reason;
        }
        if (payload.usage) {
          result.usage = normalizeModelUsage(payload.usage);
        }

        if (
          Array.isArray(message?.tool_calls) &&
          message.tool_calls.length > 0
        ) {
          const toolCalls = message.tool_calls.flatMap((toolCall) => {
            if (
              toolCall?.type !== "function" ||
              typeof toolCall.id !== "string" ||
              !toolCall.function ||
              typeof toolCall.function.name !== "string" ||
              typeof toolCall.function.arguments !== "string" ||
              !requestedToolNames.has(toolCall.function.name)
            ) {
              return [];
            }

            return [
              {
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              },
            ];
          });

          if (toolCalls.length > 0) {
            result.toolCalls = toolCalls;
          }
        }

        return result;
      } catch (error) {
        if (options?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        throw normalizeTimeoutLikeError(error, timeoutMs);
      }
    },
  };
}

const LISTING_TEXT_MISSING_DETAIL =
  "The listing text was not captured, so there was nothing to tailor the resume toward; your original wording was kept.";

const LISTING_TEXT_NOT_DISTINGUISHING_DETAIL =
  "This listing says almost nothing about the job itself, so there was nothing to tailor the resume toward; your original wording was kept.";

/**
 * Words too common to tell one job from another. Deliberately generic and
 * board-neutral: no site names, no role families (ADR 0007).
 */
const LISTING_BOILERPLATE_TOKENS = new Set([
  "about",
  "apply",
  "benefits",
  "candidate",
  "company",
  "employer",
  "equal",
  "experience",
  "job",
  "must",
  "opportunity",
  "position",
  "requirements",
  "responsibilities",
  "role",
  "skills",
  "team",
  "the",
  "this",
  "will",
  "with",
  "work",
  "you",
  "your",
]);

/**
 * How many content words the listing brings that could make this draft
 * different from a draft for another job.
 *
 * Two unrelated postings were producing byte-identical "tailored" resumes
 * because their bodies carried nothing but boilerplate. A draft that the job
 * did not shape is not tailored, whatever the mode says.
 */
export function countDistinguishingListingTerms(job: {
  description?: string | null;
  summary?: string | null;
  keySkills?: readonly string[];
}): number {
  const text = [
    job.description ?? "",
    job.summary ?? "",
    ...(job.keySkills ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const terms = new Set(
    text
      .split(/[^\p{L}\p{N}+#.]+/u)
      .map((token) => token.replace(/^[.]+|[.]+$/gu, ""))
      .filter(
        (token) => token.length >= 3 && !LISTING_BOILERPLATE_TOKENS.has(token),
      ),
  );

  return terms.size;
}

/**
 * Below this, the body is a stub — a one-line "We are hiring" or a cookie
 * banner the extractor kept — and tailoring toward it cannot distinguish this
 * job from the next one.
 */
export const MINIMUM_DISTINGUISHING_LISTING_TERMS = 12;

/** The agent's opening placeholder before it has worked; never an answer. */
/** What the Resume Assistant says when the AI could not answer at all. */
const RESUME_ASSISTANT_UNAVAILABLE_REPLY =
  "The AI could not answer this time, so nothing was changed. Send the request again.";

const RESUME_EDIT_PLACEHOLDER_CONTENT =
  /^I am reviewing the requested résumé change against the saved evidence\.?$/u;

/**
 * A resume the AI could not write is a failure, not a built-in draft in its
 * place (ADR 0041): the job keeps the resume it had and the person is told.
 */
function resumeWritingFailed(error: unknown): Error {
  const accessFailure = getAiProviderAccessFailure(error);
  if (accessFailure) return new Error(accessFailure.message, { cause: error });
  const timedOut = /timed out/i.test(summarizeError(error));
  return new Error(
    timedOut
      ? "The AI could not write this resume in time, so nothing was changed. Try again."
      : "The AI could not write this resume, so nothing was changed. Try again.",
    { cause: error },
  );
}

/** Why a stage used the built-in reader when no model is available at all. */
export const NO_AI_PROVIDER_REASON = "No AI model is available right now.";

export const PROFILE_ASSISTANT_UNFINISHED_MESSAGE =
  "The Assistant stopped before it could finish this request, so nothing was changed. Your question is kept; ask it again or say it another way.";

/** The Assistant ran twice without finishing and prepared nothing. */
export class ProfileCopilotUnfinishedError extends Error {
  constructor() {
    super(PROFILE_ASSISTANT_UNFINISHED_MESSAGE);
    this.name = "ProfileCopilotUnfinishedError";
  }
}

/**
 * Stops a fresh run can plausibly get past: the model circled without a
 * change, or ran out of turns. A time-budget stop already used the whole
 * wait, and a refused external action or a question for the person would
 * stop the same way again.
 */
function shouldRetryUnfinishedProfileRun(reply: ProfileCopilotReply): boolean {
  const stopReason = reply.executionReceipt?.stopReason;
  return (
    stopReason === "no_progress" ||
    stopReason === "emergency_ceiling" ||
    stopReason === "cost_budget"
  );
}

const RESUME_IMPORT_STAGE_ATTEMPTS = 3;
const RESUME_IMPORT_RETRY_DELAYS_MS = [0, 3_000, 8_000] as const;

const RESUME_IMPORT_STAGE_SUBJECTS: Record<string, string> = {
  identity_summary: "your name, contact details and summary",
  experience: "your work history",
  background: "your education, skills, languages and certifications",
  shared_memory: "your reusable evidence and application answers",
};

/**
 * A resume section the model could not read even after asking again. The
 * message is what the person reads beside the import.
 */
export class ResumeImportStageUnreadError extends Error {
  constructor(stage: string, cause: string) {
    super(
      `Job Finder could not read ${RESUME_IMPORT_STAGE_SUBJECTS[stage] ?? "part of your resume"} because the AI model was not available (${cause}). Nothing was guessed for that part; import the file again to fill it in.`,
    );
    this.name = "ResumeImportStageUnreadError";
  }
}

function waitBeforeResumeImportRetry(attempt: number): Promise<void> {
  const delayMs = RESUME_IMPORT_RETRY_DELAYS_MS[attempt] ?? 8_000;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createJobFinderAiClientFromEnvironment(
  env: StringMap = process.env,
): JobFinderAiClient {
  const apiKey = env.NESTOR_AI_API_KEY;
  const parsedRequestTimeoutMs = parseConfiguredTimeoutMs(
    env.NESTOR_AI_TIMEOUT_MS,
  );
  const parsedResumeExtractionTimeoutMs = parseConfiguredTimeoutMs(
    env.NESTOR_AI_RESUME_TIMEOUT_MS,
  );
  // Liveness and retry knobs shared by every model route (see ADR 0020).
  const parsedResilience = {
    idleTimeoutMs: parseConfiguredTimeoutMs(env.NESTOR_AI_IDLE_TIMEOUT_MS),
    maxAttempts: parseConfiguredPositiveInteger(env.NESTOR_AI_MAX_ATTEMPTS),
    streaming: parseConfiguredBoolean(env.NESTOR_AI_STREAMING),
    retryBaseDelayMs: parseConfiguredPositiveInteger(
      env.NESTOR_AI_RETRY_BASE_DELAY_MS,
      0,
    ),
  };

  const browserVisualProvider =
    createBrowserVisualAnalysisProviderFromEnvironment(env);

  if (!apiKey) {
    const deterministicClient = createDeterministicJobFinderAiClient(
      undefined,
      { generationReason: "no_provider_configured" },
    );

    return {
      ...deterministicClient,
      // The model ships with the product, so a missing one is an outage, not
      // a setup step. Without these markers an import finished "Ready" and
      // the Assistant answered "I could not turn it into a safe edit", and
      // nobody could tell the AI had never been asked.
      async extractResumeImportStage(input) {
        const result =
          await deterministicClient.extractResumeImportStage(input);
        return input.stage === "shared_memory"
          ? result
          : {
              ...result,
              fallback: {
                kind: "provider_error" as const,
                reason: NO_AI_PROVIDER_REASON,
              },
            };
      },
      async reviseCandidateProfile(input) {
        const reply = await deterministicClient.reviseCandidateProfile(input);
        const timestamp = new Date().toISOString();
        return {
          ...reply,
          executionReceipt: AgentTaskExecutionReceiptSchema.parse({
            taskId: `profile_copilot_unavailable_${Date.now()}`,
            capability: "profile_copilot",
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 0,
            model: null,
            reasoningEffort: null,
            providerCalls: 0,
            repairAttempts: 0,
            fallbackUsed: true,
            stopReason: "permanent_failure",
            finalValidationIssues: [],
            toolReceipts: [],
          }),
        };
      },
      analyzeBrowserVisualSnapshot: (input) =>
        browserVisualProvider.analyzeBrowserVisualSnapshot(input),
    };
  }

  const primaryClient = createOpenAiCompatibleJobFinderAiClient({
    apiKey,
    baseUrl: env.NESTOR_AI_BASE_URL ?? DEFAULT_OPENCODE_GO_BASE_URL,
    model: env.NESTOR_AI_MODEL ?? DEFAULT_TEXT_MODEL,
    apiMode:
      parseModelApiMode(env.NESTOR_AI_API_MODE) ?? DEFAULT_TEXT_MODEL_API_MODE,
    reasoningEffort:
      parseModelReasoningEffort(env.NESTOR_AI_REASONING_EFFORT) ??
      DEFAULT_TEXT_MODEL_REASONING_EFFORT,
    agentReasoningEffort:
      parseModelReasoningEffort(env.NESTOR_AI_AGENT_REASONING_EFFORT) ??
      DEFAULT_AGENT_TURN_REASONING_EFFORT,
    label: "AI resume agent",
    requestTimeoutMs: parsedRequestTimeoutMs,
    resumeExtractionTimeoutMs: parsedResumeExtractionTimeoutMs,
    ...parsedResilience,
  });
  // Aggressive resume tailoring uses its own model route rather than the
  // primary provider. DeepSeek V4.1 Flash is text-only, so it uses Chat
  // Completions; reasoning effort is read from its own env var so it is
  // always applied (defaults to `high` when not configured). See ADR 0019.
  const aggressiveClient = createOpenAiCompatibleJobFinderAiClient({
    apiKey,
    baseUrl: env.NESTOR_AI_BASE_URL ?? DEFAULT_OPENCODE_GO_BASE_URL,
    model:
      env.NESTOR_AI_AGGRESSIVE_MODEL?.trim() || DEFAULT_AGGRESSIVE_RESUME_MODEL,
    apiMode:
      parseModelApiMode(env.NESTOR_AI_AGGRESSIVE_API_MODE) ??
      DEFAULT_AGGRESSIVE_RESUME_MODEL_API_MODE,
    reasoningEffort:
      parseModelReasoningEffort(env.NESTOR_AI_AGGRESSIVE_REASONING_EFFORT) ??
      DEFAULT_AGGRESSIVE_RESUME_MODEL_REASONING_EFFORT,
    label: "Aggressive AI resume agent",
    requestTimeoutMs: parsedRequestTimeoutMs,
    resumeExtractionTimeoutMs: parsedResumeExtractionTimeoutMs,
    ...parsedResilience,
  });
  function selectResumeGenerationClient(
    input: CreateResumeDraftInput | TailorResumeInput,
  ): AgentCapableJobFinderAiClient {
    const tailoringStrength =
      "strategy" in input ? input.strategy?.tailoringStrength : undefined;
    const effectiveTailoringMode =
      tailoringStrength ?? input.searchPreferences.tailoringMode;
    return effectiveTailoringMode === "aggressive"
      ? aggressiveClient
      : primaryClient;
  }
  const fallbackClient = createDeterministicJobFinderAiClient(
    "The configured model is enabled, and deterministic fallbacks protect the app when a model call fails.",
  );
  function createFallbackExecutionReceipt(
    capability: string,
    stopReason: "no_progress" | "permanent_failure" | "time_budget",
  ) {
    const timestamp = new Date().toISOString();
    return AgentTaskExecutionReceiptSchema.parse({
      taskId: `${capability}_fallback_${Date.now()}`,
      capability,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      model: primaryClient.getStatus().model ?? null,
      reasoningEffort: null,
      providerCalls: 0,
      repairAttempts: 0,
      fallbackUsed: true,
      stopReason,
      finalValidationIssues: [],
      toolReceipts: [],
    });
  }
  return {
    getStatus() {
      return primaryClient.getStatus();
    },
    // No rule-made stand-in when a model call fails (ADR 0041): the failure
    // is reported and what the person had stays as it was.
    extractProfileFromResume(input) {
      return primaryClient.extractProfileFromResume(input);
    },
    async extractResumeImportStage(input) {
      const startedAtMs = performance.now();
      // The model reads the resume (ADR 0041). Its candidates are the
      // import; no rule-read candidates are mixed in beside them. A call that
      // fails for a passing reason (an overloaded provider, a dropped
      // connection) is asked again. A section it still cannot read fails
      // with a sentence for the person, instead of being filled from rule
      // guesses that would land in the profile unseen.
      let lastError: unknown = null;
      for (
        let attempt = 0;
        attempt < RESUME_IMPORT_STAGE_ATTEMPTS;
        attempt += 1
      ) {
        if (attempt > 0) {
          await waitBeforeResumeImportRetry(attempt);
        }
        const primaryStartedAtMs = performance.now();
        try {
          const primary = await runResumeImportStageAgentTask({
            client: primaryClient,
            request: input,
          });
          return {
            ...primary,
            timing: {
              durationMs: Math.max(
                0,
                Math.round(performance.now() - startedAtMs),
              ),
              primaryProviderMs:
                primary.timing?.primaryProviderMs ??
                Math.max(0, Math.round(performance.now() - primaryStartedAtMs)),
              deterministicFallbackMs: null,
            },
          };
        } catch (error) {
          lastError = error;
          logFallbackError("extractResumeImportStage", error);
          if (/timed out after \d+s/i.test(summarizeError(error))) {
            // A timeout already spent the whole budget once; asking again
            // would double the wait for the same answer.
            break;
          }
        }
      }
      throw new ResumeImportStageUnreadError(
        input.stage,
        summarizeError(lastError),
      );
    },
    async adjudicateResumeImportCandidates(input) {
      // Without the model's ruling every conflict stays in setup review for
      // the person; nothing is decided for them.
      if (!primaryClient.adjudicateResumeImportCandidates) {
        return {
          candidates: [],
          notes: [
            "The AI could not review the conflicting resume details, so they stayed in setup review.",
          ],
          warnings: [],
        };
      }
      try {
        return await primaryClient.adjudicateResumeImportCandidates(input);
      } catch (error) {
        logFallbackError("adjudicateResumeImportCandidates", error);
        return {
          candidates: [],
          notes: [
            "The AI could not review the conflicting resume details, so they stayed in setup review.",
            `AI import review failed: ${summarizeError(error)}`,
          ],
          warnings: [],
        };
      }
    },
    async createResumeDraft(input) {
      // A card-only posting has no listing body. Asking the model to tailor
      // toward a bare title wastes the request and comes back as "no usable
      // proposals", which the studio then reports as a model failure. State
      // the real reason and keep the grounded wording instead.
      if (assessJobPostingDetailQuality(input.job) === "card_only") {
        const fallback = await fallbackClient.createResumeDraft(input);
        return {
          ...fallback,
          generationProvenance: {
            method: "deterministic" as const,
            reason: "listing_text_missing" as const,
            detail: LISTING_TEXT_MISSING_DETAIL,
          },
          notes: uniqueStrings([
            ...fallback.notes,
            LISTING_TEXT_MISSING_DETAIL,
          ]),
        };
      }
      // A body that says nothing specific is the same problem one step along:
      // tailoring toward it produced the same draft for unrelated jobs, which
      // the screen then called "tailored".
      if (
        countDistinguishingListingTerms(input.job) <
        MINIMUM_DISTINGUISHING_LISTING_TERMS
      ) {
        const fallback = await fallbackClient.createResumeDraft(input);
        return {
          ...fallback,
          generationProvenance: {
            method: "deterministic" as const,
            reason: "listing_text_not_distinguishing" as const,
            detail: LISTING_TEXT_NOT_DISTINGUISHING_DETAIL,
          },
          notes: uniqueStrings([
            ...fallback.notes,
            LISTING_TEXT_NOT_DISTINGUISHING_DETAIL,
          ]),
        };
      }
      const modelClient = selectResumeGenerationClient(input);
      const providerLabel =
        modelClient === aggressiveClient ? "Aggressive AI" : "Primary AI";
      try {
        const generated = await runResumeGenerationAgentTask({
          client: modelClient,
          request: input,
          substantivePrompt: buildResumeRewriteProposalPrompt(
            input.strategy?.tailoringStrength ??
              input.searchPreferences.tailoringMode,
            input.strategy,
          ),
        });
        const model = modelClient.getStatus().model;
        return {
          ...generated,
          notes:
            generated.generationProvenance?.method === "ai"
              ? uniqueStrings([
                  ...generated.notes,
                  `Generated with ${providerLabel}${model ? ` (${model})` : ""}.`,
                ])
              : generated.notes,
        };
      } catch (error) {
        logFallbackError("createResumeDraft", error);
        throw resumeWritingFailed(error);
      }
    },
    async reviseResumeDraft(input) {
      // Model-backed review and section regeneration on an aggressive draft
      // stays on the aggressive provider so the whole lifecycle uses one
      // model; without a known aggressive strength the primary provider runs.
      const editClient =
        input.tailoringStrength === "aggressive"
          ? aggressiveClient
          : primaryClient;
      try {
        const reply = await runResumeEditAgentTask({
          client: editClient,
          request: input,
        });
        if (reply.executionReceipt?.stopReason === "completed") return reply;
        // Names and outcomes only, never content: without this a stopped
        // Assistant run left no trace of what it spent its budget on.
        console.warn(
          `[AI Provider] reviseResumeDraft stopped (${reply.executionReceipt?.stopReason ?? "unknown"}) after ${reply.executionReceipt?.providerCalls ?? 0} model calls: ${(
            reply.executionReceipt?.toolReceipts ?? []
          )
            .map(
              (receipt) =>
                `${receipt.toolName}:${receipt.outcome}${receipt.durationMs >= 5_000 ? `(${Math.round(receipt.durationMs / 1_000)}s)` : ""}`,
            )
            .join(", ")}`,
        );
        // A run that stopped on its time or progress budget may still have
        // produced the answer: a grounded patch, or a plain explanation of
        // what could not be done. Throwing that away for the deterministic
        // fallback cost the user the model's work. Keep it, with the receipt
        // saying honestly how the run ended.
        if (
          reply.patches.length > 0 ||
          (reply.content.trim().length > 0 &&
            !RESUME_EDIT_PLACEHOLDER_CONTENT.test(reply.content))
        ) {
          return reply;
        }
        const timedOut = reply.executionReceipt?.stopReason === "time_budget";
        return {
          content: timedOut
            ? "The AI took too long to answer this time, so nothing was changed. Send the request again."
            : RESUME_ASSISTANT_UNAVAILABLE_REPLY,
          patches: [],
          executionReceipt: createFallbackExecutionReceipt(
            "resume_guided_edit",
            timedOut ? "time_budget" : "no_progress",
          ),
        };
      } catch (error) {
        logFallbackError("reviseResumeDraft", error);
        return {
          content: RESUME_ASSISTANT_UNAVAILABLE_REPLY,
          patches: [],
          executionReceipt: createFallbackExecutionReceipt(
            "resume_guided_edit",
            "permanent_failure",
          ),
        };
      }
    },
    async reviseCandidateProfile(input) {
      try {
        let primaryReply = await runProfileCopilotAgentTask({
          client: primaryClient,
          request: input,
        });

        // A run that stops short of finish_task used to be thrown away whole,
        // proposals included (a live "add a target role" run). A run that
        // stopped with nothing prepared gets one fresh attempt; one that
        // prepared cards keeps them, and its receipt tells the service it
        // stopped early.
        if (
          shouldRetryUnfinishedProfileRun(primaryReply) &&
          primaryReply.patchGroups.length === 0
        ) {
          primaryReply = await runProfileCopilotAgentTask({
            client: primaryClient,
            request: input,
          });
        }

        // Nothing prepared and not finished: the question stays on screen
        // with Ask again under it. No rule-made edit stands in (ADR 0041).
        if (
          primaryReply.executionReceipt?.stopReason !== "completed" &&
          primaryReply.patchGroups.length === 0
        ) {
          throw new ProfileCopilotUnfinishedError();
        }
        return primaryReply;
      } catch (error) {
        if (error instanceof ProfileCopilotUnfinishedError) {
          throw error;
        }
        logFallbackError("reviseCandidateProfile", error);
        // The service turns this into the outage message on screen.
        return {
          content: PROFILE_ASSISTANT_UNFINISHED_MESSAGE,
          patchGroups: [],
          executionReceipt: createFallbackExecutionReceipt(
            "profile_copilot",
            "permanent_failure",
          ),
        };
      }
    },
    async tailorResume(input) {
      const modelClient = selectResumeGenerationClient(input);
      try {
        return await modelClient.tailorResume(input);
      } catch (error) {
        logFallbackError("tailorResume", error);
        throw resumeWritingFailed(error);
      }
    },
    async assessJobFit(input) {
      try {
        return await primaryClient.assessJobFit(input);
      } catch (error) {
        if (
          input.signal?.aborted ||
          error instanceof FullFitEvidenceBudgetError
        ) {
          throw error;
        }
        // No verdict stands in: the job stays as it was and says so.
        logFallbackError("assessJobFit", error);
        return null;
      }
    },
    // A failed check leaves the lines unchecked for the person to look at;
    // no rule stands in for the model's verdict (ADR 0041).
    checkResumeClaims(input) {
      const claimClient =
        input.tailoringStrength === "aggressive"
          ? aggressiveClient
          : primaryClient;
      return claimClient.checkResumeClaims
        ? claimClient.checkResumeClaims(input)
        : Promise.resolve([]);
    },
    async judgeJobFits(input) {
      if (!primaryClient.judgeJobFits) {
        return [];
      }
      try {
        return await primaryClient.judgeJobFits(input);
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
        // No rule-made verdict stands in: the jobs stay unjudged and the
        // next pass asks again.
        logFallbackError("judgeJobFits", error);
        return [];
      }
    },
    async extractJobsFromPage(input) {
      try {
        return await primaryClient.extractJobsFromPage(input);
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
        // A failed read is reported to whoever asked, never passed off as a
        // page with no jobs on it.
        logFallbackError("extractJobsFromPage", error);
        throw error;
      }
    },
    async analyzeBrowserVisualSnapshot(input) {
      try {
        return await browserVisualProvider.analyzeBrowserVisualSnapshot(input);
      } catch (error) {
        logFallbackError("analyzeBrowserVisualSnapshot", error);
        throw error;
      }
    },
    async chatWithTools(messages, tools, options?: ChatWithToolsOptions) {
      try {
        return await primaryClient.chatWithTools(messages, tools, options);
      } catch (error) {
        logFallbackError("chatWithTools", error);
        throw error;
      }
    },
  };
}
