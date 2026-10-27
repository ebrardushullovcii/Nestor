import { createHash } from "node:crypto";
import { readRenderedPageHtml } from "./rendered-page-reader";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import {
  ApplyExecutionResultSchema,
  ApplyVisualCheckpointSchema,
  BrowserVisualEvidenceSummarySchema,
  BrowserVisualSnapshotRefSchema,
  BrowserVisualSnapshotRequestSchema,
  BrowserSessionStateSchema,
  DiscoveryRunResultSchema,
  toJobSearchGoals,
  type ApplicationPageState,
  type ApplicationPageReopenProgress,
  type PreparedApplicationForm,
  type PreparedFormAttachment,
  type ApplyExecutionResult,
  type ApplyExecutionStage,
  type ApplyExecutionTiming,
  type BrowserSessionState,
  type BrowserVisualSnapshotRequest,
  type DiscoveryRunResult,
  type JobPosting,
  type JobSource,
} from "@nestor/contracts";
import type { ApplyRawPageHands } from "@nestor/contracts";
import {
  getAiProviderAccessFailure,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  createApplyPageHands,
  createSearchResultCache,
  readCachedSearchResult,
  runJobSearchAgent,
  type AgentConfig,
  type AgentResult,
  type AgentExtractorPageType,
  type LLMClient,
} from "@nestor/browser-agent";
import type {
  AgentDiscoveryOptions,
  BrowserSessionRuntime,
  PreparedApplicationFormStore,
  ExecuteApplicationFlowInput,
  ExecuteEasyApplyInput,
} from "./runtime-types";
import { ApplicationNavigationError } from "./application-navigation-error";
import {
  capturePreparedForm,
  describePreparedFormAttachments,
  restorePreparedForm,
  type PreparedFormSnapshot,
  type RecoveryFile,
} from "./prepared-form-recovery";
import {
  applicationSiteKey,
  applicationPreparationConcurrency,
  createApplicationPreparationScheduler,
  type ApplicationPreparationLease,
} from "./application-preparation-scheduler";
import { guardApplicationPreparationSession } from "./application-preparation-session";
import { createApplicationSitePacing } from "./application-site-pacing";
import {
  buildPreparationResult,
  createApplicationRunServiceWorkerSentinel,
  ensurePrepareOnlyMutationGuard,
  closePrepareOnlyAuthorizedFormActionWindow,
  closePrepareOnlyFinalActionWindow,
  allowPrepareOnlyRunNavigation,
  openPrepareOnlyFinalActionWindow,
  installServiceWorkerRegisterGuardInPage,
  loadVerifiedResumeBytes,
  type ServiceWorkerSafetyFinding,
} from "./playwright-application-flow";
import {
  armPlaywrightApplicationFormAction,
  createPlaywrightApplyPageMechanics,
  createPlaywrightApplyPageSession,
  readRawApplyPage,
} from "./apply-page-mechanics";
import {
  executeExactlyOneFinalAction as executeExactlyOneFinalActionOnPage,
  observeApplicationForm as observeApplicationFormOnPage,
} from "./application-submission-browser-hands";
import type {
  ExecuteExactlyOneFinalActionInput,
  ObserveApplicationFormOptions,
} from "./application-submission-browser-hands";
import {
  createInconclusiveSourceAccessProbeResult,
  inspectSourceAccessPage,
  selectUniqueSourceAccessPage,
} from "./source-access-probe";
import {
  areStructurallyEquivalentHttpUrls,
  bringPageToFrontBestEffort,
  buildChromeExecutableCandidates,
  buildQuerySummary,
  findRunningChromeDebugPortForUserDataDir,
  isHttpUrlLike,
  isWarmPageReusable,
  isTcpPortReachable,
  pathExists,
  readDevToolsActivePort,
  selectLiveHttpPage,
  validateJobPostings,
} from "./playwright-browser-runtime-utils";

export interface JobPageExtractionInput {
  pageText: string;
  pageUrl: string;
  pageType: "search_results" | "job_detail";
  maxJobs: number;
  /**
   * The person's goals for this page read, so the reader can say which
   * listings do not fit (opaque to the runtime; built by the search agent).
   */
  selectionContext?: string;
  signal?: AbortSignal;
}

export type JobPageExtractor = (
  input: JobPageExtractionInput,
) => Promise<JobPosting[]>;

export function selectPreparedApplicationPage<
  TPage extends Pick<Page, "isClosed">,
>(preparedPages: ReadonlyMap<string, TPage>, pageBindingKey: string): TPage {
  const preparedPage = preparedPages.get(pageBindingKey) ?? null;
  if (!preparedPage) {
    throw new Error("The exact prepared application page is no longer open.");
  }
  if (preparedPage.isClosed()) {
    throw new Error("The prepared application page was closed.");
  }
  return preparedPage;
}

export async function focusPreparedApplicationPage<
  TPage extends Pick<Page, "isClosed" | "bringToFront">,
>(
  preparedPages: ReadonlyMap<string, TPage>,
  pageBindingKey: string,
): Promise<boolean> {
  let page: TPage;
  try {
    page = selectPreparedApplicationPage(preparedPages, pageBindingKey);
  } catch {
    return false;
  }
  await bringPageToFrontBestEffort(page);
  return true;
}

const NAVIGATION_CONNECTION_FAILURE_RE =
  /ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)|\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b/iu;

/** Keep a healthy browser usable when only the requested site is unreachable. */
export function classifyBrowserNavigationFailure(
  detail: string,
): Pick<BrowserSessionState, "status" | "label" | "detail"> {
  if (NAVIGATION_CONNECTION_FAILURE_RE.test(detail)) {
    return {
      status: "ready",
      label: "Browser open",
      detail:
        "The browser is open, but the requested site could not be reached. Check the connection or site, then try again.",
    };
  }
  return {
    status: "blocked",
    label: "Browser navigation failed",
    detail,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// connectOverCDP attaches the persistent default context without accepting
// Playwright's serviceWorkers:"block" context option, so the same hardened
// registration guard Playwright would install for that option is applied
// explicitly before managed flows navigate. The installer hardens both the
// ServiceWorkerContainer prototype and instance non-configurably before site
// scripts run in every document and frame.
const SERVICE_WORKER_BLOCK_INIT_SCRIPT =
  installServiceWorkerRegisterGuardInPage;

const serviceWorkerBlockedContexts = new WeakSet<BrowserContext>();

async function blockServiceWorkersOnManagedContext(
  context: BrowserContext,
): Promise<void> {
  if (serviceWorkerBlockedContexts.has(context)) {
    return;
  }

  serviceWorkerBlockedContexts.add(context);

  // Hosts that do not expose init scripts cannot carry the block; installation
  // failures on capable hosts remain fatal.
  if (typeof context.addInitScript !== "function") {
    return;
  }

  try {
    await context.addInitScript(SERVICE_WORKER_BLOCK_INIT_SCRIPT);
  } catch (error) {
    serviceWorkerBlockedContexts.delete(context);
    throw error;
  }
}

export type ActiveServiceWorkerBlockReason =
  | "active_service_worker_controlling_application_origin"
  | "service_worker_origin_unresolved"
  | "service_worker_inspection_unavailable";

export class ActiveServiceWorkerBlockError extends Error {
  readonly code = "active_service_worker_block" as const;
  readonly reason: ActiveServiceWorkerBlockReason;
  readonly targetUrl: string;
  readonly serviceWorkerUrls: string[];

  constructor(input: {
    reason: ActiveServiceWorkerBlockReason;
    targetUrl: string;
    detail: string;
    serviceWorkerUrls?: string[];
  }) {
    super(input.detail);
    this.name = "ActiveServiceWorkerBlockError";
    this.reason = input.reason;
    this.targetUrl = input.targetUrl;
    this.serviceWorkerUrls = input.serviceWorkerUrls ?? [];
  }
}

function parseHttpOrigin(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function assertRetainedApplicationPageOrigin(
  pageUrl: string,
  input: ExecuteApplicationFlowInput,
): void {
  const observedOrigin = parseHttpOrigin(pageUrl);
  const allowedOrigins = new Set(
    [
      ...(input.applyAllowedOrigins ?? []),
      input.startingUrl,
      input.job.applicationUrl,
      input.job.canonicalUrl,
    ]
      .filter((value): value is string => Boolean(value))
      .map(parseHttpOrigin)
      .filter((value): value is string => value !== null),
  );
  if (!observedOrigin || !allowedOrigins.has(observedOrigin)) {
    throw new Error(
      "The exact prepared application page left the allowed application origins. Prepare the application again before continuing.",
    );
  }
}

function assertNoActiveServiceWorkerControlsApplicationOrigin(input: {
  context: BrowserContext;
  targetUrl: string;
}): void {
  if (typeof input.context.serviceWorkers !== "function") {
    throw new ActiveServiceWorkerBlockError({
      reason: "service_worker_inspection_unavailable",
      targetUrl: input.targetUrl,
      detail: `Active service workers could not be inspected on the managed browser context before opening ${input.targetUrl}. Reset the dedicated browser profile from Safeguards, then finish this application manually.`,
    });
  }

  let activeWorkers;
  try {
    activeWorkers = input.context.serviceWorkers();
  } catch (error) {
    throw new ActiveServiceWorkerBlockError({
      reason: "service_worker_inspection_unavailable",
      targetUrl: input.targetUrl,
      detail: `Active service workers could not be inspected on the managed browser context before opening ${input.targetUrl}: ${
        error instanceof Error ? error.message : "unknown inspection error"
      }. Reset the dedicated browser profile from Safeguards, then finish this application manually.`,
    });
  }

  const targetOrigin = parseHttpOrigin(input.targetUrl);
  if (!targetOrigin) {
    throw new ActiveServiceWorkerBlockError({
      reason: "service_worker_origin_unresolved",
      targetUrl: input.targetUrl,
      detail: `The application origin for ${input.targetUrl} could not be safely determined while active browser service workers exist. Reset the dedicated browser profile from Safeguards, then finish this application manually.`,
    });
  }

  const controllingWorkerUrls: string[] = [];
  const unresolvedWorkerUrls: string[] = [];
  for (const worker of activeWorkers) {
    const workerUrl = worker.url();
    const workerOrigin = parseHttpOrigin(workerUrl);
    if (!workerOrigin) {
      unresolvedWorkerUrls.push(workerUrl);
    } else if (workerOrigin === targetOrigin) {
      controllingWorkerUrls.push(workerUrl);
    }
  }

  if (controllingWorkerUrls.length > 0) {
    throw new ActiveServiceWorkerBlockError({
      reason: "active_service_worker_controlling_application_origin",
      targetUrl: input.targetUrl,
      detail: `An active service worker (${controllingWorkerUrls.join(", ")}) can control the application origin ${targetOrigin}. Close or reset the dedicated browser profile so the worker stops, then finish this application manually; automated preparation stays stopped.`,
      serviceWorkerUrls: controllingWorkerUrls,
    });
  }

  if (unresolvedWorkerUrls.length > 0) {
    throw new ActiveServiceWorkerBlockError({
      reason: "service_worker_origin_unresolved",
      targetUrl: input.targetUrl,
      detail: `An active service worker (${unresolvedWorkerUrls.join(", ")}) has an origin that cannot be safely determined relative to ${targetOrigin}. Reset the dedicated browser profile from Safeguards, then finish this application manually.`,
      serviceWorkerUrls: unresolvedWorkerUrls,
    });
  }
}

function buildServiceWorkerSafetyStopResult(input: {
  executionInput: ExecuteApplicationFlowInput;
  finding: ServiceWorkerSafetyFinding;
}): ApplyExecutionResult {
  const targetUrl =
    input.executionInput.job.applicationUrl ??
    input.executionInput.job.canonicalUrl;
  const detail = `${input.finding.detail} The runtime stopped before any further field or click action and left every service-worker registration untouched. Reset the dedicated browser profile from Safeguards, then finish this application manually.`;
  return buildPreparationResult({
    executionInput: input.executionInput,
    summary: "A service worker can influence this application origin",
    detail,
    questions: [],
    blocker: {
      code: "requires_manual_review",
      summary: "A service worker can influence this application origin.",
      detail,
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: isHttpUrlLike(targetUrl) ? targetUrl : null,
    },
    checkpoints: [],
    checkpointLabel: "Paused for an application-origin service worker",
    checkpointDetail: detail,
    checkpointUrls: isHttpUrlLike(targetUrl) ? [targetUrl] : [],
    lastUrl: isHttpUrlLike(targetUrl) ? targetUrl : null,
    now: new Date().toISOString(),
    nextActionLabel:
      "Reset the browser profile, then finish this application manually",
  });
}

async function markManagedChromeProfileExitedCleanly(
  userDataDir: string,
): Promise<void> {
  const preferencesPath = join(userDataDir, "Default", "Preferences");
  let preferencesText: string;

  try {
    preferencesText = await readFile(preferencesPath, "utf8");
  } catch {
    return;
  }

  try {
    const preferences: unknown = JSON.parse(preferencesText);
    if (!isJsonRecord(preferences)) {
      return;
    }

    const existingProfile = isJsonRecord(preferences.profile)
      ? preferences.profile
      : {};
    if (
      existingProfile.exit_type === "Normal" &&
      existingProfile.exited_cleanly === true
    ) {
      return;
    }

    const temporaryPath = `${preferencesPath}.nestor-clean-exit-${process.pid}`;
    await writeFile(
      temporaryPath,
      JSON.stringify({
        ...preferences,
        profile: {
          ...existingProfile,
          exit_type: "Normal",
          exited_cleanly: true,
        },
      }),
      "utf8",
    );
    try {
      await rename(temporaryPath, preferencesPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  } catch {
    // A malformed or temporarily locked Preferences file must not block the browser.
  }
}

export function createAgentChatWithToolsBridge(
  chatWithTools: NonNullable<JobFinderAiClient["chatWithTools"]>,
): LLMClient {
  return {
    chatWithTools,
  };
}

/**
 * ADR 0013 compact-first discovery can finish without model tools. When the
 * configured client lacks `chatWithTools`, keep a rejecting stub so escalation
 * fails with the same honest warning instead of skipping the page scan.
 */
export function resolveAgentDiscoveryChatWithTools(
  chatWithTools: JobFinderAiClient["chatWithTools"] | undefined,
): NonNullable<JobFinderAiClient["chatWithTools"]> {
  return (
    chatWithTools ??
    (() =>
      Promise.reject(
        new Error(
          "AI client does not support tool calling. Cannot run agent discovery.",
        ),
      ))
  );
}

function buildUnsupportedApplyResult(input: {
  job: ExecuteEasyApplyInput["job"];
  startedAt: string;
  mode: "easy_apply" | ExecuteApplicationFlowInput["mode"];
  targetUrl?: string | null;
  visualEvidence?: ApplyExecutionResult["visualEvidence"];
  visualObservationSets?: ApplyExecutionResult["visualObservationSets"];
  visualCheckpoints?: ApplyExecutionResult["visualCheckpoints"];
}): ApplyExecutionResult {
  const targetUrl =
    input.targetUrl ?? input.job.applicationUrl ?? input.job.canonicalUrl;
  const prepareOnly = input.mode === "prepare_only";

  return ApplyExecutionResultSchema.parse({
    state: "unsupported",
    summary: "Apply automation is not available for generic target flows",
    detail: prepareOnly
      ? `The current runtime does not yet support review-safe apply preparation for '${input.job.title}'. Use the learned target guidance to continue manually.`
      : `The current runtime does not submit applications automatically for '${input.job.title}'. Use the learned target guidance to continue manually.`,
    submittedAt: null,
    outcome: null,
    questions: [],
    blocker: {
      code: "unsupported_apply_path",
      summary: prepareOnly
        ? "The generic runtime does not support review-safe apply preparation."
        : "The generic runtime does not support automated application submission.",
      detail:
        "Use the learned target guidance to continue this application manually.",
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: targetUrl,
    },
    consentDecisions: [],
    replay: {
      sourceInstructionArtifactId: null,
      sourceDebugEvidenceRefIds: [],
      lastUrl: targetUrl,
      checkpointUrls: targetUrl ? [targetUrl] : [],
    },
    visualEvidence: input.visualEvidence ?? [],
    visualObservationSets: input.visualObservationSets ?? [],
    visualCheckpoints: input.visualCheckpoints ?? [],
    nextActionLabel: "Open the listing manually",
    checkpoints: [
      {
        id: `checkpoint_${input.job.id}_generic_apply_unsupported`,
        at: input.startedAt,
        label: "Apply automation unavailable",
        detail: prepareOnly
          ? "This target uses the generic debugger flow, so application preparation and submission stay manual until a target-agnostic runtime exists."
          : "This target uses the generic debugger flow, so submission stays manual until a target-agnostic apply runtime exists.",
        state: "unsupported",
        visualEvidence: input.visualEvidence ?? [],
      },
    ],
  });
}

async function buildApplyVisualDiagnostics(input: {
  job: ExecuteApplicationFlowInput["job"];
  mode: ExecuteApplicationFlowInput["mode"];
  targetUrl: string | null;
  captureVisualSnapshot?: ExecuteApplicationFlowInput["captureVisualSnapshot"];
  analyzeVisualSnapshot?: ExecuteApplicationFlowInput["analyzeVisualSnapshot"];
}): Promise<{
  visualEvidence: NonNullable<ApplyExecutionResult["visualEvidence"]>;
  visualObservationSets: NonNullable<
    ApplyExecutionResult["visualObservationSets"]
  >;
  visualCheckpoints: NonNullable<ApplyExecutionResult["visualCheckpoints"]>;
}> {
  if (!input.captureVisualSnapshot || !input.analyzeVisualSnapshot) {
    return {
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
    };
  }

  try {
    const snapshot = await input.captureVisualSnapshot({
      purpose: "apply_checkpoint",
      mode: "viewport",
      label: "Apply page visual checkpoint",
      reason:
        "Classify visible application page state before stopping the safe non-submitting apply flow.",
      region: null,
      retention: {
        retention: "temporary",
        redactionLevel: "sensitive",
        reason:
          "Temporary apply visual analysis input; screenshots are not persisted by default.",
        expiresAt: null,
      },
    });
    const observationSet = await input.analyzeVisualSnapshot({
      snapshot,
      context: {
        purpose: "apply_checkpoint",
        taskGoal:
          "Classify visible application form state, blockers, field/control hints, validation errors, and recovery context without directing browser actions.",
        pageUrl: snapshot.url ?? input.targetUrl,
        pageTitle: snapshot.pageTitle,
        visibleTextSample: null,
        domSignals: [
          input.mode === "prepare_only"
            ? "Safe apply flow is running in prepare-only mode."
            : "Safe apply flow is not authorized for live final submit.",
        ],
        sourceDebug: null,
        apply: {
          jobTitle: input.job.title,
          company: input.job.company,
          checkpointLabel: "Apply page visual checkpoint",
          recoveryMode: false,
        },
      },
    });
    const summary =
      observationSet.summary ??
      observationSet.blockers[0] ??
      observationSet.fieldControls[0] ??
      observationSet.validationErrors[0] ??
      observationSet.recoveryNotes[0] ??
      "Visual apply checkpoint captured no strong visible blocker.";
    const evidence = BrowserVisualEvidenceSummarySchema.parse({
      snapshotId: snapshot.id,
      observationSetId: observationSet.id,
      summary,
      capturedAt: snapshot.capturedAt,
      storagePath: snapshot.storagePath,
      retention: snapshot.retention.retention,
      redactionLevel: snapshot.retention.redactionLevel,
      confidence:
        observationSet.observations[0]?.confidence ??
        observationSet.reconciliations[0]?.confidence ??
        0.6,
      reconciliationStatus: observationSet.reconciliations[0]?.status ?? null,
    });
    const checkpoint = ApplyVisualCheckpointSchema.parse({
      id: `apply_visual_checkpoint_${input.job.id}_${snapshot.id}`,
      label: "Apply page visual checkpoint",
      purpose: snapshot.purpose,
      snapshotId: snapshot.id,
      observationSetId: observationSet.id,
      summary,
      capturedAt: snapshot.capturedAt,
      retained: snapshot.retention.retention !== "temporary",
      storagePath: snapshot.storagePath,
      blockers: observationSet.blockers,
      fieldControls: observationSet.fieldControls,
      validationErrors: observationSet.validationErrors,
      buttonStates: observationSet.buttonStates,
      questionContextIds: observationSet.questionContexts.map(
        (context) => context.id,
      ),
      reconciliations: observationSet.reconciliations,
    });

    return {
      visualEvidence: [evidence],
      visualObservationSets: [observationSet],
      visualCheckpoints: [checkpoint],
    };
  } catch {
    // Return empty results instead of fabricated evidence with dangling IDs
    return {
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
    };
  }
}

export interface BrowserAgentRuntimeOptions {
  userDataDir: string;
  /** Rebind native tab ownership after a verified, model-free refill. */
  onApplicationPageRestored?(key: string, page: Page, label?: string): Promise<void>;
  preparedFormStore?: PreparedApplicationFormStore;
  /** Host-owned pages, for example a desktop application's embedded browser. */
  browserHost?: {
    connect(): Promise<Browser>;
    getOpenBrowser(): Promise<Browser | null>;
    close(): Promise<void>;
    assertAutomationSafe(): void | Promise<void>;
    /**
     * Every tab the host has open, including the person's own tabs that
     * automation never sees. The host's tab limit counts those too.
     */
    openTabCount?(): number;
    /** Waiting forms are excluded from the host's working slots. */
    workingTabCount?(): number;
    hasAutomationTabCapacity?(reservedTabs?: number): boolean;
  };
  headless?: boolean;
  maxJobsPerRun?: number;
  chromeExecutablePath?: string;
  debugPort?: number;
  jobExtractor?: JobPageExtractor;
  aiClient?: JobFinderAiClient;
}

interface ManagedBrowserWindowBounds {
  height: number;
  width: number;
  x?: number;
  y?: number;
  windowState?: "normal" | "minimized" | "maximized" | "fullscreen";
}

async function resolveChromeExecutable(explicitPath?: string): Promise<string> {
  for (const candidate of buildChromeExecutableCandidates(explicitPath)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "A Chrome executable was not found for the dedicated browser agent. Set NESTOR_CHROME_PATH to a local Chrome installation.",
  );
}

async function getDebuggerWebSocketUrl(
  debugPort: number,
): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const webSocketDebuggerUrl = payload.webSocketDebuggerUrl;
    return typeof webSocketDebuggerUrl === "string" &&
      /^wss?:\/\//iu.test(webSocketDebuggerUrl)
      ? webSocketDebuggerUrl
      : null;
  } catch {
    return null;
  }
}

async function isDebuggerEndpointReady(debugPort: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });

    return response.ok;
  } catch {
    return false;
  }
}

function normalizeUserDataDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function createVisualSnapshotId(): string {
  return `visual_snapshot_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function createVisualSnapshotFileName(snapshotId: string): string {
  return `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
}

function createVisualSnapshotMetadataFileName(snapshotId: string): string {
  return `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

function getVisualSnapshotArtifactDir(userDataDir: string): string {
  return join(userDataDir, "visual-snapshots");
}

async function cleanupExpiredVisualSnapshots(input: {
  artifactDir: string;
  nowMs?: number;
  maxAgeMs?: number;
  maxFiles?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxFiles = input.maxFiles ?? 200;

  try {
    const entries = await readdir(input.artifactDir, { withFileTypes: true });
    const pngEntries = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
        .map(async (entry) => {
          const path = join(input.artifactDir, entry.name);
          const metadataPath = join(
            input.artifactDir,
            `${entry.name.slice(0, -4)}.json`,
          );
          try {
            const stats = await stat(path);
            const expiresAtMs = await readFile(metadataPath, "utf8")
              .then((content) => {
                const payload = JSON.parse(content) as { expiresAt?: unknown };
                return typeof payload.expiresAt === "string"
                  ? Date.parse(payload.expiresAt)
                  : Number.NaN;
              })
              .catch(() => Number.NaN);
            return { path, metadataPath, mtimeMs: stats.mtimeMs, expiresAtMs };
          } catch {
            return null;
          }
        }),
    );
    const files = pngEntries
      .filter(
        (
          entry,
        ): entry is {
          path: string;
          metadataPath: string;
          mtimeMs: number;
          expiresAtMs: number;
        } => entry !== null,
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const expired = files.filter((entry) => {
      if (Number.isFinite(entry.expiresAtMs)) {
        return entry.expiresAtMs <= nowMs;
      }

      return nowMs - entry.mtimeMs > maxAgeMs;
    });
    const overflow = files.slice(maxFiles);
    const pathsToDelete = new Set<string>();
    [...expired, ...overflow].forEach((entry) => {
      pathsToDelete.add(entry.path);
      pathsToDelete.add(entry.metadataPath);
    });

    await Promise.all(
      [...pathsToDelete].map((path) =>
        rm(path, { force: true }).catch(() => {}),
      ),
    );
  } catch {
    // Retention cleanup is best-effort and must never block browser work.
  }
}

async function safePageTitle(page: Page): Promise<string | null> {
  try {
    const title = await page.title();
    return title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

function safePageUrl(page: Page): string | null {
  try {
    const url = page.url();
    if (!url || url === "about:blank") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function isDebuggerEndpointOwnedByUserDataDir(
  debugPort: number,
  userDataDir: string,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const normalizedUserDataDir = normalizeUserDataDir(userDataDir);
    const candidateUserDataDirs = [
      payload.userDataDir,
      payload.userDataDirPath,
      payload.browserUserDataDir,
      payload["User-Data-Dir"],
    ].flatMap((value) =>
      typeof value === "string" && value.trim().length > 0 ? [value] : [],
    );

    return candidateUserDataDirs.some(
      (candidate) => normalizeUserDataDir(candidate) === normalizedUserDataDir,
    );
  } catch {
    return false;
  }
}

async function resolveBrowserDebugPort(
  preferredDebugPort: number,
  userDataDir: string,
): Promise<number> {
  const runningDebugPortForUserDataDir =
    await findRunningChromeDebugPortForUserDataDir(userDataDir);

  if (
    runningDebugPortForUserDataDir !== null &&
    (await isDebuggerEndpointReady(runningDebugPortForUserDataDir))
  ) {
    return runningDebugPortForUserDataDir;
  }

  const activeDebugPortFromProfile = await readDevToolsActivePort(userDataDir);

  if (
    activeDebugPortFromProfile !== null &&
    (await isDebuggerEndpointReady(activeDebugPortFromProfile))
  ) {
    return activeDebugPortFromProfile;
  }

  if (!(await isTcpPortReachable(preferredDebugPort))) {
    return preferredDebugPort;
  }

  if (!(await isDebuggerEndpointReady(preferredDebugPort))) {
    for (
      let candidatePort = preferredDebugPort + 1;
      candidatePort < preferredDebugPort + 20;
      candidatePort += 1
    ) {
      if (!(await isTcpPortReachable(candidatePort))) {
        return candidatePort;
      }
    }

    throw new Error(
      `Remote debugging port ${preferredDebugPort} is occupied by a non-Chrome process. Close that process or set NESTOR_CHROME_DEBUG_PORT to a free port.`,
    );
  }

  if (
    await isDebuggerEndpointOwnedByUserDataDir(preferredDebugPort, userDataDir)
  ) {
    return preferredDebugPort;
  }

  for (
    let candidatePort = preferredDebugPort + 1;
    candidatePort < preferredDebugPort + 20;
    candidatePort += 1
  ) {
    if (!(await isTcpPortReachable(candidatePort))) {
      return candidatePort;
    }
  }

  throw new Error(
    `Remote debugging port ${preferredDebugPort} is already serving another browser session. Close that browser or set NESTOR_CHROME_DEBUG_PORT to a free port.`,
  );
}

async function waitForDebuggerEndpoint(
  debugPort: number,
  chromeProcess?: ChildProcess | null,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  let windowsLauncherExitedAt: number | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (await isDebuggerEndpointReady(debugPort)) {
      return;
    }

    if (
      chromeProcess &&
      chromeProcess.exitCode !== null &&
      process.platform !== "win32"
    ) {
      throw new Error(
        `Chrome exited before the remote debugging endpoint on port ${debugPort} became ready.`,
      );
    }

    if (chromeProcess?.exitCode !== null && process.platform === "win32") {
      windowsLauncherExitedAt ??= Date.now();
      if (Date.now() - windowsLauncherExitedAt >= 5_000) {
        throw new Error(
          `Chrome exited before the remote debugging endpoint on port ${debugPort} became ready.`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Chrome started but the remote debugging endpoint on port ${debugPort} did not become ready within ${timeoutMs}ms.`,
  );
}

async function getPrimaryPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  const openPages = pages.filter((page) => !page.isClosed());
  return openPages[openPages.length - 1] ?? context.newPage();
}

function areExactHttpUrls(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  try {
    const leftUrl = new URL(left ?? "");
    const rightUrl = new URL(right ?? "");
    return (
      (leftUrl.protocol === "http:" || leftUrl.protocol === "https:") &&
      leftUrl.toString() === rightUrl.toString()
    );
  } catch {
    return false;
  }
}

async function navigatePageToTarget(input: {
  page: Page;
  targetUrl: string;
  timeout?: number;
  requireExactTarget?: boolean;
}): Promise<boolean> {
  const alreadyAtTarget = input.requireExactTarget
    ? areExactHttpUrls(input.page.url(), input.targetUrl)
    : areStructurallyEquivalentHttpUrls(input.page.url(), input.targetUrl);
  if (alreadyAtTarget) {
    return false;
  }

  allowPrepareOnlyRunNavigation(input.page, input.targetUrl);
  await input.page.goto(input.targetUrl, {
    waitUntil: "domcontentloaded",
    ...(input.timeout ? { timeout: input.timeout } : {}),
  });

  return true;
}

