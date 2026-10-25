import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hasSubmissionConfirmationText, type ApplyAgentResult } from "@nestor/browser-agent";
import { applicationPreparationConcurrency, type BrowserSessionRuntime, type ExecuteApplicationFlowInput } from "@nestor/browser-runtime";
import {
  AiBehaviorPreferenceSchema, ApplicationResumeArtifactSchema, SubmissionOutcomeRecordSchema,
  submissionConfirmationSummary,
  isActiveApplicationAuthorityEnvelope,
  type ApplicationAuthorityEnvelope, type ApplicationRow, type ApplicationResumeArtifact,
  type ApplicationReviewCard, type CandidateProfile, type JobFinderSettings,
  type JobSearchPreferences, type JobDetail, type NeedsYouKind, type SubmissionOutcomeRecord,
} from "@nestor/contracts";
import type { ApplicationStore } from "@nestor/db/applications";
import { createResumeStore, type JobStore } from "@nestor/db/job-store";
import type { JobFinderAiClient } from "@nestor/ai-providers";

import { createApplyFormPreparer, buildApplyLetterDependencies } from "../internal/agent-application-preparation";
import { withApplicationAuthorityGate, resolveApplicationAuthoritySuccessorId } from "../internal/application-authority-gate";
import { authorizeReviewedApplicationOrigin } from "../internal/apply-authority-resolution";
import { runApplicationSubmissionRuntime } from "../internal/application-submission-runtime";
import { submitPreparedApplication, type SubmitPreparedApplicationRepository } from "../internal/apply-submission-handoff";
import type { JobFinderRepository } from "@nestor/db";
import type { JobFinderDocumentManager } from "../internal/workspace-service-contracts";
import { toResumeJob } from "../resumes/write-resume";
import { describeFormQuestion, toKnownFormAnswer } from "./questions";

export interface ApplicationServiceDeps {
  jobs: JobStore;
  applications: ApplicationStore;
  browser: BrowserSessionRuntime;
  aiClient: JobFinderAiClient;
  documentManager: JobFinderDocumentManager;
  authorityRepository: SubmitPreparedApplicationRepository & Pick<JobFinderRepository,
    "listApplicationAuthorityEnvelopes" | "getApplicationAuthorityEnvelope" |
    "commitApplicationAuthorityEnvelope" | "replaceApplicationAuthorityEnvelope">;
  readInputs(): Promise<{ profile: CandidateProfile; settings: JobFinderSettings; searchPreferences: JobSearchPreferences }>;
  isPaused(): Promise<boolean>;
  isHoldingCurrent(): Promise<boolean>;
  authorizeSending(input: { application: ApplicationRow; artifact: ApplicationResumeArtifact; job: JobDetail; signal: AbortSignal }): Promise<ApplicationAuthorityEnvelope | null>;
  concurrency?: number;
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
  const resumes = createResumeStore(jobs);
  const active = new Map<number, AbortController>();
  const waiting = new Map<number, number>();
  const capacity = applicationPreparationConcurrency(String(deps.concurrency ?? 16));
  const onError = deps.onError ?? ((error: unknown) => console.error("[Apply]", error));
  let stopped = true;
  let unsubscribe: (() => void) | null = null;
  let pumping: Promise<void> | null = null;
  let pumpAgain = false;
  let watching = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function current(row: ApplicationRow): boolean {
    const next = applications.getApplication(row.id);
    return !!next && next.attempt === row.attempt && !["stopped", "failed", "submitted", "uncertain"].includes(next.state);
  }

  async function closePage(id: number, attempt: number): Promise<void> {
    waiting.delete(id);
    await browser.releaseApplicationPageBinding?.("target_site", applicationIdentity(id, attempt).resultId);
  }

