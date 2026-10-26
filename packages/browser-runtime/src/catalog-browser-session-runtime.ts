import {
  ApplyExecutionResultSchema,
  ApplyVisualCheckpointSchema,
  BrowserVisualEvidenceSummarySchema,
  BrowserVisualObservationSetSchema,
  BrowserVisualSnapshotRefSchema,
  BrowserVisualSnapshotRequestSchema,
  BrowserSessionStateSchema,
  DiscoveryRunResultSchema,
  JobPostingSchema,
  type ApplyExecutionResult,
  type ApplicationAttemptQuestion,
  type BrowserSessionState,
  type JobPosting,
  type JobSource,
} from "@nestor/contracts";
import type {
  AgentDiscoveryOptions,
  BrowserSessionRuntime,
  CatalogBrowserSessionRuntimeSeed,
  ExecuteApplicationFlowInput,
  ExecuteEasyApplyInput,
  StubBrowserSessionRuntimeSeed,
} from "./runtime-types";
import { createInconclusiveSourceAccessProbeResult } from "./source-access-probe";
import {
  buildDiscoveryQuerySummary,
  buildSessionBlockedResult,
  cloneValue,
  matchesAnyPhrase,
  meetsCompensationMinimum,
  normalizeText,
} from "./catalog-runtime-utils";

let catalogVisualSnapshotSequence = 0;

function filterCatalogDiscoveryJobs(
  jobs: readonly JobPosting[],
  searchPreferences: Parameters<BrowserSessionRuntime["runDiscovery"]>[1],
) {
  return jobs.filter((job) => {
    if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
      return false;
    }

    if (
      searchPreferences.companyBlacklist.some(
        (company) => normalizeText(company) === normalizeText(job.company),
      )
    ) {
      return false;
    }

    const matchesRole = matchesAnyPhrase(
      job.title,
      searchPreferences.targetRoles,
    );
    const matchesLocation = matchesAnyPhrase(
      job.location,
      searchPreferences.locations,
    );
    const matchesWorkMode =
      searchPreferences.workModes.length === 0 ||
      searchPreferences.workModes.includes("flexible") ||
      job.workMode.length === 0 ||
      job.workMode.includes("flexible") ||
      job.workMode.some((mode) => searchPreferences.workModes.includes(mode));
    const meetsSalaryExpectation = meetsCompensationMinimum(
      job.salaryText,
      searchPreferences.compensation,
    );

    return (
      matchesRole &&
      matchesLocation &&
      matchesWorkMode &&
      meetsSalaryExpectation
    );
  });
}

function filterCatalogAgentDiscoveryJobs(
  jobs: readonly JobPosting[],
  options: AgentDiscoveryOptions,
) {
  return jobs
    .filter((job) => {
      if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
        return false;
      }

      const matchesRole = matchesAnyPhrase(
        job.title,
        options.searchPreferences.targetRoles,
      );
      const matchesLocation = matchesAnyPhrase(
        job.location,
        options.searchPreferences.locations,
      );
      return matchesRole && matchesLocation;
    })
    .slice(0, options.targetJobCount);
}

function getStartingUrl(options: AgentDiscoveryOptions): string {
  const startingUrl = options.startingUrls
    .map((url) => url.trim())
    .find((url) => url.length > 0);

  if (!startingUrl) {
    throw new Error(
      `Catalog browser runtime requires at least one starting URL for ${options.siteLabel}.`,
    );
  }

  return startingUrl;
}

function buildApplyReplay(
  job: ExecuteApplicationFlowInput["job"],
  recoveryContext?: ExecuteApplicationFlowInput["recoveryContext"],
) {
  const lastUrl = job.applicationUrl ?? job.canonicalUrl;
  const checkpointUrls = Array.from(
    new Set([
      ...(recoveryContext?.latestCheckpoint?.url
        ? [recoveryContext.latestCheckpoint.url]
        : []),
      ...(recoveryContext?.checkpointUrls ?? []),
      ...(lastUrl ? [lastUrl] : []),
    ]),
  );

  return {
    sourceInstructionArtifactId: null,
    sourceDebugEvidenceRefIds: [],
    lastUrl:
      recoveryContext?.latestCheckpoint?.url ??
      recoveryContext?.checkpointUrls?.[0] ??
      lastUrl,
    checkpointUrls,
  };
}