async function resolveLivePageForContext(
  context: BrowserContext,
  options?: { bringToFront?: boolean },
): Promise<Page> {
  const bringToFront = options?.bringToFront !== false;
  const currentPages = context.pages();
  const liveHttpPage = selectLiveHttpPage(currentPages);
  const page = liveHttpPage ?? (await getPrimaryPage(context));

  if (bringToFront) {
    await bringPageToFrontBestEffort(page);
  }
  return page;
}

export async function resolveAutomationPageForContext(
  context: BrowserContext,
  options: {
    targetUrl?: string | null;
    bringToFront?: boolean;
    closeOtherPages?: boolean;
    reuseExistingPage?: boolean;
    protectedPageUrls?: readonly string[];
    protectedPages?: readonly Page[];
    preferredPage?: Page | null;
    requireExactTarget?: boolean;
    onPageResolved?: (page: Page) => void | Promise<void>;
  } = {},
): Promise<Page> {
  const normalizedTargetUrl =
    typeof options.targetUrl === "string" ? options.targetUrl.trim() : "";
  const currentPages = context.pages();
  const openPages = currentPages.filter((page) => !page.isClosed());
  const preferredTargetPage =
    options.preferredPage &&
    openPages.includes(options.preferredPage) &&
    areExactHttpUrls(options.preferredPage.url(), normalizedTargetUrl)
      ? options.preferredPage
      : null;
  const protectedPages = new Set(
    openPages.filter(
      (page) =>
        page !== preferredTargetPage &&
        ((options.protectedPages ?? []).includes(page) ||
          (options.protectedPageUrls ?? []).some((url) =>
            areStructurallyEquivalentHttpUrls(page.url(), url),
          )),
    ),
  );
  const selectablePages = openPages.filter((page) => !protectedPages.has(page));
  const exactTargetPage = isHttpUrlLike(normalizedTargetUrl)
    ? selectablePages.find((page) =>
        options.requireExactTarget
          ? areExactHttpUrls(page.url(), normalizedTargetUrl)
          : areStructurallyEquivalentHttpUrls(page.url(), normalizedTargetUrl),
      )
    : null;
  const blankPage =
    selectablePages.find((page) => !isHttpUrlLike(page.url())) ?? null;
  const reusableLivePage = selectLiveHttpPage(selectablePages);
  const page =
    options.reuseExistingPage === false
      ? await context.newPage()
      : (preferredTargetPage ??
        exactTargetPage ??
        blankPage ??
        reusableLivePage ??
        (await context.newPage()));
  await options.onPageResolved?.(page);

  if (options.closeOtherPages && options.reuseExistingPage !== false) {
    await Promise.allSettled(
      openPages
        .filter(
          (candidate) => candidate !== page && !protectedPages.has(candidate),
        )
        .map(async (candidate) => candidate.close()),
    );
  }

  if (options.bringToFront !== false) {
    await bringPageToFrontBestEffort(page);
  }

  return page;
}

async function prepareAutomationPageForTarget(
  context: BrowserContext,
  options: {
    targetUrl: string;
    setBlockedState: (detail: string) => void;
    bringToFront?: boolean;
    navigationTimeoutMs?: number;
    acceptTargetOriginAfterTimeout?: boolean;
    closeOtherPages?: boolean;
    reuseExistingPage?: boolean;
    protectedPageUrls?: readonly string[];
    protectedPages?: readonly Page[];
    preferredPage?: Page | null;
    requireExactTarget?: boolean;
    signal?: AbortSignal;
    onPageResolved?: (page: Page) => void | Promise<void>;
  },
): Promise<{
  page: Page;
  alreadyAtTarget: boolean;
  navigatedToTarget: boolean;
}> {
  options.signal?.throwIfAborted();
  const page = await resolveAutomationPageForContext(context, {
    targetUrl: options.targetUrl,
    bringToFront: false,
    ...(options.reuseExistingPage !== undefined
      ? { reuseExistingPage: options.reuseExistingPage }
      : {}),
    ...(options.closeOtherPages !== undefined
      ? { closeOtherPages: options.closeOtherPages }
      : {}),
    ...(options.protectedPageUrls
      ? { protectedPageUrls: options.protectedPageUrls }
      : {}),
    ...(options.protectedPages
      ? { protectedPages: options.protectedPages }
      : {}),
    ...(options.preferredPage ? { preferredPage: options.preferredPage } : {}),
    ...(options.requireExactTarget !== undefined
      ? { requireExactTarget: options.requireExactTarget }
      : {}),
    ...(options.onPageResolved
      ? { onPageResolved: options.onPageResolved }
      : {}),
  });
  options.signal?.throwIfAborted();
  const alreadyAtTarget = options.requireExactTarget
    ? areExactHttpUrls(page.url(), options.targetUrl)
    : areStructurallyEquivalentHttpUrls(page.url(), options.targetUrl);
  let navigatedToTarget = false;

  if (!alreadyAtTarget) {
    try {
      navigatedToTarget = await navigatePageToTarget({
        page,
        targetUrl: options.targetUrl,
        ...(options.navigationTimeoutMs
          ? { timeout: options.navigationTimeoutMs }
          : {}),
        ...(options.requireExactTarget !== undefined
          ? { requireExactTarget: options.requireExactTarget }
          : {}),
      });
      options.signal?.throwIfAborted();
    } catch (error) {
      const timeoutReached =
        error instanceof Error && error.name === "TimeoutError";
      const targetOriginReached = (() => {
        try {
          return (
            new URL(page.url()).origin === new URL(options.targetUrl).origin
          );
        } catch {
          return false;
        }
      })();

      if (
        timeoutReached &&
        options.acceptTargetOriginAfterTimeout === true &&
        targetOriginReached
      ) {
        navigatedToTarget = true;
      } else {
        const detail =
          error instanceof Error
            ? error.message
            : `The dedicated browser profile could not open ${options.targetUrl}.`;
        options.setBlockedState(detail);
        // Classify once at the goto boundary so consumers can separate
        // "the employer page never opened" from every other failure mode.
        throw new ApplicationNavigationError({
          targetUrl: options.targetUrl,
          diagnosticDetail: detail,
          ...(error instanceof Error ? { cause: error } : {}),
        });
      }
    }
  }

  if (options.bringToFront !== false) {
    await bringPageToFrontBestEffort(page);
  }

  return {
    page,
    alreadyAtTarget,
    navigatedToTarget,
  };
}

const pendingEmbeddedApplicationTabs = new WeakMap<BrowserContext, number>();

/** Takes a tab now if the browser has room; never waits. */
export function takeEmbeddedApplicationTab(
  context: BrowserContext,
  hostTabCount?: () => number,
  hostWorkingTabCount?: () => number,
  hostHasCapacity?: (reservedTabs: number) => boolean,
  spareWorkingTabs = 0,
): (() => void) | null {
  const pending = pendingEmbeddedApplicationTabs.get(context) ?? 0;
  const occupied =
    Math.max(
      context.pages().filter((page) => !page.isClosed()).length,
      hostTabCount?.() ?? 0,
    ) + pending;
  const working = hostWorkingTabCount
    ? hostWorkingTabCount() + pending
    : occupied;
  // The native host owns its capacity, including tabs hidden from CDP.
  // Keep the old bounded fallback only for hosts without that capability.
  if (
    !(hostHasCapacity
      ? hostHasCapacity(pending + spareWorkingTabs)
      : working < 7 && occupied < (hostWorkingTabCount ? 15 : 7))
  )
    return null;
  pendingEmbeddedApplicationTabs.set(context, pending + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (pendingEmbeddedApplicationTabs.get(context) ?? 1) - 1;
    if (remaining > 0) pendingEmbeddedApplicationTabs.set(context, remaining);
    else pendingEmbeddedApplicationTabs.delete(context);
  };
}

