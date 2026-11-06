// ADR 0079: ordinary site requests and service workers run normally. Legacy
// hooks remain for session compatibility; none installs a request fence.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Page,Locator,Frame,BrowserContext,Request} from 'playwright';
import {ApplyExecutionResultSchema,type ApplyExecutionResult,type ApplyExecutionModelUse,type ApplicationAttemptBlocker,type ApplicationAttemptCheckpoint,type ApplicationAttemptExternalWriteEvidence,type ApplicationAttemptQuestion,type ApplyBlockedAttempt,type ApplyRequestPermit,type ApplyUploadFile} from '@nestor/contracts';
import type {IntermediateMutationWindowSnapshot} from './application-intermediate-mutation-policy';
import type {ExecuteApplicationFlowInput} from './runtime-types';
export type PrepareOnlyBlockedAttempt=ApplyBlockedAttempt;
export function onPrepareOnlyUploadPermit(
  page: Page,
  listener: (request: Request, permit: ApplyRequestPermit) => void,
): void{
void page;
void listener;

}
export function getAttachmentGuardRefusal(
  request: Request,
): string | undefined{
void request;
return undefined;
}
export function getPrepareOnlyRequestPermit(
  request: Request,
): ApplyRequestPermit | null{
void request;
return null;
}
export function allowPrepareOnlyRunNavigation(page: Page, url: string): void{
void page;
void url;

}
export interface PrepareOnlyGuardSnapshot {
  installed: boolean;
  blockedAttempts: PrepareOnlyBlockedAttempt[];
  /**
   * Every request the in-page guard refused, with what it lacked. For the
   * record only: `blockedAttempts` alone decides whether a run stops.
   */
  refusals?: PrepareOnlyRefusal[];
}
export interface PrepareOnlyRefusal {
  kind: "fetch" | "xhr" | "send_beacon";
  method: string;
  url: string | null;
  /** What the body was: a string, form data, a file or other opaque body. */
  body: "none" | "text" | "form_data" | "opaque";
  at: string;
}
export async function armAccountWindowInPage(
  locator: Locator,
  token: string,
  expiresAtMs: number,
): Promise<void>{
void locator;
void token;
void expiresAtMs;

}
export async function pendingAccountWindowInPage(
  locator: Locator,
  token: string,
): Promise<boolean>{
void locator;
void token;
return true;
}
export async function releaseAccountWindowInPage(
  locator: Locator,
  token: string,
): Promise<boolean>{
void locator;
void token;
return true;
}
export async function cancelAccountWindowInPage(
  locator: Locator,
  token: string,
): Promise<void>{
void locator;
void token;

}
export async function installAccountWindowContainment(
  child: Page,
  input: {
    opener: Page;
    writeOrigins: readonly string[];
    disclosableValues?: readonly string[];
    canWrite?: () => boolean;
  },
): Promise<void>{
void child;
void input;

}
export function readPrepareOnlyIntermediateWriteCount(page: Page): number{
void page;
return 0;
}
export async function drainPrepareOnlyIntermediateWrites(
  page: Page,
): Promise<void>{
void page;

}
export async function openPrepareOnlyAuthorizedFormActionWindow(
  page: Page,
  locator: Locator,
  durationMs: number | null = 20_000,
  expected?: { action: string; method: "POST" },
): Promise<void>{
void page;
void locator;
void durationMs;
void expected;

}
export async function waitForPrepareOnlyAuthorizedFormAction(
  page: Page,
  timeoutMs = 3_000,
): Promise<void>{
void page;
void timeoutMs;

}
export async function closePrepareOnlyAuthorizedFormActionWindow(
  page: Page,
): Promise<void>{
void page;

}
export function isPrepareOnlyFinalActionWindowOpen(page: Page): boolean | null{
void page;
return null;
}
export async function openPrepareOnlyFinalActionWindow(
  page: Page,
  durationMs = 20_000,
): Promise<void>{
void page;
void durationMs;

}
export async function closePrepareOnlyFinalActionWindow(
  page: Page,
): Promise<void>{
void page;

}
export function installPrepareOnlyMutationGuardInPage(guardInput: {
  intermediateMutationsAuthorized: boolean;
  finalActionSignal: string;
  /** `PICKER_CHOICE_WINDOW_MS`, passed in: this function cannot import. */
  pickerChoiceWindowMs: number;
  /** `CAPTCHA_VERIFICATION_REQUEST`, passed in for the same reason. */
  captchaVerificationSignal?: string;
  /** `SITE_BOT_CHECK_PATH`, passed in for the same reason. */
  siteBotCheckPath?: string;
}): void{
void guardInput;

}
export function setPrepareOnlyIntermediateMutationWindowInPage(
  mutationWindow: IntermediateMutationWindowSnapshot | null,
): void{
void mutationWindow;

}
export function registerPrepareOnlyPreparedValueInPage(value: string): void{
void value;

}
export function markPrepareOnlyPickerChoiceInPage(values: string[]): void{
void values;

}
export function readPrepareOnlyMutationGuardInPage(): PrepareOnlyGuardSnapshot{

return {installed:false,blockedAttempts:[]};
}
export interface ServiceWorkerRegisterGuardStatus {
  supported: boolean;
  prototypeGuardInstalled: boolean;
  instanceGuardInstalled: boolean;
  integrityVerified: boolean;
  guardStatePresent: boolean;
  blockedRegistrationAttempts: number;
}
export function installServiceWorkerRegisterGuardInPage(): void{


}
export function readServiceWorkerRegisterGuardInPage(): ServiceWorkerRegisterGuardStatus{

return {supported:true,prototypeGuardInstalled:false,instanceGuardInstalled:false,integrityVerified:false,guardStatePresent:false,blockedRegistrationAttempts:0};
}
export interface PageServiceWorkerScanPayload {
  scanned: boolean;
  controllerUrl: string | null;
  registrations: Array<{
    scope: string;
    installingUrl: string | null;
    waitingUrl: string | null;
    activeUrl: string | null;
  }>;
}
export function collectApplicationOriginServiceWorkerStateInPage(): Promise<PageServiceWorkerScanPayload>{

return Promise.resolve({scanned:false,controllerUrl:null,registrations:[]});
}
export async function ensurePrepareOnlyMutationGuard(
  page: Page,
  intermediateMutationsAuthorized: boolean,
  intermediateMutationAllowedOrigins: readonly string[] = [],
  attachmentUploadsAuthorized = false,
): Promise<PrepareOnlyGuardSnapshot>{
void page;
void intermediateMutationsAuthorized;
void intermediateMutationAllowedOrigins;
void attachmentUploadsAuthorized;
return {installed:false,blockedAttempts:[]};
}
export async function openPrepareOnlyIntermediateMutationWindow(
  page: Page,
): Promise<void>{
void page;

}
export async function fencePrepareOnlyLocalPress(page: Page): Promise<void>{
void page;

}
export async function closePrepareOnlyIntermediateMutationWindow(
  page: Page,
): Promise<void>{
void page;

}
export async function openPrepareOnlyAttachmentUploadWindow(
  page: Page,
  file: ApplyUploadFile,
  field: string | null = null,
): Promise<void>{
void page;
void file;
void field;

}
export async function closePrepareOnlyAttachmentUploadWindow(
  page: Page,
): Promise<void>{
void page;

}
export async function registerPrepareOnlyPreparedValue(
  page: Page,
  value: string,
): Promise<void>{
void page;
void value;

}
export async function markPrepareOnlyPickerChoice(
  page: Page,
  values: readonly string[],
): Promise<void>{
void page;
void values;

}
export async function getLatestBlockedPrepareOnlyAttempt(
  page: Page,
): Promise<PrepareOnlyBlockedAttempt | null>{
void page;
return null;
}
export async function getBlockedPrepareOnlyAttempts(
  page: Page,
): Promise<PrepareOnlyBlockedAttempt[]>{
void page;
return [];
}
export function recordPrepareOnlyRunInterruption(
  page: Page,
  attempt: PrepareOnlyBlockedAttempt,
): void{
void page;
void attempt;

}
export type ServiceWorkerSafetyStopReason =
  | "active_service_worker_controlling_application_origin"
  | "service_worker_origin_unresolved"
  | "application_origin_registration_detected"
  | "register_guard_compromised"
  | "service_worker_safety_channel_unavailable";