function inferConsentInterruptKind(
  description: string,
): "signup" | "existing_account_decision" | "manual_verification" | null {
  const normalizedDescription = description.toLowerCase();

  if (
    normalizedDescription.includes("sign up") ||
    normalizedDescription.includes("signup") ||
    normalizedDescription.includes("create an account")
  ) {
    return "signup";
  }

  if (normalizedDescription.includes("already have an account")) {
    return "existing_account_decision";
  }

  if (normalizedDescription.includes("manual verification")) {
    return "manual_verification";
  }

  return null;
}

function buildProfileAnswerQuestion(input: {
  id: string;
  prompt: string;
  kind: ApplicationAttemptQuestion["kind"];
  answerText: string | null;
  sourceId: string;
  now: string;
}): ApplicationAttemptQuestion {
  return {
    id: input.id,
    prompt: input.prompt,
    kind: input.kind,
    isRequired: true,
    detectedAt: input.now,
    answerOptions: [],
    suggestedAnswers: input.answerText
      ? [
          {
            id: `suggested_answer_${input.id}`,
            text: input.answerText,
            sourceKind: "profile",
            sourceId: input.sourceId,
            confidenceLabel: "profile default",
            provenance: [
              {
                id: `answer_provenance_${input.id}`,
                sourceKind: "profile",
                sourceId: input.sourceId,
                label: "Profile answer bank",
                snippet: input.answerText,
              },
            ],
          },
        ]
      : [],
    submittedAnswer: null,
    status: "detected",
  };
}

function buildScreeningQuestions(input: {
  job: ExecuteApplicationFlowInput["job"];
  profile: ExecuteApplicationFlowInput["profile"];
  now: string;
}): ApplicationAttemptQuestion[] {
  const normalizedDescription = input.job.description.toLowerCase();
  const questions: ApplicationAttemptQuestion[] = [];

  if (
    normalizedDescription.includes("work authorization") ||
    normalizedDescription.includes("visa sponsorship")
  ) {
    const questionId = `question_${input.job.id}_work_auth`;
    const suggestedAnswerTexts: string[] = [];

    questions.push({
      id: questionId,
      prompt:
        "Can you confirm your work authorization or visa sponsorship status?",
      kind: "work_authorization",
      isRequired: true,
      detectedAt: input.now,
      answerOptions: [],
      suggestedAnswers: suggestedAnswerTexts.map((text, index) => ({
        id: `suggested_answer_${questionId}_${index + 1}`,
        text,
        sourceKind: "profile",
        sourceId: input.profile.id,
        confidenceLabel: "profile default",
        provenance: [
          {
            id: `answer_provenance_${questionId}_${index + 1}`,
            sourceKind: "profile",
            sourceId: input.profile.id,
            label: "Profile answer bank",
            snippet: text,
          },
        ],
      })),
      submittedAnswer: null,
      status: "detected",
    });
  }

  if (normalizedDescription.includes("salary expectation")) {
    questions.push(
      buildProfileAnswerQuestion({
        id: `question_${input.job.id}_salary`,
        prompt: "What are your salary expectations for this role?",
        kind: "salary_expectation",
        answerText: null,
        sourceId: input.profile.id,
        now: input.now,
      }),
    );
  }

  if (normalizedDescription.includes("portfolio")) {
    questions.push(
      buildProfileAnswerQuestion({
        id: `question_${input.job.id}_portfolio`,
        prompt: "Please share a portfolio, case study, or public work sample.",
        kind: "portfolio",
        answerText: input.profile.portfolioUrl,
        sourceId: input.profile.id,
        now: input.now,
      }),
    );
  }

  return questions;
}