export async function reserveEmbeddedApplicationTab(
  context: BrowserContext,
  signal?: AbortSignal,
  closeIdlePage?: () => Promise<boolean>,
  /**
   * Told once when the browser is full and this application waits for a
   * tab. Without it the wait is bounded and ends in "close a tab" (old
   * callers); with it the application waits until a tab frees or it is
   * stopped, and the caller says so on the application.
   */
  onWaiting?: () => void,
  /** The host's own count of open tabs, when it has tabs automation cannot see. */
  hostTabCount?: () => number,
  hostWorkingTabCount?: () => number,
  hostHasCapacity?: (reservedTabs: number) => boolean,
  /** Native working slots left for other workflows when admitting a search. */
  spareWorkingTabs = 0,
): Promise<() => void> {
  // Reserve atomically before creating a page. Native hosts account for their
  // own working/retained tabs; older hosts retain the conservative fallback.
  const startedAt = Date.now();
  const deadline = startedAt + 20_000;
  let toldWaiting = false;
  while (true) {
    signal?.throwIfAborted();
    const release = takeEmbeddedApplicationTab(
      context,
      hostTabCount,
      hostWorkingTabCount,
      hostHasCapacity,
      spareWorkingTabs,
    );
    if (release) return release;
    // An empty tab nobody uses (the browser's startup tab) is not worth a
    // form: close it before waiting on the person.
    if (closeIdlePage && (await closeIdlePage())) continue;
    if (onWaiting) {
      if (!toldWaiting && Date.now() - startedAt >= 2_000) {
        toldWaiting = true;
        onWaiting();
      }
    } else if (Date.now() >= deadline)
      throw new Error("Close a browser tab before opening another one.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 250);
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Binds Stop to the currently resolved page, including during navigation. */
export function createDiscoveryPageAbortBinding(signal?: AbortSignal): {
  dispose: () => void;
  onPageResolved: (page: Page) => void;
} {
  let page: Page | null = null;
  const closePageOnAbort = () => {
    if (page && !page.isClosed()) {
      void page.close().catch(() => undefined);
    }
  };
  signal?.addEventListener("abort", closePageOnAbort, { once: true });

  return {
    dispose: () => signal?.removeEventListener("abort", closePageOnAbort),
    onPageResolved: (resolvedPage) => {
      page = resolvedPage;
      if (signal?.aborted) {
        closePageOnAbort();
      }
    },
  };
}

/**
 * How long a prepared page stays open to the person's own submit after they
 * open it to finish it themselves. Job Finder locks it again as soon as it
 * works on that page.
 */
const PERSON_HANDOFF_WINDOW_MS = 12 * 60 * 60 * 1000;

export function createBrowserAgentRuntime(
  options: BrowserAgentRuntimeOptions,
): BrowserSessionRuntime {
  const searchResultCache = createSearchResultCache();
  const debugPort = options.debugPort ?? 9333;
  let activeDebugPort = debugPort;
  const jobExtractor = options.jobExtractor;
  const runtimeAiClient = options.aiClient ?? null;
  let browserPromise: Promise<Browser> | null = null;
  let launchedChromeProcess: ChildProcess | null = null;
  let ownsChromeProcess = false;
  const applicationPreparationScheduler = createApplicationPreparationScheduler(
    applicationPreparationConcurrency(
      process.env.NESTOR_APPLICATION_PREPARATION_CONCURRENCY,
    ),
  );
  const usesEmbeddedBrowserHost = Boolean(options.browserHost);
  const applicationSitePacing = createApplicationSitePacing(
    applicationPreparationScheduler,
  );
  const hostTabCount = options.browserHost?.openTabCount?.bind(
    options.browserHost,
  );
  const hostWorkingTabCount = options.browserHost?.workingTabCount?.bind(
    options.browserHost,
  );
  const hostHasCapacity = options.browserHost?.hasAutomationTabCapacity?.bind(
    options.browserHost,
  );
  // A person can prepare several Ask-before-sending forms or open unrelated
  // tabs. Keep every final action bound to its exact preparation identity.
  const preparedApplicationPages = new Map<string, Page>();
  // Every prepared page carries its own binding key (a window variable and
  // the tab's sessionStorage, which survives same-origin navigation). A
  // takeover or pause drops the automation connection, and every Page handle
  // with it, while the tab itself stays open on the filled form; the key the
  // tab carries finds that exact tab again. No URL is ever compared.
  const PREPARED_PAGE_MARK = "__nestorPreparedApplication";
  // Pages a run is working in right now. A host may share one browser
  // between runs (the desktop app searches several sources and fills an
  // application at once); a run must never reuse, navigate or close a page
  // another run is using.
  const pagesInUse = new Map<Page, number>();
  function usePage(page: Page): () => void {
    pagesInUse.set(page, (pagesInUse.get(page) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (pagesInUse.get(page) ?? 1) - 1;
      if (count <= 0) pagesInUse.delete(page);
      else pagesInUse.set(page, count);
    };
  }
  const pagesInUseByOtherRuns = (): Page[] =>
    [...pagesInUse.keys()].filter((page) => !page.isClosed());
  const markedPreparedApplicationKeys = new Set<string>();
  // Prepared pages the person was handed to finish themselves, until the
  // next continuation or send locks them again.
  const preparedPagesWithPerson = new Set<string>();
  const preparedFormStore = options.preparedFormStore;
  const formRecovery = new Map<
    string,
    {
      files: RecoveryFile[];
      /** Durable identities of `files`, for any later save of this form. */
      attachments: PreparedFormAttachment[];
      guard: (page: Page) => Promise<unknown>;
      snapshot?: PreparedFormSnapshot;
      saved?: PreparedApplicationForm;
      /** The caller can refill this form, so its page may close without a snapshot. */
      refillable?: boolean;
    }
  >();
  const recoveryUnavailable = new Set<string>();
  const recoveringForms = new Map<string, Promise<void>>();

  async function loadSavedForm(key: string): Promise<PreparedApplicationForm | null> {
    const saved = await preparedFormStore?.get(key) ?? null;
    if (saved?.snapshot && !formRecovery.has(key)) {
      formRecovery.set(key, {
        snapshot: saved.snapshot,
        saved,
        attachments: saved.attachments,
        files: saved.attachments.map(file => ({name: file.name, load: async () => {
          const bytes = await preparedFormStore!.loadAttachment(file);
          if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
            throw new Error("Attachment changed");
          return bytes;
        }})),
        // Recovery does not inherit any old send or intermediate-write window.
        guard: page => ensurePrepareOnlyMutationGuard(page, false),
      });
    }
    return saved;
  }

  async function invalidateSavedForm(key: string, reason: "form_changed" | "attachment_unavailable") {
    const saved = await preparedFormStore?.get(key);
    if (saved) await preparedFormStore!.save({...saved, snapshot: null, attachments: [], reason});
    formRecovery.delete(key);
  }

  async function applicationPageState(key: string): Promise<ApplicationPageState> {
    const live = preparedApplicationPages.get(key);
    if (live && !live.isClosed()) return {resultId: key, state: "open", reason: null};
    const saved = await loadSavedForm(key);
    if (formRecovery.get(key)?.snapshot) {
      try {
        for (const file of formRecovery.get(key)!.files) await file.load();
      } catch {
        await invalidateSavedForm(key, "attachment_unavailable");
        return {resultId: key, state: "needs_preparing", reason: "attachment_unavailable"};
      }
      return {resultId: key, state: "reopenable", reason: null};
    }
    return {resultId: key, state: "needs_preparing", reason: saved?.reason ?? "no_snapshot"};
  }

  async function markPreparedPage(key: string, page: Page): Promise<void> {
    if (typeof page.evaluate !== "function") return;
    await page
      .evaluate(
        ({ mark, value }) => {
          (window as unknown as Record<string, unknown>)[mark] = value;
          try {
            window.sessionStorage.setItem(mark, value);
          } catch {
            // Storage can be unavailable on some pages; the variable stays.
          }
        },
        { mark: PREPARED_PAGE_MARK, value: key },
      )
      .catch(() => undefined);
  }

  async function readPreparedPageMark(page: Page): Promise<string | null> {
    if (typeof page.evaluate !== "function") return null;
    return page
      .evaluate((mark) => {
        const value = (window as unknown as Record<string, unknown>)[mark];
        if (typeof value === "string") return value;
        try {
          return window.sessionStorage.getItem(mark);
        } catch {
          return null;
        }
      }, PREPARED_PAGE_MARK)
      .catch(() => null);
  }

  function bindPreparedApplicationPage(key: string, page: Page): void {
    const alreadyBound = preparedApplicationPages.get(key) === page;
    preparedApplicationPages.set(key, page);
    markedPreparedApplicationKeys.add(key);
    void markPreparedPage(key, page);
    if (alreadyBound) return;
    page.once?.("close", () => {
      if (preparedApplicationPages.get(key) !== page) return;
      preparedApplicationPages.delete(key);
      // CDP detachment also closes Playwright's Page while the native tab
      // remains with the person. Keep its marker until native destruction.
    });
  }

  /**
   * Finds the exact tab of a prepared application again after the automation
   * connection was dropped (the person took over or paused the browser), by
   * the key that tab carries, and only on a browser that is already open.
   */
  async function rebindPreparedApplicationPage(key: string,
    onProgress?: (progress: ApplicationPageReopenProgress) => void): Promise<void> {
    const current = preparedApplicationPages.get(key);
    if (current && !current.isClosed()) {
      // Keep the mark fresh across the form's own navigations.
      await markPreparedPage(key, current);
      return;
    }
    await loadSavedForm(key);
    const recovery = formRecovery.get(key);
    if (recovery?.snapshot) {
      let pending = recoveringForms.get(key);
      if (!pending) {
        const snapshot = recovery.snapshot;
        pending = (async () => {
          let failure: "form_changed" | "attachment_unavailable" | "reopen_failed" = "reopen_failed";
          const page = await restorePreparedForm({
            context: await getContext(),
            snapshot,
            files: recovery.files,
            guard: recovery.guard,
            onProgress: phase => onProgress?.({resultId: key, phase}),
            onFailure: reason => { failure = reason; },
          });
          if (!page) {
            if (failure !== "reopen_failed") await invalidateSavedForm(key, failure);
            throw new Error(
              "The saved form could not be refilled exactly. Prepare the application again before sending.",
            );
          }
          if (formRecovery.get(key) !== recovery) {
            await page.close({runBeforeUnload: false});
            throw new Error("Application changed while reopening");
          }
          bindPreparedApplicationPage(key, page);
          await markPreparedPage(key, page);
          delete recovery.snapshot;
          try {
            await options.onApplicationPageRestored?.(key, page, recovery.saved?.label);
          } catch (error) {
            recovery.snapshot = snapshot;
            preparedApplicationPages.delete(key);
            await page.close({runBeforeUnload: false}).catch(() => undefined);
            throw error;
          }
        })().finally(() => recoveringForms.delete(key));
        recoveringForms.set(key, pending);
      }
      await pending;
      return;
    }
    if (!markedPreparedApplicationKeys.has(key) || !options.browserHost) return;
    const browser = await options.browserHost
      .getOpenBrowser()
      .catch(() => null);
    if (!browser) return;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        if ((await readPreparedPageMark(page)) !== key) continue;
        preparedApplicationPages.set(key, page);
        // The in-page half of the prepare-only guard lives in the tab and
        // survived; its network half went with the old connection.
        await ensurePrepareOnlyMutationGuard(page, false).catch(
          () => undefined,
        );
        return;
      }
    }
  }

  /** Forgets a finished application's page and closes its exact retained tab. */
  async function releaseApplicationPage(key: string): Promise<void> {
    await preparedFormStore?.delete(key);
    // Completing an evicted application must not reopen it just to close it.
    if (!formRecovery.get(key)?.snapshot)
      await rebindPreparedApplicationPage(key);
    formRecovery.delete(key);
    recoveryUnavailable.delete(key);
    const page = preparedApplicationPages.get(key);
    preparedApplicationPages.delete(key);
    markedPreparedApplicationKeys.delete(key);
    preparedPagesWithPerson.delete(key);
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }

  const getLivePreparedApplicationPages = (): Page[] => [
    ...new Set(
      [...preparedApplicationPages.values()].filter((page) => !page.isClosed()),
    ),
  ];

  async function getProtectedApplicationPages(context: BrowserContext): Promise<Page[]> {
    const roots = new Set([
      ...getLivePreparedApplicationPages(),
      ...pagesInUseByOtherRuns(),
    ]);
    const protectedPages = new Set(roots);
    for (const candidate of context.pages()) {
      if (candidate.isClosed() || protectedPages.has(candidate)) continue;
      let current: Page | null = candidate;
      const seen = new Set<Page>();
      for (let depth = 0; current && depth < 8; depth += 1) {
        if (seen.has(current) || typeof current.opener !== "function") break;
        seen.add(current);
        current = await current.opener().catch(() => null);
        if (current && roots.has(current)) {
          protectedPages.add(candidate);
          break;
        }
      }
    }
    return [...protectedPages];
  }
  const windowBoundsPath = join(
    options.userDataDir,
    "nestor-browser-window-bounds.json",
  );

  function parseManagedBrowserWindowBounds(
    value: unknown,
  ): ManagedBrowserWindowBounds | null {
    if (!isJsonRecord(value)) return null;
    const width = value.width;
    const height = value.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 640 ||
      height < 480
    ) {
      return null;
    }
    return {
      width: Math.round(width),
      height: Math.round(height),
      ...(typeof value.x === "number" && Number.isFinite(value.x)
        ? { x: Math.round(value.x) }
        : {}),
      ...(typeof value.y === "number" && Number.isFinite(value.y)
        ? { y: Math.round(value.y) }
        : {}),
      ...(value.windowState === "normal" ||
      value.windowState === "minimized" ||
      value.windowState === "maximized" ||
      value.windowState === "fullscreen"
        ? { windowState: value.windowState }
        : {}),
    };
  }

  async function getBrowserWindowSession(browser: Browser): Promise<{
    session: CDPSession;
    windowId: number;
    bounds: ManagedBrowserWindowBounds;
  } | null> {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) return null;
    const session = await page.context().newCDPSession(page);
    try {
      const info = await session.send("Browser.getWindowForTarget");
      const bounds = parseManagedBrowserWindowBounds(info.bounds);
      if (!bounds) {
        await session.detach().catch(() => undefined);
        return null;
      }
      return {
        session,
        windowId: info.windowId,
        bounds,
      };
    } catch (error) {
      await session.detach().catch(() => undefined);
      throw error;
    }
  }

  async function restoreBrowserWindowBounds(browser: Browser): Promise<void> {
    if (options.headless) return;
    const saved = await readFile(windowBoundsPath, "utf8")
      .then((content) => parseManagedBrowserWindowBounds(JSON.parse(content)))
      .catch(() => null);
    const connection = await getBrowserWindowSession(browser).catch(() => null);
    if (!connection) return;
    try {
      await connection.session.send("Browser.setWindowBounds", {
        windowId: connection.windowId,
        bounds: saved ?? { width: 1280, height: 820, windowState: "normal" },
      });
    } finally {
      await connection.session.detach().catch(() => undefined);
    }
  }

  async function persistBrowserWindowBounds(browser: Browser): Promise<void> {
    if (options.headless) return;
    const connection = await getBrowserWindowSession(browser).catch(() => null);
    if (!connection) return;
    try {
      const parsed = parseManagedBrowserWindowBounds(connection.bounds);
      if (!parsed) return;
      await mkdir(options.userDataDir, { recursive: true });
      const temporaryPath = `${windowBoundsPath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(parsed), "utf8");
      await rename(temporaryPath, windowBoundsPath);
    } finally {
      await connection.session.detach().catch(() => undefined);
    }
  }
  let currentSessionState = BrowserSessionStateSchema.parse({
    source: "target_site",
    status: "unknown",
    driver: options.browserHost
      ? "embedded_browser_agent"
      : "chrome_profile_agent",
    label: "Browser profile not started",
    detail:
      "Open the dedicated browser profile when you want the agent to reuse a warm or authenticated browser context.",
    lastCheckedAt: new Date().toISOString(),
  });

  function setSessionState(
    source: JobSource,
    status: BrowserSessionState["status"],
    label: string,
    detail: string | null,
  ) {
    currentSessionState = BrowserSessionStateSchema.parse({
      source,
      status,
      driver: options.browserHost
        ? "embedded_browser_agent"
        : "chrome_profile_agent",
      label,
      detail,
      lastCheckedAt: new Date().toISOString(),
    });

    return currentSessionState;
  }

  function resetBrowserConnection(): void {
    preparedApplicationPages.clear();
    browserPromise = null;
    launchedChromeProcess = null;
    ownsChromeProcess = false;
    setSessionState(
      "target_site",
      "unknown",
      "Browser profile not started",
      "Open the dedicated browser profile when you want the agent to reuse a warm or authenticated browser context.",
    );
  }

  function attachBrowserLifecycle(browser: Browser): Browser {
    browser.once("disconnected", () => {
      resetBrowserConnection();
    });

    return browser;
  }

  async function waitForChromeProcessExit(
    chromeProcess: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (chromeProcess.exitCode !== null) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const onSettled = () => {
        clearTimeout(timeout);
        chromeProcess.off("exit", onExit);
        chromeProcess.off("error", onError);
      };
      const onExit = () => {
        onSettled();
        resolve(true);
      };
      const onError = () => {
        onSettled();
        resolve(true);
      };
      const timeout = setTimeout(() => {
        onSettled();
        resolve(false);
      }, timeoutMs);

      chromeProcess.once("exit", onExit);
      chromeProcess.once("error", onError);
    });
  }

  async function terminateChromeProcess(
    chromeProcess: ChildProcess | null,
    shouldTerminate: boolean,
  ): Promise<void> {
    if (
      !shouldTerminate ||
      !chromeProcess?.pid ||
      chromeProcess.exitCode !== null
    ) {
      return;
    }

    try {
      if (process.platform === "win32") {
        const taskkill = spawn(
          "taskkill",
          ["/PID", String(chromeProcess.pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
          },
        );
        await new Promise<void>((resolve) => {
          taskkill.once("exit", () => resolve());
          taskkill.once("error", () => resolve());
        });
        await waitForChromeProcessExit(chromeProcess, 5_000);
        return;
      }

      process.kill(-chromeProcess.pid, "SIGTERM");
      const exitedAfterSigterm = await waitForChromeProcessExit(
        chromeProcess,
        1_000,
      );

      if (!exitedAfterSigterm) {
        process.kill(-chromeProcess.pid, "SIGKILL");
        await waitForChromeProcessExit(chromeProcess, 1_000);
      }
    } catch {
      try {
        chromeProcess.kill("SIGTERM");
        const exitedAfterSigterm = await waitForChromeProcessExit(
          chromeProcess,
          1_000,
        );

        if (!exitedAfterSigterm) {
          chromeProcess.kill("SIGKILL");
          await waitForChromeProcessExit(chromeProcess, 1_000);
        }
      } catch {
        // Ignore cleanup failures here; session reset still clears local state.
      }
    }
  }

  async function terminateLaunchedChromeProcess(): Promise<void> {
    const chromeProcess = launchedChromeProcess;
    const shouldTerminate = ownsChromeProcess;
    launchedChromeProcess = null;
    ownsChromeProcess = false;

    await terminateChromeProcess(chromeProcess, shouldTerminate);
  }

  async function connectBrowser(): Promise<Browser> {
    const { chromium } = await import("playwright");
    const cdpEndpoint =
      (await getDebuggerWebSocketUrl(activeDebugPort)) ??
      `http://127.0.0.1:${activeDebugPort}`;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const browser = attachBrowserLifecycle(
          await chromium.connectOverCDP(cdpEndpoint, {
            timeout: 5_000,
          }),
        );
        await restoreBrowserWindowBounds(browser).catch(() => undefined);
        return browser;
      } catch (error) {
        lastError = error;

        if (attempt === 2) {
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (attempt + 1)),
        );
      }
    }

    throw lastError instanceof Error
      ? new Error(
          `Chrome exposed the debugging endpoint on port ${activeDebugPort}, but CDP attach still failed: ${lastError.message}`,
        )
      : new Error(
          `Chrome exposed the debugging endpoint on port ${activeDebugPort}, but CDP attach still failed.`,
        );
  }

  async function ensureBrowser(): Promise<Browser> {
    if (options.browserHost) {
      browserPromise = options.browserHost.connect();
      return browserPromise;
    }
    if (browserPromise) {
      try {
        const browser = await browserPromise;

        if (browser.isConnected()) {
          return browser;
        }
      } catch {
        resetBrowserConnection();
      }
    }

    browserPromise = (async () => {
      activeDebugPort = await resolveBrowserDebugPort(
        debugPort,
        options.userDataDir,
      );

      if (!(await isDebuggerEndpointReady(activeDebugPort))) {
        const chromeExecutable = await resolveChromeExecutable(
          options.chromeExecutablePath,
        );

        await mkdir(options.userDataDir, { recursive: true });
        await markManagedChromeProfileExitedCleanly(options.userDataDir);

        const launchArgs = [
          `--remote-debugging-port=${activeDebugPort}`,
          `--user-data-dir=${options.userDataDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-session-crashed-bubble",
          "--hide-crash-restore-bubble",
          // Extension service workers can observe or mutate application pages
          // outside the typed runtime boundary. Keep the managed profile's
          // ordinary cookies/session state, but never activate installed
          // extensions in an automation-owned Chrome process.
          "--disable-extensions",
          // Chrome can still start bundled component-extension background
          // workers when ordinary extensions are disabled. Those workers are
          // unrelated to an ATS page but must not make the fail-closed active
          // worker gate reject every fresh managed profile.
          "--disable-component-extensions-with-background-pages",
          "--new-window",
          "about:blank",
        ];

        if (options.headless) {
          launchArgs.push("--headless=new");
        }

        launchedChromeProcess = spawn(chromeExecutable, launchArgs, {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        ownsChromeProcess = true;
        launchedChromeProcess.once("exit", () => {
          // Chrome on Windows can hand off from the short-lived process returned
          // by spawn to a continuing browser process. The CDP connection owns the
          // authoritative lifecycle after that handoff.
          if (process.platform !== "win32") {
            resetBrowserConnection();
          }
        });
        launchedChromeProcess.unref();

        try {
          await waitForDebuggerEndpoint(activeDebugPort, launchedChromeProcess);
        } catch (error) {
          await terminateLaunchedChromeProcess().catch(() => undefined);
          throw error;
        }
      }

      return connectBrowser();
    })().catch(async (error: unknown) => {
      await terminateLaunchedChromeProcess().catch(() => undefined);
      resetBrowserConnection();
      throw error;
    });

    return browserPromise;
  }

  async function getContext(): Promise<BrowserContext> {
    await options.browserHost?.assertAutomationSafe();
    const browser = await ensureBrowser();
    const context = browser.contexts()[0];

    if (!context) {
      throw new Error(
        "Chrome opened but did not expose a default browsing context for automation.",
      );
    }

    await blockServiceWorkersOnManagedContext(context);

    return context;
  }

  async function getReadyPage(source: JobSource): Promise<Page> {
    const context = await getContext();
    const page = await resolveLivePageForContext(context, {
      bringToFront: currentSessionState.status !== "ready",
    });
    setSessionState(
      source,
      "ready",
      "Browser profile ready",
      "The dedicated browser profile is open and ready for target-specific discovery.",
    );
    return page;
  }

  async function getPreparedApplicationPage(
    source: JobSource,
    pageBindingKey?: string,
  ): Promise<Page> {
    if (pageBindingKey) {
      await rebindPreparedApplicationPage(pageBindingKey);
      return selectPreparedApplicationPage(
        preparedApplicationPages,
        pageBindingKey,
      );
    }
    return getReadyPage(source);
  }

  async function getAgentRunPage(
    source: JobSource,
    agentOptions: AgentDiscoveryOptions,
    onPageResolved?: (page: Page) => void | Promise<void>,
  ): Promise<Page> {
    if ((agentOptions.sourceCatalog?.length ?? 0) > 0) {
      // Catalog review needs an isolated page only if the agent later chooses
      // to browse. Do not depend on the source landing page being reachable.
      const page = await (await getContext()).newPage();
      await onPageResolved?.(page);
      setSessionState(
        source,
        "ready",
        "Browser profile ready",
        "The browser is available for additional source research.",
      );
      return page;
    }
    const navigationTarget =
      agentOptions.startingUrls.find((url) => isHttpUrlLike(url)) ?? null;

    if (!navigationTarget) {
      const page = await (await getContext()).newPage();
      await onPageResolved?.(page);
      return page;
    }

    const context = await getContext();
    const retainedApplicationPages = await getProtectedApplicationPages(context);
    const prepared = await prepareAutomationPageForTarget(context, {
      targetUrl: navigationTarget,
      acceptTargetOriginAfterTimeout: true,
      bringToFront: !agentOptions.inventoryOnly && currentSessionState.status !== "ready",
      closeOtherPages: !agentOptions.dedicatedPage,
      ...(agentOptions.dedicatedPage ? { reuseExistingPage: false } : {}),
      ...(agentOptions.protectedPages
        ? {
            protectedPageUrls: agentOptions.protectedPages.map(
              (protectedPage) => protectedPage.url,
            ),
          }
        : {}),
      ...(retainedApplicationPages.length > 0
        ? {
            protectedPages: retainedApplicationPages,
          }
        : {}),
      ...(agentOptions.signal ? { signal: agentOptions.signal } : {}),
      ...(onPageResolved ? { onPageResolved } : {}),
      setBlockedState: (detail) => {
        const failure = classifyBrowserNavigationFailure(detail);
        setSessionState(source, failure.status, failure.label, failure.detail);
      },
    });
    setSessionState(
      source,
      "ready",
      "Browser profile ready",
      "The dedicated browser profile is open and ready for target-specific discovery.",
    );
    return prepared.page;
  }

  async function openSessionAtTarget(input: {
    source: JobSource;
    reuseExistingPage?: boolean;
    targetUrl?: string | null;
  }): Promise<BrowserSessionState> {
    const normalizedTargetUrl =
      typeof input.targetUrl === "string" ? input.targetUrl.trim() : "";
    if (isHttpUrlLike(normalizedTargetUrl)) {
      const context = await getContext();
      const retainedApplicationPages = await getProtectedApplicationPages(context);
      await prepareAutomationPageForTarget(context, {
        targetUrl: normalizedTargetUrl,
        ...(input.reuseExistingPage !== undefined
          ? { reuseExistingPage: input.reuseExistingPage }
          : {}),
        bringToFront: true,
        closeOtherPages: true,
        ...(retainedApplicationPages.length > 0
          ? {
              protectedPages: retainedApplicationPages,
            }
          : {}),
        navigationTimeoutMs: 8_000,
        acceptTargetOriginAfterTimeout: true,
        setBlockedState: (detail) => {
          const failure = classifyBrowserNavigationFailure(detail);
          setSessionState(
            input.source,
            failure.status,
            failure.label,
            failure.detail,
          );
        },
      });
    } else {
      await getReadyPage(input.source);
    }

    setSessionState(
      input.source,
      "ready",
      "Browser profile ready",
      "The dedicated browser profile is open and ready for target-specific discovery.",
    );

    return BrowserSessionStateSchema.parse({
      ...currentSessionState,
      source: input.source,
    });
  }

  async function captureVisualSnapshotForPage(
    page: Page,
    request: BrowserVisualSnapshotRequest,
  ) {
    const normalizedRequest = BrowserVisualSnapshotRequestSchema.parse(request);
    const viewportSize = page.viewportSize();
    const screenshotBuffer = await page.screenshot({
      type: "png",
      animations: "disabled",
      timeout: 10_000,
      fullPage: normalizedRequest.mode === "full_page",
      ...(normalizedRequest.mode === "region" && normalizedRequest.region
        ? {
            clip: {
              x: normalizedRequest.region.x,
              y: normalizedRequest.region.y,
              width: normalizedRequest.region.width,
              height: normalizedRequest.region.height,
            },
          }
        : {}),
    });
    const capturedAt = new Date().toISOString();
    const dataUrl = `data:image/png;base64,${screenshotBuffer.toString("base64")}`;
    const snapshotId = createVisualSnapshotId();
    let storagePath: string | null = null;
    const warnings: string[] = [];

    if (normalizedRequest.retention.retention !== "temporary") {
      try {
        const visualArtifactDir = getVisualSnapshotArtifactDir(
          options.userDataDir,
        );
        await mkdir(visualArtifactDir, { recursive: true });
        await cleanupExpiredVisualSnapshots({ artifactDir: visualArtifactDir });
        storagePath = join(
          visualArtifactDir,
          createVisualSnapshotFileName(snapshotId),
        );
        await writeFile(storagePath, screenshotBuffer);
        await writeFile(
          join(
            visualArtifactDir,
            createVisualSnapshotMetadataFileName(snapshotId),
          ),
          JSON.stringify(
            {
              snapshotId,
              capturedAt,
              purpose: normalizedRequest.purpose,
              mode: normalizedRequest.mode,
              retention: normalizedRequest.retention.retention,
              redactionLevel: normalizedRequest.retention.redactionLevel,
              expiresAt: normalizedRequest.retention.expiresAt,
            },
            null,
            2,
          ),
          "utf8",
        );
      } catch (error) {
        warnings.push(
          `Screenshot was captured in memory but could not be retained on disk: ${error instanceof Error ? error.message : "unknown storage error"}.`,
        );
      }
    }

    return BrowserVisualSnapshotRefSchema.parse({
      id: snapshotId,
      capturedAt,
      url: safePageUrl(page),
      pageTitle: await safePageTitle(page),
      mode: normalizedRequest.mode,
      purpose: normalizedRequest.purpose,
      label: normalizedRequest.label,
      region: normalizedRequest.region,
      viewport: viewportSize
        ? {
            x: 0,
            y: 0,
            width: viewportSize.width,
            height: viewportSize.height,
          }
        : null,
      mimeType: "image/png",
      dataUrl,
      storagePath,
      retention: normalizedRequest.retention,
      warnings,
    });
  }

  async function captureVisualSnapshotForSource(
    source: JobSource,
    request: BrowserVisualSnapshotRequest,
  ) {
    return captureVisualSnapshotForPage(await getReadyPage(source), request);
  }

  async function observeApplicationFormForSource(
    source: JobSource,
    observeOptions?: ObserveApplicationFormOptions,
  ) {
    return observeApplicationFormOnPage(
      await getPreparedApplicationPage(source, observeOptions?.pageBindingKey),
      observeOptions,
    );
  }

  /**
   * The reading and writing hands for the application page this source has
   * open. The page itself never leaves this module: the caller gets a set of
   * bounded operations on it and nothing else.
   */
  function applyPageMechanicsForSource(source: JobSource): ApplyRawPageHands {
    const onReadyPage = async <TResult>(
      operation: (page: Page) => Promise<TResult>,
    ): Promise<TResult> => operation(await getReadyPage(source));

    return {
      readPage: () => onReadyPage((page) => readRawApplyPage(page)),
      fillText: (ref, value) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).fillText(ref, value),
        ),
      chooseOption: (ref, optionLabel) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).chooseOption(
            ref,
            optionLabel,
          ),
        ),
      setToggle: (ref, checked) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).setToggle(ref, checked),
        ),
      uploadFile: (ref, file) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).uploadFile(ref, file),
        ),
      clickAction: (ref) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).clickAction(ref),
        ),
      followLink: (ref) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).followLink(ref),
        ),
      navigate: (url) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).navigate(url),
        ),
      clickElement: (ref) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).clickElement(ref),
        ),
      pressKey: (ref, key) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).pressKey(ref, key),
        ),
      scroll: (direction) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).scroll(direction),
        ),
      wait: (milliseconds) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).wait(milliseconds),
        ),
      goBack: () =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).goBack(),
        ),
      readText: (ref) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).readText(ref),
        ),
      adoptOpenedTab: (index) =>
        onReadyPage((page) =>
          createPlaywrightApplyPageMechanics(page).adoptOpenedTab!(index),
        ),
    };
  }

  /**
   * Installs the guard that keeps a prepare-only run from transmitting
   * anything on this source's application page. The page stays here.
   */
  async function installApplyPrepareOnlyGuardForSource(
    source: JobSource,
    guardInput: {
      intermediateMutationsAuthorized: boolean;
      allowedOrigins: readonly string[];
    },
  ): Promise<void> {
    await ensurePrepareOnlyMutationGuard(
      await getPreparedApplicationPage(source),
      guardInput.intermediateMutationsAuthorized,
      guardInput.allowedOrigins,
    );
  }

  async function executeExactlyOneFinalActionForSource(
    source: JobSource,
    actionInput: ExecuteExactlyOneFinalActionInput,
  ) {
    actionInput.signal?.throwIfAborted();
    const page = await getPreparedApplicationPage(
      source,
      actionInput.pageBindingKey,
    );
    // Marks the page in use so tab reclamation cannot close it mid-send.
    const releasePageUse = usePage(page);
    try {
      return await executeExactlyOneFinalActionOnPage(page, actionInput);
    } finally {
      releasePageUse();
    }
  }

  return {
    async readRenderedPage(url, readOptions) {
      return readRenderedPageHtml(await getContext(), url, readOptions);
    },
    getSessionState(source) {
      return Promise.resolve(
        BrowserSessionStateSchema.parse({
          ...currentSessionState,
          source,
        }),
      );
    },
    async openSession(source, options) {
      return openSessionAtTarget({
        source,
        targetUrl: options?.targetUrl ?? null,
        ...(options?.reuseExistingPage !== undefined
          ? { reuseExistingPage: options.reuseExistingPage }
          : {}),
      });
    },
    async closeSession(source) {
      if (
        pagesInUseByOtherRuns().length > 0 ||
        getLivePreparedApplicationPages().length > 0
      ) {
        return BrowserSessionStateSchema.parse({
          ...currentSessionState,
          source,
        });
      }
      if (options.browserHost) {
        await options.browserHost.close();
        resetBrowserConnection();
        return setSessionState(
          source,
          "unknown",
          "Browser closed",
          "Browser pages are closed. Saved sign-ins are kept.",
        );
      }
      const chromeProcess = launchedChromeProcess;
      const shouldTerminateChromeProcess = ownsChromeProcess;
      launchedChromeProcess = null;
      ownsChromeProcess = false;

      try {
        if (browserPromise) {
          const browser = await browserPromise;
          if (shouldTerminateChromeProcess) {
            await persistBrowserWindowBounds(browser).catch(() => undefined);
            const browserClosedGracefully = await browser.close().then(
              () => true,
              () => false,
            );
            if (browserClosedGracefully && chromeProcess) {
              await waitForChromeProcessExit(chromeProcess, 5_000);
            }
          }
        }
      } catch {
        // Ignore browser close failures and continue process cleanup.
      } finally {
        await terminateChromeProcess(
          chromeProcess,
          shouldTerminateChromeProcess,
        ).catch(() => {});
        resetBrowserConnection();
      }

      return setSessionState(
        source,
        "unknown",
        "Browser profile closed",
        "The dedicated browser profile is closed. It will reopen automatically when the next run starts.",
      );
    },
    async inspectSourceAccess(source, input) {
      void source;
      if (options.browserHost) {
        const openBrowser = await options.browserHost.getOpenBrowser();
        if (!openBrowser)
          return createInconclusiveSourceAccessProbeResult(input);
        browserPromise = Promise.resolve(openBrowser);
      }
      if (!browserPromise) {
        return createInconclusiveSourceAccessProbeResult(input);
      }

      const browser = await browserPromise.catch(() => null);
      if (!browser || !browser.isConnected()) {
        return createInconclusiveSourceAccessProbeResult(input);
      }

      const pages = browser.contexts().flatMap((context) => context.pages());
      const page = selectUniqueSourceAccessPage(pages, input.expectedOrigin);
      return page
        ? inspectSourceAccessPage(page, input)
        : createInconclusiveSourceAccessProbeResult(input);
    },
    observeApplicationForm: observeApplicationFormForSource,
    getApplicationPageState: (_source, key) => applicationPageState(key),
    async reopenApplicationPage(_source, key, onProgress) {
      const state = await applicationPageState(key);
      if (state.state === "needs_preparing") {
        onProgress?.({resultId: key, phase: "needs_preparing"});
        return state;
      }
      onProgress?.({resultId: key, phase: "opening"});
      try {
        await rebindPreparedApplicationPage(key, onProgress);
        const page = selectPreparedApplicationPage(preparedApplicationPages, key);
        await ensurePrepareOnlyMutationGuard(page, false);
        await closePrepareOnlyAuthorizedFormActionWindow(page);
        await closePrepareOnlyFinalActionWindow(page);
        await focusPreparedApplicationPage(preparedApplicationPages, key);
        onProgress?.({resultId: key, phase: "ready"});
        return {resultId: key, state: "open", reason: null};
      } catch {
        const failed = await applicationPageState(key);
        onProgress?.({resultId: key, phase: failed.state === "needs_preparing" ? "needs_preparing" : "failed"});
        return {...failed, reason: failed.reason ?? "reopen_failed"};
      }
    },
    async hasApplicationPageBinding(_source, pageBindingKey) {
      await loadSavedForm(pageBindingKey);
      if (formRecovery.get(pageBindingKey)?.snapshot) return true;
      await rebindPreparedApplicationPage(pageBindingKey);
      try {
        selectPreparedApplicationPage(preparedApplicationPages, pageBindingKey);
        return true;
      } catch {
        return false;
      }
    },
    clearApplicationPageRecovery() {
      formRecovery.clear();
      recoveryUnavailable.clear();
      markedPreparedApplicationKeys.clear();
      preparedPagesWithPerson.clear();
      preparedApplicationPages.clear();
    },
    forgetClosedApplicationPage(_source, key) {
      preparedApplicationPages.delete(key);
      if (formRecovery.get(key)?.snapshot) return false;
      markedPreparedApplicationKeys.delete(key);
      preparedPagesWithPerson.delete(key);
      formRecovery.delete(key);
      recoveryUnavailable.delete(key);
      return true;
    },
    async hibernateApplicationPageBinding(_source, key, canDiscard) {
      const recovery = formRecovery.get(key);
      const page = preparedApplicationPages.get(key);
      if (
        !recovery ||
        recovery.snapshot ||
        (recoveryUnavailable.has(key) && !recovery.refillable) ||
        !page ||
        page.isClosed() ||
        pagesInUse.has(page) ||
        preparedPagesWithPerson.has(key) ||
        !canDiscard()
      )
        return false;
      let duplicate: Page | null = null;
      try {
        const snapshot = await capturePreparedForm(page);
        // A form saved for restarts must carry its files' identities, or it
        // would come back unable to attach them; keep the live page instead.
        const attachments = snapshot && describePreparedFormAttachments(snapshot, recovery.attachments);
        if (
          !snapshot ||
          (preparedFormStore && !attachments) ||
          snapshot.fields.some((field) =>
            field.files.some(
              (saved) =>
                recovery.files.filter((file) => file.name === saved.name).length !==
                1,
            ),
          )
        ) {
          // No exact snapshot here (a custom widget, a Needs-you form): the
          // caller brings it back by refilling from what it kept. Close only
          // a page nobody is using right now.
          if (recovery.refillable && canDiscard() && !pagesInUse.has(page) && !preparedPagesWithPerson.has(key)) {
            formRecovery.delete(key);
            recoveryUnavailable.delete(key);
            preparedApplicationPages.delete(key);
            markedPreparedApplicationKeys.delete(key);
            await page.close({ runBeforeUnload: false });
            return true;
          }
          recoveryUnavailable.add(key);
          return false;
        }
        duplicate = await restorePreparedForm({
          context: page.context(),
          snapshot,
          files: recovery.files,
          guard: recovery.guard,
        });
        if (!duplicate) {
          // A temporary navigation or capacity failure does not establish
          // that this form can never be restored. Keep it for a later try.
          return false;
        }
        const pageIsFree = () =>
          canDiscard() &&
          !page.isClosed() &&
          !pagesInUse.has(page) &&
          !preparedPagesWithPerson.has(key);
        if (
          !pageIsFree() ||
          JSON.stringify(await capturePreparedForm(page)) !==
            JSON.stringify(snapshot)
        )
          return false;
        if (recovery.saved && preparedFormStore) {
          recovery.saved = {...recovery.saved, snapshot, attachments: attachments ?? [], reason: null, savedAt: new Date().toISOString()};
          await preparedFormStore.save(recovery.saved);
        }
        // The readback and save awaited: a Send or the person may have taken
        // the page since. Close it only if it is still free right now.
        if (!pageIsFree()) return false;
        recovery.snapshot = snapshot;
        preparedApplicationPages.delete(key);
        await page.close({ runBeforeUnload: false });
        return true;
      } finally {
        await duplicate
          ?.close({ runBeforeUnload: false })
          .catch(() => undefined);
      }
    },
    async focusApplicationPageBinding(_source, pageBindingKey) {
      try {
        await rebindPreparedApplicationPage(pageBindingKey);
      } catch {
        // Use the existing lost-page recovery in the workspace instead of
        // leaving a changed form marked ready behind a button that loops.
        formRecovery.delete(pageBindingKey);
        markedPreparedApplicationKeys.delete(pageBindingKey);
        preparedPagesWithPerson.delete(pageBindingKey);
        recoveryUnavailable.delete(pageBindingKey);
        return false;
      }
      return focusPreparedApplicationPage(
        preparedApplicationPages,
        pageBindingKey,
      );
    },
    async readApplicationPageBinding(_source, pageBindingKey) {
      await rebindPreparedApplicationPage(pageBindingKey);
      const page = selectPreparedApplicationPage(
        preparedApplicationPages,
        pageBindingKey,
      );
      const raw = await readRawApplyPage(page);
      return {
        ...raw,
        controls: raw.controls.map((control) =>
          control.inputType.toLowerCase() === "password"
            ? { ...control, value: "" }
            : control,
        ),
      };
    },
    async reloadApplicationPageBinding(_source, pageBindingKey, applicationUrl) {
      await rebindPreparedApplicationPage(pageBindingKey).catch(() => undefined);
      let page = preparedApplicationPages.get(pageBindingKey);
      if (!page || page.isClosed()) {
        if (!applicationUrl || !isHttpUrlLike(applicationUrl))
          throw new Error("The application entry page is unavailable.");
        await options.browserHost?.assertAutomationSafe();
        const context = await getContext();
        const release = usesEmbeddedBrowserHost
          ? await reserveEmbeddedApplicationTab(
              context, undefined, undefined, undefined,
              hostTabCount, hostWorkingTabCount, hostHasCapacity,
            )
          : () => undefined;
        try {
          page = await context.newPage();
          await ensurePrepareOnlyMutationGuard(page, false);
          allowPrepareOnlyRunNavigation(page, applicationUrl);
          await page.goto(applicationUrl, {
            waitUntil: "domcontentloaded", timeout: 15_000,
          });
          bindPreparedApplicationPage(pageBindingKey, page);
          await options.onApplicationPageRestored?.(pageBindingKey, page);
          return;
        } catch (error) {
          preparedApplicationPages.delete(pageBindingKey);
          await page?.close({ runBeforeUnload: false }).catch(() => undefined);
          throw error;
        } finally {
          release();
        }
      }
      // Re-enter with GET; never replay a credential, challenge or application POST.
      allowPrepareOnlyRunNavigation(page, applicationUrl ?? page.url());
      await page.goto(applicationUrl ?? page.url(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    },
    async armApplicationFormAction(_source, input) {
      await rebindPreparedApplicationPage(input.pageBindingKey);
      const page = selectPreparedApplicationPage(
        preparedApplicationPages,
        input.pageBindingKey,
      );
      await closePrepareOnlyAuthorizedFormActionWindow(page);
      const raw = await readRawApplyPage(page);
      const action = raw.actions.find(
        (candidate) => (candidate.ref ?? `a${candidate.index}`) === input.ref,
      );
      if (
        raw.url !== input.pageUrl ||
        !action ||
        !action.visible ||
        action.disabled ||
        action.label.trim() !== input.label ||
        action.formAction !== input.formAction ||
        action.formMethod?.toUpperCase() !== input.formMethod
      ) {
        throw new Error(
          "The exact observed form action changed before handoff.",
        );
      }
      await armPlaywrightApplicationFormAction(page, input.ref);
    },
    async closeApplicationFormAction(_source, pageBindingKey) {
      preparedPagesWithPerson.delete(pageBindingKey);
      await rebindPreparedApplicationPage(pageBindingKey);
      const page = preparedApplicationPages.get(pageBindingKey);
      if (!page || page.isClosed()) return;
      await closePrepareOnlyAuthorizedFormActionWindow(page);
      await closePrepareOnlyFinalActionWindow(page);
    },
    async handApplicationPageToPerson(_source, pageBindingKey) {
      await rebindPreparedApplicationPage(pageBindingKey);
      const page = selectPreparedApplicationPage(
        preparedApplicationPages,
        pageBindingKey,
      );
      await openPrepareOnlyFinalActionWindow(page, PERSON_HANDOFF_WINDOW_MS);
      preparedPagesWithPerson.add(pageBindingKey);
    },
    async readApplicationPageWithPerson(_source, pageBindingKey) {
      if (!preparedPagesWithPerson.has(pageBindingKey)) return null;
      const page = preparedApplicationPages.get(pageBindingKey);
      if (!page || page.isClosed()) return null;
      return readRawApplyPage(page);
    },
    releaseApplicationPageBinding: (_source, key) =>
      releaseApplicationPage(key),
    async transferApplicationPageBinding(_source, previousKey, nextKey) {
      await rebindPreparedApplicationPage(previousKey);
      const page = preparedApplicationPages.get(previousKey);
      if (!page || page.isClosed()) return false;
      if (previousKey === nextKey) return true;
      await closePrepareOnlyAuthorizedFormActionWindow(page);
      await closePrepareOnlyFinalActionWindow(page);
      preparedApplicationPages.delete(previousKey);
      const saved = await preparedFormStore?.get(previousKey);
      if (saved) {
        await preparedFormStore!.save({...saved, id: nextKey});
        await preparedFormStore!.delete(previousKey);
      }
      const recovery = formRecovery.get(previousKey);
      formRecovery.delete(previousKey);
      if (recovery) {
        if (recovery.saved) recovery.saved = {...recovery.saved, id: nextKey};
        formRecovery.set(nextKey, recovery);
      }
      recoveryUnavailable.delete(previousKey);
      markedPreparedApplicationKeys.delete(previousKey);
      preparedPagesWithPerson.delete(previousKey);
      bindPreparedApplicationPage(nextKey, page);
      await markPreparedPage(nextKey, page);
      return true;
    },
    applyPageMechanics: applyPageMechanicsForSource,
    installApplyPrepareOnlyGuard: installApplyPrepareOnlyGuardForSource,
    executeExactlyOneFinalAction: executeExactlyOneFinalActionForSource,
    async withApplicationPageExecution(
      source,
      pageBindingKey,
      operation,
      signal,
    ) {
      void source;
      signal?.throwIfAborted();
      await rebindPreparedApplicationPage(pageBindingKey);
      const page = selectPreparedApplicationPage(
        preparedApplicationPages,
        pageBindingKey,
      );
      const releasePageUse = usePage(page);
      let lease: ApplicationPreparationLease | null = null;
      try {
        lease = await applicationPreparationScheduler.acquire(page.url(), signal);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (page.isClosed())
            throw new Error("The prepared application page was closed.");
          const currentUrl = page.url();
          await applicationSitePacing.waitForReady(page, lease, signal);
          if (applicationSiteKey(page.url()) === applicationSiteKey(currentUrl))
            break;
          if (attempt === 2)
            throw new Error(
              "The prepared application page moved while waiting for its site.",
            );
        }
        signal?.throwIfAborted();
        return await operation();
      } finally {
        releasePageUse();
        lease?.release();
      }
    },
    runDiscovery(source, searchPreferences) {
      const timestamp = new Date().toISOString();

      return Promise.resolve(
        DiscoveryRunResultSchema.parse({
          source,
          startedAt: timestamp,
          completedAt: timestamp,
          querySummary: buildQuerySummary(
            searchPreferences.targetRoles,
            searchPreferences.locations,
          ),
          warning:
            "Direct live discovery is not available for generic target flows. Use the agent discovery path instead.",
          inventoryCompleteness: "unknown",
          jobs: [],
        }),
      );
    },
    executeEasyApply(
      source,
      input: ExecuteEasyApplyInput,
    ): Promise<ApplyExecutionResult> {
      const startedAt = new Date().toISOString();

      return Promise.resolve(
        buildUnsupportedApplyResult({
          job: input.job,
          startedAt,
          mode: "easy_apply",
        }),
      );
    },
    executeApplicationFlow(
      source,
      input: ExecuteApplicationFlowInput,
      options,
    ): Promise<ApplyExecutionResult> {
      return (async () => {
        const requestedUrl =
          input.startingUrl ??
          input.job.applicationUrl ??
          input.job.canonicalUrl;
        const preparationLease = await applicationPreparationScheduler.acquire(
          requestedUrl,
          options?.signal,
        );
        try {
        const executionStartedAtMs = Date.now();
        const startedAt = new Date(executionStartedAtMs).toISOString();
        const executionTimings: ApplyExecutionTiming[] = [];
        const recordExecutionTiming = (
          stage: ApplyExecutionStage,
          stageStartedAtMs: number,
        ): void => {
          const completedAtMs = Date.now();
          executionTimings.push({
            stage,
            startedAt: new Date(stageStartedAtMs).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
            durationMs: Math.max(0, completedAtMs - stageStartedAtMs),
          });
        };
        // A continued run owns one exact prepared Page. Its live URL is more
        // authoritative than a persisted checkpoint URL: the form can move
        // from a listing through several wizard URLs before the checkpoint is
        // written. Requiring the binding also prevents restart recovery from
        // creating a fresh, empty same-URL form and calling it continuation.
        const isContinuation = isHttpUrlLike(input.startingUrl ?? "");
        if (input.applicationPageBindingKey) {
          await rebindPreparedApplicationPage(input.applicationPageBindingKey);
        }
        const retainedContinuationPage =
          input.applicationPageBindingKey
            ? isContinuation
              ? selectPreparedApplicationPage(
                  preparedApplicationPages,
                  input.applicationPageBindingKey,
                )
              : (preparedApplicationPages.get(
                  input.applicationPageBindingKey,
                ) ?? null)
            : null;
        if (retainedContinuationPage) {
          await closePrepareOnlyAuthorizedFormActionWindow(
            retainedContinuationPage,
          );
          assertRetainedApplicationPageOrigin(
            retainedContinuationPage.url(),
            input,
          );
        }
        const targetUrl =
          (retainedContinuationPage &&
          isHttpUrlLike(retainedContinuationPage.url())
            ? retainedContinuationPage.url()
            : null) ??
          (isContinuation ? input.startingUrl : null) ??
          input.job.applicationUrl ??
          input.job.canonicalUrl;
        await preparationLease.moveTo(targetUrl);
        const resumeFilePath = input.resumeArtifact.filePath.trim();
        const approvedResumeFileExists = resumeFilePath
          ? await pathExists(resumeFilePath)
          : false;
        let executionResult: ApplyExecutionResult;
        let applicationPageOpened = false;
        let applicationPageForVisuals: Page | null = null;

        if (
          input.resumeArtifact.jobId !== input.job.id ||
          !approvedResumeFileExists
        ) {
          const detail =
            "The production runtime refused to open the application because the approved application resume is missing or does not belong to this job.";
          executionResult = buildPreparationResult({
            executionInput: input,
            state: "failed",
            summary: "Approved resume export is missing",
            detail,
            questions: [],
            blocker: {
              code: "missing_resume",
              summary: "A current approved resume export is required.",
              detail,
              questionIds: [],
              sourceDebugEvidenceRefIds: [],
              url: isHttpUrlLike(targetUrl) ? targetUrl : null,
            },
            checkpoints: [],
            checkpointLabel: "Stopped before opening the application",
            checkpointDetail: detail,
            checkpointUrls: isHttpUrlLike(targetUrl) ? [targetUrl] : [],
            lastUrl: isHttpUrlLike(targetUrl) ? targetUrl : null,
            now: startedAt,
            nextActionLabel: "Export and approve the tailored resume",
          });
        } else if (!isHttpUrlLike(targetUrl)) {
          executionResult = buildUnsupportedApplyResult({
            job: input.job,
            startedAt,
            mode: input.mode,
            targetUrl: null,
          });
        } else {
          const browserPreparationStartedAtMs = Date.now();
          let formPreparationStartedAtMs: number | null = null;
          let workingPage: Page | null = null;
          let workingPageOwnedByRun = false;
          let releaseReservedTab: (() => void) | null = null;
          let releaseWorkingPageUse: (() => void) | null = null;
          const closeWorkingPageOnAbort = () => {
            if (workingPage && workingPageOwnedByRun) {
              void workingPage.close().catch(() => undefined);
            }
          };
          options?.signal?.addEventListener("abort", closeWorkingPageOnAbort, {
            once: true,
          });
          try {
            const context = await getContext();
            const pagesBeforeRun = new Set(context.pages());
            assertNoActiveServiceWorkerControlsApplicationOrigin({
              context,
              targetUrl,
            });
            const runSentinel = createApplicationRunServiceWorkerSentinel({
              context,
              targetUrl,
            });
            try {
              const preNavigationFinding = await runSentinel.check(
                "browser_preparation",
              );
              if (preNavigationFinding) {
                executionResult = buildServiceWorkerSafetyStopResult({
                  executionInput: input,
                  finding: preNavigationFinding,
                });
              } else {
                const boundPage =
                  retainedContinuationPage ??
                  (input.applicationPageBindingKey
                    ? (preparedApplicationPages.get(
                        input.applicationPageBindingKey,
                      ) ?? null)
                    : null);
                const otherPreparedPages = [
                  ...preparedApplicationPages.entries(),
                ]
                  .filter(
                    ([key, page]) =>
                      key !== input.applicationPageBindingKey &&
                      !page.isClosed(),
                  )
                  .map(([, page]) => page);
                const boundPageMatchesTarget =
                  boundPage !== null &&
                  !boundPage.isClosed() &&
                  areExactHttpUrls(boundPage.url(), targetUrl);
                // Take a free tab while holding the site. Only a full browser
                // gives the site up, and that wait keeps no tab: the pages
                // occupying the tabs may need the site to finish, and a
                // preparation queued behind its site must not hold a working
                // tab that searches and other sites could use.
                while (
                  usesEmbeddedBrowserHost &&
                  !boundPageMatchesTarget &&
                  !(releaseReservedTab = takeEmbeddedApplicationTab(
                    context,
                    hostTabCount,
                    hostWorkingTabCount,
                    hostHasCapacity,
                  ))
                )
                  await preparationLease.suspend(async () =>
                    (await reserveEmbeddedApplicationTab(
                      context,
                      options?.signal,
                      // A blank tab may still be opening for another worker.
                      // The native host owns its actual startup placeholder.
                      undefined,
                      input.onWaitingForBrowserTab
                        ? () => {
                            void Promise.resolve(
                              input.onWaitingForBrowserTab?.(),
                            ).catch(() => undefined);
                          }
                        : undefined,
                      hostTabCount,
                      hostWorkingTabCount,
                      hostHasCapacity,
                    ))(),
                  );
                const protectedPreparedPages = [
                  ...otherPreparedPages,
                  ...(boundPage && !boundPageMatchesTarget ? [boundPage] : []),
                  ...(await getProtectedApplicationPages(context)).filter(
                    (page) => page !== boundPage,
                  ),
                ];
                const exactTargetOwnedByAnotherPreparation =
                  !boundPageMatchesTarget &&
                  otherPreparedPages.some((page) =>
                    areExactHttpUrls(page.url(), targetUrl),
                  );
                const prepared = await prepareAutomationPageForTarget(context, {
                  targetUrl,
                  requireExactTarget: true,
                  bringToFront: !usesEmbeddedBrowserHost,
                  closeOtherPages: false,
                  ...(usesEmbeddedBrowserHost && !boundPageMatchesTarget
                    ? { reuseExistingPage: false }
                    : {}),
                  ...(boundPageMatchesTarget
                    ? { preferredPage: boundPage }
                    : {}),
                  ...(protectedPreparedPages.length > 0
                    ? { protectedPages: protectedPreparedPages }
                    : {}),
                  ...(exactTargetOwnedByAnotherPreparation
                    ? { reuseExistingPage: false }
                    : {}),
                  ...(options?.signal ? { signal: options.signal } : {}),
                  onPageResolved: async (page) => {
                    applicationSitePacing.observe(page);
                    releaseReservedTab?.();
                    releaseReservedTab = null;
                    workingPage = page;
                    workingPageOwnedByRun = !pagesBeforeRun.has(page);
                    releaseWorkingPageUse?.();
                    releaseWorkingPageUse = usePage(page);
                    await options?.onAutomationPage?.(page);
                    runSentinel.attachPage(page);
                    if (options?.signal?.aborted) {
                      closeWorkingPageOnAbort();
                    }
                  },
                  setBlockedState: (detail) => {
                    setSessionState(
                      source,
                      "blocked",
                      "Application navigation failed",
                      detail,
                    );
                  },
                });
                await applicationSitePacing.waitForReady(
                  prepared.page,
                  preparationLease,
                  options?.signal,
                );
                applicationPageForVisuals = prepared.page;
                if (input.applicationPageBindingKey) {
                  bindPreparedApplicationPage(
                    input.applicationPageBindingKey,
                    prepared.page,
                  );
                }
                options?.signal?.throwIfAborted();
                const postNavigationFinding =
                  await runSentinel.check("post_navigation");
                if (postNavigationFinding) {
                  applicationPageOpened = true;
                  recordExecutionTiming(
                    "browser_preparation",
                    browserPreparationStartedAtMs,
                  );
                  executionResult = buildServiceWorkerSafetyStopResult({
                    executionInput: input,
                    finding: postNavigationFinding,
                  });
                } else {
                  applicationPageOpened = true;
                  recordExecutionTiming(
                    "browser_preparation",
                    browserPreparationStartedAtMs,
                  );
                  setSessionState(
                    source,
                    "ready",
                    "Application page ready",
                    "The Job Finder browser is open at the current application checkpoint.",
                  );
                  formPreparationStartedAtMs = Date.now();
                  const applicationSession = guardApplicationPreparationSession(
                    createPlaywrightApplyPageSession({
                      page: prepared.page,
                      sentinel: runSentinel,
                    }),
                    preparationLease,
                    () => applicationSitePacing.waitForReady(
                      prepared.page,
                      preparationLease,
                      options?.signal,
                    ),
                    options?.signal,
                  );
                  if (input.prepareTaskLocalCredentials) {
                    await input.prepareTaskLocalCredentials({
                      session: applicationSession,
                      ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    options?.signal?.throwIfAborted();
                  }
                  executionResult = await input.prepareApplicationForm({
                    session: applicationSession,
                    currentUrl: prepared.page.url(),
                    startedAt,
                    ...(options?.signal ? { signal: options.signal } : {}),
                  });
                  await preparationLease.moveTo(prepared.page.url());
                  options?.signal?.throwIfAborted();
                  recordExecutionTiming(
                    "form_preparation",
                    formPreparationStartedAtMs,
                  );
                }
              }
            } finally {
              runSentinel.detach();
            }
          } catch (error) {
            if (options?.signal?.aborted) {
              throw error;
            }
            if (!applicationPageOpened) {
              recordExecutionTiming(
                "browser_preparation",
                browserPreparationStartedAtMs,
              );
            } else if (formPreparationStartedAtMs !== null) {
              recordExecutionTiming(
                "form_preparation",
                formPreparationStartedAtMs,
              );
            }
            const errorDetail =
              error instanceof Error
                ? error.message
                : "The application page could not be inspected safely.";
            if (error instanceof ApplicationNavigationError) {
              // The employer page never opened, so this is a technical failure,
              // not a Needs-you step: report it failed with causal-free copy.
              // Raw transport detail stays in session diagnostics only.
              const unreachableDetail = `${error.userDetail}`;
              executionResult = buildPreparationResult({
                executionInput: input,
                state: "failed",
                summary: error.userSummary,
                detail: unreachableDetail,
                questions: [],
                blocker: {
                  code: "application_page_unreachable",
                  summary: `${error.userSummary}.`,
                  detail: unreachableDetail,
                  questionIds: [],
                  sourceDebugEvidenceRefIds: [],
                  url: isHttpUrlLike(targetUrl) ? targetUrl : null,
                },
                checkpoints: [],
                checkpointLabel: "Failed before the application page opened",
                checkpointDetail: unreachableDetail,
                checkpointUrls: isHttpUrlLike(targetUrl) ? [targetUrl] : [],
                lastUrl: isHttpUrlLike(targetUrl) ? targetUrl : null,
                now: new Date().toISOString(),
                nextActionLabel: "Retry preparation",
              });
            } else if (
              (workingPage as Page | null) === null &&
              /Close a browser tab before opening another/i.test(errorDetail)
            ) {
              // The embedded browser refused a new tab for this application,
              // so no page ever opened and there is nothing for the person
              // to look at: a failure to try again, not a Needs-you step.
              const summary = "The Job Finder browser has too many tabs open";
              const unopenedDetail =
                "Job Finder could not open this application because its browser already has as many tabs as it allows. Nothing was sent. Close tabs you no longer need, then try again.";
              executionResult = buildPreparationResult({
                executionInput: input,
                state: "failed",
                summary,
                detail: unopenedDetail,
                questions: [],
                blocker: {
                  code: "application_page_unreachable",
                  summary: `${summary}.`,
                  detail: unopenedDetail,
                  questionIds: [],
                  sourceDebugEvidenceRefIds: [],
                  url: isHttpUrlLike(targetUrl) ? targetUrl : null,
                },
                checkpoints: [],
                checkpointLabel: "Failed before the application page opened",
                checkpointDetail: unopenedDetail,
                checkpointUrls: isHttpUrlLike(targetUrl) ? [targetUrl] : [],
                lastUrl: isHttpUrlLike(targetUrl) ? targetUrl : null,
                now: new Date().toISOString(),
                nextActionLabel: "Retry preparation",
              });
            } else {
              const detail = `The runtime stopped without submitting after browser preparation failed: ${errorDetail}`;
              executionResult = buildPreparationResult({
                executionInput: input,
                summary: "Application preparation stopped safely",
                detail,
                questions: [],
                blocker: {
                  code: "requires_manual_review",
                  summary: "The live application page needs manual review.",
                  detail,
                  questionIds: [],
                  sourceDebugEvidenceRefIds: [],
                  url: targetUrl,
                },
                checkpoints: [],
                checkpointLabel: "Stopped after a safe browser failure",
                checkpointDetail: detail,
                checkpointUrls: [targetUrl],
                lastUrl: targetUrl,
                now: new Date().toISOString(),
                nextActionLabel: "Inspect the application page manually",
              });
            }
          } finally {
            releaseReservedTab?.();
            (releaseWorkingPageUse as (() => void) | null)?.();
            options?.signal?.removeEventListener(
              "abort",
              closeWorkingPageOnAbort,
            );
            const pageToClose = workingPage as Page | null;
            if (
              (options?.signal?.aborted || !applicationPageOpened) &&
              workingPageOwnedByRun &&
              pageToClose &&
              !pageToClose.isClosed()
            ) {
              await pageToClose.close().catch(() => undefined);
            }
          }
        }

        const visualDiagnosticsStartedAtMs = Date.now();
        const visualDiagnostics = applicationPageOpened
          ? await buildApplyVisualDiagnostics({
              job: input.job,
              mode: input.mode,
              targetUrl: executionResult.replay.lastUrl ?? targetUrl,
              ...(input.captureVisualSnapshot
                ? {
                    captureVisualSnapshot: (request: BrowserVisualSnapshotRequest) =>
                      applicationPageForVisuals
                        ? captureVisualSnapshotForPage(applicationPageForVisuals, request)
                        : input.captureVisualSnapshot!(request),
                  }
                : {}),
              ...(input.analyzeVisualSnapshot
                ? { analyzeVisualSnapshot: input.analyzeVisualSnapshot }
                : {}),
            })
          : {
              visualEvidence: [],
              visualObservationSets: [],
              visualCheckpoints: [],
            };
        if (applicationPageOpened) {
          recordExecutionTiming(
            "visual_diagnostics",
            visualDiagnosticsStartedAtMs,
          );
        }
        recordExecutionTiming("total", executionStartedAtMs);
        const lastCheckpointIndex = executionResult.checkpoints.length - 1;

        if (
          input.applicationPageBindingKey &&
          executionResult.state === "ready" &&
          preparedApplicationPages.has(input.applicationPageBindingKey)
        ) {
          const resumeArtifact = input.resumeArtifact;
          const attachments = input.applicationAttachments ?? [];
          const available: PreparedFormAttachment[] = [
            ...(resumeArtifact.sha256 && (resumeArtifact.exportArtifactId || resumeArtifact.sourceDocumentId) ? [{
              kind: resumeArtifact.exportArtifactId ? "resume_export" as const : "resume_source" as const,
              id: (resumeArtifact.exportArtifactId ?? resumeArtifact.sourceDocumentId)!,
              name: resumeArtifact.fileName, sha256: resumeArtifact.sha256.toLowerCase(),
            }] : []),
            ...attachments.map(file => ({kind: "candidate_asset" as const, id: file.assetId, name: file.fileName, sha256: file.sha256.toLowerCase()})),
          ];
          formRecovery.set(input.applicationPageBindingKey, {
            files: [
              { name: resumeArtifact.fileName, load: () => loadVerifiedResumeBytes(resumeArtifact) },
              ...attachments.map(file => ({name: file.fileName, load: file.loadVerifiedBytes})),
            ],
            attachments: available,
            guard: page => ensurePrepareOnlyMutationGuard(page, false),
          });
          recoveryUnavailable.delete(input.applicationPageBindingKey);
          if (preparedFormStore) {
            const key = input.applicationPageBindingKey;
            const page = preparedApplicationPages.get(key)!;
            let snapshot = await capturePreparedForm(page).catch(() => null);
            let reason: PreparedApplicationForm["reason"] = snapshot ? null : "unsupported_form";
            const descriptors = snapshot ? describePreparedFormAttachments(snapshot, available) : null;
            if (snapshot && !descriptors) { snapshot = null; reason = "attachment_unavailable"; }
            const saved: PreparedApplicationForm = {id: key,
              label: [input.job.location, input.job.title.slice(0, 120), input.job.company.slice(0, 80)].filter(Boolean).join(" · ").slice(0, 280),
              savedAt: new Date().toISOString(), snapshot,
              attachments: snapshot ? descriptors ?? [] : [], reason,
            };
            await preparedFormStore.save(saved);
            formRecovery.get(key)!.saved = saved;
          }
        }

        // A Ready or Needs-you form the caller can refill may have its page
        // closed to save memory, snapshot or not.
        if (
          input.applicationPageBindingKey &&
          input.restorableByRefill === true &&
          (executionResult.state === "ready" ||
            executionResult.state === "paused") &&
          preparedApplicationPages.has(input.applicationPageBindingKey)
        ) {
          const recovery = formRecovery.get(input.applicationPageBindingKey);
          if (recovery) recovery.refillable = true;
          else
            formRecovery.set(input.applicationPageBindingKey, {
              files: [],
              attachments: [],
              guard: (page) => ensurePrepareOnlyMutationGuard(page, false),
              refillable: true,
            });
        }

        if (
          executionResult.state === "submitted" ||
          executionResult.state === "failed" ||
          executionResult.state === "unsupported"
        ) {
          if (input.applicationPageBindingKey)
            await releaseApplicationPage(input.applicationPageBindingKey);
          else if (
            applicationPageForVisuals &&
            !applicationPageForVisuals.isClosed()
          )
            await applicationPageForVisuals.close().catch(() => undefined);
        }
        return ApplyExecutionResultSchema.parse({
          ...executionResult,
          checkpoints: executionResult.checkpoints.map((checkpoint, index) =>
            index === lastCheckpointIndex
              ? {
                  ...checkpoint,
                  visualEvidence: visualDiagnostics.visualEvidence,
                }
              : checkpoint,
          ),
          visualEvidence: visualDiagnostics.visualEvidence,
          visualObservationSets: visualDiagnostics.visualObservationSets,
          visualCheckpoints: visualDiagnostics.visualCheckpoints,
          executionTimings,
        });
        } finally {
          preparationLease.release();
        }
      })();
    },
    async captureVisualSnapshot(source, request: BrowserVisualSnapshotRequest) {
      return captureVisualSnapshotForSource(source, request);
    },
    async runAgentDiscovery(
      source: JobSource,
      agentOptions: AgentDiscoveryOptions,
    ): Promise<DiscoveryRunResult> {
      const startedAt = new Date().toISOString();
      const aiClient = agentOptions.aiClient ?? runtimeAiClient;

      if (!jobExtractor) {
        return DiscoveryRunResultSchema.parse({
          source,
          startedAt,
          completedAt: new Date().toISOString(),
          querySummary: buildQuerySummary(
            agentOptions.searchPreferences.targetRoles,
            agentOptions.searchPreferences.locations,
            agentOptions.siteLabel,
          ),
          warning: "No job extractor configured. Cannot run agent discovery.",
          inventoryCompleteness: "unknown",
          jobs: [],
        });
      }

      // ADR 0013: compact-first observation can finish without any model.
      // Missing or tool-less AI must therefore reach the page scan. Escalation
      // alone uses the rejecting stub below and preserves the honest warning
      // when deterministic observation cannot finish the requested inventory.
      const chatWithTools = resolveAgentDiscoveryChatWithTools(
        aiClient?.chatWithTools,
      );

      const agentConfig: AgentConfig = {
        source,
        ...(agentOptions.inventoryOnly ? { inventoryOnly: true } : {}),
        ...(agentOptions.lookupKnownUrls
          ? { lookupKnownUrls: agentOptions.lookupKnownUrls }
          : {}),
        ...(agentOptions.sourceCatalog
          ? {
              sourceCatalog: agentOptions.sourceCatalog,
              sourceCatalogComplete:
                agentOptions.sourceCatalogComplete === true,
            }
          : {}),
        ...(agentOptions.retainAllFound ? { retainAllFound: true } : {}),
        maxSteps: agentOptions.maxSteps,
        ...(agentOptions.runControl
          ? { runControl: agentOptions.runControl }
          : {}),
        ...(agentOptions.resumeCheckpoint
          ? { resumeCheckpoint: agentOptions.resumeCheckpoint }
          : {}),
        ...(agentOptions.onCheckpoint
          ? { onCheckpoint: agentOptions.onCheckpoint }
          : {}),
        targetJobCount: agentOptions.targetJobCount,
        userProfile: agentOptions.userProfile,
        searchPreferences: toJobSearchGoals(agentOptions.searchPreferences),
        startingUrls: agentOptions.startingUrls,
        navigationPolicy: {
          allowedHostnames: agentOptions.navigationHostnames,
          allowSubdomains: true,
        },
        promptContext: {
          siteLabel: agentOptions.siteLabel,
          ...(agentOptions.searchMode
            ? { searchMode: agentOptions.searchMode }
            : {}),
          ...(agentOptions.searchRequest
            ? { searchRequest: agentOptions.searchRequest }
            : {}),
          ...(agentOptions.searchGuidance
            ? { searchGuidance: agentOptions.searchGuidance }
            : {}),
          ...(agentOptions.siteInstructions
            ? { siteInstructions: agentOptions.siteInstructions }
            : {}),
          ...(agentOptions.toolUsageNotes
            ? { toolUsageNotes: agentOptions.toolUsageNotes }
            : {}),
          ...(agentOptions.taskPacket
            ? { taskPacket: agentOptions.taskPacket }
            : {}),
        },
      };

      const toDiscoveryResult = (result: AgentResult): DiscoveryRunResult => {
        return DiscoveryRunResultSchema.parse({
          source,
          startedAt,
          completedAt: new Date().toISOString(),
          querySummary: buildQuerySummary(
            agentOptions.searchPreferences.targetRoles,
            agentOptions.searchPreferences.locations,
            agentOptions.siteLabel,
          ),
          warning:
            [
              // Never states a SAVED count. What the runtime holds is the
              // volume it read off the site; what a search keeps is decided
              // afterwards, by the run that dedupes and retains. Reporting
              // the first number as the second is how one screen carried
              // "Stopped early with 24 jobs saved" beside its own "15
              // results" — three numbers for one population, and at most one
              // of them true. The kept count belongs to the run report, and
              // this sentence points at it instead of guessing.
              result.incomplete
                ? `Stopped early after reading ${result.jobs.length} listing${result.jobs.length === 1 ? "" : "s"} from this site. How many were kept is shown with this search's results.`
                : null,
              result.warning ?? null,
              result.error ?? null,
            ]
              .filter(Boolean)
              .join(" ") || null,
          inventoryCompleteness: "partial",
          jobs: result.jobs,
          agentMetadata: {
            steps: result.steps,
            incomplete: result.incomplete ?? false,
            transcriptMessageCount: result.transcriptMessageCount,
            reviewTranscript: result.reviewTranscript ?? [],
            compactionState: result.compactionState ?? null,
            compactionUsedFallbackTrigger:
              result.compactionUsedFallbackTrigger ?? false,
            phaseCompletionMode: result.phaseCompletionMode ?? null,
            phaseCompletionReason: result.phaseCompletionReason ?? null,
            coveredPageUrls: result.coveredPageUrls,
            deferredListingPageUrls: result.deferredListingPageUrls,
            duplicateListingPageUrls: result.duplicateListingPageUrls,
            duplicateListings: result.duplicateListings,
            unreadableListings: result.unreadableListings,
            ...(result.pagesCovered !== undefined
              ? { pagesCovered: result.pagesCovered }
              : {}),
            phaseEvidence: result.phaseEvidence ?? null,
            debugFindings: result.debugFindings ?? null,
            accessBlockerReason: result.accessBlockerReason ?? null,
            parkedTab: result.parkedPageUrl
              ? {
                  tabId: null,
                  url: result.parkedPageUrl,
                  title: null,
                }
              : null,
          },
        });
      };
      agentOptions.signal?.throwIfAborted();
      const reused = await readCachedSearchResult(searchResultCache, agentConfig);
      if (reused) {
        const reason = "This source has not changed; reused the previous search results.";
        agentOptions.onProgress?.({currentUrl:agentConfig.startingUrls[0] ?? "about:blank", jobsFound:reused.jobs.length,stepCount:0,currentAction:"finish",message:reason,targetId:null,adapterKind:source});
        return toDiscoveryResult({...reused,steps:0,phaseCompletionReason:reason});
      }
      let page: Page | null = null;
      // Set when the agent stopped on a page only the person can continue
      // (a sign-in, a check). That page is the parked tab: it stays open.
      let pageParkedForPerson = false;
      let releaseDiscoveryPageUse: (() => void) | null = null;
      const pageAbortBinding = createDiscoveryPageAbortBinding(
        agentOptions.signal,
      );

      let releaseReservedTab: (() => void) | null = null;
      try {
        if (usesEmbeddedBrowserHost) {
          const context = await getContext();
          releaseReservedTab = await reserveEmbeddedApplicationTab(
            context,
            agentOptions.signal,
            undefined,
            () => agentOptions.onWaitingForBrowserTab?.(),
            hostTabCount,
            hostWorkingTabCount,
            hostHasCapacity,
            // Five application preparations and a popup must still fit while
            // a ten-source search runs. Hosts without native capacity keep
            // their existing conservative admission limit.
            6,
          );
        }
        page = await getAgentRunPage(source, agentOptions, async (resolvedPage) => {
          releaseReservedTab?.();
          releaseReservedTab = null;
          page = resolvedPage;
          releaseDiscoveryPageUse?.();
          releaseDiscoveryPageUse = usePage(resolvedPage);
          pageAbortBinding.onPageResolved(resolvedPage);
          await agentOptions.onAutomationPage?.(resolvedPage);
        });

        const navigationTarget =
          agentOptions.startingUrls.find((url) => isHttpUrlLike(url)) ??
          agentOptions.startingUrls[0] ??
          null;
        const warmPageReusable = isWarmPageReusable({
          pageUrl: page.url(),
          options: agentOptions,
        });
        // A usable public catalog is already the starting evidence. The agent
        // can navigate later if it needs more; an unavailable landing page
        // must not prevent it from reviewing the feed.
        const hasSourceCatalog = (agentOptions.sourceCatalog?.length ?? 0) > 0;
        if (!hasSourceCatalog && warmPageReusable && navigationTarget) {
          // A source check may have left its starting URL open even when that
          // URL returned 404. Reusing the page must not bypass the same
          // failure check a fresh navigation would make.
          const warmStatus = await page
            .evaluate(() => {
              const navigation = performance
                .getEntriesByType("navigation")
                .at(-1);
              return navigation && "responseStatus" in navigation
                ? Number(navigation.responseStatus)
                : null;
            })
            .catch(() => null);
          if (warmStatus === 404 || warmStatus === 410) {
            throw new Error(
              `Starting page returned HTTP ${warmStatus}: ${navigationTarget}`,
            );
          }
        }

        if (!hasSourceCatalog && !warmPageReusable) {
          if (navigationTarget) {
            allowPrepareOnlyRunNavigation(page, navigationTarget);
            const response = await page.goto(navigationTarget, {
              waitUntil: "domcontentloaded",
            }).catch((error: unknown) => {
              // A navigation deadline does not mean the page is unusable.
              // Let the agent inspect it and wait or retry, keeping its work.
              if (error instanceof Error && error.name === "TimeoutError") return null;
              throw error;
            });
            const status = response?.status() ?? null;
            if (status === 404 || status === 410) {
              throw new Error(
                `Starting page returned HTTP ${status}: ${navigationTarget}`,
              );
            }
          }
        }



        const result = await runJobSearchAgent({
          resultCache: searchResultCache,
          hands: createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
          page,
          config: agentConfig,
          llmClient: createAgentChatWithToolsBridge(chatWithTools),
          jobExtractor: {
            extractJobsFromPage: async (input: {
              pageText: string;
              pageUrl: string;
              pageType: AgentExtractorPageType;
              maxJobs: number;
              selectionContext?: string;
              signal?: AbortSignal;
            }) => {
              const extractionInput: JobPageExtractionInput = {
                pageText: input.pageText,
                pageUrl: input.pageUrl,
                pageType: input.pageType,
                maxJobs: input.maxJobs,
                ...(input.selectionContext
                  ? { selectionContext: input.selectionContext }
                  : {}),
              };
              if (input.signal) {
                extractionInput.signal = input.signal;
              }

              const jobs = validateJobPostings(
                await jobExtractor(extractionInput),
                input.pageUrl,
              );

              return jobs.map((job) => ({
                needsRenderedPage: job.needsRenderedPage,
                sourceJobId: job.sourceJobId,
                canonicalUrl: job.canonicalUrl,
                applicationUrl: job.applicationUrl,
                title: job.title,
                company: job.company,
                location: job.location,
                description: job.description,
                summary: job.summary,
                postedAt: job.postedAt,
                postedAtText: job.postedAtText,
                providerUpdatedAt: job.providerUpdatedAt,
                salaryText: job.salaryText,
                workMode: job.workMode,
                applyPath: job.applyPath,
                easyApplyEligible: job.easyApplyEligible,
                keySkills: job.keySkills,
                responsibilities: job.responsibilities,
                minimumQualifications: job.minimumQualifications,
                preferredQualifications: job.preferredQualifications,
                seniority: job.seniority,
                employmentType: job.employmentType,
                department: job.department,
                team: job.team,
                employerWebsiteUrl: job.employerWebsiteUrl,
                employerDomain: job.employerDomain,
                benefits: job.benefits,
                ...(job.searchRejection
                  ? { searchRejection: job.searchRejection }
                  : {}),
              }));
            },
          },
          ...(agentOptions.onProgress
            ? { onProgress: agentOptions.onProgress }
            : {}),
          ...(agentOptions.signal ? { signal: agentOptions.signal } : {}),
        });
        pageParkedForPerson = Boolean(result.parkedPageUrl);

        return toDiscoveryResult(result);
      } catch (error) {
        if (
          (error instanceof DOMException && error.name === "AbortError") ||
          agentOptions.signal?.aborted
        ) {
          throw error;
        }

        const detail =
          error instanceof Error
            ? error.message
            : "Unknown error during agent discovery";
        // The AI service refusing the request is an outage to the person,
        // never the service's own words about keys or accounts.
        const accessFailure = getAiProviderAccessFailure(error);

        return DiscoveryRunResultSchema.parse({
          source,
          startedAt,
          completedAt: new Date().toISOString(),
          querySummary: buildQuerySummary(
            agentOptions.searchPreferences.targetRoles,
            agentOptions.searchPreferences.locations,
            agentOptions.siteLabel,
          ),
          warning: accessFailure
            ? accessFailure.message
            : /Close a browser tab before opening another/i.test(detail)
              ? "The browser tab limit is reached. Close finished tabs, then run this search again."
              : `Agent discovery failed: ${detail}`,
          inventoryCompleteness: "unknown",
          jobs: [],
          agentMetadata: null,
        });
      } finally {
        releaseReservedTab?.();
        (releaseDiscoveryPageUse as (() => void) | null)?.();
        pageAbortBinding.dispose();
        if (page && !page.isClosed() && !agentOptions.signal?.aborted) {
          setSessionState(
            source,
            "ready",
            "Browser profile ready",
            "The dedicated browser profile is open and ready for target-specific discovery.",
          );
        }
        // The run's page is closed with it. A page the agent parked for the
        // person (sign-in, a challenge) stays open: the host binds it to the
        // request, and closing the request closes it.
        if (!pageParkedForPerson && page && !page.isClosed()) {
          await page.close().catch(() => undefined);
        }
      }
    },
  };
}
