import type { JobFinderAiClient } from "@nestor/ai-providers";
import {
  createModelUsageRecorder,
  getAiProviderAccessFailure,
  getRejectedModelRequest,
  isAiProviderAccessMessage,
} from "@nestor/ai-providers";
import { APP_AI_ACCESS, type AiAccessWatch } from "../internal/ai-access-watch";
import {
  buildApplyFormObservation,
  fileUploadProblems,
  questionPrompt,
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
  applicationPageUrl,
  browserAgentPermissionsOf,
  intendedAccountEmail,
  isActiveApplicationAuthorityEnvelope,
  isUploadRepairPrompt,
  isWebPageUrl,
  jobSiteTarget,
  normalizeFormQuestionPrompt,
  NESTOR_REQUEST_REJECTED_MESSAGE,
  SubmissionOutcomeRecordSchema,
  UPLOAD_ATTACHED_ANSWER,
  type ApplicationAuthorityEnvelope,
  type ApplicationAutomationMode,
  type ApplicationResumeArtifact,
  type ApplicationReviewCard,
  type ApplicationRow,
  type ApplyExecutionResult,
  type CandidateProfile,
  type JobDetail,
  type JobFinderSettings,
  type JobSearchPreferences,
  type NeedsYouKind,
  type OpenApplicationResult,
  type SourceInstructionArtifact,
  type SubmissionOutcomeRecord,
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
import { traceEvent } from "@nestor/core/run-trace";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { accumulateApplyUsage } from "./apply-usage";
import {
  approvedJobResumeIdentity,
  loadApprovedJobResumeBytes,
  loadOriginalResumeBytes,
  renderApplicationResume,
  renderReadyJobResume,
} from "./resume-artifacts";

import {
  buildApplyLetterDependencies,
  createApplyFormPreparer,
  mergeApplyReviewCards,
} from "../internal/agent-application-preparation";
import {
  resolveApplicationAuthoritySuccessorId,
  withApplicationAuthorityGate,
} from "../internal/application-authority-gate";
import { runApplicationSubmissionRuntime } from "../internal/application-submission-runtime";
import { recordReportedSend } from "../internal/record-reported-send";
import { currentSendOutcomes } from "../internal/current-send-outcomes";
import { authorizeReviewedApplicationOrigin } from "../internal/apply-authority-resolution";
import {
  submitPreparedApplication,
  type SubmitPreparedApplicationRepository,
} from "../internal/apply-submission-handoff";
import { uniqueStrings } from "../internal/shared";
import { resolveApplicationAttachmentsForExecution } from "../internal/workspace-application-attachments";
import {
  buildInstructionGuidance,
  resolveActiveSourceInstructionArtifact,
} from "../internal/workspace-helpers";
import type {
  CandidateAssetResolver,
  JobFinderDocumentManager,
} from "../internal/workspace-service-contracts";
import {
  RESUME_WRITER_VERSION,
  toResumeJob,
  writeResume,
} from "../resumes/write-resume";
import {
  createResumeListingReader,
  PostingClosedError,
} from "../resumes/read-resume-listing";
import { createBrowserPostingReader } from "../internal/browser-listing-read";
import {
  applicationAnswerDependencies,
  applicationAnswersUnchanged,
  profileFactsDigest,
} from "./answer-dependencies";
import {
  describeFormQuestion,
  toKnownFormAnswer,
  type FormQuestion,
} from "./questions";

/** The file fields an upload item names, from its words. */
function uploadRepairFields(prompt: string): string[] {
  return prompt
    .replace(/ — upload (?:failed|not confirmed)$/u, "")
    .split(", ")
    .filter(Boolean);
}

export interface ApplicationServiceDeps {
  /** Whether the AI account lets calls through; the app's own by default. */
  aiAccess?: AiAccessWatch;
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
  /**
   * The person's own Send went through and the site confirmed it. Called just
   * before the form's page (bound under `pageKey`) closes.
   */
  onPersonSent?(sent: {
    applicationId: number;
    jobId: number;
    company: string;
    title: string;
    pageKey: string;
  }): void;
}

/**
 * How often a page waiting on the person is read. A read pulls the whole form
 * across the browser connection; every waiting page every two seconds kept the
 * main process busy with ten waiting, and the app lagged. A page the person
 * just opened or checked is read every two seconds for two minutes.
 */
const WATCH_IDLE_MS = 30_000;
const WATCH_CLOSE_MS = 2_000;
const WATCH_CLOSE_FOR_MS = 120_000;

export const applicationIdentity = (id: number, attempt: number) => ({
  applicationRecordId: `application_${id}`,
  runId: `application_run_${id}`,
  resultId: `application_${id}_attempt_${attempt}`,
});

type SendLedger = Pick<SendGuards, "getSubmissionIdempotencyRecord"> & {
  listSubmissionOutcomeRecords(options?: {
    jobId?: string;
  }): Promise<readonly { id?: string; idempotencyKey?: string }[]>;
};

/**
 * This attempt's send as the send ledger holds it now: a confirmed send, or
 * else the latest uncertain one. Null when the ledger recorded no send.
 */
export async function recordedSend(
  ledger: SendLedger,
  row: Pick<ApplicationRow, "id" | "jobId" | "attempt">,
): Promise<SubmissionOutcomeRecord | null> {
  const identity = applicationIdentity(row.id, row.attempt);
  const sends = (
    await currentSendOutcomes(
      ledger,
      await ledger.listSubmissionOutcomeRecords({ jobId: String(row.jobId) }),
    )
  )
    .map((outcome) => SubmissionOutcomeRecordSchema.parse(outcome))
    .filter(
      (outcome) =>
        outcome.runId === identity.runId &&
        outcome.resultId === identity.resultId &&
        ["submitted", "outcome_uncertain"].includes(outcome.outcome),
    )
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
  return sends.find((s) => s.outcome === "submitted") ?? sends[0] ?? null;
}

/**
 * Applications a run left Failed after the ledger recorded their send (a
 * result it could not save) follow the ledger: Applied or Uncertain. Runs
 * at start, so a row stored that way heals without anyone pressing anything.
 */
export async function followRecordedSends(
  applications: Pick<ApplicationStore, "listWorkInState" | "followSendLedger">,
  ledger: SendLedger,
): Promise<number[]> {
  const healed: number[] = [];
  // Every failed row: -1 is SQLite's "no limit".
  for (const row of applications.listWorkInState("failed", -1)) {
    const sent = await recordedSend(ledger, row);
    if (sent && applications.followSendLedger(row.id, row.attempt, sent))
      healed.push(row.id);
  }
  return healed;
}

/** Store rows own admission and progress; the existing engine owns the form and send guards. */
/**
 * What the run started by the person's Send is told. Their press is the
 * instruction to send; the model finds the form's own send control on the
 * page as it is now, restoring what they reviewed if the page lost it.
 */
export const PERSON_SEND_INSTRUCTION =
  "The person reviewed this filled application in Job Finder and pressed Send. Send it now, once, with submit_application on the form's own final send control as it is on the page. If the page was reloaded, closed or lost answers, first restore the answers and files from the earlier application state (they are what the person reviewed), then send. Read the send ledger facts first: a send to this posting that is already confirmed or uncertain is not sent again without checking the site.";

/**
 * An apply link that is not a web page, told to the run as a fact. No tab
 * opens a mailto: link, so the run starts on the listing; the address,
 * subject and text the link carries are the model's to apply with, from the
 * person's mail in a second tab or however it judges best.
 */
export function applyLinkInstruction(
  job: Pick<JobDetail, "url" | "applyUrl">,
): string | null {
  if (!job.applyUrl || isWebPageUrl(job.applyUrl)) return null;
  let link: URL | null = null;
  try {
    link = new URL(job.applyUrl);
  } catch {
    link = null;
  }
  if (link?.protocol !== "mailto:")
    return `This posting's apply link is ${JSON.stringify(job.applyUrl)}, which is not a web page, so this run opened on the listing at ${job.url}. Read the listing for how it asks applicants to apply.`;
  const params = link.searchParams;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const to = [decode(link.pathname), ...params.getAll("to")]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const cc = params.getAll("cc").join(", ").trim();
  const subject = params.get("subject")?.trim();
  const body = params.get("body")?.trim();
  return [
    `This posting is applied to by email: its apply link is ${JSON.stringify(job.applyUrl)}, an email address rather than a web form, so this run opened on the listing at ${job.url}.`,
    `The application is an email to ${to.join(", ") || "the address the listing names"}`,
    cc ? `, copied to ${cc}` : "",
    subject ? `, with the subject ${JSON.stringify(subject)}` : "",
    body ? `, starting from this text: ${JSON.stringify(body)}` : "",
    ".",
    " Read the listing for anything it asks applicants to send or write. The person's signed-in mail is open to you in a second tab (Gmail composes at https://mail.google.com/mail/?view=cm&fs=1&to=<address>); attach the resume to that email and write its message from the person's facts. That mail client's Send is this application's send control.",
  ].join("");
}

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
  const personSends = new Map<number, Set<AbortController>>();
  const waiting = new Map<number, number>();
  /** When each waiting page is read next, and until when it is read closely. */
  const watchPlan = new Map<number, { next: number; closeUntil: number }>();
  const watchClosely = (id: number) =>
    watchPlan.set(id, { next: 0, closeUntil: Date.now() + WATCH_CLOSE_FOR_MS });
  const opening = new Map<number, Promise<OpenApplicationResult>>();
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
  // These requests cannot change until another start. Their rows stay queued.
  const rejectedRequests = new Set<number>();
  const parkRejectedRequest = (row: ApplicationRow) => {
    rejectedRequests.add(row.id);
    if (
      !applications.continuePreparation(
        row.id,
        row.attempt,
        NESTOR_REQUEST_REJECTED_MESSAGE,
      )
    )
      rejectedRequests.delete(row.id);
  };
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let unsubscribePersonSend: (() => void) | null = null;
  let stopWatchingAccess: (() => void) | null = null;
  const access = () => deps.aiAccess ?? APP_AI_ACCESS;
  /** Claims the periodic check may make while the AI account refuses calls. */
  let checksAllowed = 0;
  /**
   * Applications the AI account refused go back in the queue, through the
   * same path as Try again: all of them once calls go through again, or the
   * oldest as the check while it still refuses. Each is tried once per
   * recovery; the queue runs them at its normal pace.
   */
  const retryRefusedApplications = (only?: "oldest"): boolean => {
    if (stopped) return false;
    let queued = false;
    for (const row of applications.listWorkInState("failed", -1)) {
      if (!isAiProviderAccessMessage(row.error)) continue;
      if (resumes.get(row.jobId)?.state !== "ready") continue;
      if (applications.retryPreparation(row.id, row.attempt)) queued = true;
      if (queued && only) break;
    }
    if (queued) wake();
    return queued;
  };
  /** The check while the account refuses: one waiting application, claimed now. */
  const checkWithOneApplication = (): boolean => {
    if (stopped || active.size > 0) return false;
    const waitingRow =
      retryRefusedApplications("oldest") ||
      applications
        .listWorkInState("queued", rejectedRequests.size + 1)
        .some(
          (row) =>
            row.error !== NESTOR_REQUEST_REJECTED_MESSAGE ||
            !rejectedRequests.has(row.id),
        );
    if (!waitingRow) return false;
    checksAllowed = 1;
    wake();
    return true;
  };
  let pumping: Promise<void> | null = null;
  let pumpAgain = false;
  let watching = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function current(row: ApplicationRow): boolean {
    const next = applications.getApplication(row.id);
    return (
      !!next &&
      next.attempt === row.attempt &&
      !["stopped", "failed", "closed", "submitted", "uncertain"].includes(
        next.state,
      )
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
    const handoff = await browser.handApplicationPageToPerson?.(
      "target_site",
      applicationIdentity(row.id, row.attempt).resultId,
    );
    if (handoff && !handoff.ok)
      applications.submissionRefused(row.id, row.attempt, handoff.error);
    waiting.set(row.id, row.attempt);
  }

  async function showAccessPage(row: ApplicationRow): Promise<void> {
    const key = applicationIdentity(row.id, row.attempt).resultId;
    try {
      // Show the retained challenge itself. A missing page stays available
      // through Needs you's Open action; this never restores or navigates it.
      const shown = await browser.focusRetainedApplicationPage?.(
        "target_site",
        key,
      );
      if (!shown || !current(row)) return;
      const handoff = await browser.handApplicationPageToPerson?.(
        "target_site",
        key,
      );
      if (handoff && !handoff.ok)
        applications.submissionRefused(row.id, row.attempt, handoff.error);
      watchClosely(row.id);
    } catch (error) {
      onError(error);
    }
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
  ): Promise<ApplicationAutomationMode | null> {
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
    return row.mode;
  }

  function instructionsFor(
    job: JobDetail,
    sourceInstructionArtifacts: readonly SourceInstructionArtifact[] = [],
  ): string[] {
    const target = job.applyUrl ?? job.url;
    const sighting =
      job.sightings.find((row) => (row.applyUrl ?? row.url) === target) ??
      job.sightings.find((row) => row.url === job.url);
    const siteId = Number(sighting?.sourceId);
    const site =
      Number.isSafeInteger(siteId) && siteId > 0
        ? createJobSitesStore(jobs).get(siteId)
        : null;
    return site
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
  }

  async function run(row: ApplicationRow, signal: AbortSignal): Promise<void> {
    let job = jobs.getJob(row.jobId);
    // The resume at the person's chosen level, approved or not: approval is
    // their own marker and is recorded with the file, never a condition.
    let resume = resumes.get(row.jobId);
    if (!job || resume?.state !== "ready")
      throw new Error(
        "This job's resume is being written again. Apply again once it is ready.",
      );
    const {
      profile: savedProfile,
      settings,
      searchPreferences,
      sourceInstructionArtifacts = [],
    } = await deps.readInputs();
    const profile = savedProfile;
    // A ready PDF can predate the current writer. Rewrite at the person's
    // chosen level before loading any attachment, including an approved PDF.
    // The posting is read first: one found closed gets no resume written.
    if (
      resume.level !== "original" &&
      resume.draft?.writerVersion !== RESUME_WRITER_VERSION
    ) {
      try {
        job = await createResumeListingReader({
          resumes,
          readPosting: createBrowserPostingReader({
            browserRuntime: browser,
            aiClient: deps.aiClient,
            readInputs: () => deps.readInputs(),
          }),
        })(job, signal, { readFirst: true });
      } catch (error) {
        if (!(error instanceof PostingClosedError)) throw error;
        signal.throwIfAborted();
        if (!current(row)) return;
        applications.finishPreparation({
          id: row.id,
          attempt: row.attempt,
          state: "closed",
          error: error.message,
        });
        return;
      }
      const draft = await writeResume(deps, {
        profile,
        settings,
        searchPreferences,
        job,
        level: resume.level,
        signal,
      });
      signal.throwIfAborted();
      if (!current(row)) return;
      if (!draft)
        throw new Error(
          "The resume writer returned no draft. Nothing was attached.",
        );
      resume = resumes.saveDraft(row.jobId, draft, resume.updatedAt);
    }
    let previous = applications.getWork(row.id);
    // An interrupted run can have a file on the employer's form before it
    // has saved any execution result. Reuse the recorded file independently.
    const existingArtifact =
      previous?.resumeArtifact ?? applications.getResumeArtifact(row.id);
    let artifact: ApplicationResumeArtifact;
    if (resume.draft && !resume.pdfPath) {
      // Written and not approved: rendered now, as approval would render it.
      artifact = await renderReadyJobResume({
        resume,
        profile,
        job: toResumeJob(job),
        settings,
        documentManager: deps.documentManager,
        existingArtifact,
        signal,
      });
    } else {
      // The PDF made at approval, or the imported file for Original.
      const filePath = resume.pdfPath ?? profile.baseResume.storagePath;
      if (!filePath)
        throw new Error(
          "Your resume file is unavailable. Import or export it again.",
        );
      const exportIdentity = resume.pdfPath
        ? approvedJobResumeIdentity(resume)
        : null;
      const bytes = exportIdentity
        ? await loadApprovedJobResumeBytes(
            resume,
            exportIdentity,
            resume.pdfSha256!.toLowerCase(),
          )
        : await loadOriginalResumeBytes(profile.baseResume);
      const digest = createHash("sha256").update(bytes).digest("hex");
      artifact = ApplicationResumeArtifactSchema.parse({
        id: `resume_${row.jobId}_${digest}`,
        jobId: String(row.jobId),
        source: resume.pdfPath === null ? "original_upload" : "tailored_export",
        sourceDocumentId:
          resume.pdfPath === null ? profile.baseResume.id : null,
        exportArtifactId: exportIdentity,
        fileName: basename(filePath),
        filePath,
        sha256: digest,
        approvedAt: resume.approvedAt,
        level: resume.level,
      });
    }
    const renderedResume = await renderApplicationResume({
      artifact,
      resume,
      profile,
      job: toResumeJob(job),
      settings,
      documentManager: deps.documentManager,
      existingArtifact,
      signal,
    });
    artifact = renderedResume.artifact;
    const sha256 = artifact.sha256!;
    signal.throwIfAborted();
    if (!current(row)) return;
    const profileDigest = profileFactsDigest(savedProfile);
    const describeForRun = (question: FormQuestion) => {
      return describeFormQuestion(question, job, profile);
    };
    if (
      !applications.setResumeArtifact(
        row.id,
        row.attempt,
        artifact,
        profileDigest,
      )
    )
      return;
    // An email apply link has no site; the run starts on the listing.
    const target = applicationPageUrl(job);
    applications.recordOrigin(row.id, new URL(target).origin);
    applications.recordOrigin(row.id, new URL(job.url).origin);
    // Apply captures the default. Only task-local authority can narrow it later.
    // The person's own Send on the form they reviewed is their instruction
    // to send it: that run works as Send for me, on the retained page.
    const personSend = applications.isPersonSend(row.id);
    const mode = personSend ? "autonomous_submit" : await modeFor(row);
    if (!mode)
      throw new Error("The instruction for this application was withdrawn.");
    const sends = mode === "autonomous_submit";
    let envelope = sends
      ? await deps.authorizeSending({
          application: row,
          artifact,
          job,
          signal,
          ...(personSend ? { personClicked: true } : {}),
        })
      : null;
    const identity = applicationIdentity(row.id, row.attempt);
    const instructions = instructionsFor(job, sourceInstructionArtifacts);
    const applyLink = applyLinkInstruction(job);
    if (applyLink) instructions.push(applyLink);
    if (personSend) instructions.push(PERSON_SEND_INSTRUCTION);
    const siteStep = previous?.accessRecheck
      ? applications.needsYou
          .accessForApplication(row.id)
          .find((task) => task.kind === "other")
      : undefined;
    let startingUrl = siteStep?.pageUrl ?? undefined;
    // A continue keeps the page, and with it the files already attached.
    let keptPage = false;
    let sourceAttempt: number | null = null;
    if (browser.hasApplicationPageBinding) {
      for (let attempt = row.attempt - 1; attempt >= 1; attempt -= 1) {
        if (
          await browser.hasApplicationPageBinding(
            "target_site",
            applicationIdentity(row.id, attempt).resultId,
          )
        ) {
          sourceAttempt = attempt;
          break;
        }
        if (!current(row) || signal.aborted) return;
      }
    } else if (
      row.attempt > 1 &&
      (!previous ||
        !["failed", "unsupported", "submitted"].includes(
          previous.execution.state,
        ))
    ) {
      // Non-native runtimes predating the binding query retain their old transfer path.
      sourceAttempt = previous?.attempt ?? row.attempt - 1;
    }
    if (!current(row) || signal.aborted) return;
    while (sourceAttempt !== null) {
      const sourceKey = applicationIdentity(row.id, sourceAttempt).resultId;
      const receipt = applications.getSubmissionReceipt(row.id);
      const older = sourceAttempt < row.attempt - 1;
      if (
        receipt?.outcome === "submitted" ||
        previous?.execution.state === "submitted" ||
        (older &&
          !(
            previous?.attempt === row.attempt - 1 &&
            ["failed", "unsupported"].includes(previous.execution.state)
          ))
      ) {
        applications.finishPreparation({
          id: row.id,
          attempt: row.attempt,
          state: "failed",
          error:
            "An earlier application page is still open and may have been sent. Check that page before continuing; Nestor has not opened or sent another application.",
        });
        return;
      }
      const transferred = await browser
        .transferApplicationPageBinding?.(
          "target_site",
          sourceKey,
          identity.resultId,
        )
        .catch(() => false);
      if (!current(row) || signal.aborted) return;
      const sourceStillLive =
        !transferred &&
        (await browser.hasApplicationPageBinding?.("target_site", sourceKey));
      if (!current(row) || signal.aborted) return;
      if (
        !transferred &&
        browser.hasApplicationPageBinding &&
        !sourceStillLive
      ) {
        // The selected tab closed during attachment. Look for an older live tab
        // before allowing a fresh page; a failed attachment is not a retry.
        let remaining: number | null = null;
        for (let attempt = sourceAttempt - 1; attempt >= 1; attempt -= 1) {
          const live = await browser.hasApplicationPageBinding(
            "target_site",
            applicationIdentity(row.id, attempt).resultId,
          );
          if (!current(row) || signal.aborted) return;
          if (live) {
            remaining = attempt;
            break;
          }
        }
        sourceAttempt = remaining;
        continue;
      }
      if (!transferred && sourceStillLive) {
        const adopted = await browser
          .adoptApplicationPageOwnership?.(
            "target_site",
            sourceKey,
            identity.resultId,
          )
          .catch(() => false);
        if (!current(row) || signal.aborted) return;
        if (!adopted) {
          applications.finishPreparation({
            id: row.id,
            attempt: row.attempt,
            state: "failed",
            error:
              "The earlier application page is still open and a send may have been pressed there. Check the site before continuing. Nestor has not opened or sent another application.",
          });
          return;
        }
        applications.finishPreparation({
          id: row.id,
          attempt: row.attempt,
          state: "failed",
          error:
            "Nestor could not attach automation to the retained application page. The page and recorded answers are kept. Retry when the connection is available.",
        });
        return;
      }
      if (!current(row) || signal.aborted) return;
      // N-1 was a different, failed page. Its replay and attachment claims cannot describe this tab.
      if (transferred && older) previous = null;
      if (transferred)
        startingUrl =
          (
            await browser.readApplicationPageBinding?.(
              "target_site",
              identity.resultId,
            )
          )?.url ?? startingUrl;
      const reenterForAccess = previous?.accessRecheck && !siteStep;
      if (transferred && reenterForAccess)
        await browser.reloadApplicationPageBinding?.(
          "target_site",
          identity.resultId,
          target,
        );
      if (transferred && reenterForAccess) startingUrl = target;
      keptPage = Boolean(transferred) && !reenterForAccess;
      break;
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
    if (renderedResume.docx?.ok) {
      const docx = renderedResume.docx;
      attachmentArtifacts.unshift({
        assetId: `${artifact.id}_docx`,
        questionId: null,
        sha256: docx.sha256,
        fileName: docx.fileName,
        mime: docx.mimeType,
        prompt: "Your CV",
        questionKind: "resume",
        assetKind: "resume",
        loadVerifiedBytes: async () => {
          const bytes = await readFile(docx.storagePath);
          if (createHash("sha256").update(bytes).digest("hex") !== docx.sha256)
            throw new Error("The resume's Word copy changed after rendering.");
          return new Uint8Array(bytes);
        },
      });
    }
    const letterAnswers = readSavedApplicationAnswers(
      jobs,
      [
        "self_intro",
        "career_transition",
        "availability",
        "notice_period",
        "travel",
      ],
      origin,
    );
    const savedAnswers = readSavedApplicationAnswers(jobs, undefined, origin);
    const answerDependencies = applicationAnswerDependencies(
      applications.needsYou,
      row.id,
      origin,
      savedAnswers,
    );
    const readSendHistory = async () =>
      currentSendOutcomes(
        deps.authorityRepository,
        await deps.authorityRepository.listSubmissionOutcomeRecords({
          jobId: String(row.jobId),
        }),
      );
    const previousSends = await readSendHistory();
    for (const previousSend of previousSends)
      instructions.push(
        `Send ledger: a send to this posting at ${previousSend.attemptedAt} is ${previousSend.outcome} (sendCallId=${previousSend.idempotencyKey}). This is recorded history, not permission to replay it. Check the site's applied list or confirmation before a new send decision. If you find the outcome of this call, use its sendCallId in record_send_outcome or finish.sendOutcome.`,
      );
    const facts: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm"> = {
      ...(instructions.length ? { instructions } : {}),
      job: {
        ...toResumeJob(job),
        // A tab opens only a web page; an email link is in the instructions.
        applicationUrl: isWebPageUrl(job.applyUrl) ? job.applyUrl : null,
      },
      listingDiscovery: listingDiscovery(job),
      profile,
      settings,
      resumeArtifact: artifact,
      applicationAttachments: attachmentArtifacts,
      mode: "prepare_only",
      applyAutomationMode: mode,
      submitAuthorized: sends && envelope !== null,
      applicationPageBindingKey: identity.resultId,
      // The review card keeps what each run filled: a closed page comes back
      // from it (no model call when the form still matches).
      restorableByRefill: true,
      idempotencyKey: identity.resultId,
      ...(startingUrl ? { startingUrl } : {}),
      accountCreationAuthorized:
        browserAgentPermissionsOf(settings).createAccounts,
      readIntendedAccountEmail: async () =>
        intendedAccountEmail((await deps.readInputs()).profile),
      readBrowserPermissions: async () =>
        browserAgentPermissionsOf((await deps.readInputs()).settings),
      // The form's own field saves go out as the run fills, as they do when
      // a person fills the form by hand (Ashby keeps the form only in what
      // it saved). Fill in for me still presses no form button and sends
      // nothing shaped like a final submit: the click stays the person's.
      // Send for me includes these same bounded field saves.
      intermediateMutationsAuthorized: envelope
        ? envelope.mode === "autonomous_submit" ||
          envelope.intermediateMutationsAuthorized === true
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
          envelope.mode !== "autonomous_submit" &&
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
              permission.mode !== "autonomous_submit" &&
              !permission.intermediateMutationsAuthorized)
          )
            return false;
        }
        const latest = await deps.readInputs();
        const latestMode = await modeFor(row);
        return (
          latestMode !== null &&
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
    let sentDuringPreparation: SubmissionOutcomeRecord | null = null;
    const preparationSends = new Map<string, SubmissionOutcomeRecord>();
    const retainSend = (receipt: SubmissionOutcomeRecord) => {
      preparationSends.set(receipt.idempotencyKey, receipt);
      sentDuringPreparation =
        [...preparationSends.values()].find(
          (item) => item.outcome === "submitted",
        ) ??
        [...preparationSends.values()].at(-1) ??
        null;
    };
    let agent: ApplyAgentResult | null = null;
    let review: ApplicationReviewCard | null = null;
    let currentReview: ApplicationReviewCard | null = null;
    const shouldRetainFailedApplicationPage = (
      execution: ApplyExecutionResult,
    ): boolean => {
      const technical = agent;
      return (
        current(row) &&
        !signal.aborted &&
        (technical?.outcome === "stuck" || technical?.outcome === "paused") &&
        (technical.technicalFailure?.code ===
          "question_classification_unavailable" ||
          technical.technicalFailure?.code ===
            "answer_grounding_unavailable") &&
        technical.technicalFailure.retryable &&
        technical.technicalFailure.pageDisposition === "retain" &&
        !!technical.finalUrl &&
        technical.readyToSend === null &&
        technical.pauses.every(
          (pause) => pause.code === "question_needs_you" && !pause.blocker,
        ) &&
        ["failed", "paused"].includes(execution.state) &&
        !execution.submittedAt &&
        execution.outcome === null &&
        !["submitted", "outcome_uncertain"].includes(
          applications.getSubmissionReceipt(row.id)?.outcome ?? "",
        )
      );
    };
    const localAnswers = () =>
      (previous?.execution.questions ?? []).flatMap((question) => {
        const answer = applications.needsYou.fieldAnswer(row.id, question.id);
        return answer
          ? [
              {
                ...toKnownFormAnswer(
                  {
                    id: `${row.id}_${question.id}`,
                    prompt: answer.prompt,
                    answer: answer.answer,
                    local: true,
                  },
                  question,
                  job.location,
                  row.id,
                ),
                context: {
                  options: question.answerOptions,
                  siteOrigin: origin,
                  company: job.company,
                  givenBy: "person",
                },
              },
            ]
          : [];
      });
    const usageRecorder = createModelUsageRecorder();
    const executeApplicationFlow: BrowserSessionRuntime["executeApplicationFlow"] =
      (...args) =>
        usageRecorder.run(() => browser.executeApplicationFlow(...args));
    const earlierStep = previous?.execution.stepReceipts?.findLast(
      (receipt) => receipt.kind === "final",
    );
    const result = await executeApplicationFlow(
      "target_site",
      {
        ...facts,
        shouldRetainFailedApplicationPage,
        prepareApplicationForm: createApplyFormPreparer({
          history: applications.history(),
          reusableAnswers: [...savedAnswers, ...localAnswers()],
          initialUnansweredPickerQuestions:
            previous?.execution.questions
              .filter(
                (question) =>
                  question.status === "detected" &&
                  !question.submittedAnswer &&
                  !applications.needsYou.answersForQuestions(
                    row.id,
                    [
                      {
                        ...describeForRun(question),
                        prompt: question.prompt,
                      },
                    ],
                    origin,
                  ).length,
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
            resumeText: artifact.textContent ?? null,
            reusableAnswers: letterAnswers,
          }),
          uploadsConfirmedByPerson: confirmedUploadFields(row),
          earlierAttachments: keptPage
            ? (previous?.reviewCard?.attachments ?? [])
            : [],
          earlierActivity: previous?.execution.checkpoints ?? [],
          earlierAttemptProgress: applications.earlierAttemptProgress(
            row.id,
            row.attempt,
          ),
          saveAttemptProgress: (progress) =>
            applications.saveAttemptProgress(row.id, row.attempt, progress),
          // Earlier recorded answers, files and path are facts for the model.
          // Only its explicit tool calls may restore anything to the page.
          ...(previous &&
          (previous.reviewCard || previous.execution.replay.lastUrl)
            ? {
                replay: {
                  answers: previous.reviewCard?.answers ?? [],
                  attachments: keptPage
                    ? []
                    : (previous.reviewCard?.attachments ?? []),
                  path: previous.execution.formPath ?? [],
                  formUrl:
                    previous.reviewCard?.pageUrl ??
                    previous.execution.replay.lastUrl ??
                    undefined,
                  ...(earlierStep
                    ? {
                        formStep: {
                          label: earlierStep.stepLabel,
                          index: earlierStep.stepIndex,
                          total: earlierStep.stepTotal,
                        },
                      }
                    : {}),
                },
              }
            : {}),
          readReusableAnswers: () =>
            Promise.resolve([
              ...answerDependencies.includeContext(
                readSavedApplicationAnswers(jobs),
              ),
              ...localAnswers(),
            ]),
          submitApplication: async (decision) => {
            signal.throwIfAborted();
            const sent = await submitPreparedApplication({
              repository: deps.authorityRepository,
              browserRuntime: {
                observeApplicationForm:
                  browser.observeApplicationForm!.bind(browser),
                executeExactlyOneFinalAction:
                  browser.executeExactlyOneFinalAction!.bind(browser),
              },
              source: "target_site",
              envelope,
              mode,
              lineage: {
                ...identity,
                jobId: String(row.jobId),
                campaignId: null,
              },
              finalAction: decision,
              ...(decision.callId ? { callId: decision.callId } : {}),
              loadResumeBytes: async () =>
                new Uint8Array(await readFile(artifact.filePath)),
              now: new Date().toISOString(),
              signal,
              runSubmission: runApplicationSubmissionRuntime,
            });
            const receipt = "outcome" in sent ? sent.outcome : null;
            if (receipt) retainSend(receipt);
            const requests = receipt?.browserAction?.requestsAfterClick;
            const networkObservation =
              requests === undefined
                ? "No network observation was recorded for this press."
                : `Network requests the harness observed during the press: ${JSON.stringify(requests)}. An empty list means only that the harness observed no requests during the press.`;
            return {
              ...(receipt ? { sendCallId: receipt.idempotencyKey } : {}),
              outcome: receipt?.outcome ?? null,
              content: receipt
                ? `Send ledger: sendCallId=${receipt.idempotencyKey}, ${receipt.attemptedAt}, ${receipt.outcome}. Browser action: ${receipt.browserAction?.reason ?? "unknown"}. ${receipt.browserAction?.detail ?? ""} ${networkObservation} Inspect the current page, then call record_send_outcome with that sendCallId and your observed outcome. ${receipt.outcome === "outcome_uncertain" ? "This send call was not replayed. Check the site's applied list or confirmation before deciding whether to send again." : receipt.outcome === "submitted" ? "The employer confirmed receipt." : "The site did not confirm a send. Inspect the page and decide the next action."}`
                : "detail" in sent
                  ? sent.detail
                  : "The send did not execute; observe again.",
            };
          },
          recordSendOutcome: async (decision) => {
            signal.throwIfAborted();
            const reportedKey = `model_report_${identity.applicationRecordId}_${decision.sendCallId}`;
            const repository = deps.authorityRepository;
            const reportOutcomeId = `resolution_${reportedKey}`;
            let ledger =
              (await repository.getSubmissionIdempotencyRecord(
                decision.sendCallId,
              )) ??
              (await repository.getSubmissionIdempotencyRecord(reportedKey));
            let inferredSend = false;
            let repeatedReport = false;
            if (!ledger && decision.inferSendCallId) {
              // A retry of this finish still refers to the same send after
              // the first report has resolved its uncertainty.
              const priorReport =
                await repository.getSubmissionOutcomeRecord(reportOutcomeId);
              let sendCallId = priorReport?.idempotencyKey;
              repeatedReport = priorReport !== null;
              if (!sendCallId) {
                const unsettled = (await readSendHistory()).filter(
                  (send) =>
                    send.runId === identity.runId &&
                    send.outcome === "outcome_uncertain",
                );
                if (unsettled.length === 1)
                  sendCallId = unsettled[0]!.idempotencyKey;
              }
              if (sendCallId) {
                ledger =
                  await repository.getSubmissionIdempotencyRecord(sendCallId);
                inferredSend = true;
              }
            }
            const previous = ledger?.outcomeId
              ? await repository.getSubmissionOutcomeRecord(ledger.outcomeId)
              : null;
            if (!ledger) {
              const recorded = await recordReportedSend({
                repository,
                lineage: {
                  ...identity,
                  jobId: String(row.jobId),
                  campaignId: null,
                },
                envelope,
                mode,
                resumeBytes: new Uint8Array(await readFile(artifact.filePath)),
                decision: {
                  ...decision,
                  sendCallId: reportedKey,
                  pageUrl: decision.pageUrl ?? job.url,
                },
                now: new Date().toISOString(),
              });
              const receipt = "outcome" in recorded ? recorded.outcome : null;
              if (!receipt)
                return {
                  recorded: false,
                  content:
                    "detail" in recorded
                      ? recorded.detail
                      : "The model report could not be recorded.",
                };
              retainSend(receipt);
              if (decision.outcome === "waiting")
                applications.recordUnsettledSend(row.id, row.attempt, receipt);
              return {
                recorded: true,
                content: `Recorded ${decision.outcome}: ${decision.evidence}. No browser action was issued; the original send had no prior intent.`,
              };
            }
            if (
              !previous ||
              previous.applicationRecordId !== identity.applicationRecordId ||
              previous.jobId !== String(row.jobId)
            )
              return {
                recorded: false,
                content:
                  "No send with that call ID belongs to this application. Read the send ledger and the result of submit_application.",
              };
            const outcome =
              decision.outcome === "confirmed"
                ? "submitted"
                : decision.outcome === "failed"
                  ? "not_submitted"
                  : "outcome_uncertain";
            const reason =
              decision.outcome === "waiting"
                ? "awaiting_email_verification"
                : "model_observed_outcome";
            // One send call has one recorded outcome: the same report again
            // (record_send_outcome, then finish) adds no second row.
            if (
              repeatedReport ||
              (!inferredSend &&
                previous.outcome === outcome &&
                (previous.browserAction?.reason === reason ||
                  previous.browserAction?.reason ===
                    "model_reported_send_without_prior_intent"))
            ) {
              retainSend(previous);
              return {
                recorded: true,
                sendCallId: previous.idempotencyKey,
                content: `sendCallId=${previous.idempotencyKey} already has this ${decision.outcome} outcome recorded; nothing new was written. This call ID remains consumed and will never be replayed.`,
              };
            }
            const at = new Date().toISOString();
            const destination = new URL(decision.pageUrl ?? job.url);
            const receipt = SubmissionOutcomeRecordSchema.parse({
              ...previous,
              id: inferredSend
                ? reportOutcomeId
                : `${previous.id}_model_${randomUUID()}`,
              outcome,
              verifiedAt:
                decision.outcome === "uncertain" ||
                decision.outcome === "waiting"
                  ? null
                  : at,
              evidence: [
                {
                  id: `model_${randomUUID()}`,
                  kind: "employer_site_state",
                  observedAt: at,
                  destination: {
                    origin: destination.origin,
                    safePath: destination.pathname,
                  },
                  artifactRefId: null,
                  summary: decision.evidence,
                },
              ],
              retry: {
                eligible: false,
                blockReason:
                  decision.outcome === "confirmed"
                    ? "submission_confirmed"
                    : decision.outcome === "failed"
                      ? "policy_decision"
                      : "outcome_uncertain",
              },
              browserAction: { ...previous.browserAction, reason },
            });
            const recorded = await repository.resolveSubmissionOutcome({
              expectedOutcomeId: previous.id,
              expectedIdempotencyRevision: ledger.revision,
              outcome: receipt,
            });
            if (
              recorded.status !== "recorded" &&
              recorded.status !== "duplicate"
            )
              return {
                recorded: false,
                content: `The ledger update returned ${recorded.status}; read its current state before deciding again.`,
              };
            retainSend(receipt);
            if (decision.outcome === "waiting")
              applications.recordUnsettledSend(row.id, row.attempt, receipt);
            return {
              recorded: true,
              sendCallId: receipt.idempotencyKey,
              content: `Recorded ${decision.outcome} for sendCallId=${receipt.idempotencyKey}: ${decision.evidence}. The form remains bound. This call ID remains consumed and will never be replayed.`,
            };
          },
          onPrepared: (outcome) => {
            agent = outcome.result;
            currentReview = outcome.reviewCard;
            review =
              outcome.result.readyToSend ||
              ["submitted", "uncertain"].includes(outcome.result.outcome)
                ? outcome.reviewCard
                : mergeApplyReviewCards(
                    previous?.reviewCard ?? null,
                    outcome.reviewCard,
                    {
                      freshPreparation:
                        !keptPage ||
                        [
                          "submitted",
                          "failed",
                          "uncertain",
                          "ready_to_send",
                        ].includes(outcome.result.outcome),
                    },
                  );
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
    const recordedSend =
      sentDuringPreparation as SubmissionOutcomeRecord | null;
    // A send the site did not confirm, followed by a step the model handed
    // to the person, waits on that step: the ledger keeps the send's outcome
    // and the handoff goes to Needs you on the open page.
    const handedToPerson =
      result.questions.some(
        (question) =>
          question.status === "detected" && !question.submittedAnswer,
      ) ||
      ((agent as ApplyAgentResult | null)?.pauses ?? []).some(
        (pause) => accessKind(pause.blocker) !== null,
      );
    if (recordedSend && recordedSend.outcome !== "submitted" && handedToPerson)
      applications.recordUnsettledSend(row.id, row.attempt, recordedSend);
    else if (
      recordedSend &&
      recordedSend.browserAction?.reason !== "awaiting_email_verification"
    ) {
      applications.beginSubmission(row.id, row.attempt);
      applications.recordSubmission(row.id, row.attempt, recordedSend);
      if (recordedSend.outcome === "submitted")
        await closePage(row.id, row.attempt);
      return;
    }
    if (result.requestRejected) {
      parkRejectedRequest(row);
      return;
    }
    const retainedTechnicalFailure = shouldRetainFailedApplicationPage(result);
    const finishTechnicalFailure = async () => {
      // Only this live, cancelled-checked attempt may retain its owned binding.
      // A provider/read outage creates no personal question or automatic retry.
      const retained = await browser
        .hasApplicationPageBinding?.("target_site", identity.resultId)
        .catch(() => false);
      // A grounding failure says which answer it could not confirm (council D4).
      // Assigned by the preparer callback, so read it without narrowing.
      const technical = agent;
      const grounding =
        technical?.technicalFailure?.code === "answer_grounding_unavailable"
          ? technical.outcome === "stuck"
            ? technical.reason
            : "Nestor could not finish checking the remaining application answers. Your page and answers are kept. Try again."
          : null;
      if (current(row) && !signal.aborted)
        applications.finishPreparation({
          id: row.id,
          attempt: row.attempt,
          state: "failed",
          error: grounding
            ? retained
              ? grounding
              : grounding.replace(
                  "Your page and answers are kept.",
                  "The page is unavailable; your recorded answers are kept.",
                )
            : retained
              ? "Nestor could not read this form after three tries. The page and your answers are kept. Try again."
              : "Nestor could not read this form after three tries. The page is unavailable; your recorded answers are kept. Try again.",
        });
    };
    if (retainedTechnicalFailure && result.questions.length === 0) {
      await finishTechnicalFailure();
      return;
    }
    // The site took the file this time: its upload item is done, even when
    // the form now stops on another question.
    if (
      (result.state === "ready" ||
        result.questions.some((question) => question.status === "detected")) &&
      uploadRepaired(row, result, currentReview as ApplicationReviewCard | null)
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
    if (
      !retainedTechnicalFailure &&
      (result.state === "failed" || result.state === "unsupported")
    ) {
      applications.finishPreparation({
        id: row.id,
        attempt: row.attempt,
        state:
          result.blocker?.code === "application_closed" ? "closed" : "failed",
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
    for (const question of result.questions.filter(
      (q) => q.status === "detected" && !q.submittedAnswer,
    )) {
      const known = describeForRun(question);
      applications.needsYou.request(
        {
          applicationId: row.id,
          attempt: row.attempt,
          fieldKey: question.id,
          kind: "question",
          key: known.key,
          scope: {
            siteOrigin: new URL(
              question.currentFieldBinding?.pageUrl ??
                (agent as ApplyAgentResult | null)?.finalUrl ??
                target,
            ).origin,
          },
          prompt: question.prompt,
          input: known.input,
          options: known.options,
          reusePrompt: false,
          askReason: question.askReason ?? {
            kind: "no_source",
            detail: result.detail,
          },
        },
        { reuseAnswers: false },
      );
    }
    if (retainedTechnicalFailure) {
      await finishTechnicalFailure();
      return;
    }
    // The raw engine's typed blockers distinguish access steps from technical failures.
    const prepared = agent as ApplyAgentResult | null;
    if (prepared && !prepared.pauses.some((pause) => pause.blocker))
      for (const task of applications.needsYou.accessForApplication(row.id))
        applications.needsYou.completeAccess(task.id, row.id);
    const steps = (prepared?.pauses ?? []).flatMap((pause) => {
      const kind = accessKind(pause.blocker);
      return kind
        ? [
            {
              kind,
              instructions: pause.summary,
              ownBrowser: pause.blocker?.code === "browser_blocked",
            },
          ]
        : [];
    });
    const ownBrowser = steps.find((step) => step.ownBrowser);
    const step = ownBrowser ?? steps[0];
    if (step) {
      const observedUrl = prepared?.finalUrl ?? result.replay.lastUrl ?? target;
      const observedPage = URL.parse(observedUrl);
      // Query strings and fragments can carry OAuth or other one-use secrets.
      const pageUrl =
        observedPage && isWebPageUrl(observedUrl)
          ? observedPage.origin + observedPage.pathname
          : null;
      jobs.transaction(() => {
        applications.needsYou.request({
          applicationId: row.id,
          attempt: row.attempt,
          fieldKey: "site_access",
          kind: step.kind,
          key: "site_access",
          scope: {
            siteOrigin: new URL(pageUrl ?? target).origin,
          },
          prompt:
            ownBrowser?.instructions ??
            steps.map((entry) => entry.instructions).join("\n\n"),
          input: "text",
          options: [],
          ...(ownBrowser ? { blockedUrl: target } : {}),
          ...(step.kind === "other" ? { pageUrl } : {}),
        });
        if (ownBrowser)
          applications.block(row.id, row.attempt, ownBrowser.instructions);
      });
    }
    if (ownBrowser) return;
    if (applications.getApplication(row.id)?.state === "needs_you") {
      waiting.set(row.id, row.attempt);
      if (applications.needsYou.accessForApplication(row.id).length)
        await showAccessPage(row);
      return;
    }
    if (result.state !== "ready") {
      applications.finishPreparation({
        id: row.id,
        attempt: row.attempt,
        state:
          result.blocker?.code === "application_closed" ? "closed" : "failed",
        error: result.detail,
      });
      await closePage(row.id, row.attempt);
      return;
    }
    if (prepared?.readyToSend) {
      await send(
        row,
        artifact,
        envelope,
        profileDigest,
        signal,
        false,
        prepared.readyToSend,
      );
    } else {
      // Fill in for me leaves the send to the person: its finish is the
      // run's summary, already saved with its execution, never an error. A
      // Send for me run that finished without sending keeps why it waits.
      await leaveForPerson(
        row,
        sends
          ? `The model finished without sending: ${result.detail}`
          : undefined,
      );
    }
  }

  async function send(
    row: ApplicationRow,
    artifact: ApplicationResumeArtifact,
    original: ApplicationAuthorityEnvelope | null,
    profileDigest: string,
    signal: AbortSignal,
    personClicked = false,
    decision?: NonNullable<ApplyAgentResult["readyToSend"]>,
    callId?: string,
  ): Promise<void> {
    const identity = applicationIdentity(row.id, row.attempt);
    const queuedAt = Date.now();
    const timing = (stage: string, startedAt: number) =>
      console.info(
        `[apply] timing application=${identity.resultId} stage=${stage} startedAt=${new Date(startedAt).toISOString()} completedAt=${new Date().toISOString()} durationMs=${Date.now() - startedAt}`,
      );
    const operation = () => {
      timing("send_queue", queuedAt);
      return withApplicationAuthorityGate(
        deps.authorityRepository,
        signal,
        async () => {
          void profileDigest;
          signal.throwIfAborted();
          const latest = applications.getApplication(row.id);
          if (
            !latest ||
            latest.attempt !== row.attempt ||
            signal.aborted ||
            ["stopped", "failed", "submitted"].includes(latest.state)
          )
            return;
          if (
            !applications.beginSubmission(row.id, row.attempt, {
              newSendDecision: !!callId,
            })
          )
            return;
          const envelope = original;
          const runtime = {
            observeApplicationForm:
              browser.observeApplicationForm!.bind(browser),
            executeExactlyOneFinalAction:
              browser.executeExactlyOneFinalAction!.bind(browser),
          };
          const sendCallId = decision?.callId ?? callId;
          const outcome = await submitPreparedApplication({
            repository: deps.authorityRepository,
            browserRuntime: runtime,
            ...(decision ? { finalAction: decision } : {}),
            ...(sendCallId ? { callId: sendCallId } : {}),
            ...(personClicked ? { confirmedByPerson: true } : {}),
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
            if (outcome.outcome.outcome === "submitted")
              await closePage(row.id, row.attempt);
            else if (outcome.outcome.outcome === "outcome_uncertain") {
              waiting.delete(row.id);
            } else
              await leaveForPerson(
                row,
                outcome.outcome.browserAction?.detail ??
                  outcome.outcome.browserAction?.reason ??
                  "The send was recorded as not submitted.",
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
    };
    if (browser.withApplicationPageExecution)
      await browser.withApplicationPageExecution(
        "target_site",
        identity.resultId,
        operation,
        signal,
      );
    else await operation();
  }

  /**
   * The person checked the site after a send the app could not confirm and
   * says what it shows. Their word settles the row: sent moves it to
   * Applied; not sent stops it, so nothing sends it again by itself.
   */
  async function reportSendByPerson(
    id: number,
    sent: boolean,
  ): Promise<boolean> {
    const row = applications.getApplication(id);
    if (!row || row.state === "submitted" || row.submittedAt !== null)
      return false;
    const job = jobs.getJob(row.jobId);
    const page =
      applications.getWork(id)?.reviewCard?.pageUrl ??
      (job ? applicationPageUrl(job) : null);
    if (!page) return false;
    const destination = new URL(page);
    const previous = applications.getSubmissionReceipt(id);
    const identity = applicationIdentity(id, row.attempt);
    const key = `person_${identity.resultId}_checked`;
    const at = new Date().toISOString();
    const receipt = SubmissionOutcomeRecordSchema.parse({
      id: key,
      preflightId: previous?.preflightId ?? key,
      idempotencyKey: previous?.idempotencyKey ?? key,
      authorityEnvelopeId: previous?.authorityEnvelopeId ?? key,
      authorityRevision: previous?.authorityRevision ?? 1,
      ...identity,
      jobId: String(row.jobId),
      outcome: sent ? "submitted" : "not_submitted",
      attemptedAt: previous?.attemptedAt ?? at,
      verifiedAt: sent ? at : null,
      evidence: [
        {
          id: key,
          kind: "operator_confirmation",
          observedAt: at,
          destination: {
            origin: destination.origin,
            safePath: destination.pathname,
          },
          artifactRefId: null,
          summary: sent
            ? "You reported that this application was sent."
            : "You reported that this application was not sent.",
        },
      ],
      retry: {
        eligible: false,
        blockReason: sent ? "submission_confirmed" : "policy_decision",
      },
    });
    if (!applications.reportSendByPerson(id, receipt)) return false;
    active.get(id)?.abort();
    for (const controller of personSends.get(id) ?? []) controller.abort();
    await closePage(id, row.attempt);
    return true;
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
   * Uncertain. Their page stays available for checking and an explicit
   * outcome can settle the recorded press without another send.
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
    return (
      !!page?.url &&
      !!pressedAt &&
      recordPersonSend(row, attempt, pressedAt, page.url)
    );
  }

  function recordPersonSend(
    row: ApplicationRow,
    attempt: number,
    pressedAt: string,
    pageUrl: string,
  ): boolean {
    if (Date.parse(pressedAt) < Date.parse(row.updatedAt) || !current(row))
      return false;
    const receipt = personReceipt(row, attempt, {
      kind: "pressed",
      at: pressedAt,
      url: new URL(pageUrl),
    });
    if (!applications.recordSubmission(row.id, attempt, receipt)) return false;
    waiting.delete(row.id);
    return true;
  }

  function accessKind(
    blocker: ApplyBlocker | null | undefined,
  ): Exclude<NeedsYouKind, "question"> | null {
    if (blocker?.code === "person_step_required" && blocker.requiresPerson)
      return "other";
    return (blocker?.code === "browser_blocked" ||
      blocker?.code === "security_challenge") &&
      blocker.requiresPerson
      ? "captcha"
      : blocker?.code === "multi_factor_required"
        ? "mfa"
        : blocker?.code === "site_login_required" ||
            blocker?.code === "account_creation_required"
          ? "sign_in"
          : null;
  }

  /** The person fixed the upload on the page: drop its item, finish the rest. */
  async function checkUploadRepair(
    row: ApplicationRow,
    readUnheld = true,
  ): Promise<boolean> {
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
      (readUnheld
        ? await browser
            .readApplicationPageBinding?.("target_site", key)
            .catch(() => null)
        : null);
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
        // A page the person holds is read every cycle. A page nobody holds
        // is read only when due.
        const now = Date.now();
        const plan = watchPlan.get(id);
        const due = !plan || now >= plan.next;
        if (due)
          watchPlan.set(id, {
            next:
              now +
              (plan && now < plan.closeUntil ? WATCH_CLOSE_MS : WATCH_IDLE_MS),
            closeUntil: plan?.closeUntil ?? 0,
          });
        if (await recordPersonPress(row, attempt)) continue;
        if (await checkUploadRepair(row, due)) continue;
      }
      for (const id of watchPlan.keys())
        if (!waiting.has(id)) watchPlan.delete(id);
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
        // While the AI account refuses calls, queued applications wait in
        // the queue instead of each failing; the periodic check claims one.
        if (access().status() === "blocked") {
          if (checksAllowed === 0) break;
          checksAllowed--;
        }
        const row = applications.claimNext(rejectedRequests);
        if (!row) break;
        void runClaimed(row, new AbortController());
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

  /** Runs one claimed attempt, settling it if the run itself fails. */
  function runClaimed(
    row: ApplicationRow,
    controller: AbortController,
  ): Promise<void> {
    active.set(row.id, controller);
    return run(row, controller.signal)
      .catch(async (error) => {
        if (stopped) return;
        const requestRejected = getRejectedModelRequest(error);
        if (!requestRejected && (await deps.isHoldingCurrent())) {
          applications.continuePreparation(row.id, row.attempt);
          return;
        }
        if (!controller.signal.aborted) onError(error);
        // The run failed after the ledger recorded its send: the row says
        // what the ledger says, never Failed with Apply again on offer.
        const sent = await recordedSend(deps.authorityRepository, row).catch(
          (ledgerError: unknown) => (onError(ledgerError), null),
        );
        if (sent && applications.followSendLedger(row.id, row.attempt, sent)) {
          if (sent.outcome === "submitted")
            await closePage(row.id, row.attempt).catch(onError);
          else waiting.delete(row.id);
          return;
        }
        if (applications.getApplication(row.id)?.state === "submitting")
          applications.submissionUnknown(row.id, row.attempt);
        else if (requestRejected) {
          parkRejectedRequest(row);
          return;
        } else
          applications.finishPreparation({
            id: row.id,
            attempt: row.attempt,
            state: "failed",
            error:
              getAiProviderAccessFailure(error)?.message ??
              (error instanceof Error
                ? error.message
                : "The application could not finish."),
          });
        await closePage(row.id, row.attempt).catch(onError);
      })
      .finally(() => {
        if (active.get(row.id) === controller) active.delete(row.id);
        wake();
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
      await followRecordedSends(applications, deps.authorityRepository);
      rejectedRequests.clear();
      stopped = false;
      unsubscribePersonSend =
        browser.onApplicationSendPressed?.((press) => {
          const match = /^application_(\d+)_attempt_(\d+)$/u.exec(
            press.resultId,
          );
          if (!match) return;
          const row = applications.getApplication(Number(match[1]));
          if (row?.attempt === Number(match[2]))
            recordPersonSend(row, row.attempt, press.pressedAt, press.pageUrl);
        }) ?? null;
      applications.recoverPreparation();
      applications.needsYou.reconcileSavedQuestions();
      for (const state of ["ready", "needs_you"] as const)
        for (const row of applications.listWorkInState(state))
          waiting.set(row.id, row.attempt);
      unsubscribe = jobs.onChange((change) => {
        if (
          change.cause !== "application" &&
          !change.stages.includes("resume") &&
          !change.stages.includes("shortlisted")
        )
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
      const stopHearing = access().onChange((status) => {
        if (status !== "available") return;
        checksAllowed = 0;
        if (!retryRefusedApplications()) wake();
      });
      const stopChecking = access().onRecheck(checkWithOneApplication);
      stopWatchingAccess = () => {
        stopHearing();
        stopChecking();
      };
      // Calls already went through since the app started: what the account
      // refused earlier goes again now.
      if (access().status() === "available") retryRefusedApplications();
      wake();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      stopWatchingAccess?.();
      stopWatchingAccess = null;
      unsubscribePersonSend?.();
      unsubscribePersonSend = null;
      if (timer) clearInterval(timer);
      timer = null;
      for (const controller of active.values()) controller.abort();
      for (const controllers of personSends.values())
        for (const controller of controllers) controller.abort();
    },
    wake,
    /**
     * The person pressed Send on a Ready form, or the sidebar sent one with
     * its call ID. The in-app model sends it: it reads the page as it is now
     * (the form they reviewed, or a reloaded or reopened one, which it
     * restores from the recorded answers first) and presses the form's own
     * send control through the send ledger. A second press, or the same
     * call ID again, starts nothing.
     */
    async sendPrepared(id: number, callId?: string): Promise<boolean> {
      const row = applications.getApplication(id);
      if (!row || !applications.getWork(id) || !jobs.getJob(row.jobId))
        return false;
      const claimed = applications.claimPersonSend(
        id,
        row.attempt,
        callId ?? null,
      );
      // The press is the person's own action, recorded in the run trace
      // under both attempts: the form they reviewed and the run that sends it.
      traceEvent("operator_action", {
        source: callId ? "person (sidebar)" : "person",
        action: "send_application",
        applicationKeys: [
          applicationIdentity(id, row.attempt).resultId,
          ...(claimed
            ? [applicationIdentity(id, claimed.attempt).resultId]
            : []),
        ],
        detail: claimed
          ? `Send pressed on the ${row.state} application (attempt ${row.attempt}); attempt ${claimed.attempt} sends it`
          : `Send pressed on the ${row.state} application (attempt ${row.attempt}); it started no new send`,
        outcome: claimed ? "ok" : "no new send",
        ...(callId ? { callId } : {}),
      });
      if (!claimed) return false;
      const controller = new AbortController();
      const controllers = personSends.get(id) ?? new Set<AbortController>();
      controllers.add(controller);
      personSends.set(id, controllers);
      try {
        await runClaimed(claimed, controller);
        return applications.getApplication(id)?.state === "submitted";
      } finally {
        controllers.delete(controller);
        if (!controllers.size) personSends.delete(id);
      }
    },
    checkAccess(taskId: number): Promise<boolean> {
      return Promise.resolve().then(() => {
        if (!applications.needsYou.details(taskId)) return false;
        let retrying = false;
        for (const app of applications.needsYou.applicationsToCheckForAccess(
          taskId,
        )) {
          watchClosely(app.id);
          // Each application re-enters at its own address with GET. An account
          // session can carry across pages, but each run observes its own result.
          if (applications.retryAccessForPerson(app.id, app.attempt))
            retrying = true;
        }
        if (retrying) wake();
        return applications.needsYou.details(taskId) === null;
      });
    },
    reportSendByPerson,
    retryPreparation(id: number): boolean {
      const row = applications.getApplication(id);
      if (!row || resumes.get(row.jobId)?.state !== "ready") return false;
      const queued = applications.retryPreparation(id, row.attempt);
      if (queued) wake();
      return queued;
    },
    resolveUncertainByPerson(id: number, sent: boolean): Promise<boolean> {
      return applications.getApplication(id)?.state === "uncertain"
        ? reportSendByPerson(id, sent)
        : Promise.resolve(false);
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
    open(id: number): Promise<OpenApplicationResult> {
      const pending = opening.get(id);
      if (pending) return pending;
      const operation = open(id).finally(() => opening.delete(id));
      opening.set(id, operation);
      return operation;
    },
  };

  async function open(id: number): Promise<OpenApplicationResult> {
    const row = applications.getApplication(id);
    if (!row) return { opened: false, retained: false };
    const key = applicationIdentity(id, row.attempt).resultId;
    // Focus only a live retained page. Snapshot restoration can refill fields;
    // Open must never run preparation, replay answers or change the saved mode.
    const retained = await browser
      .focusRetainedApplicationPage?.("target_site", key)
      .catch((error: unknown) => {
        onError(error);
        return false;
      });
    if (retained) {
      if (["ready", "needs_you"].includes(row.state)) {
        await browser.handApplicationPageToPerson?.("target_site", key);
        waiting.set(id, row.attempt);
        watchClosely(id);
      }
      return { opened: true, retained: true };
    }
    const job = jobs.getJob(row.jobId);
    const work = applications.getWork(id);
    const access =
      row.state === "needs_you" || row.state === "blocked"
        ? applications.needsYou.accessForApplication(id)
        : [];
    const accessPage = access.length
      ? (access.find((task) => task.kind === "other")?.pageUrl ??
        work?.execution.replay.lastUrl ??
        work?.execution.blocker?.url)
      : null;
    const url =
      accessPage ??
      work?.reviewCard?.pageUrl ??
      (job ? applicationPageUrl(job) : null);
    if (!url) return { opened: false, retained: false };
    await browser.openSession("target_site", { targetUrl: url });
    return { opened: true, retained: false };
  }
}

export type ApplicationService = ReturnType<typeof createApplicationService>;