export type ServiceWorkerSafetyDetectionChannel =
  | "context_serviceworker_event"
  | "context_service_workers_enumeration"
  | "page_service_worker_scan"
  | "register_guard_integrity";
export interface ServiceWorkerSafetyFinding {
  reason: ServiceWorkerSafetyStopReason;
  channel: ServiceWorkerSafetyDetectionChannel;
  phase: string;
  workerUrls: string[];
  detail: string;
}
export async function findApplicationOriginServiceWorkerIssue(input: {
  context: BrowserContext;
  targetUrl: string;
  page?: Page | null;
  phase: string;
  pendingWorkerEventUrls?: readonly string[];
}): Promise<ServiceWorkerSafetyFinding | null>{
void input;
return null;
}
export interface ApplicationRunServiceWorkerSentinel {
  check(phase: string): Promise<ServiceWorkerSafetyFinding | null>;
  attachPage(page: Page): void;
  pendingWorkerEventCount(): number;
  detach(): void;
  armAccountWindow(token: string, expiresAtMs: number): Promise<Page | null>;
  onDetach?(listener: () => void): void;
  disarmAccountWindow(): void;
  isDetached(): boolean;
}
export async function openPrepareOnlyProviderWriteWindow(
  page: Page,
  input: {
    origins: readonly string[];
    disclosableValues: readonly string[];
    active: () => boolean;
    login?: { frame: Frame; formAction: string; token: string };
  },
): Promise<(() => Promise<void>) & { writes(): number }>{
void page;
void input;
return Object.assign(async()=>{}, {writes:()=>0});
}
const activeAccountWindows=new WeakMap<Page,Page>();const claimedAccountWindows=new WeakSet<Page>();
export const registerAccountSurfaceOrigins=(page:Page,origins:readonly string[]):void=>{void page;void origins;};
export const isClaimedAccountWindow=(page:Page):boolean=>claimedAccountWindows.has(page);
export const hasActiveAccountWindow=(page:Page):boolean=>{const child=activeAccountWindows.get(page);return !!child&&!child.isClosed();};
export const ACCOUNT_WINDOW_OPEN_MESSAGE='An account window is open for this application; finish or close it first.';
export const hasPrepareOnlyPreparedValues=(page:Page):boolean=>{void page;return false;};
export const PICKER_CHOICE_WINDOW_MS=10000;
export function createApplicationRunServiceWorkerSentinel(input:{context:BrowserContext;targetUrl:string;now?:()=>Date}):ApplicationRunServiceWorkerSentinel{
let page:Page|null=null,detached=false;let resolveChild:((page:Page|null)=>void)|null=null;const listeners:(()=>void)[]=[];
const onPage=(child:Page)=>{void child.opener().then(opener=>{if(!detached&&opener===page&&resolveChild&&page){claimedAccountWindows.add(child);activeAccountWindows.set(page,child);resolveChild(child);resolveChild=null;}}).catch(()=>undefined);};input.context.on('page',onPage);
return {check:async()=>null,attachPage:next=>{page=next;},pendingWorkerEventCount:()=>0,onDetach:listener=>{listeners.push(listener);},armAccountWindow:()=>new Promise(resolve=>{resolveChild=resolve;}),disarmAccountWindow:()=>{resolveChild?.(null);resolveChild=null;},isDetached:()=>detached,detach:()=>{detached=true;resolveChild?.(null);resolveChild=null;input.context.off('page',onPage);for(const listener of listeners)listener();}};}
export function normalizeFileSystemPath(value: string): string {
  const normalized = resolve(value.trim()).replace(/\\/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function describeUnknownError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}

export async function loadVerifiedResumeBytes(
  resumeArtifact: ExecuteApplicationFlowInput["resumeArtifact"],
): Promise<Uint8Array> {
  const expectedSha256 = resumeArtifact.sha256?.trim().toLowerCase() ?? "";
  if (!expectedSha256) {
    throw new Error(
      "The approved resume has no SHA-256 integrity record. Re-import or re-export it before application preparation.",
    );
  }

  const bytes = await readFile(resumeArtifact.filePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "The approved resume changed after verification. Re-import or re-export it before application preparation.",
    );
  }
  return bytes;
}

