import { createHash } from "node:crypto";
import { createModelUsageRecorder } from "@nestor/ai-providers";
import { accumulateApplyUsage } from "./apply-usage";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  buildApplyFormObservation,
  canContinueApplicationAfterAccess,
  checkClassifiedApplicationAnswers,
  inferQuestionKind,
  fileUploadProblems,
  hasSubmissionConfirmationText,
  questionPrompt,
  STEP_HANDOVER_QUESTION_ID,
  UPLOAD_REPAIR_QUESTION_ID,
  type ApplyAgentResult,
  type ApplyBlocker,
} from "@nestor/browser-agent";
import {
  applicationPreparationConcurrency,
  type BrowserSessionRuntime,
  type ExecuteApplicationFlowInput,
} from "@nestor/browser-runtime";
import {
  AiBehaviorPreferenceSchema,
  ApplicationResumeArtifactSchema,
  SubmissionOutcomeRecordSchema,
  UPLOAD_ATTACHED_ANSWER,
  isUploadRepairPrompt,
  normalizeFormQuestionPrompt,
  submissionConfirmationSummary,
  isActiveApplicationAuthorityEnvelope,
  type ApplicationAuthorityEnvelope,
  type ApplicationRow,
  type ApplicationResumeArtifact,
  type ApplicationReviewCard,
  type ApplyExecutionResult,
  type CandidateProfile,
  type CandidateAnswerKind,
  type JobFinderSettings,
  type SubmissionOutcomeRecord,
  type JobSearchPreferences,
  type JobDetail,
  type NeedsYouKind,
  type ApplicationAutomationMode,
  type SourceInstructionArtifact,
  jobSiteTarget,
} from "@nestor/contracts";
import {
  readSavedApplicationAnswers,
  type ApplicationStore,
} from "@nestor/db/applications";
import {
  createJobSitesStore,
  createResumeStore,
  type JobStore,
  type SendGuards,
} from "@nestor/db/job-store";
import type { JobFinderAiClient } from "@nestor/ai-providers";

import {
  createApplyFormPreparer,
  buildApplyLetterDependencies,
  toApplyLlmClient,
} from "../internal/agent-application-preparation";
import {
  withApplicationAuthorityGate,
  resolveApplicationAuthoritySuccessorId,
} from "../internal/application-authority-gate";
import { authorizeReviewedApplicationOrigin } from "../internal/apply-authority-resolution";
import { runApplicationSubmissionRuntime } from "../internal/application-submission-runtime";
import {
  submitPreparedApplication,
  type SubmitPreparedApplicationRepository,
} from "../internal/apply-submission-handoff";
import type { JobFinderDocumentManager } from "../internal/workspace-service-contracts";
import { toResumeJob } from "../resumes/write-resume";
import {
  describeFormQuestion,
  pageAnswerSuggestion,
  toKnownFormAnswer,
} from "./questions";
import {
  applicationAnswerDependencies,
  applicationAnswersUnchanged,
  profileFactsDigest,
} from "./answer-dependencies";
import { resolveApplicationAttachmentsForExecution } from "../internal/workspace-application-attachments";
import type { CandidateAssetResolver } from "../internal/workspace-service-contracts";
import {
  buildInstructionGuidance,
  resolveActiveSourceInstructionArtifact,
} from "../internal/workspace-helpers";
import { uniqueStrings } from "../internal/shared";

/** The file fields an upload item names, from its words. */
function uploadRepairFields(prompt: string): string[] {
  return prompt
    .replace(/ — upload (?:failed|not confirmed)$/u, "")
    .split(", ")
    .filter(Boolean);
}

export interface ApplicationServiceDeps {
  jobs: JobStore;
  applications: ApplicationStore;
  browser: BrowserSessionRuntime;
  aiClient: JobFinderAiClient;
  documentManager: JobFinderDocumentManager;
  candidateAssets?: CandidateAssetResolver;
  authorityRepository: SubmitPreparedApplicationRepository &
    Pick<
      SendGuards,
      | "listApplicationAuthorityEnvelopes"
      | "getApplicationAuthorityEnvelope"
      | "commitApplicationAuthorityEnvelope"
      | "replaceApplicationAuthorityEnvelope"
    >;
  readInputs(): Promise<{
    profile: CandidateProfile;
    settings: JobFinderSettings;
    searchPreferences: JobSearchPreferences;
    sourceInstructionArtifacts?: readonly SourceInstructionArtifact[];
  }>;
  isPaused(): Promise<boolean>;
  isHoldingCurrent(): Promise<boolean>;
  authorizeSending(input: {
    application: ApplicationRow;
    artifact: ApplicationResumeArtifact;
    job: JobDetail;
    signal: AbortSignal;
    personClicked?: boolean;
  }): Promise<ApplicationAuthorityEnvelope | null>;
  concurrency?: number | (() => number);
  instructionMode?(input: {
    conversationId: string;
    jobId: number;
    mode: ApplicationAutomationMode;
  }): Promise<ApplicationAutomationMode | null>;
  onError?: (error: unknown) => void;
}

export const applicationIdentity = (id: number, attempt: number) => ({
  applicationRecordId: `application_${id}`,
  runId: `application_run_${id}`,
  resultId: `application_${id}_attempt_${attempt}`,
});