  async function run(row: ApplicationRow, signal: AbortSignal): Promise<void> {
    const job = jobs.getJob(row.jobId);
    const approved = resumes.get(row.jobId);
    if (!job || job.stage !== "resume" || approved?.state !== "ready" || !approved.approvedAt)
      throw new Error("Approve this job's resume before applying.");
    const { profile: savedProfile, settings, searchPreferences } = await deps.readInputs();
    const profile = { ...savedProfile, answerBank: { ...savedProfile.answerBank, customAnswers: [] } };
    const filePath = approved.pdfPath ?? profile.baseResume.storagePath;
    if (!filePath) throw new Error("Your approved resume file is unavailable. Import or export it again.");
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = ApplicationResumeArtifactSchema.parse({
      id: `resume_${row.jobId}_${sha256}`, jobId: String(row.jobId),
      source: approved.pdfPath === null ? "original_upload" : "tailored_export",
      sourceDocumentId: approved.pdfPath === null ? profile.baseResume.id : null,
      exportArtifactId: null, fileName: basename(filePath), filePath, sha256,
      approvedAt: approved.approvedAt,
    });
    signal.throwIfAborted();
    if (!current(row)) return;
    const previous = applications.getWork(row.id);
    if (!applications.setResumeArtifact(row.id, row.attempt, artifact)) return;
    applications.recordOrigin(row.id, new URL(job.applyUrl ?? job.url).origin);
    applications.recordOrigin(row.id, new URL(job.url).origin);
    const profileDigest = createHash("sha256").update(JSON.stringify(savedProfile)).digest("hex");
    // The saved setting can narrow the mode captured at Apply, never widen it.
    const sends = row.mode === "autonomous_submit" && settings.applicationAutomationMode === "autonomous_submit";
    let envelope = sends ? await deps.authorizeSending({ application: row, artifact, job, signal }) : null;
    const identity = applicationIdentity(row.id, row.attempt);
    let startingUrl: string | undefined;
    if (row.attempt > 1 && (!previous || !["failed", "unsupported", "submitted"].includes(previous.execution.state))) {
      const transferred = await browser.transferApplicationPageBinding?.("target_site", applicationIdentity(row.id, previous?.attempt ?? row.attempt - 1).resultId, identity.resultId);
      if (transferred) startingUrl = (await browser.readApplicationPageBinding?.("target_site", identity.resultId))?.url ?? undefined;
    }
    const target = job.applyUrl ?? job.url;
    const origin = new URL(target).origin;
    const allowedOrigins = new Set([origin, new URL(job.url).origin, ...(envelope?.allowedOrigins ?? []).map(value => new URL(value).origin)]);
    const behavior = AiBehaviorPreferenceSchema.parse(settings.aiBehavior ?? {}).applying;
    const facts: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm"> = {
      job: toResumeJob(job), profile, settings, resumeArtifact: artifact,
      mode: "prepare_only", applyAutomationMode: sends && envelope ? "autonomous_submit" : "confirm_before_submit",
      submitAuthorized: sends && envelope !== null,
      applicationPageBindingKey: identity.resultId, idempotencyKey: identity.resultId,
      ...(startingUrl ? { startingUrl } : {}), accountCreationAuthorized: false,
      intermediateMutationsAuthorized: true,
      intermediateMutationAllowedOrigins: [...allowedOrigins],
      recheckIntermediateMutationAuthority: async observedOrigin => {
        if (!current(row) || signal.aborted || !allowedOrigins.has(observedOrigin)) return false;
        if (envelope) {
          const permission = await deps.authorityRepository.getApplicationAuthorityEnvelope(resolveApplicationAuthoritySuccessorId(deps.authorityRepository, envelope.id));
          if (!permission || !isActiveApplicationAuthorityEnvelope(permission, new Date().toISOString()) || !permission.scope.jobIds.includes(String(row.jobId)) || !permission.allowedResumeSha256.includes(sha256)) return false;
        }
        const latest = await deps.readInputs();
        return createHash("sha256").update(JSON.stringify(latest.profile)).digest("hex") === profileDigest;
      },
      applyAllowedOrigins: [...allowedOrigins],
      preApprovedAttestationKinds: behavior.preApprovedDeclarations,
      salaryDisclosure: settings.salaryDisclosure ?? "pause_for_user",
      authorizeReviewedApplicationOrigin: async nextOrigin => {
        if (!envelope) return null;
        const next = await authorizeReviewedApplicationOrigin({ repository: deps.authorityRepository, envelope, jobId: String(job.id), origin: nextOrigin, now: new Date().toISOString() });
        if (next) { envelope = next; allowedOrigins.add(nextOrigin); applications.recordOrigin(row.id, nextOrigin); }
        return next;
      },
    };
    let agent: ApplyAgentResult | null = null;
    let review: ApplicationReviewCard | null = null;
    const result = await browser.executeApplicationFlow!("target_site", {
      ...facts,
      prepareApplicationForm: createApplyFormPreparer({
        executionInput: facts, applicationRecordId: identity.applicationRecordId,
        searchPreferences, aiClient: deps.aiClient, envelope,
        siteLabel: job.company,
        letters: buildApplyLetterDependencies({ aiClient: deps.aiClient, documentManager: deps.documentManager, job: facts.job, profile, settings, searchPreferences }),
        readReusableAnswers: async questions => {
          const byKey = new Map(questions.map(question => [describeFormQuestion(question, job).key, question]));
          return applications.needsYou.answersForQuestions(row.id, [...byKey.keys()], origin)
            .map(answer => toKnownFormAnswer(answer, byKey.get(answer.key)!, job.location, row.id));
        },
        onPrepared: outcome => { agent = outcome.result; review = outcome.reviewCard; },
      }),
    }, { signal });
    signal.throwIfAborted();
    if (!current(row) || !applications.saveWork(row.id, { attempt: row.attempt, resumeArtifact: artifact, execution: result, reviewCard: review, authorityEnvelopeId: envelope?.id ?? null })) return;
    if (await deps.isHoldingCurrent()) { applications.continuePreparation(row.id, row.attempt); return; }
    if (result.state === "failed" || result.state === "unsupported") {
      applications.finishPreparation({ id: row.id, attempt: row.attempt, state: "failed", error: result.detail });
      return;
    }
    let fromMemory = false;
    for (const question of result.questions.filter(q => q.status === "detected" && !q.submittedAnswer)) {
      const known = describeFormQuestion(question, job);
      const requested = applications.needsYou.request({
        applicationId: row.id, attempt: row.attempt, fieldKey: question.id,
        kind: "question", key: known.key, scope: {}, prompt: question.prompt,
        input: known.input, options: known.options,
      });
      fromMemory ||= requested.status === "answered";
    }
    // The raw engine's typed blockers distinguish access steps from technical failures.
    const prepared = agent as ApplyAgentResult | null;
    for (const pause of prepared?.pauses ?? []) {
      const code = pause.blocker?.code;
      const kind: NeedsYouKind | null = code === "security_challenge" ? "captcha" : code === "multi_factor_required" ? "mfa"
        : code === "site_login_required" || code === "account_creation_required" ? "sign_in" : null;
      if (kind) applications.needsYou.request({ applicationId: row.id, attempt: row.attempt,
        fieldKey: kind, kind, key: `${kind}:${origin}`, scope: { siteOrigin: origin },
        prompt: pause.summary, input: "text", options: [],
      });
    }
    if (applications.getApplication(row.id)?.state === "needs_you") {
      waiting.set(row.id, row.attempt);
      return;
    }
    if (fromMemory) { applications.continuePreparation(row.id, row.attempt); return; }
    if (result.state !== "ready") {
      applications.finishPreparation({ id: row.id, attempt: row.attempt, state: "failed", error: result.detail });
      await closePage(row.id, row.attempt);
      return;
    }
    if (sends && envelope && prepared?.readyToSend) {
      await send(row, artifact, envelope, profileDigest, signal);
    } else {
      applications.finishPreparation({ id: row.id, attempt: row.attempt, state: "ready" });
      await browser.handApplicationPageToPerson?.("target_site", identity.resultId);
      waiting.set(row.id, row.attempt);
    }
  }

  async function send(row: ApplicationRow, artifact: ApplicationResumeArtifact, original: ApplicationAuthorityEnvelope, profileDigest: string, signal: AbortSignal): Promise<void> {
    const identity = applicationIdentity(row.id, row.attempt);
    const operation = () => withApplicationAuthorityGate(deps.authorityRepository, signal, async () => {
      const { settings, profile } = await deps.readInputs();
      if (!current(row) || settings.applicationAutomationMode !== "autonomous_submit" || createHash("sha256").update(JSON.stringify(profile)).digest("hex") !== profileDigest) {
        applications.finishPreparation({ id: row.id, attempt: row.attempt, state: "ready" });
        waiting.set(row.id, row.attempt);
        return;
      }
      const activeEnvelopes = await deps.authorityRepository.listApplicationAuthorityEnvelopes({ status: "active" });
      const envelope = activeEnvelopes.length === 1 ? activeEnvelopes[0] : null;
      if (!envelope || envelope.id !== resolveApplicationAuthoritySuccessorId(deps.authorityRepository, original.id) || envelope.mode !== original.mode || !envelope.scope.jobIds.includes(String(row.jobId)) || !envelope.allowedResumeSha256.includes(artifact.sha256!))
        throw new Error("The permission to send this application changed. Review the filled form before trying again.");
      if (!applications.beginSubmission(row.id, row.attempt)) return;
      const runtime = {
        observeApplicationForm: browser.observeApplicationForm!.bind(browser),
        executeExactlyOneFinalAction: (source: Parameters<NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>>[0], input: Parameters<NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>>[1]) => browser.executeExactlyOneFinalAction!(source, {
          ...input, veto: async facts => {
            const { settings: latest, profile: latestProfile } = await deps.readInputs();
            const app = applications.getApplication(row.id);
            return !!app && app.attempt === row.attempt && app.state === "submitting" && latest.applicationAutomationMode === "autonomous_submit" && createHash("sha256").update(JSON.stringify(latestProfile)).digest("hex") === profileDigest && await input.veto(facts);
          },
        }),
      };
      const outcome = await submitPreparedApplication({
        repository: deps.authorityRepository, browserRuntime: runtime, source: "target_site", envelope,
        lineage: { ...identity, jobId: String(row.jobId), campaignId: null },
        loadResumeBytes: async () => new Uint8Array(await readFile(artifact.filePath)),
        now: new Date().toISOString(), signal, runSubmission: runApplicationSubmissionRuntime,
      });
      if ("outcome" in outcome && outcome.outcome) {
        applications.recordSubmission(row.id, row.attempt, outcome.outcome);
        if (outcome.outcome.outcome !== "not_submitted") await closePage(row.id, row.attempt);
      } else applications.submissionRefused(row.id, row.attempt, "detail" in outcome ? outcome.detail : "The application was not sent.");
    });
    if (browser.withApplicationPageExecution) await browser.withApplicationPageExecution("target_site", identity.resultId, operation, signal);
    else await operation();
  }

  async function watch(): Promise<void> {
    if (stopped || watching) return;
    watching = true;
    try {
      for (const [id, attempt] of waiting) {
        const row = applications.getApplication(id);
        if (!row || ["stopped", "failed", "submitted", "uncertain"].includes(row.state)) { await closePage(id, attempt); continue; }
        if (row.attempt !== attempt || !["ready", "needs_you"].includes(row.state)) { waiting.delete(id); continue; }
        const identity = applicationIdentity(id, attempt);
        const page = await browser.readApplicationPageWithPerson?.("target_site", identity.resultId).catch(() => null);
        if (!page || page.loading || !page.url || !hasSubmissionConfirmationText(page.bodyText)) continue;
        const destination = new URL(page.url);
        const preparedUrl = applications.getWork(id)?.reviewCard?.pageUrl;
        if (!preparedUrl || destination.origin !== new URL(preparedUrl).origin) continue;
        const at = new Date().toISOString();
        const key = `person_${identity.resultId}`;
        const receipt = SubmissionOutcomeRecordSchema.parse({
          id: key, preflightId: key, idempotencyKey: key, authorityEnvelopeId: key, authorityRevision: 1,
          ...identity, jobId: String(row.jobId), outcome: "submitted", attemptedAt: at, verifiedAt: at,
          evidence: [{ id: key, kind: "employer_site_state", observedAt: at,
            destination: { origin: destination.origin, safePath: destination.pathname }, artifactRefId: null,
            summary: submissionConfirmationSummary(page.bodyText),
          }], retry: { eligible: false, blockReason: "submission_confirmed" },
        });
        if (applications.recordSubmission(id, attempt, receipt)) await closePage(id, attempt);
      }
    } finally { watching = false; }
  }

  function wake(): void {
    if (stopped) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = (async () => {
      while (!stopped && active.size < capacity && !(await deps.isPaused())) {
        const row = applications.claimNext();
        if (!row) break;
        const controller = new AbortController();
        active.set(row.id, controller);
        void run(row, controller.signal).catch(async error => {
          if (stopped) return;
          if (await deps.isHoldingCurrent()) {
            applications.continuePreparation(row.id, row.attempt);
            return;
          }
          if (!controller.signal.aborted) onError(error);
          if (applications.getApplication(row.id)?.state === "submitting") applications.submissionUnknown(row.id, row.attempt);
          else applications.finishPreparation({ id: row.id, attempt: row.attempt, state: "failed", error: error instanceof Error ? error.message : "The application could not finish." });
          await closePage(row.id, row.attempt).catch(onError);
        }).finally(() => { active.delete(row.id); wake(); });
      }
    })().catch(onError).finally(() => { pumping = null; if (pumpAgain) { pumpAgain = false; wake(); } });
  }

  return {
    async start() {
      if (!stopped) return;
      await deps.authorityRepository.recoverArmedSubmissionAttempts({ now: new Date().toISOString() });
      for (const row of applications.listWorkInState("submitting")) {
        const outcomes = await deps.authorityRepository.listSubmissionOutcomeRecords({ jobId: String(row.jobId) });
        const saved = outcomes.find(outcome => outcome.runId === applicationIdentity(row.id, row.attempt).runId);
        if (saved) applications.recordSubmission(row.id, row.attempt, SubmissionOutcomeRecordSchema.parse(saved));
        else applications.submissionUnknown(row.id, row.attempt);
      }
      stopped = false;
      applications.recoverPreparation();
      unsubscribe = jobs.onChange(change => {
        if (change.cause !== "application" && !change.stages.includes("resume")) return;
        for (const [id, controller] of active) {
          const row = applications.getApplication(id);
          if (!row || row.state === "stopped") controller.abort();
        }
        wake();
      });
      timer = setInterval(() => { void watch().catch(onError); wake(); }, 2_000);
      timer.unref();
      wake();
    },
    stop() { stopped = true; unsubscribe?.(); unsubscribe = null; if (timer) clearInterval(timer); timer = null; for (const controller of active.values()) controller.abort(); },
    wake,
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
        if (row?.attempt === Number(match[2]) && row.state === "running") applications.continuePreparation(row.id, row.attempt);
      }
      wake();
    },
    async open(id: number): Promise<boolean> {
      const row = applications.getApplication(id);
      const work = applications.getWork(id);
      if (!row || !work || !["ready", "needs_you"].includes(row.state)) return false;
      const key = applicationIdentity(id, work.attempt).resultId;
      const focused = await browser.focusApplicationPageBinding?.("target_site", key);
      if (focused) { await browser.handApplicationPageToPerson?.("target_site", key); waiting.set(id, work.attempt); }
      return focused ?? false;
    },
  };
}

export type ApplicationService = ReturnType<typeof createApplicationService>;