/** A short, stable, readable id segment made from a label. */
function toStableIdSegment(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .trim()
      .replace(/\s+/gu, "_")
      .slice(0, 48) || "field"
  );
}

function createPreparationConsentDecisions(input: {
  jobId: string;
  now: string;
  questions: readonly ApplicationAttemptQuestion[];
  usesOriginalResume: boolean;
  manualDecisionLabel?: string;
  externalWrites?: readonly ApplicationAttemptExternalWriteEvidence[];
}) {
  const externalWrites = input.externalWrites ?? [];
  // The resume card records consent to USE a document, which the attempt's
  // own answered resume question settles.
  const resumeAttached = input.questions.some(
    (question) => question.kind === "resume" && question.status === "answered",
  );
  // The autofill card claims values reached the employer's form, and only the
  // write receipt can support that claim.
  const profileAutofilled = externalWrites.some(
    (write) =>
      write.category === "profile_field" ||
      write.category === "application_answer",
  );

  return [
    ...(resumeAttached
      ? [
          {
            id: `consent_${input.jobId}_resume_use`,
            kind: "resume_use" as const,
            label: input.usesOriginalResume
              ? "Use the selected original resume for this application"
              : "Use the approved tailored resume for this application",
            status: "approved" as const,
            decidedAt: input.now,
            detail: input.usesOriginalResume
              ? "The exact original resume selected by the user was attached during prepare-only automation."
              : "The approved tailored resume was attached during prepare-only automation.",
          },
        ]
      : []),
    ...(profileAutofilled
      ? [
          {
            id: `consent_${input.jobId}_autofill_profile`,
            kind: "autofill_profile" as const,
            label: "Use exact saved profile fields for this application",
            status: "approved" as const,
            decidedAt: input.now,
            detail:
              "Only exact identity, contact, location, and portfolio field matches were filled.",
          },
        ]
      : []),
    ...(input.manualDecisionLabel
      ? [
          {
            id: `consent_${input.jobId}_manual_follow_up`,
            kind: "manual_follow_up" as const,
            label: input.manualDecisionLabel,
            status: "requested" as const,
            decidedAt: null,
            detail:
              "The runtime paused without making this decision on the user's behalf.",
          },
        ]
      : []),
  ];
}