function buildCatalogApplyVisualDiagnostics(input: {
  input: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">;
  now: string;
}): Pick<
  ApplyExecutionResult,
  "visualEvidence" | "visualObservationSets" | "visualCheckpoints"
> {
  if (
    !input.input.captureVisualSnapshot ||
    !input.input.analyzeVisualSnapshot
  ) {
    return {
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
    };
  }

  const explicitCaptureVisualSnapshot = input.input.captureVisualSnapshot;
  const explicitAnalyzeVisualSnapshot = input.input.analyzeVisualSnapshot;
  void explicitCaptureVisualSnapshot;
  void explicitAnalyzeVisualSnapshot;

  const { job } = input.input;
  const normalizedDescription = job.description.toLowerCase();
  const blockers = [
    normalizedDescription.includes("sign up") ||
    normalizedDescription.includes("already have an account")
      ? "Application description indicates a consent or account-choice blocker."
      : null,
  ].filter((value): value is string => Boolean(value));
  const fieldControls = [
    "Approved resume upload is represented by the saved apply runtime contract.",
    normalizedDescription.includes("portfolio")
      ? "Portfolio field may be visible in the application form."
      : null,
    normalizedDescription.includes("email") ||
    normalizedDescription.includes("phone")
      ? "Contact-detail fields may be visible in the application form."
      : null,
  ].filter((value): value is string => Boolean(value));
  const validationErrors = [
    normalizedDescription.includes("required")
      ? "Application description includes required-field language."
      : null,
  ].filter((value): value is string => Boolean(value));
  const summary =
    blockers[0] ??
    fieldControls[0] ??
    "Catalog runtime produced deterministic apply visual context.";
  const evidence = BrowserVisualEvidenceSummarySchema.parse({
    snapshotId: `catalog_apply_visual_snapshot_${job.id}`,
    observationSetId: `catalog_apply_visual_observation_${job.id}`,
    summary,
    capturedAt: input.now,
    storagePath: null,
    retention: "temporary",
    redactionLevel: "sensitive",
    confidence: 0.52,
    reconciliationStatus: "not_compared",
  });
  const observationSet = BrowserVisualObservationSetSchema.parse({
    id: evidence.observationSetId,
    snapshotId: evidence.snapshotId,
    observedAt: input.now,
    url: job.applicationUrl ?? job.canonicalUrl,
    purpose: "apply_checkpoint",
    providerKind: "deterministic",
    providerLabel: "Catalog apply visual diagnostics",
    summary,
    blockers,
    fieldControls,
    validationErrors,
    recoveryNotes: [
      "Catalog runtime produced deterministic visual context without capturing screenshots.",
    ],
  });
  const checkpoint = ApplyVisualCheckpointSchema.parse({
    id: `catalog_apply_visual_checkpoint_${job.id}`,
    label: "Deterministic apply visual checkpoint",
    purpose: "apply_checkpoint",
    snapshotId: evidence.snapshotId,
    observationSetId: evidence.observationSetId,
    summary,
    capturedAt: input.now,
    retained: false,
    storagePath: null,
    blockers,
    fieldControls,
    validationErrors,
    buttonStates: [],
    questionContextIds: [],
    reconciliations: [],
  });

  return {
    visualEvidence: [evidence],
    visualObservationSets: [observationSet],
    visualCheckpoints: [checkpoint],
  };
}

/**
 * The catalog runtime answers from a fixture rather than a page, so it never
 * fills a form in and never needs the preparer a live run supplies.
 */
