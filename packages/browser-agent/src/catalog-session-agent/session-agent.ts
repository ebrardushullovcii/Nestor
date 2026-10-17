import {
  ApplyExecutionResultSchema,
  DiscoveryRunResultSchema,
  type AgentDiscoveryProgress,
  type ApplyExecutionResult,
  type ApplyRecoveryContext,
  type BrowserSessionState,
  type CandidateProfile,
  type DiscoveryRunResult,
  type JobFinderSettings,
  type JobPosting,
  type JobSearchPreferences,
  type JobSource,
  type ApplicationResumeArtifact,
  type SavedJob,
} from "@nestor/contracts";
import { buildApplyReplay, buildScreeningQuestions } from "./apply";
import {
  buildDiscoveryQuerySummary,
  filterCatalogAgentDiscoveryJobs,
  filterCatalogDiscoveryJobs,
} from "./discovery";

export interface CatalogSessionRuntimePrimitives {
  getSessionState(source: JobSource): BrowserSessionState;
  listCatalogJobs(source: JobSource): readonly JobPosting[];
}

export interface CatalogSessionAgentDiscoveryOptions {
  searchPreferences: Pick<
    JobSearchPreferences,
    "targetRoles" | "locations" | "companyBlacklist"
  >;
  targetJobCount: number;
  startingUrls: string[];
  siteLabel: string;
  skipSessionValidation?: boolean;
  onProgress?: (progress: AgentDiscoveryProgress) => void;
}

export interface CatalogSessionEasyApplyInput {
  job: SavedJob;
  resumeArtifact: ApplicationResumeArtifact;
  profile: CandidateProfile;
  settings: JobFinderSettings;
  instructions?: readonly string[];
}