export function buildPreparationResult(input: {
  // Only the application facts are needed; the callback that fills the form is
  // not one of them.
  executionInput: Omit<ExecuteApplicationFlowInput, "prepareApplicationForm">;
  state?: "paused" | "failed" | "ready";
  summary: string;
  detail: string;
  questions: readonly ApplicationAttemptQuestion[];
  blocker: ApplicationAttemptBlocker | null;
  checkpoints: readonly ApplicationAttemptCheckpoint[];
  checkpointLabel: string;
  checkpointDetail: string;
  checkpointUrls: readonly string[];
  lastUrl: string | null;
  now: string;
  nextActionLabel: string;
  manualDecisionLabel?: string;
  externalWrites?: readonly ApplicationAttemptExternalWriteEvidence[];
  modelUse?: readonly ApplyExecutionModelUse[];
}): ApplyExecutionResult {
  const finalCheckpoint: ApplicationAttemptCheckpoint = {
    id: `checkpoint_${input.executionInput.job.id}_${toStableIdSegment(input.checkpointLabel)}_${input.checkpoints.length + 1}`,
    at: input.now,
    label: input.checkpointLabel,
    detail: input.checkpointDetail,
    state: input.state ?? "paused",
    visualEvidence: [],
  };
  const questions = [...input.questions];

  return ApplyExecutionResultSchema.parse({
    state: input.state ?? "paused",
    summary: input.summary,
    detail: input.detail,
    submittedAt: null,
    outcome: null,
    questions,
    blocker: input.blocker,
    consentDecisions: createPreparationConsentDecisions({
      jobId: input.executionInput.job.id,
      now: input.now,
      questions,
      usesOriginalResume:
        input.executionInput.resumeArtifact.source === "original_upload",
      ...(input.externalWrites ? { externalWrites: input.externalWrites } : {}),
      ...(input.manualDecisionLabel
        ? { manualDecisionLabel: input.manualDecisionLabel }
        : {}),
    }),
    replay: {
      sourceInstructionArtifactId: null,
      sourceDebugEvidenceRefIds: [],
      lastUrl: input.lastUrl,
      checkpointUrls: [...new Set(input.checkpointUrls)],
    },
    visualEvidence: [],
    visualObservationSets: [],
    visualCheckpoints: [],
    nextActionLabel: input.nextActionLabel,
    checkpoints: [...input.checkpoints, finalCheckpoint],
    modelUse: input.modelUse ? [...input.modelUse] : [],
    externalWrites: input.externalWrites
      ? [...input.externalWrites]
      : undefined,
  });
}