function executeCatalogApplicationFlow(
  input: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">,
): ApplyExecutionResult {
  const now = new Date().toISOString();
  const { job, resumeArtifact } = input;
  const resumeFilePath = resumeArtifact.filePath;
  const resumeFileName = resumeArtifact.fileName;
  const resumeLabel =
    resumeArtifact.source === "original_upload"
      ? "Original resume selected by the user"
      : "Approved tailored resume export";
  const questions = buildScreeningQuestions({
    job,
    profile: input.profile,
    now,
  });
  const replay = buildApplyReplay(job, input.recoveryContext);
  const consentInterruptKind = inferConsentInterruptKind(job.description);
  const requiresConsentInterrupt = consentInterruptKind !== null;
  const recoveryCheckpoint = input.recoveryContext?.latestCheckpoint
    ? {
        id: `checkpoint_${job.id}_recovery_resume`,
        at: now,
        label: "Resumed from retained apply context",
        detail: input.recoveryContext.latestCheckpoint.detail
          ? `Retry started from retained context after '${input.recoveryContext.latestCheckpoint.label}'. ${input.recoveryContext.latestCheckpoint.detail}`
          : `Retry started from retained context after '${input.recoveryContext.latestCheckpoint.label}'.`,
        state: "in_progress" as const,
      }
    : null;
  const visualDiagnostics = buildCatalogApplyVisualDiagnostics({ input, now });

  if (!resumeFilePath.trim()) {
    return ApplyExecutionResultSchema.parse({
      state: "failed",
      summary: "Approved resume export is missing",
      detail:
        "The apply flow cannot continue until the selected application resume is available.",
      submittedAt: null,
      outcome: null,
      questions: [],
      blocker: {
        code: "missing_resume",
        summary: "The approved tailored resume export is missing.",
        detail:
          "The catalog runtime refused to continue without an approved resume export file path.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl ?? job.canonicalUrl,
      },
      consentDecisions: [],
      replay,
      visualEvidence: visualDiagnostics.visualEvidence,
      visualObservationSets: visualDiagnostics.visualObservationSets,
      visualCheckpoints: visualDiagnostics.visualCheckpoints,
      nextActionLabel: "Re-export and approve the tailored resume",
      checkpoints: [
        ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
        {
          id: `checkpoint_${job.id}_asset_missing`,
          at: now,
          label: "Resume export missing",
          detail:
            "The catalog runtime refused to continue without an approved resume export file path.",
          state: "failed",
          visualEvidence: visualDiagnostics.visualEvidence,
        },
      ],
    });
  }

  const resumeQuestion: ApplicationAttemptQuestion = {
    id: `question_${job.id}_resume_upload`,
    prompt: "Upload the approved tailored resume.",
    kind: "resume",
    isRequired: true,
    detectedAt: now,
    answerOptions: [],
    suggestedAnswers: [
      {
        id: `suggested_answer_${job.id}_resume_upload`,
        text: resumeFileName,
        sourceKind: "resume",
        sourceId: resumeArtifact.id,
        confidenceLabel: "user-approved resume",
        provenance: [
          {
            id: `answer_provenance_resume_${resumeArtifact.id}`,
            sourceKind: "resume",
            sourceId: resumeArtifact.id,
            label: resumeLabel,
            snippet: resumeFileName,
          },
        ],
      },
    ],
    submittedAnswer: resumeFileName,
    status: "submitted",
  };
  const capturedQuestions = [resumeQuestion, ...questions];

  if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
    return ApplyExecutionResultSchema.parse({
      state: "unsupported",
      summary: "Easy Apply path is unsupported",
      detail: `${job.title} at ${job.company} no longer exposes a supported Easy Apply path for this slice.`,
      submittedAt: null,
      outcome: null,
      questions: [],
      blocker: {
        code: "unsupported_apply_path",
        summary: "The saved job no longer exposes a supported Easy Apply path.",
        detail:
          "The deterministic catalog runtime stopped before entering an unsupported or external branch.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl ?? job.canonicalUrl,
      },
      consentDecisions: [],
      replay,
      visualEvidence: visualDiagnostics.visualEvidence,
      visualObservationSets: visualDiagnostics.visualObservationSets,
      visualCheckpoints: visualDiagnostics.visualCheckpoints,
      nextActionLabel: "Inspect the listing manually",
      checkpoints: [
        ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
        {
          id: `checkpoint_${job.id}_unsupported`,
          at: now,
          label: "Unsupported apply path",
          detail:
            "The deterministic catalog runtime stopped before entering an unsupported or external branch.",
          state: "unsupported",
        },
      ],
    });
  }

  if (requiresConsentInterrupt) {
    const consentDecisionLabel =
      consentInterruptKind === "signup"
        ? "Continue into a sign-up step for this application"
        : consentInterruptKind === "existing_account_decision"
          ? "Choose whether to continue through an existing-account path"
          : "Continue through the manual verification step for this application";
    const consentDecisionDetail =
      consentInterruptKind === "signup"
        ? "The page indicates that a sign-up step is required before the application can continue."
        : consentInterruptKind === "existing_account_decision"
          ? "The page asks whether you already have an account, and the run cannot assume that answer."
          : "The page requires a manual verification step before the application can continue.";

    return ApplyExecutionResultSchema.parse({
      state: "paused",
      summary: "Apply run paused for live consent",
      detail:
        "The application flow reached a consent-gated step that requires an explicit user decision before the run can continue.",
      submittedAt: null,
      outcome: null,
      questions: capturedQuestions,
      blocker: {
        code: "missing_consent",
        summary: "A consent-gated step needs a live user decision.",
        detail:
          "The deterministic catalog runtime stopped before any consent-gated branch such as sign-up, account-choice, or manual verification.",
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl ?? job.canonicalUrl,
      },
      consentDecisions: [
        {
          id: `consent_${job.id}_resume_use`,
          kind: "resume_use",
          label: "Use the selected resume for this apply flow",
          status: "approved",
          decidedAt: now,
          detail: `${resumeLabel} (${resumeArtifact.id}) stayed selected for this run.`,
        },
        {
          id: `consent_${job.id}_consent_interrupt`,
          kind: "manual_follow_up",
          label: consentDecisionLabel,
          status: "requested",
          decidedAt: null,
          detail: consentDecisionDetail,
        },
      ],
      replay,
      visualEvidence: visualDiagnostics.visualEvidence,
      visualObservationSets: visualDiagnostics.visualObservationSets,
      visualCheckpoints: visualDiagnostics.visualCheckpoints,
      nextActionLabel:
        "Review the consent request and decide whether to continue or skip this job",
      checkpoints: [
        ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
        {
          id: `checkpoint_${job.id}_open_listing`,
          at: now,
          label: "Opened Easy Apply",
          detail:
            "The catalog runtime validated the listing and started the Easy Apply flow.",
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_resume_attached`,
          at: now,
          label: "Attached selected resume",
          detail: `Attached the selected application resume '${resumeFileName}'.`,
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_consent_pause`,
          at: now,
          label: "Paused for consent",
          detail:
            "The run reached a consent-gated step and stopped before any consent-required branch continued.",
          state: "paused",
        },
      ],
    });
  }

  const requiresHumanPause = questions.length > 0;

  if (input.mode === "prepare_only") {
    return ApplyExecutionResultSchema.parse({
      state: "paused",
      summary: requiresHumanPause
        ? "Apply copilot paused for review-ready questions"
        : "Apply copilot paused before final submit",
      detail: requiresHumanPause
        ? `${job.company} asks for additional information. The copilot captured grounded suggestions, attached the approved resume, and paused for review before any final submit.`
        : "The approved tailored resume is attached and grounded profile answers are prepared. The copilot stopped before the final submit step.",
      submittedAt: null,
      outcome: null,
      questions: capturedQuestions,
      blocker: requiresHumanPause
        ? {
            code: "requires_manual_review",
            summary:
              "Additional questions are ready for review before final submit.",
            detail:
              "The deterministic catalog runtime captured grounded suggestions, then paused without clicking the final submit button.",
            questionIds: questions.map((question) => question.id),
            sourceDebugEvidenceRefIds: [],
            url: job.applicationUrl ?? job.canonicalUrl,
          }
        : null,
      consentDecisions: [
        {
          id: `consent_${job.id}_resume_use`,
          kind: "resume_use",
          label: "Use the selected resume for this apply flow",
          status: "approved",
          decidedAt: now,
          detail: `${resumeLabel} (${resumeArtifact.id}) stayed selected for this copilot run.`,
        },
        {
          id: `consent_${job.id}_autofill_profile`,
          kind: "autofill_profile",
          label: "Use saved profile details where the form requests them",
          status: "approved",
          decidedAt: now,
          detail: requiresHumanPause
            ? "Grounded suggestions were prepared for review-ready questions."
            : "Grounded profile fields were prepared without needing extra review.",
        },
      ],
      replay,
      visualEvidence: visualDiagnostics.visualEvidence,
      visualObservationSets: visualDiagnostics.visualObservationSets,
      visualCheckpoints: visualDiagnostics.visualCheckpoints,
      nextActionLabel: requiresHumanPause
        ? "Review the prepared answers and continue manually when ready"
        : "Review the prepared application and submit manually when ready",
      checkpoints: [
        ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
        {
          id: `checkpoint_${job.id}_open_listing`,
          at: now,
          label: "Opened Easy Apply",
          detail:
            "The catalog runtime validated the listing and started the Easy Apply flow.",
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_resume_attached`,
          at: now,
          label: "Attached selected resume",
          detail: `Attached the selected application resume '${resumeFileName}'.`,
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_prepared_for_review`,
          at: now,
          label: requiresHumanPause
            ? "Captured review-ready questions"
            : "Prepared application for final review",
          detail: requiresHumanPause
            ? "Grounded answer suggestions were captured and the run paused before final submit."
            : "The supported path reached the review step and paused before final submit.",
          state: "paused",
        },
      ],
    });
  }

  if (requiresHumanPause) {
    return ApplyExecutionResultSchema.parse({
      state: "paused",
      summary: "Easy Apply needs manual review",
      detail: `${job.company} asks for additional information that the safe automation path will not guess.`,
      submittedAt: null,
      outcome: null,
      questions: capturedQuestions,
      blocker: {
        code: "requires_manual_review",
        summary: "Extra application questions need manual review.",
        detail:
          "The deterministic catalog runtime detected unsupported questions before submission.",
        questionIds: questions.map((question) => question.id),
        sourceDebugEvidenceRefIds: [],
        url: job.applicationUrl ?? job.canonicalUrl,
      },
      consentDecisions: [
        {
          id: `consent_${job.id}_resume_use`,
          kind: "resume_use",
          label: "Use the selected resume for this apply flow",
          status: "approved",
          decidedAt: now,
          detail: `${resumeLabel} (${resumeArtifact.id}) stayed selected for this attempt.`,
        },
        {
          id: `consent_${job.id}_manual_follow_up`,
          kind: "manual_follow_up",
          label: "Finish unsupported answers manually",
          status: "requested",
          decidedAt: null,
          detail:
            "The remaining questions need a human answer before submission.",
        },
      ],
      replay,
      visualEvidence: visualDiagnostics.visualEvidence,
      visualObservationSets: visualDiagnostics.visualObservationSets,
      visualCheckpoints: visualDiagnostics.visualCheckpoints,
      nextActionLabel:
        "Open the application and finish the unsupported fields manually",
      checkpoints: [
        ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
        {
          id: `checkpoint_${job.id}_open_listing`,
          at: now,
          label: "Opened Easy Apply",
          detail:
            "The catalog runtime validated the listing and started the Easy Apply flow.",
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_resume_attached`,
          at: now,
          label: "Attached selected resume",
          detail: `Attached the selected application resume '${resumeFileName}'.`,
          state: "in_progress",
        },
        {
          id: `checkpoint_${job.id}_manual_review`,
          at: now,
          label: "Paused for manual review",
          detail: "Unsupported questions were detected before submission.",
          state: "paused",
        },
      ],
    });
  }

  return ApplyExecutionResultSchema.parse({
    state: "paused",
    summary: "Apply copilot paused before final submit",
    detail:
      "The selected application resume is attached and grounded profile answers are prepared. The copilot stopped before the final submit step.",
    submittedAt: null,
    outcome: null,
    questions: capturedQuestions,
    blocker: null,
    consentDecisions: [
      {
        id: `consent_${job.id}_resume_use`,
        kind: "resume_use",
        label: "Use the selected resume for this apply flow",
        status: "approved",
        decidedAt: now,
        detail: `${resumeLabel} (${resumeArtifact.id}) stayed selected for this copilot run.`,
      },
      {
        id: `consent_${job.id}_autofill_profile`,
        kind: "autofill_profile",
        label: "Use saved profile details where the form requests them",
        status: "approved",
        decidedAt: now,
        detail:
          "Grounded profile fields were prepared without needing extra review.",
      },
    ],
    replay,
    visualEvidence: visualDiagnostics.visualEvidence,
    visualObservationSets: visualDiagnostics.visualObservationSets,
    visualCheckpoints: visualDiagnostics.visualCheckpoints,
    nextActionLabel:
      "Review the prepared application and submit manually when ready",
    checkpoints: [
      ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
      {
        id: `checkpoint_${job.id}_open_listing`,
        at: now,
        label: "Opened Easy Apply",
        detail:
          "The catalog runtime validated the listing and started the Easy Apply flow.",
        state: "in_progress",
      },
      {
        id: `checkpoint_${job.id}_resume_attached`,
        at: now,
        label: "Attached selected resume",
        detail: `Attached the selected application resume '${resumeFileName}'.`,
        state: "in_progress",
      },
      {
        id: `checkpoint_${job.id}_prepared_for_review`,
        at: now,
        label: "Prepared application for final review",
        detail:
          "The supported path reached the review step and paused before final submit.",
        state: "paused",
      },
    ],
  });
}

export function createCatalogBrowserSessionRuntime(
  seed: CatalogBrowserSessionRuntimeSeed,
): BrowserSessionRuntime {
  const initialSessions = new Map(
    seed.sessions.map((session) => [
      session.source,
      BrowserSessionStateSchema.parse(cloneValue(session)),
    ]),
  );
  const sessions = new Map(initialSessions);
  const catalog = JobPostingSchema.array().parse(cloneValue(seed.catalog));

  function getSession(source: JobSource): BrowserSessionState {
    const session = sessions.get(source);

    if (session) {
      return cloneValue(session);
    }

    return BrowserSessionStateSchema.parse({
      source,
      status: "unknown",
      label: "Session status unavailable",
      detail:
        "No browser runtime session has been configured for this source yet.",
      lastCheckedAt: new Date(0).toISOString(),
    });
  }

  const listCatalogJobs = (source: JobSource) =>
    catalog
      .filter((job) => job.source === source)
      .map((job) => cloneValue(job));

  return {
    getSessionState(source) {
      return Promise.resolve(getSession(source));
    },
    openSession(source, options) {
      void options;

      const reopenedSession = cloneValue(
        initialSessions.get(source) ??
          BrowserSessionStateSchema.parse({
            source,
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser session unavailable",
            detail:
              "No browser runtime session has been configured for this source yet.",
            lastCheckedAt: new Date().toISOString(),
          }),
      );
      sessions.set(source, reopenedSession);
      return Promise.resolve(reopenedSession);
    },
    closeSession(source) {
      const closedState = BrowserSessionStateSchema.parse({
        source,
        status: "unknown",
        driver: "catalog_seed",
        label: "Browser session closed",
        detail:
          "The browser session is closed. It will reopen when the next run starts.",
        lastCheckedAt: new Date().toISOString(),
      });
      sessions.set(source, closedState);
      return Promise.resolve(closedState);
    },
    inspectSourceAccess(source, input) {
      void source;
      return Promise.resolve(createInconclusiveSourceAccessProbeResult(input));
    },
    runDiscovery(source, searchPreferences) {
      const session = getSession(source);

      if (session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      const startedAt = new Date().toISOString();
      const filteredJobs = filterCatalogDiscoveryJobs(
        listCatalogJobs(source),
        searchPreferences,
      );

      return Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source,
          startedAt,
          completedAt: new Date().toISOString(),
          querySummary: buildDiscoveryQuerySummary(searchPreferences),
          warning:
            filteredJobs.length === 0
              ? "No supported listings matched the current preferences in the configured discovery target."
              : null,
          inventoryCompleteness: "complete",
          jobs: filteredJobs,
        }),
      );
    },
    executeEasyApply(source, input: ExecuteEasyApplyInput) {
      const session = getSession(source);

      if (session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      return Promise.resolve(
        executeCatalogApplicationFlow({
          ...input,
          mode: "prepare_only",
        }),
      );
    },
    executeApplicationFlow(
      source,
      input: ExecuteApplicationFlowInput,
      options,
    ) {
      options?.signal?.throwIfAborted();
      const session = getSession(source);

      if (session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      return Promise.resolve(
        executeCatalogApplicationFlow({
          ...input,
          mode: "prepare_only",
        }),
      );
    },
    captureVisualSnapshot(source, request) {
      const normalizedRequest =
        BrowserVisualSnapshotRequestSchema.parse(request);
      const now = new Date().toISOString();
      catalogVisualSnapshotSequence += 1;

      return Promise.resolve(
        BrowserVisualSnapshotRefSchema.parse({
          id: `visual_snapshot_catalog_${now.replace(/[^0-9]/g, "")}_${catalogVisualSnapshotSequence}`,
          capturedAt: now,
          url: null,
          pageTitle: null,
          mode: normalizedRequest.mode,
          purpose: normalizedRequest.purpose,
          label: normalizedRequest.label,
          region: normalizedRequest.region,
          viewport: null,
          mimeType: "image/png",
          dataUrl: null,
          storagePath: null,
          retention: {
            ...normalizedRequest.retention,
            retention: "temporary",
            reason: `${normalizedRequest.retention.reason} Catalog runtime does not capture screenshots for ${source}.`,
          },
          warnings: [
            "Catalog browser runtime does not provide visual screenshot capture.",
          ],
        }),
      );
    },
    runAgentDiscovery(source, options) {
      const session = getSession(source);

      if (!options.skipSessionValidation && session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      const startingUrl = getStartingUrl(options);
      options.onProgress?.({
        currentUrl: startingUrl,
        jobsFound: 0,
        stepCount: 1,
        currentAction: "navigate",
        targetId: null,
        adapterKind: source,
      });
      const filteredJobs = filterCatalogAgentDiscoveryJobs(
        listCatalogJobs(source),
        options,
      );
      options.onProgress?.({
        currentUrl: startingUrl,
        jobsFound: filteredJobs.length,
        stepCount: 2,
        currentAction: "extract_jobs",
        targetId: null,
        adapterKind: source,
      });

      return Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          querySummary: `${options.searchPreferences.targetRoles.join(", ") || "all roles"} | ${options.searchPreferences.locations.join(", ") || "all locations"} | ${options.siteLabel}`,
          warning:
            filteredJobs.length === 0
              ? `No catalog jobs matched the current ${options.siteLabel} target.`
              : null,
          inventoryCompleteness: "partial",
          jobs: filteredJobs,
          agentMetadata: {
            steps: 2,
            incomplete: false,
            transcriptMessageCount: 0,
            reviewTranscript: [],
            compactionState: null,
            phaseCompletionMode: null,
            phaseCompletionReason: null,
            phaseEvidence: null,
            debugFindings: null,
          },
        }),
      );
    },
  };
}

export function createStubBrowserSessionRuntime(
  seed: StubBrowserSessionRuntimeSeed,
): BrowserSessionRuntime {
  return createCatalogBrowserSessionRuntime(seed);
}