export interface CatalogSessionApplicationFlowInput extends CatalogSessionEasyApplyInput {
  mode: "prepare_only" | "submit_when_ready";
  recoveryContext?: ApplyRecoveryContext;
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

function buildSessionBlockedResult(session: BrowserSessionState): Error {
  const detail = session.detail ? ` ${session.detail}` : "";
  return new Error(`Browser session is not ready for automation.${detail}`);
}

function getStartingUrl(options: CatalogSessionAgentDiscoveryOptions): string {
  const startingUrl = options.startingUrls
    .map((url) => url.trim())
    .find((url) => url.length > 0);

  if (!startingUrl) {
    throw new Error(
      `Catalog session agent requires at least one starting URL for ${options.siteLabel}.`,
    );
  }

  return startingUrl;
}

function requireStartingUrl(
  options: CatalogSessionAgentDiscoveryOptions,
): Promise<string> {
  return Promise.resolve().then(() => getStartingUrl(options));
}

export function createCatalogSessionAgent(
  primitives: CatalogSessionRuntimePrimitives,
) {
  function executeApplicationFlow(
    source: JobSource,
    input: CatalogSessionApplicationFlowInput,
  ): Promise<ApplyExecutionResult> {
    const session = primitives.getSessionState(source);

    if (session.status !== "ready") {
      return Promise.reject(buildSessionBlockedResult(session));
    }

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
    const consentInterruptKind =
      job.screeningHints.requiresConsentInterruptKind ??
      inferConsentInterruptKind(job.description);
    const requiresConsentInterrupt =
      job.screeningHints.requiresConsentInterrupt ??
      consentInterruptKind !== null;

    if (!resumeFilePath.trim()) {
      return Promise.resolve(
        ApplyExecutionResultSchema.parse({
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
              "The adapter refused to continue without an approved resume export file path.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: job.applicationUrl ?? job.canonicalUrl,
          },
          consentDecisions: [],
          replay,
          nextActionLabel: "Re-export and approve the tailored resume",
          checkpoints: [
            ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
            {
              id: `checkpoint_${job.id}_asset_missing`,
              at: now,
              label: "Resume export missing",
              detail:
                "The adapter refused to continue without an approved resume export file path.",
              state: "failed",
            },
          ],
        }),
      );
    }

    const resumeQuestion = {
      id: `question_${job.id}_resume_upload`,
      prompt: "Upload the approved tailored resume.",
      kind: "resume" as const,
      isRequired: true,
      detectedAt: now,
      answerOptions: [],
      suggestedAnswers: [
        {
          id: `suggested_answer_${job.id}_resume_upload`,
          text: resumeFileName,
          sourceKind: "resume" as const,
          sourceId: resumeArtifact.id,
          confidenceLabel: "user-approved resume",
          provenance: [
            {
              id: `answer_provenance_resume_${resumeArtifact.id}`,
              sourceKind: "resume" as const,
              sourceId: resumeArtifact.id,
              label: resumeLabel,
              snippet: resumeFileName,
            },
          ],
        },
      ],
      submittedAnswer: resumeFileName,
      status: "submitted" as const,
    };

    const capturedQuestions = [resumeQuestion, ...questions];

    if (job.applyPath !== "easy_apply" || !job.easyApplyEligible) {
      return Promise.resolve(
        ApplyExecutionResultSchema.parse({
          state: "unsupported",
          summary: "Easy Apply path is unsupported",
          detail: `${job.title} at ${job.company} no longer exposes a supported Easy Apply path for this slice.`,
          submittedAt: null,
          outcome: null,
          questions: [],
          blocker: {
            code: "unsupported_apply_path",
            summary:
              "The saved job no longer exposes a supported Easy Apply path.",
            detail:
              "The deterministic adapter stopped before entering an unsupported or external branch.",
            questionIds: [],
            sourceDebugEvidenceRefIds: [],
            url: job.applicationUrl ?? job.canonicalUrl,
          },
          consentDecisions: [],
          replay,
          nextActionLabel: "Inspect the listing manually",
          checkpoints: [
            ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
            {
              id: `checkpoint_${job.id}_unsupported`,
              at: now,
              label: "Unsupported apply path",
              detail:
                "The adapter stopped before entering an unsupported or external branch.",
              state: "unsupported",
            },
          ],
        }),
      );
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

      return Promise.resolve(
        ApplyExecutionResultSchema.parse({
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
              "The deterministic adapter stopped before any consent-gated branch such as sign-up, account-choice, or manual verification.",
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
          nextActionLabel:
            "Review the consent request and decide whether to continue or skip this job",
          checkpoints: [
            ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
            {
              id: `checkpoint_${job.id}_open_listing`,
              at: now,
              label: "Opened Easy Apply",
              detail:
                "The adapter validated the listing and started the Easy Apply flow.",
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
        }),
      );
    }

    const requiresHumanPause = questions.length > 0;

    if (input.mode === "prepare_only") {
      return Promise.resolve(
        ApplyExecutionResultSchema.parse({
          state: "paused",
          summary: requiresHumanPause
            ? "Apply copilot paused for review-ready questions"
            : "Apply copilot paused before final submit",
          detail: requiresHumanPause
            ? `${job.company} asks for additional information. The copilot captured grounded suggestions, attached the approved resume, and paused for review before any final submit.`
            : `The approved tailored resume is attached and grounded profile answers are prepared. The copilot stopped before the final submit step.`,
          submittedAt: null,
          outcome: null,
          questions: capturedQuestions,
          blocker: requiresHumanPause
            ? {
                code: "requires_manual_review",
                summary:
                  "Additional questions are ready for review before final submit.",
                detail:
                  "The deterministic adapter captured grounded suggestions, then paused without clicking the final submit button.",
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
                "The adapter validated the listing and started the Easy Apply flow.",
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
        }),
      );
    }

    if (requiresHumanPause) {
      return Promise.resolve(
        ApplyExecutionResultSchema.parse({
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
              "The deterministic adapter detected unsupported questions before submission.",
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
          nextActionLabel:
            "Open the application and finish the unsupported fields manually",
          checkpoints: [
            ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
            {
              id: `checkpoint_${job.id}_open_listing`,
              at: now,
              label: "Opened Easy Apply",
              detail:
                "The adapter validated the listing and started the Easy Apply flow.",
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
        }),
      );
    }

    return Promise.resolve(
      ApplyExecutionResultSchema.parse({
        state: "paused",
        summary: "Apply copilot paused before final submit",
        detail: `The selected application resume is attached and grounded profile answers are prepared. The copilot stopped before the final submit step.`,
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
        nextActionLabel:
          "Review the prepared application and submit manually when ready",
        checkpoints: [
          ...(recoveryCheckpoint ? [recoveryCheckpoint] : []),
          {
            id: `checkpoint_${job.id}_open_listing`,
            at: now,
            label: "Opened Easy Apply",
            detail:
              "The adapter validated the listing and started the Easy Apply flow.",
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
      }),
    );
  }

  return {
    runDiscovery(
      source: JobSource,
      searchPreferences: JobSearchPreferences,
    ): Promise<DiscoveryRunResult> {
      const session = primitives.getSessionState(source);

      if (session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      const startedAt = new Date().toISOString();
      const filteredJobs = filterCatalogDiscoveryJobs(
        primitives.listCatalogJobs(source),
        searchPreferences,
      );
      const completedAt = new Date().toISOString();

      return Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source,
          startedAt,
          completedAt,
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
    executeEasyApply(source: JobSource, input: CatalogSessionEasyApplyInput) {
      return executeApplicationFlow(source, {
        ...input,
        mode: "prepare_only",
      });
    },
    executeApplicationFlow(
      source: JobSource,
      input: CatalogSessionApplicationFlowInput,
    ) {
      return executeApplicationFlow(source, {
        ...input,
        mode: "prepare_only",
      });
    },
    runAgentDiscovery(
      source: JobSource,
      options: CatalogSessionAgentDiscoveryOptions,
    ): Promise<DiscoveryRunResult> {
      const session = primitives.getSessionState(source);

      if (!options.skipSessionValidation && session.status !== "ready") {
        return Promise.reject(buildSessionBlockedResult(session));
      }

      return requireStartingUrl(options).then((startingUrl) => {
        options.onProgress?.({
          currentUrl: startingUrl,
          jobsFound: 0,
          stepCount: 1,
          currentAction: "navigate",
          targetId: null,
          adapterKind: source,
        });

        const startedAt = new Date().toISOString();
        const filteredJobs = filterCatalogAgentDiscoveryJobs(
          primitives.listCatalogJobs(source),
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

        return DiscoveryRunResultSchema.parse({
          source,
          startedAt,
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
        });
      });
    },
  };
}