/** Store rows own admission and progress; the existing engine owns the form and send guards. */
export function createApplicationService(deps: ApplicationServiceDeps) {
  const { jobs, applications, browser } = deps;
  const listingDiscovery = (job: JobDetail) => {
    const first = [...job.sightings].sort((a, b) =>
      a.seenAt.localeCompare(b.seenAt),
    )[0];
    return {
      label: first?.sourceLabel ?? job.sourceLabel,
      // Site settings are editable; only the historical sighting is evidence.
      url: first?.url ?? job.url,
    };
  };
  const resumes = createResumeStore(jobs);
  const active = new Map<number, AbortController>();
  const waiting = new Map<number, number>();
  /**
   * Applications the person sent on the site themselves, kept Uncertain until
   * the site confirms it: attempt, and how long their page is watched for it.
   */
  const pressedByPerson = new Map<
    number,
    { attempt: number; pressedAt: string; until: number }
  >();
  const opening = new Map<number, Promise<boolean>>();
  // Read at each pump, so a Speed change applies to the next application.
  const capacity = () =>
    applicationPreparationConcurrency(
      String(
        typeof deps.concurrency === "function"
          ? deps.concurrency()
          : (deps.concurrency ?? 4),
      ),
    );
  const onError =
    deps.onError ?? ((error: unknown) => console.error("[Apply]", error));
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let pumping: Promise<void> | null = null;
  let pumpAgain = false;
  let watching = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function current(row: ApplicationRow): boolean {
    const next = applications.getApplication(row.id);
    return (
      !!next &&
      next.attempt === row.attempt &&
      !["stopped", "failed", "submitted", "uncertain"].includes(next.state)
    );
  }

  async function closePage(id: number, attempt: number): Promise<void> {
    waiting.delete(id);
    await browser.releaseApplicationPageBinding?.(
      "target_site",
      applicationIdentity(id, attempt).resultId,
    );
  }

  async function leaveForPerson(
    row: ApplicationRow,
    reason?: string,
  ): Promise<void> {
    if (!current(row)) return;
    applications.finishPreparation({
      id: row.id,
      attempt: row.attempt,
      state: "ready",
      ...(reason ? { error: reason } : {}),
    });
    if (reason || applications.getApplication(row.id)?.state === "submitting")
      applications.submissionRefused(
        row.id,
        row.attempt,
        reason ?? "The form is ready for your click.",
      );
    const state = applications.getApplication(row.id)?.state;
    // An open file item kept it in Needs you; the person's page stays watched.
    if (state === "needs_you") waiting.set(row.id, row.attempt);
    if (state !== "ready") return;
    await browser.handApplicationPageToPerson?.(
      "target_site",
      applicationIdentity(row.id, row.attempt).resultId,
    );
    waiting.set(row.id, row.attempt);
  }

  /**
   * The file fields the person said are attached on the site, from the
   * upload item of the attempt just before this one. The word lasts one
   * attempt and covers only the fields that item named.
   */
  /**
   * The picker choices earlier runs tried and the form refused, minus the
   * questions the person answered in Needs you since the last run. Their
   * answer says the choice is there; the old refusal (often the fence's,
   * before a fix) must not refuse it again, nor make their own pick on the
   * page read as the run's leftover search.
   */
  function pickerAttemptsAfterAnswers(
    row: ApplicationRow,
    execution: ApplyExecutionResult,
  ): ApplyExecutionResult["pickerAttempts"] {
    const answered = new Set(
      execution.questions
        .filter(
          (question) =>
            applications.needsYou.fieldAnswer(row.id, question.id)?.attempt ===
            row.attempt - 1,
        )
        .map((question) => normalizeFormQuestionPrompt(question.prompt)),
    );
    return (execution.pickerAttempts ?? []).map((attempt) =>
      answered.has(attempt.question)
        ? { ...attempt, tried: [], notOffered: [] }
        : attempt,
    );
  }

  function confirmedUploadFields(row: ApplicationRow): string[] {
    const said = applications.needsYou.fieldAnswer(
      row.id,
      UPLOAD_REPAIR_QUESTION_ID,
    );
    if (
      said?.answer !== UPLOAD_ATTACHED_ANSWER ||
      said.attempt !== row.attempt - 1
    )
      return [];
    return uploadRepairFields(said.prompt);
  }

  /**
   * The upload item is done when this run attached a file to every field it
   * names. A run that settled a different field's file, or resumed past the
   * file's step, leaves it alone.
   */
  function uploadRepaired(
    row: ApplicationRow,
    result: ApplyExecutionResult,
    review: ApplicationReviewCard | null,
  ): boolean {
    if (
      result.questions.some(
        (question) =>
          question.id === UPLOAD_REPAIR_QUESTION_ID &&
          question.status === "detected",
      )
    )
      return false;
    const prompt = applications.needsYou.openPrompt(
      row.id,
      UPLOAD_REPAIR_QUESTION_ID,
    );
    if (!prompt) return false;
    const attached = new Set(
      (review?.attachments ?? []).map((attachment) => attachment.field),
    );
    const fields = uploadRepairFields(prompt);
    return fields.length > 0 && fields.every((field) => attached.has(field));
  }

  async function modeFor(
    row: ApplicationRow,
    settings: JobFinderSettings,
  ): Promise<ApplicationAutomationMode | null> {
    // The person pressed Open to look: that refill never sends.
    if (applications.isReviewRefill(row.id)) return "confirm_before_submit";
    const instruction = applications.instructionFor(row.id);
    if (instruction) {
      const requested = await deps.instructionMode?.({
        ...instruction,
        jobId: row.jobId,
      });
      if (!requested) return null;
      return requested === "autonomous_submit" &&
        row.mode !== "autonomous_submit"
        ? "confirm_before_submit"
        : requested;
    }
    return row.mode === "autonomous_submit" &&
      settings.applicationAutomationMode === "autonomous_submit"
      ? "autonomous_submit"
      : "confirm_before_submit";
  }

  async function run(row: ApplicationRow, signal: AbortSignal): Promise<void> {
    const job = jobs.getJob(row.jobId);
    const approved = resumes.get(row.jobId);
    if (
      !job ||
      job.stage !== "resume" ||
      approved?.state !== "ready" ||
      !approved.approvedAt
    )
      throw new Error("Approve this job's resume before applying.");
    const knownBlock = applications.needsYou.blockedSite(
      new URL(job.applyUrl ?? job.url).origin,
    );
    if (knownBlock) {
      applications.needsYou.request({
        applicationId: row.id,
        attempt: row.attempt,
        fieldKey: "site_access",
        kind: "sign_in",
        key: knownBlock.key,
        scope: knownBlock.scope,
        prompt: knownBlock.prompt,
        input: "text",
        options: [],
        blockedUrl: knownBlock.blockedUrl,
      });
      applications.block(row.id, row.attempt, knownBlock.prompt);
      await closePage(row.id, row.attempt);
      return;
    }
    const {
      profile: savedProfile,
      settings,
      searchPreferences,
      sourceInstructionArtifacts = [],
    } = await deps.readInputs();
    const profile = savedProfile;
    const filePath = approved.pdfPath ?? profile.baseResume.storagePath;
    if (!filePath)
      throw new Error(
        "Your approved resume file is unavailable. Import or export it again.",
      );
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = ApplicationResumeArtifactSchema.parse({
      id: `resume_${row.jobId}_${sha256}`,
      jobId: String(row.jobId),
      source: approved.pdfPath === null ? "original_upload" : "tailored_export",
      sourceDocumentId:
        approved.pdfPath === null ? profile.baseResume.id : null,
      exportArtifactId: null,
      fileName: basename(filePath),
      filePath,
      sha256,
      approvedAt: approved.approvedAt,
    });
    signal.throwIfAborted();
    if (!current(row)) return;
    const previous = applications.getWork(row.id);
    const profileDigest = profileFactsDigest(savedProfile);
    if (
      !applications.setResumeArtifact(
        row.id,
        row.attempt,
        artifact,
        profileDigest,
      )
    )
      return;
    applications.recordOrigin(row.id, new URL(job.applyUrl ?? job.url).origin);
    applications.recordOrigin(row.id, new URL(job.url).origin);
    // The saved setting can narrow the mode captured at Apply, never widen it.
    const mode = await modeFor(row, settings);
    if (!mode)
      throw new Error("The instruction for this application was withdrawn.");
    const sends = mode === "autonomous_submit";
    let envelope = sends
      ? await deps.authorizeSending({ application: row, artifact, job, signal })
      : null;
    const identity = applicationIdentity(row.id, row.attempt);
    const target = job.applyUrl ?? job.url;
    const sighting =
      job.sightings.find((row) => (row.applyUrl ?? row.url) === target) ??
      job.sightings.find((row) => row.url === job.url);
    const siteId = Number(sighting?.sourceId);
    const site =
      Number.isSafeInteger(siteId) && siteId > 0
        ? createJobSitesStore(jobs).get(siteId)
        : null;
    const instructions = site
      ? uniqueStrings([
          site.customInstructions ?? "",
          ...buildInstructionGuidance(
            resolveActiveSourceInstructionArtifact(
              jobSiteTarget(site),
              sourceInstructionArtifacts,
            ),
          ),
        ])
      : [];
    let startingUrl: string | undefined;
    // A continue keeps the page, and with it the files already attached.
    let keptPage = false;
    if (
      row.attempt > 1 &&
      (!previous ||
        !["failed", "unsupported", "submitted"].includes(
          previous.execution.state,
        ))
    ) {
      const transferred = await browser
        .transferApplicationPageBinding?.(
          "target_site",
          applicationIdentity(row.id, previous?.attempt ?? row.attempt - 1)
            .resultId,
          identity.resultId,
        )
        .catch(() => false);
      if (transferred)
        startingUrl =
          (
            await browser.readApplicationPageBinding?.(
              "target_site",
              identity.resultId,
            )
          )?.url ?? undefined;
      if (transferred && previous?.accessRecheck)
        await browser.reloadApplicationPageBinding?.(
          "target_site",
          identity.resultId,
          target,
        );
      if (transferred && previous?.accessRecheck) startingUrl = target;
      keptPage = Boolean(transferred) && !previous?.accessRecheck;
    }
    const origin = new URL(target).origin;
    const allowedOrigins = new Set([
      origin,
      new URL(job.url).origin,
      ...(envelope?.allowedOrigins ?? []).map((value) => new URL(value).origin),
    ]);
    const behavior = AiBehaviorPreferenceSchema.parse(
      settings.aiBehavior ?? {},
    ).applying;
    const attachmentArtifacts = await resolveApplicationAttachmentsForExecution(
      {
        jobId: String(job.id),
        resolver: deps.candidateAssets,
        questionRecords: [],
        answerRecords: [],
      },
    );
    const letterAnswers = readSavedApplicationAnswers(jobs, [
      "self_intro",
      "career_transition",
      "availability",
      "notice_period",
      "travel",
    ]);
    const answerDependencies = applicationAnswerDependencies(
      applications.needsYou,
      row.id,
      origin,
      letterAnswers,
    );
    const facts: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm"> = {
      ...(instructions.length ? { instructions } : {}),
      job: toResumeJob(job),
      listingDiscovery: listingDiscovery(job),
      profile,
      settings,
      resumeArtifact: artifact,
      applicationAttachments: attachmentArtifacts,
      mode: "prepare_only",
      applyAutomationMode:
        sends && envelope
          ? "autonomous_submit"
          : mode === "prepare_only"
            ? "prepare_only"
            : "confirm_before_submit",
      submitAuthorized: sends && envelope !== null,
      applicationPageBindingKey: identity.resultId,
      // The review card keeps what each run filled: a closed page comes back
      // from it (no model call when the form still matches).
      restorableByRefill: true,
      idempotencyKey: identity.resultId,
      ...(startingUrl ? { startingUrl } : {}),
      accountCreationAuthorized: false,
      // The form's own field saves go out as the run fills, as they do when
      // a person fills the form by hand (Ashby keeps the form only in what
      // it saved). Fill in for me still presses no form button and sends
      // nothing shaped like a final submit: the click stays the person's.
      // Send for me's envelope can still withhold saves.
      intermediateMutationsAuthorized: envelope
        ? envelope.intermediateMutationsAuthorized === true
        : true,
      attachmentUploadsAuthorized: true,
      // No envelope: the browser pins each live form frame's own origin.
      // An envelope, when present, continues to narrow those destinations.
      intermediateMutationAllowedOrigins: envelope ? [...allowedOrigins] : [],
      recheckIntermediateMutationAuthority: async (
        observedOrigin,
        purpose = "answers",
      ) => {
        if (
          purpose === "answers" &&
          envelope &&
          envelope.intermediateMutationsAuthorized !== true
        )
          return false;
        if (
          !current(row) ||
          signal.aborted ||
          !allowedOrigins.has(observedOrigin)
        )
          return false;
        if (envelope) {
          const permission =
            await deps.authorityRepository.getApplicationAuthorityEnvelope(
              resolveApplicationAuthoritySuccessorId(
                deps.authorityRepository,
                envelope.id,
              ),
            );
          if (
            !permission ||
            !isActiveApplicationAuthorityEnvelope(
              permission,
              new Date().toISOString(),
            ) ||
            !permission.scope.jobIds.includes(String(row.jobId)) ||
            !permission.allowedResumeSha256.includes(sha256) ||
            !permission.allowedOrigins.includes(observedOrigin) ||
            (purpose === "answers" &&
              !permission.intermediateMutationsAuthorized)
          )
            return false;
        }
        const latest = await deps.readInputs();
        const latestMode = await modeFor(row, latest.settings);
        const resume = resumes.get(row.jobId);
        return (
          latestMode !== null &&
          jobs.getJob(row.jobId)?.stage === "resume" &&
          resume?.approvedAt === approved.approvedAt &&
          resume.pdfPath === approved.pdfPath &&
          JSON.stringify(
            AiBehaviorPreferenceSchema.parse(latest.settings.aiBehavior ?? {})
              .applying.preApprovedDeclarations,
          ) === JSON.stringify(behavior.preApprovedDeclarations) &&
          (latest.settings.salaryDisclosure ?? "pause_for_user") ===
            (settings.salaryDisclosure ?? "pause_for_user") &&
          profileFactsDigest(latest.profile) === profileDigest &&
          applicationAnswersUnchanged(
            applications.needsYou,
            row.id,
            origin,
            answerDependencies.snapshot(),
          )
        );
      },
      applyAllowedOrigins: [...allowedOrigins],
      preApprovedAttestationKinds: behavior.preApprovedDeclarations,
      salaryDisclosure: settings.salaryDisclosure ?? "pause_for_user",
      authorizeReviewedApplicationOrigin: async (nextOrigin) => {
        if (!current(row) || signal.aborted) return null;
        if (!envelope) {
          allowedOrigins.add(nextOrigin);
          applications.recordOrigin(row.id, nextOrigin);
          return true;
        }
        const next = await authorizeReviewedApplicationOrigin({
          repository: deps.authorityRepository,
          envelope,
          jobId: String(job.id),
          origin: nextOrigin,
          now: new Date().toISOString(),
        });
        if (next) {
          envelope = next;
          allowedOrigins.add(nextOrigin);
          applications.recordOrigin(row.id, nextOrigin);
        }
        return next;
      },
    };
    let agent: ApplyAgentResult | null = null;
    let review: ApplicationReviewCard | null = null;
    const usageRecorder = createModelUsageRecorder();
    const executeApplicationFlow: BrowserSessionRuntime["executeApplicationFlow"] =
      (...args) =>
        usageRecorder.run(() => browser.executeApplicationFlow(...args));
    const result = await executeApplicationFlow(
      "target_site",
      {
        ...facts,
        prepareApplicationForm: createApplyFormPreparer({
          initialUnansweredPickerQuestions:
            previous?.execution.questions
              .filter(
                (question) =>
                  question.status === "detected" && !question.submittedAnswer,
              )
              .map((question) => ({
                prompt: question.prompt,
                options: question.answerOptions,
              })) ?? [],
          ...(previous?.execution.questionContexts
            ? { initialQuestionContexts: previous.execution.questionContexts }
            : {}),
          ...(previous?.execution.pickerAttempts?.length
            ? {
                initialPickerAttempts: pickerAttemptsAfterAnswers(
                  row,
                  previous.execution,
                ),
              }
            : {}),
          executionInput: facts,
          applicationRecordId: identity.applicationRecordId,
          searchPreferences,
          aiClient: deps.aiClient,
          envelope,
          siteLabel: job.company,
          letters: buildApplyLetterDependencies({
            aiClient: deps.aiClient,
            documentManager: deps.documentManager,
            job: facts.job,
            profile,
            settings,
            searchPreferences,
            reusableAnswers: letterAnswers,
          }),
          uploadsConfirmedByPerson: confirmedUploadFields(row),
          earlierAttachments: keptPage
            ? (previous?.reviewCard?.attachments ?? [])
            : [],
          // What the attempt before left on the form: a page that was closed
          // (or reopened) comes back from it without the model, and so do
          // the questions it left with the person.
          ...(previous?.reviewCard &&
          (previous.reviewCard.answers.length ||
            previous.reviewCard.attachments.length ||
            previous.execution.questions.some(
              (question) =>
                question.status === "detected" && !question.submittedAnswer,
            ))
            ? {
                replay: {
                  answers: previous.reviewCard.answers,
                  attachments: keptPage ? [] : previous.reviewCard.attachments,
                  path: previous.execution.formPath ?? [],
                  formUrl: previous.reviewCard.pageUrl ?? undefined,
                },
              }
            : {}),
          readReusableAnswers: (questions) => {
            const byKey = new Map(
              questions.map((question) => [
                describeFormQuestion(question, job).key,
                question,
              ]),
            );
            return Promise.resolve(
              answerDependencies
                .read(
                  questions.map((question) => ({
                    ...describeFormQuestion(question, job),
                    prompt: question.prompt,
                    kind: [
                      "work_authorization",
                      "visa_sponsorship",
                      "relocation",
                      "travel",
                      "notice_period",
                      "availability",
                      "salary_expectation",
                      "self_intro",
                      "career_transition",
                    ].includes(question.kind)
                      ? (question.kind as CandidateAnswerKind)
                      : "other",
                  })),
                )
                .map((answer) =>
                  toKnownFormAnswer(
                    answer,
                    byKey.get(answer.key)!,
                    job.location,
                    row.id,
                  ),
                ),
            );
          },
          onPrepared: (outcome) => {
            agent = outcome.result;
            review = outcome.reviewCard;
          },
        }),
      },
      { signal },
    );
    signal.throwIfAborted();
    if (
      !current(row) ||
      !applications.saveWork(row.id, {
        attempt: row.attempt,
        resumeArtifact: artifact,
        execution: {
          ...result,
          // A run that never reached the form still keeps what earlier runs
          // learned about its pickers.
          pickerAttempts: result.pickerAttempts?.length
            ? result.pickerAttempts
            : (previous?.execution.pickerAttempts ?? []),
          applyUsageTotals: accumulateApplyUsage(
            previous?.execution,
            usageRecorder.snapshot(),
          ),
          answerDependencies: answerDependencies.snapshot(),
        },
        reviewCard: review,
        authorityEnvelopeId: envelope?.id ?? null,
        profileDigest,
      })
    )
      return;
    // The site took the file this time: its upload item is done, even when
    // the form now stops on another question.
    if (
      (result.state === "ready" ||
        result.questions.some((question) => question.status === "detected")) &&
      uploadRepaired(row, result, review as ApplicationReviewCard | null)
    )
      applications.needsYou.dropQuestion(
        row.id,
        row.attempt,
        UPLOAD_REPAIR_QUESTION_ID,
      );
    if (await deps.isHoldingCurrent()) {
      applications.continuePreparation(row.id, row.attempt);
      return;
    }
    const blockedAgent = agent as ApplyAgentResult | null;
    const refusedBrowser = blockedAgent?.pauses.find(
      (pause) => pause.blocker?.code === "browser_blocked",
    );
    if (refusedBrowser) {
      const origin = new URL(blockedAgent?.finalUrl ?? target).origin;
      applications.needsYou.request({
        applicationId: row.id,
        attempt: row.attempt,
        fieldKey: "site_access",
        kind: "sign_in",
        key: `access:${origin}`,
        scope: { siteOrigin: origin },
        prompt: refusedBrowser.summary,
        input: "text",
        options: [],
        blockedUrl: job.url,
      });
      applications.block(row.id, row.attempt, refusedBrowser.summary);
      await closePage(row.id, row.attempt);
      return;
    }
    await checkApplicationAccess(row);
    if (
      applications.getApplication(row.id)?.state === "needs_you" &&
      applications.needsYou.accessForApplication(row.id).length
    ) {
      waiting.set(row.id, row.attempt);
      return;
    }
    if (result.state === "failed" || result.state === "unsupported") {
      applications.finishPreparation({
        id: row.id,
        attempt: row.attempt,
        state: "failed",
        error: result.detail,
      });
      await closePage(row.id, row.attempt);
      return;
    }
    if (result.skipReason) {
      // Stop or a new attempt may have taken the row meanwhile; the skip is
      // then theirs to decide. A row still this run's never stays running.
      if (
        !applications.skip(row.id, row.attempt, result.skipReason) &&
        current(row)
      )
        applications.finishPreparation({
          id: row.id,
          attempt: row.attempt,
          state: "failed",
          error: result.skipReason,
        });
      await closePage(row.id, row.attempt);
      return;
    }
    let fromMemory = false;
    for (const question of result.questions.filter(
      (q) => q.status === "detected" && !q.submittedAnswer,
    )) {
      const known = describeFormQuestion(question, job);
      const repeated =
        previous?.execution.questions.some(
          (earlier) =>
            earlier.status === "detected" &&
            describeFormQuestion(earlier, job).key === known.key,
        ) ?? false;
      const currentAnswer = applications.needsYou
        .answersForQuestions(
          row.id,
          [{ ...known, prompt: question.prompt }],
          origin,
        )
        .find((answer) => answer.key === known.key)?.answer;
      const alreadyRead =
        currentAnswer != null &&
        answerDependencies
          .snapshot()
          .form.some(
            (answer) =>
              answer.key === known.key && answer.answer === currentAnswer,
          );
      const requested = applications.needsYou.request(
        {
          applicationId: row.id,
          attempt: row.attempt,
          fieldKey: question.id,
          kind: "question",
          key: known.key,
          scope: {},
          prompt: question.prompt,
          input: known.input,
          options: known.options,
          reusePrompt: known.reusePrompt,
        },
        // A refused upload, or a button handed to the person, is never
        // settled by an earlier answer.
        {
          reuseAnswers:
            !repeated &&
            !alreadyRead &&
            question.id !== UPLOAD_REPAIR_QUESTION_ID &&
            question.id !== STEP_HANDOVER_QUESTION_ID,
        },
      );
      fromMemory ||= requested.status === "answered";
    }
    // The raw engine's typed blockers distinguish access steps from technical failures.
    const prepared = agent as ApplyAgentResult | null;
    const taskOrigin = new URL(
      prepared?.finalUrl ?? result.replay.lastUrl ?? target,
    ).origin;
    for (const pause of prepared?.pauses ?? []) {
      const kind = accessKind(pause.blocker);
      if (kind)
        applications.needsYou.request({
          applicationId: row.id,
          attempt: row.attempt,
          fieldKey: "site_access",
          kind,
          key: `access:${taskOrigin}`,
          scope: { siteOrigin: taskOrigin },
          prompt: pause.summary,
          input: "text",
          options: [],
        });
    }
    if (applications.getApplication(row.id)?.state === "needs_you") {
      waiting.set(row.id, row.attempt);
      return;
    }
    if (fromMemory) {
      applications.continuePreparation(row.id, row.attempt);
      return;
    }
    if (result.state !== "ready") {
      applications.finishPreparation({
        id: row.id,
        attempt: row.attempt,
        state: "failed",
        error: result.detail,
      });
      await closePage(row.id, row.attempt);
      return;
    }
    if (sends && envelope && prepared?.readyToSend) {
      await send(row, artifact, envelope, profileDigest, signal);
    } else {
      await leaveForPerson(row);
    }
  }

  async function send(
    row: ApplicationRow,
    artifact: ApplicationResumeArtifact,
    original: ApplicationAuthorityEnvelope,
    profileDigest: string,
    signal: AbortSignal,
    personClicked = false,
  ): Promise<void> {
    const identity = applicationIdentity(row.id, row.attempt);
    const operation = () =>
      withApplicationAuthorityGate(
        deps.authorityRepository,
        signal,
        async () => {
          const { settings, profile } = await deps.readInputs();
          if (
            !current(row) ||
            (!personClicked &&
              (await modeFor(row, settings)) !== "autonomous_submit")
          ) {
            await leaveForPerson(
              row,
              "The Apply setting changed. The filled form is ready for your review.",
            );
            return;
          }
          const job = jobs.getJob(row.jobId);
          if (!job || job.stage !== "resume")
            return leaveForPerson(
              row,
              "This job no longer has an approved resume ready to apply.",
            );
          const origin = new URL(job.applyUrl ?? job.url).origin;
          const proof = applications.getWork(row.id)?.execution
            .answerDependencies;
          const factsUnchanged = (latestProfile: CandidateProfile) =>
            profileFactsDigest(latestProfile) === profileDigest &&
            applicationAnswersUnchanged(
              applications.needsYou,
              row.id,
              origin,
              proof,
            );
          if (!factsUnchanged(profile)) {
            await leaveForPerson(row);
            await closePage(row.id, row.attempt);
            if (
              applications.reprepareForReview(
                row.id,
                row.attempt,
                "The Profile or saved answers for this form need checking again. Refilling it for your review; it will not send automatically.",
              )
            )
              void wake();
            return;
          }
          // A Ready row may predate a grounding fix. Re-ground generated
          // answers from current Profile/resume/scoped answers before arming
          // either automatic sending or the person's sidebar Send instruction.
          const card = applications.getWork(row.id)?.reviewCard;
          const written = [...(card?.answers ?? [])];
          if (
            card?.letter &&
            !card.letter.groundedIn.includes(
              "your letter for this application",
            ) &&
            !written.some((answer) => answer.answer === card.letter!.text)
          )
            written.push({
              question: card.letter.fields?.[0] ?? "Cover letter",
              answer: card.letter.text,
              source: "Written for this application",
              written: true,
              groundedIn: card.letter.groundedIn,
            });
          if (written.length) {
            const form = await browser
              .readApplicationPageBinding?.("target_site", identity.resultId)
              .catch(() => null);
            const formControls = form
              ? buildApplyFormObservation(form, new Date().toISOString())
                  .controls
              : [];
            const suggestions = written.map((answer) =>
              pageAnswerSuggestion(answer.question, formControls),
            );
            const questions = written.map((answer) => ({
              prompt: answer.question,
              kind: inferQuestionKind({
                label: answer.question,
                groupLabel: "",
                placeholder: "",
                kind: "text",
              }),
              answerControlType: /^(?:yes|no)$/iu.test(answer.answer)
                ? ("boolean" as const)
                : ("text" as const),
              answerOptions: [] as string[],
            }));
            const queries = questions.map((question) => ({
              ...describeFormQuestion(question, job),
              prompt: question.prompt,
            }));
            const saved = applications.needsYou
              .answersForQuestions(row.id, queries, origin)
              .map((answer) =>
                toKnownFormAnswer(
                  answer,
                  questions[
                    queries.findIndex((query) => query.key === answer.key)
                  ]!,
                  job.location,
                  row.id,
                ),
              );
            const client = toApplyLlmClient(deps.aiClient);
            const checks =
              client && form
                ? await checkClassifiedApplicationAnswers({
                    client,
                    application: {
                      jobId: String(job.id),
                      applicationId: identity.resultId,
                      resultId: identity.resultId,
                      applicationRecordId: identity.applicationRecordId,
                      startingUrl: form.url ?? job.applyUrl ?? job.url,
                    },
                    questionReadCacheScope: deps.aiClient,
                    approvedAttestations: AiBehaviorPreferenceSchema.parse(
                      settings.aiBehavior ?? {},
                    ).applying.preApprovedDeclarations,
                    formControls,
                    sources: {
                      listingDiscovery: listingDiscovery(job),
                      profile,
                      resumeText: profile.baseResume.textContent,
                      reusableAnswers: saved,
                      documents: [],
                      posting: {
                        title: job.title,
                        company: job.company,
                        location: job.location,
                        description: job.description ?? "",
                      },
                    },
                    answers: written,
                    formContext: {
                      pageText: form?.bodyText ?? "",
                      fields: [],
                    },
                    payDisclosed:
                      settings.salaryDisclosure === "answer_from_profile",
                    signal,
                  }).catch(() => null)
                : null;
            const rejected = questions.flatMap((question, index) =>
              checks?.[index]?.supported ? [] : [{ question, index }],
            );
            if (rejected.length) {
              applications.discardReviewAnswers(
                row.id,
                row.attempt,
                rejected.map(({ question }) => question.prompt),
                card?.letter?.text,
              );
              // The new question supersedes the ungrounded generated value.
              // Do not immediately consume the same unusable saved answer.
              for (const { question, index } of rejected) {
                const control = suggestions[index]?.control;
                const known = describeFormQuestion(
                  control
                    ? {
                        ...question,
                        answerControlType: control.answerControlType,
                        answerOptions: control.options,
                        inputConstraints: control.inputConstraints,
                      }
                    : question,
                  job,
                );
                const requested = applications.needsYou.request(
                  {
                    applicationId: row.id,
                    attempt: row.attempt,
                    fieldKey: known.key,
                    kind: "question",
                    key: known.key,
                    scope: {},
                    prompt: question.prompt,
                    input: known.input,
                    options: known.options,
                    reusePrompt: known.reusePrompt,
                  },
                  { reuseAnswers: false },
                );
                const suggestion = suggestions[index]?.answer;
                if (
                  requested.status === "needs_you" &&
                  suggestion &&
                  !applications.needsYou.details(requested.task.id)?.draft &&
                  (known.input !== "boolean" ||
                    ["Yes", "No"].includes(suggestion)) &&
                  (known.input !== "choice" ||
                    known.options.includes(suggestion)) &&
                  (known.input !== "number" ||
                    Number.isFinite(Number(suggestion)))
                )
                  applications.needsYou.saveDraft({
                    id: requested.task.id,
                    answer: suggestion,
                    remember: true,
                    revision: 0,
                  });
              }
              // Refill from the person's answer after this task resolves;
              // a retained, already-answered control must not keep the old
              // unsupported value merely because the site says it is filled.
              await closePage(row.id, row.attempt);
              waiting.set(row.id, row.attempt);
              return;
            }
          }
          const activeEnvelopes =
            await deps.authorityRepository.listApplicationAuthorityEnvelopes({
              status: "active",
            });
          const envelope =
            activeEnvelopes.length === 1 ? activeEnvelopes[0] : null;
          if (
            !envelope ||
            envelope.id !==
              resolveApplicationAuthoritySuccessorId(
                deps.authorityRepository,
                original.id,
              ) ||
            envelope.mode !== original.mode ||
            !envelope.scope.jobIds.includes(String(row.jobId)) ||
            !envelope.allowedResumeSha256.includes(artifact.sha256!)
          )
            return leaveForPerson(
              row,
              "The permission to send this application changed. Review the filled form before trying again.",
            );
          if (!applications.beginSubmission(row.id, row.attempt))
            // A file still open in Needs you holds the send back.
            return applications.waitsOnFile(row.id)
              ? leaveForPerson(row)
              : undefined;
          // The preparer understands which page actions are final. Pass their
          // exact refs, rather than asking browser hands to guess from labels.
          const finalPage = await browser
            .readApplicationPageBinding?.("target_site", identity.resultId)
            .catch(() => null);
          const finalActionTargets = finalPage
            ? buildApplyFormObservation(finalPage, new Date().toISOString())
                .actions.filter(
                  (action) =>
                    action.kind === "final" &&
                    action.visible &&
                    !action.disabled,
                )
                .map((action) => ({ ref: action.ref, label: action.label }))
            : undefined;
          if (finalActionTargets && finalActionTargets.length !== 1)
            return leaveForPerson(
              row,
              "The form does not expose exactly one final action. Review it before sending.",
            );
          const runtime = {
            observeApplicationForm: (
              source: Parameters<
                NonNullable<BrowserSessionRuntime["observeApplicationForm"]>
              >[0],
              options?: Parameters<
                NonNullable<BrowserSessionRuntime["observeApplicationForm"]>
              >[1],
            ) =>
              browser.observeApplicationForm!(source, {
                ...options,
                ...(finalActionTargets ? { finalActionTargets } : {}),
              }),
            executeExactlyOneFinalAction: (
              source: Parameters<
                NonNullable<
                  BrowserSessionRuntime["executeExactlyOneFinalAction"]
                >
              >[0],
              input: Parameters<
                NonNullable<
                  BrowserSessionRuntime["executeExactlyOneFinalAction"]
                >
              >[1],
            ) =>
              browser.executeExactlyOneFinalAction!(source, {
                ...input,
                veto: async (facts) => {
                  const { settings: latest, profile: latestProfile } =
                    await deps.readInputs();
                  const app = applications.getApplication(row.id);
                  const approved = resumes.get(row.jobId);
                  return (
                    !!app &&
                    app.attempt === row.attempt &&
                    app.state === "submitting" &&
                    !applications.waitsOnFile(row.id) &&
                    jobs.getJob(row.jobId)?.stage === "resume" &&
                    approved?.approvedAt === artifact.approvedAt &&
                    (approved.pdfPath ??
                      latestProfile.baseResume.storagePath) ===
                      artifact.filePath &&
                    (personClicked ||
                      (await modeFor(row, latest)) === "autonomous_submit") &&
                    factsUnchanged(latestProfile) &&
                    (await input.veto(facts))
                  );
                },
              }),
          };
          const outcome = await submitPreparedApplication({
            repository: deps.authorityRepository,
            browserRuntime: runtime,
            source: "target_site",
            envelope,
            lineage: {
              ...identity,
              jobId: String(row.jobId),
              campaignId: null,
            },
            loadResumeBytes: async () =>
              new Uint8Array(await readFile(artifact.filePath)),
            now: new Date().toISOString(),
            signal,
            runSubmission: runApplicationSubmissionRuntime,
          });
          if ("outcome" in outcome && outcome.outcome) {
            applications.recordSubmission(row.id, row.attempt, outcome.outcome);
            if (outcome.outcome.outcome !== "not_submitted")
              await closePage(row.id, row.attempt);
            else
              await leaveForPerson(
                row,
                "The site did not accept a submission. Review the form before trying again.",
              );
          } else
            await leaveForPerson(
              row,
              "detail" in outcome
                ? outcome.detail
                : "The application was not sent.",
            );
        },
      );
    if (browser.withApplicationPageExecution)
      await browser.withApplicationPageExecution(
        "target_site",
        identity.resultId,
        operation,
        signal,
      );
    else await operation();
  }

  /** A receipt for the person's own send on the site, by its own key. */
  function personReceipt(
    row: ApplicationRow,
    attempt: number,
    outcome:
      | { kind: "pressed"; at: string; url: URL }
      | { kind: "confirmed"; attemptedAt: string; url: URL; summary: string },
  ): SubmissionOutcomeRecord {
    const identity = applicationIdentity(row.id, attempt);
    const key = `person_${identity.resultId}`;
    const at = new Date().toISOString();
    const confirmed = outcome.kind === "confirmed";
    return SubmissionOutcomeRecordSchema.parse({
      id: confirmed ? key : `${key}_pressed`,
      preflightId: key,
      idempotencyKey: key,
      authorityEnvelopeId: key,
      authorityRevision: 1,
      ...identity,
      jobId: String(row.jobId),
      outcome: confirmed ? "submitted" : "outcome_uncertain",
      attemptedAt: confirmed ? outcome.attemptedAt : outcome.at,
      verifiedAt: confirmed ? at : null,
      evidence: [
        {
          id: key,
          kind: "employer_site_state",
          observedAt: at,
          destination: {
            origin: outcome.url.origin,
            safePath: outcome.url.pathname,
          },
          artifactRefId: null,
          summary: confirmed
            ? outcome.summary
            : "You pressed send on the site; it has not confirmed the application yet.",
        },
      ],
      retry: {
        eligible: false,
        blockReason: confirmed ? "submission_confirmed" : "outcome_uncertain",
      },
    });
  }

  /**
   * The person pressed the form's send on the site in their own window, and
   * the site has not confirmed it. From that press the application is
   * Uncertain, so nothing sends it again; their page stays watched, and a
   * confirmation moves it to Applied.
   */
  async function recordPersonPress(
    row: ApplicationRow,
    attempt: number,
  ): Promise<boolean> {
    const identity = applicationIdentity(row.id, attempt);
    const page = await browser
      .readApplicationPageWithPerson?.("target_site", identity.resultId)
      .catch(() => null);
    const pressedAt = page?.sendPressedAt;
    if (
      !page?.url ||
      !pressedAt ||
      Date.parse(pressedAt) < Date.parse(row.updatedAt) ||
      !current(row)
    )
      return false;
    const receipt = personReceipt(row, attempt, {
      kind: "pressed",
      at: pressedAt,
      url: new URL(page.url),
    });
    if (!applications.recordSubmission(row.id, attempt, receipt)) return false;
    waiting.delete(row.id);
    pressedByPerson.set(row.id, {
      attempt,
      pressedAt,
      // Their page is watched this long for the site's confirmation.
      until: Date.now() + 10 * 60_000,
    });
    return true;
  }

  /** A confirmation on the person's page after their own send. */
  async function confirmPersonPress(id: number): Promise<void> {
    const watched = pressedByPerson.get(id);
    const row = applications.getApplication(id);
    if (!watched) return;
    if (
      !row ||
      row.attempt !== watched.attempt ||
      row.state !== "uncertain" ||
      Date.now() > watched.until
    ) {
      pressedByPerson.delete(id);
      return;
    }
    const identity = applicationIdentity(id, watched.attempt);
    const page = await browser
      .readApplicationPageWithPerson?.("target_site", identity.resultId)
      .catch(() => null);
    if (
      !page ||
      page.loading ||
      !page.url ||
      !hasSubmissionConfirmationText(page.bodyText)
    )
      return;
    const preparedUrl = applications.getWork(id)?.reviewCard?.pageUrl;
    const destination = new URL(page.url);
    if (!preparedUrl || destination.origin !== new URL(preparedUrl).origin)
      return;
    const receipt = personReceipt(row, watched.attempt, {
      kind: "confirmed",
      attemptedAt: watched.pressedAt,
      url: destination,
      summary: submissionConfirmationSummary(page.bodyText),
    });
    if (applications.resolveUncertainSend(id, receipt)) {
      pressedByPerson.delete(id);
      await closePage(id, watched.attempt);
    }
  }

  async function recordPersonSubmission(
    row: ApplicationRow,
    attempt: number,
  ): Promise<boolean> {
    const id = row.id;
    const identity = applicationIdentity(id, attempt);
    const page = await browser
      .readApplicationPageWithPerson?.("target_site", identity.resultId)
      .catch(() => null);
    if (
      !page ||
      page.loading ||
      !page.url ||
      !hasSubmissionConfirmationText(page.bodyText)
    )
      return false;
    const destination = new URL(page.url);
    const preparedUrl = applications.getWork(id)?.reviewCard?.pageUrl;
    if (!preparedUrl || destination.origin !== new URL(preparedUrl).origin)
      return false;
    const receipt = personReceipt(row, attempt, {
      kind: "confirmed",
      attemptedAt: new Date().toISOString(),
      url: destination,
      summary: submissionConfirmationSummary(page.bodyText),
    });
    if (!applications.recordSubmission(id, attempt, receipt)) return false;
    await closePage(id, attempt);
    return true;
  }

  function accessKind(
    blocker: ApplyBlocker | null | undefined,
  ): Exclude<NeedsYouKind, "question"> | null {
    return blocker?.code === "security_challenge" && blocker.requiresPerson
      ? "captcha"
      : blocker?.code === "multi_factor_required"
        ? "mfa"
        : blocker?.code === "site_login_required" ||
            blocker?.code === "account_creation_required"
          ? "sign_in"
          : null;
  }

  async function checkApplicationAccess(row: ApplicationRow): Promise<void> {
    if (row.state === "blocked") return;
    const access = applications.needsYou.accessForApplication(row.id);
    if (!access.length) return;
    const key = applicationIdentity(row.id, row.attempt).resultId;
    const personPage = await browser
      .readApplicationPageWithPerson?.("target_site", key)
      .catch(() => null);
    // A login page may stay a login page even with a valid shared cookie.
    // Let the engine retry its original application entry once, keeping this
    // task linked until that exact application reaches an accessible form.
    if (!personPage && applications.getWork(row.id)?.accessRecheck) {
      applications.recheckAccess(row.id, row.attempt);
      return;
    }
    const raw =
      personPage ??
      (await browser
        .readApplicationPageBinding?.("target_site", key)
        .catch(() => null));
    if (!raw || raw.loading || !current(row)) return;
    const page = buildApplyFormObservation(raw, new Date().toISOString());
    const kind = accessKind(page.blocker);
    if (kind) {
      if (
        row.state === "needs_you" &&
        (kind === access[0]!.kind ||
          kind === "sign_in" ||
          (kind === "captcha" && access[0]!.kind === "mfa"))
      )
        return;
      applications.needsYou.request({
        applicationId: row.id,
        attempt: row.attempt,
        fieldKey: "site_access",
        kind,
        key: access[0]!.key,
        scope: access[0]!.scope,
        prompt: page.blocker!.summary,
        input: "text",
        options: [],
      });
      return;
    }
    const job = jobs.getJob(row.jobId);
    const destination = page.origin;
    if (!job || !destination || !canContinueApplicationAfterAccess(page))
      return;
    for (const task of access) {
      if (
        destination !== task.scope.siteOrigin &&
        destination !== new URL(job.applyUrl ?? job.url).origin
      )
        continue;
      applications.needsYou.completeAccess(task.id, row.id);
    }
  }

  /** The person fixed the upload on the page: drop its item, finish the rest. */
  async function checkUploadRepair(row: ApplicationRow): Promise<boolean> {
    if (
      row.state !== "needs_you" ||
      !applications.needsYou.waitsOn(row.id, UPLOAD_REPAIR_QUESTION_ID)
    )
      return false;
    const key = applicationIdentity(row.id, row.attempt).resultId;
    const raw =
      (await browser
        .readApplicationPageWithPerson?.("target_site", key)
        .catch(() => null)) ??
      (await browser
        .readApplicationPageBinding?.("target_site", key)
        .catch(() => null));
    if (!raw || raw.loading || !current(row)) return false;
    const page = buildApplyFormObservation(raw, new Date().toISOString());
    // The item names the fields whose upload failed; only a confirmed file
    // in each of those same fields clears it. Another field's upload (a
    // cover letter) succeeding says nothing about the resume.
    const item = applications.needsYou
      .forApplication(row.id)
      .find((task) => isUploadRepairPrompt(task.prompt));
    const fields = (item?.prompt ?? "")
      .replace(/ — upload (?:failed|not confirmed)$/u, "")
      .split(", ")
      .filter(Boolean);
    const problems = new Set(
      fileUploadProblems(page).map((problem) => problem.control.ref),
    );
    const accepted =
      fields.length > 0 &&
      fields.every((label) =>
        page.controls.some(
          (control) =>
            control.kind === "file" &&
            !control.disabled &&
            questionPrompt(control) === label &&
            (control.answered || control.upload?.network === "accepted") &&
            !problems.has(control.ref),
        ),
      ) &&
      applications.needsYou.dropQuestion(
        row.id,
        row.attempt,
        UPLOAD_REPAIR_QUESTION_ID,
      );
    if (accepted) wake();
    return accepted;
  }

  async function watch(): Promise<void> {
    if (stopped || watching) return;
    watching = true;
    try {
      for (const id of [...pressedByPerson.keys()])
        await confirmPersonPress(id);
      for (const [id, attempt] of waiting) {
        const row = applications.getApplication(id);
        if (
          !row ||
          ["stopped", "failed", "submitted", "uncertain"].includes(row.state)
        ) {
          await closePage(id, attempt);
          continue;
        }
        if (
          row.attempt !== attempt ||
          !["ready", "needs_you"].includes(row.state)
        ) {
          waiting.delete(id);
          continue;
        }
        if (await recordPersonSubmission(row, attempt)) continue;
        if (await recordPersonPress(row, attempt)) continue;
        if (await checkUploadRepair(row)) continue;
        await checkApplicationAccess(row);
      }
    } finally {
      watching = false;
    }
  }

  function wake(): void {
    if (stopped) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = (async () => {
      while (!stopped && active.size < capacity() && !(await deps.isPaused())) {
        const row = applications.claimNext();
        if (!row) break;
        const controller = new AbortController();
        active.set(row.id, controller);
        void run(row, controller.signal)
          .catch(async (error) => {
            if (stopped) return;
            if (await deps.isHoldingCurrent()) {
              applications.continuePreparation(row.id, row.attempt);
              return;
            }
            if (!controller.signal.aborted) onError(error);
            if (applications.getApplication(row.id)?.state === "submitting")
              applications.submissionUnknown(row.id, row.attempt);
            else
              applications.finishPreparation({
                id: row.id,
                attempt: row.attempt,
                state: "failed",
                error:
                  error instanceof Error
                    ? error.message
                    : "The application could not finish.",
              });
            await closePage(row.id, row.attempt).catch(onError);
          })
          .finally(() => {
            active.delete(row.id);
            wake();
          });
      }
    })()
      .catch(onError)
      .finally(() => {
        pumping = null;
        if (pumpAgain) {
          pumpAgain = false;
          wake();
        }
      });
  }

  return {
    async start() {
      if (!stopped) return;
      await deps.authorityRepository.recoverArmedSubmissionAttempts({
        now: new Date().toISOString(),
      });
      for (const row of applications.listWorkInState("submitting")) {
        const outcomes =
          await deps.authorityRepository.listSubmissionOutcomeRecords({
            jobId: String(row.jobId),
          });
        const identity = applicationIdentity(row.id, row.attempt);
        const saved = outcomes
          .map((outcome) => SubmissionOutcomeRecordSchema.parse(outcome))
          .filter(
            (outcome) =>
              outcome.runId === identity.runId &&
              outcome.resultId === identity.resultId,
          )
          .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0];
        if (saved)
          applications.recordSubmission(
            row.id,
            row.attempt,
            SubmissionOutcomeRecordSchema.parse(saved),
          );
        else applications.submissionUnknown(row.id, row.attempt);
      }
      stopped = false;
      applications.recoverPreparation();
      applications.needsYou.reconcileSavedQuestions();
      for (const state of ["ready", "needs_you"] as const)
        for (const row of applications.listWorkInState(state))
          waiting.set(row.id, row.attempt);
      unsubscribe = jobs.onChange((change) => {
        if (change.cause !== "application" && !change.stages.includes("resume"))
          return;
        for (const [id, controller] of active) {
          const row = applications.getApplication(id);
          if (!row || row.state === "stopped") controller.abort();
        }
        wake();
      });
      timer = setInterval(() => {
        void watch().catch(onError);
        wake();
      }, 2_000);
      timer.unref();
      wake();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearInterval(timer);
      timer = null;
      for (const controller of active.values()) controller.abort();
    },
    wake,
    async sendPrepared(id: number): Promise<boolean> {
      const row = applications.getApplication(id);
      const work = applications.getWork(id);
      const job = row && jobs.getJob(row.jobId);
      if (
        !row ||
        row.state !== "ready" ||
        !work ||
        !job ||
        job.stage !== "resume"
      )
        return false;
      const controller = new AbortController();
      // Called only by a person's send action or a checked sidebar send instruction.
      const envelope = await deps.authorizeSending({
        application: row,
        artifact: work.resumeArtifact,
        job,
        signal: controller.signal,
        personClicked: true,
      });
      if (!envelope) return false;
      await send(
        row,
        work.resumeArtifact,
        envelope,
        work.profileDigest,
        controller.signal,
        true,
      );
      return applications.getApplication(id)?.state === "submitted";
    },
    async checkAccess(taskId: number): Promise<boolean> {
      const details = applications.needsYou.details(taskId);
      if (!details || details.task.kind === "question") return false;
      for (const row of details.applications) {
        const app = applications.getApplication(row.id);
        if (app?.state === "needs_you") await checkApplicationAccess(app);
      }
      return applications.needsYou.details(taskId) === null;
    },
    async stopApplication(id: number): Promise<boolean> {
      const row = applications.getApplication(id);
      if (!row || !applications.stop(id)) return false;
      active.get(id)?.abort();
      await closePage(id, row.attempt);
      return true;
    },
    continueBindings(owners: readonly string[]): void {
      for (const owner of owners) {
        const match = /^application_(\d+)_attempt_(\d+)$/u.exec(owner);
        if (!match) continue;
        const row = applications.getApplication(Number(match[1]));
        if (row?.attempt === Number(match[2]) && row.state === "running")
          applications.continuePreparation(row.id, row.attempt);
      }
      wake();
    },
    open(id: number): Promise<boolean> {
      const pending = opening.get(id);
      if (pending) return pending;
      const operation = open(id).finally(() => opening.delete(id));
      opening.set(id, operation);
      return operation;
    },
  };

  async function open(id: number): Promise<boolean> {
    const row = applications.getApplication(id);
    const work = applications.getWork(id);
    if (!row || !work || !["ready", "needs_you"].includes(row.state))
      return false;
    const key = applicationIdentity(id, work.attempt).resultId;
    let focused = await browser.focusApplicationPageBinding?.(
      "target_site",
      key,
    );
    if (
      !focused &&
      row.state === "needs_you" &&
      applications.needsYou.accessForApplication(id).length
    ) {
      const job = jobs.getJob(row.jobId);
      if (!job || !browser.reloadApplicationPageBinding) return false;
      // Re-enter with GET, not a saved credential/MFA POST or a stale wizard URL.
      await browser.reloadApplicationPageBinding(
        "target_site",
        key,
        job.applyUrl ?? job.url,
      );
      focused = await browser.focusApplicationPageBinding?.("target_site", key);
    }
    if (!current(row)) {
      await closePage(id, work.attempt);
      return false;
    }
    if (focused) {
      await browser.handApplicationPageToPerson?.("target_site", key);
      waiting.set(id, work.attempt);
      return true;
    }
    // The page is gone (a restart closes them all): refill the form, and a
    // form still waiting on the person stops at the same items again.
    await closePage(id, work.attempt).catch(onError);
    const queued = applications.reprepareForReview(id, row.attempt);
    if (queued) wake();
    return queued;
  }
}

export type ApplicationService = ReturnType<typeof createApplicationService>;
