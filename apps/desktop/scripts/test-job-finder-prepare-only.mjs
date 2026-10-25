import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const fixturePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "profile-baseline-workspace.json",
);
const syntheticResumePath = path.join(
  desktopDir,
  "test-fixtures",
  "job-finder",
  "resume-import-sample.txt",
);
const outputLabel =
  process.env.JOB_FINDER_PREPARE_ONLY_LABEL ?? "prepare-only-live-smoke";
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "job-finder",
  outputLabel,
);
const reportPath = path.join(outputDir, "prepare-only-smoke-report.json");
const target = {
  id: process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_ID ?? "target_lever_aircall",
  label: process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_LABEL ?? "Aircall Lever",
  startingUrl:
    process.env.JOB_FINDER_PREPARE_ONLY_SOURCE_URL ??
    "https://jobs.lever.co/aircall",
};
const targetRoles = parseCommaSeparatedList(
  process.env.JOB_FINDER_PREPARE_ONLY_TARGET_ROLES,
  [
    "AI Productivity Engineer",
    "Software Engineer",
    "Product Engineer",
    "Frontend Engineer",
    "Backend Engineer",
  ],
);
const discoveryTimeoutMs = readPositiveInteger(
  process.env.JOB_FINDER_PREPARE_ONLY_DISCOVERY_TIMEOUT_MS,
  240_000,
);
const applyTimeoutMs = readPositiveInteger(
  process.env.JOB_FINDER_PREPARE_ONLY_APPLY_TIMEOUT_MS,
  180_000,
);
const expectExactSourceJob =
  process.env.JOB_FINDER_PREPARE_ONLY_EXPECT_EXACT_SOURCE_JOB === "1";
const requireFinalCheckpoint =
  process.env.JOB_FINDER_PREPARE_ONLY_REQUIRE_FINAL_CHECKPOINT === "1";
const expectedBlockerCode =
  process.env.JOB_FINDER_PREPARE_ONLY_EXPECT_BLOCKER_CODE?.trim() || null;
const useLiveDiscoveryAi =
  process.env.JOB_FINDER_PREPARE_ONLY_USE_LIVE_DISCOVERY_AI !== "0";
const keepTemporaryProfile =
  process.env.JOB_FINDER_PREPARE_ONLY_KEEP_PROFILE === "1";
const resumeApplicationMode =
  process.env.JOB_FINDER_PREPARE_ONLY_RESUME_MODE === "original_resume"
    ? "original_resume"
    : "tailored_per_job";
class SmokeBlocker extends Error {
  constructor(stage, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SmokeBlocker";
    this.stage = stage;
  }
}

class SafetyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "SafetyViolation";
  }
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommaSeparatedList(value, fallback) {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

class UnsafeAtsEnvError extends Error {
  constructor(variable, value, reason) {
    super(
      `Unsafe ${variable} ${JSON.stringify(truncateForDiagnostic(value))}: ${reason}.`,
    );
    this.name = "UnsafeAtsEnvError";
    this.variable = variable;
  }
}

function truncateForDiagnostic(value) {
  const text = typeof value === "string" ? value : String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const HOSTNAME_LABEL_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,127})?$/u;

// Workday host must be a bare hostname: no scheme, userinfo, port, path,
// query, fragment, whitespace/control characters, underscores, percent
// escapes, or IPv4 literals. Everything the URL builder may later interpolate
// is rejected before any live fetch.
export function assertSafeHostname(
  value,
  variable = "JOB_FINDER_WORKDAY_HOST",
) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host must be a non-empty hostname",
    );
  }
  if (value.length > 253) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host exceeds the 253-character hostname limit",
    );
  }
  // eslint-disable-next-line no-control-regex -- Hostnames must reject control characters.
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host contains whitespace or control characters",
    );
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(value)) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host is not a bare hostname (schemes, userinfo, ports, paths, percent-escapes, and underscores are rejected)",
    );
  }
  if (value.includes("..")) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host contains consecutive dots",
    );
  }
  if (value.startsWith(".") || value.endsWith(".")) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host must not start or end with a dot",
    );
  }
  const labels = value.split(".");
  if (labels.some((label) => !HOSTNAME_LABEL_PATTERN.test(label))) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host contains a malformed label (labels are 1-63 letters/digits with internal hyphens)",
    );
  }
  const numericLabels = labels.filter((label) => /^\d+$/u.test(label));
  if (numericLabels.length === labels.length) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "host is all-numeric and not a valid hostname",
    );
  }
  return value;
}

// Tenant/site/locale are interpolated as single URL path segments, so the
// value must be one safe segment: a bounded charset with URL/control/query
// characters, separators, percent escapes, and traversal forms rejected.
// encodeURIComponent alone is not sufficient because '.' and '..' survive it.
export function assertSafePathSegment(value, variable) {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "value must be a non-empty single path segment",
    );
  }
  if (value.length > 128) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "value exceeds the 128-character path segment limit",
    );
  }
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "value is not a safe single path segment (only letters, digits, '.', '_', '~', '-' inside a segment; URLs, separators, control characters, and traversal are rejected)",
    );
  }
  if (value === "." || value === "..") {
    throw new UnsafeAtsEnvError(
      variable,
      value,
      "value is a path-traversal segment",
    );
  }
  return value;
}

// Safe local validation of the Workday board environment before any live
// fetch: the host must be a bare hostname and tenant/site/locale safe single
// path segments. Returns the validated values for the fetch/URL construction.
export function validateWorkdayBoardEnv(env = process.env) {
  return {
    host: assertSafeHostname(
      env.JOB_FINDER_WORKDAY_HOST ?? "amat.wd1.myworkdayjobs.com",
    ),
    tenant: assertSafePathSegment(
      env.JOB_FINDER_WORKDAY_TENANT ?? "amat",
      "JOB_FINDER_WORKDAY_TENANT",
    ),
    siteId: assertSafePathSegment(
      env.JOB_FINDER_WORKDAY_SITE ?? "External",
      "JOB_FINDER_WORKDAY_SITE",
    ),
    locale: assertSafePathSegment(
      env.JOB_FINDER_WORKDAY_LOCALE ?? "en-US",
      "JOB_FINDER_WORKDAY_LOCALE",
    ),
  };
}

function normalizeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

// Portable resume evidence: identity/digest only — never the local
// storagePath of the imported original CV.
export function summarizeOriginalResumeEvidence(baseResume) {
  return {
    resumeDocumentId: baseResume?.id ?? null,
    fileName: baseResume?.fileName ?? null,
    resumeSha256: baseResume?.sha256 ?? null,
    extractionStatus: baseResume?.extractionStatus ?? null,
  };
}

function summarizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timeoutHandle = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          Promise.resolve(onTimeout?.()).catch(() => undefined);
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function waitForJobFinderBridge(page) {
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder),
    undefined,
    { timeout: 20_000 },
  );
}

// Provider/API secret variables must never reach the automated child runtime;
// the smoke drives deterministic/test AI only.
export const CHILD_ENV_SECRET_VARS = [
  "NESTOR_AI_API_KEY",
  "NESTOR_AI_VISION_API_KEY",
  "NESTOR_BROWSER_VISION_API_KEY",
  "NESTOR_INTERVIEW_AI_API_KEY",
  "NESTOR_INTERVIEW_VISION_API_KEY",
  "NESTOR_RESUME_VISION_API_KEY",
];

// Pure child-environment construction used by every launch. Ambient pollution
// (dev-server routing, run-as-node, diagnostic write opt-ins, live-AI flags,
// provider secrets) is deleted explicitly; safe browser/test/userData values
// are set last so they always win. The self-assert makes it impossible to
// construct a "no writes" env that still carries the write-authorization var.
export function buildChildLaunchEnv({
  userDataDirectory,
  forceLiveAi = false,
  intermediateWritesAuthorized = false,
  sourceEnv = process.env,
}) {
  const env = { ...sourceEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // Wrapper-level intent must never reach the child; the only write-
  // authorization carrier is NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES.
  delete env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES;
  for (const name of CHILD_ENV_SECRET_VARS) {
    delete env[name];
  }
  if (intermediateWritesAuthorized) {
    env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES = "1";
  } else {
    delete env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES;
  }
  if (forceLiveAi) {
    env.NESTOR_TEST_API_USE_LIVE_AI = "1";
  } else {
    delete env.NESTOR_TEST_API_USE_LIVE_AI;
  }
  env.NESTOR_BROWSER_AGENT = "1";
  env.NESTOR_BROWSER_HEADLESS = "1";
  env.NESTOR_ENABLE_TEST_API = "1";
  env.NESTOR_USER_DATA_DIR = userDataDirectory;
  if (
    !intermediateWritesAuthorized &&
    env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES !== undefined
  ) {
    throw new Error(
      "Child env invariant violated: intermediate-write authorization survived sanitization.",
    );
  }
  if (!forceLiveAi && env.NESTOR_TEST_API_USE_LIVE_AI !== undefined) {
    throw new Error(
      "Child env invariant violated: live-AI override survived sanitization.",
    );
  }
  return env;
}

// Report authority is derived from the final child environment, never from a
// parallel boolean.
export function childEnvAuthorizesIntermediateWrites(childEnv) {
  return childEnv.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES === "1";
}

async function launchApp(launchEnv) {
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: launchEnv,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await waitForJobFinderBridge(page);
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function getWorkspace(page) {
  return page.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

async function getWorkspaceSafely(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  return getWorkspace(page).catch(() => null);
}

function buildSearchPreferences(base) {
  return {
    ...base,
    targetRoles,
    locations: [],
    excludedLocations: [],
    workModes: [],
    seniorityLevels: [],
    minimumSalaryUsd: null,
    targetSalaryUsd: null,
    companyBlacklist: [],
    companyWhitelist: [],
    approvalMode: "review_before_submit",
    discovery: {
      historyLimit: 5,
      targets: [
        {
          ...target,
          enabled: true,
          adapterKind: "auto",
          customInstructions: null,
          instructionStatus: "missing",
          validatedInstructionId: null,
          draftInstructionId: null,
          lastDebugRunId: null,
          lastVerifiedAt: null,
          staleReason: null,
        },
      ],
    },
  };
}

function buildSettings(base) {
  return {
    ...base,
    resumeTemplateId: "classic_ats",
    humanReviewRequired: true,
    keepSessionAlive: true,
    allowAutoSubmitOverride: false,
    discoveryOnly: false,
    resumeApplicationMode,
  };
}

function selectTargetJob(jobs) {
  const normalizedStartingUrl = normalizeHttpUrl(target.startingUrl);
  const exactJob = jobs.find(
    (job) =>
      normalizeHttpUrl(job.canonicalUrl) === normalizedStartingUrl ||
      normalizeHttpUrl(job.applicationUrl) === normalizedStartingUrl,
  );
  if (exactJob || expectExactSourceJob) {
    return exactJob ?? null;
  }

  const candidates = jobs.filter((job) => {
    const title = job.title.toLowerCase();
    return /\b(?:engineer|engineering|developer|software|frontend|backend|platform)\b/u.test(
      title,
    );
  });
  return (
    candidates.find((job) =>
      targetRoles.some(
        (role) => role.toLowerCase() === job.title.toLowerCase(),
      ),
    ) ??
    candidates[0] ??
    jobs[0] ??
    null
  );
}

function buildDiscoverySummary(workspace) {
  const latestRun = workspace?.recentDiscoveryRuns?.[0] ?? null;
  return {
    provider: workspace?.agentProvider ?? null,
    runState: latestRun?.state ?? workspace?.discoveryRunState ?? null,
    summary: latestRun?.summary ?? null,
    warning: latestRun?.targetExecutions?.[0]?.warning ?? null,
    jobs: (workspace?.discoveryJobs ?? []).map((job) => ({
      id: job.id,
      title: job.title,
      company: job.company,
      location: job.location,
      canonicalUrl: job.canonicalUrl,
      applicationUrl: job.applicationUrl,
      discoveryMethod: job.discoveryMethod,
      source: job.source,
    })),
  };
}

function findLatestAttempt(workspace, jobId) {
  return (
    (workspace?.applicationAttempts ?? [])
      .filter((attempt) => attempt.jobId === jobId)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0] ?? null
  );
}

function summarizeFinalControl(attempt) {
  const checkpoint = attempt?.checkpoints?.at(-1) ?? null;
  const combinedText = `${checkpoint?.label ?? ""} ${checkpoint?.detail ?? ""}`;
  const labelMatch = combinedText.match(
    /identified '([^']+)'|action '([^']+)'/u,
  );
  const reached =
    /final (?:visible )?(?:control|submit)|pre-submit checkpoint/iu.test(
      combinedText,
    );
  return {
    state: reached ? "reached_without_submit" : "blocked_before_final_control",
    label: labelMatch?.[1] ?? labelMatch?.[2] ?? null,
    checkpoint,
    runtimeExplicitlySaysNotClicked: /did not click/u.test(combinedText),
  };
}

function summarizeSafety(workspace) {
  const submittedAttempts = (workspace?.applicationAttempts ?? []).filter(
    (attempt) =>
      attempt.state === "submitted" || attempt.outcome === "submitted",
  );
  const submittedJobs = (workspace?.discoveryJobs ?? []).filter(
    (job) => job.status === "submitted",
  );
  const submittedRecords = (workspace?.applicationRecords ?? []).filter(
    (record) =>
      record.status === "submitted" || record.lastAttemptState === "submitted",
  );
  return {
    submittedAttemptIds: submittedAttempts.map((attempt) => attempt.id),
    submittedJobIds: submittedJobs.map((job) => job.id),
    submittedRecordIds: submittedRecords.map((record) => record.id),
    submittedNeverOccurred:
      submittedAttempts.length === 0 &&
      submittedJobs.length === 0 &&
      submittedRecords.length === 0,
  };
}

// The browser runtime stops a run whose intermediate writes are unauthorized
// with a stable safety-stop shape (blocker summary/detail plus final
// checkpoint label). Classification requires all three markers so any other
// early blocker stays unclassified and cannot masquerade as a write-guard
// handoff. If the runtime wording ever drifts, classification fails closed to
// `unclassified` and gated runs refuse the outcome.
const SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD = "intermediate_write_guard";
const SAFE_BLOCKER_KIND_UNCLASSIFIED = "unclassified";

export {
  SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD,
  SAFE_BLOCKER_KIND_UNCLASSIFIED,
};
const INTERMEDIATE_WRITE_GUARD_BLOCKER_SUMMARIES = [
  "The application page could not safely save a prepared field",
  "Resume attachment needs your help",
];
const INTERMEDIATE_WRITE_GUARD_CHECKPOINT_LABELS = [
  "Paused before the application field could be saved",
  "Paused before the resume could be attached",
];
const INTERMEDIATE_WRITE_GUARD_DETAIL_PATTERN =
  /did not have permission for that external save/u;

export function classifyApplicationSafeBlocker(application) {
  const blocker = application?.blocker ?? null;
  if (!blocker) {
    return null;
  }
  const checkpoint = application?.checkpoints?.at(-1) ?? null;
  const evidence = {
    blockerCode: typeof blocker.code === "string" ? blocker.code : null,
    blockerSummary:
      typeof blocker.summary === "string" ? blocker.summary : null,
    checkpointLabel:
      checkpoint && typeof checkpoint.label === "string"
        ? checkpoint.label
        : null,
  };
  const summaryMatched =
    evidence.blockerSummary !== null &&
    INTERMEDIATE_WRITE_GUARD_BLOCKER_SUMMARIES.includes(
      evidence.blockerSummary,
    );
  const detailMatched =
    typeof blocker.detail === "string" &&
    INTERMEDIATE_WRITE_GUARD_DETAIL_PATTERN.test(blocker.detail);
  const checkpointMatched =
    evidence.checkpointLabel !== null &&
    INTERMEDIATE_WRITE_GUARD_CHECKPOINT_LABELS.includes(
      evidence.checkpointLabel,
    );
  if (summaryMatched && detailMatched && checkpointMatched) {
    return {
      kind: SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD,
      evidence,
    };
  }
  return { kind: SAFE_BLOCKER_KIND_UNCLASSIFIED, evidence };
}

// passed_ outcomes are reserved for classified results only: reaching the
// final control, the Workday human handoff, or a classified intermediate-
// write-guard handoff. Any unclassified stop gets a non-passed outcome name.
export const OUTCOME_STOPPED_UNCLASSIFIED =
  "stopped_unclassified_without_submit";

export function resolvePrepareOnlyOutcome({
  finalControlState,
  expectedBlockerCode,
  attemptBlockerCode,
  safeBlockerKind,
}) {
  if (finalControlState === "reached_without_submit") {
    return "passed_final_checkpoint_without_submit";
  }
  if (expectedBlockerCode && attemptBlockerCode === expectedBlockerCode) {
    return "passed_expected_human_handoff_without_submit";
  }
  if (safeBlockerKind === SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD) {
    return "passed_safe_blocker_without_submit";
  }
  return OUTCOME_STOPPED_UNCLASSIFIED;
}

// A truthful write-guard handoff may only stand in when the flow actually
// stopped before the final control: it must never claim a reached control, a
// verified resume upload, or any submitted journey state.
function isIntermediateWriteGuardHandoff(application) {
  const safeBlocker = application?.safeBlocker;
  if (safeBlocker?.kind !== SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD) {
    return false;
  }
  if (
    !safeBlocker.evidence?.blockerSummary ||
    !safeBlocker.evidence?.checkpointLabel
  ) {
    return false;
  }
  if (application.finalControl?.state === "reached_without_submit") {
    return false;
  }
  if (application.resumeUploadVerified === true) {
    return false;
  }
  if (
    application.state === "submitted" ||
    application.outcome === "submitted"
  ) {
    return false;
  }
  return true;
}

// Gated runs (Greenhouse/Ashby require-final-checkpoint, Workday expected
// human handoff) share one fail-closed acceptance conjunction: strict writes
// stay unauthorized, no submitted state appeared, submit/account authority
// stayed false, isolation cleanup passed, and only then may one of the
// per-gate safe outcomes stand. Greenhouse/Ashby accept exactly two outcomes:
// reaching the final control without submit, or a classified intermediate-
// write-guard handoff without submit. Everything else remains a failure.
export function collectStrictAcceptanceViolations({
  report,
  requireFinalCheckpoint,
  expectedBlockerCode,
}) {
  if (!requireFinalCheckpoint && !expectedBlockerCode) {
    return [];
  }
  const problems = [];
  const capabilities = report?.capabilities ?? {};
  const assertions = report?.assertions ?? {};
  if (capabilities.intermediateAtsWritesAuthorized === true) {
    problems.push(
      "strict acceptance requires intermediate ATS writes to stay unauthorized, but this run authorized them",
    );
  }
  if (assertions.submittedNeverOccurred !== true) {
    problems.push(
      "strict acceptance requires submittedNeverOccurred, but submitted application state was observed",
    );
  }
  if (assertions.finalSubmitAuthorized !== false) {
    problems.push("final-submit authority was elevated");
  }
  if (assertions.accountCreationAuthorized !== false) {
    problems.push("account-creation authority was elevated");
  }
  if (
    assertions.isolatedTemporaryProfile !== true ||
    assertions.isolationCleanedUp !== true
  ) {
    problems.push("temporary user-data isolation cleanup did not pass");
  }
  if (requireFinalCheckpoint) {
    const reachedFinalControlWithoutSubmit =
      report?.outcome === "passed_final_checkpoint_without_submit";
    const truthfulWriteGuardHandoff =
      report?.outcome === "passed_safe_blocker_without_submit" &&
      isIntermediateWriteGuardHandoff(report?.application);
    if (!reachedFinalControlWithoutSubmit && !truthfulWriteGuardHandoff) {
      problems.push(
        `complete-flow acceptance requires reaching the final control without submit or a classified '${SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD}' handoff without submit, but the run ended as '${report?.outcome}'${
          report?.application?.blocker?.code
            ? ` with blocker '${report.application.blocker.code}'`
            : ""
        }`,
      );
    }
  }
  const truthfulWriteGuardHandoff =
    report?.outcome === "passed_safe_blocker_without_submit" &&
    isIntermediateWriteGuardHandoff(report?.application);
  if (
    expectedBlockerCode &&
    report?.outcome !== "passed_expected_human_handoff_without_submit" &&
    !truthfulWriteGuardHandoff
  ) {
    problems.push(
      `acceptance required blocker '${expectedBlockerCode}', but the run ended as '${report?.outcome}' with '${report?.application?.blocker?.code ?? "no blocker"}'`,
    );
  }
  return problems;
}

export function evaluateStrictPrepareOnlyAcceptance(input) {
  const violations = collectStrictAcceptanceViolations(input);
  return violations.length > 0
    ? new Error(
        `Strict prepare-only acceptance refused the outcome: ${violations.join("; ")}.`,
      )
    : null;
}

async function runPrepareOnlySmoke() {
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-job-finder-prepare-only-"),
  );
  // Child environments are built once through the pure sanitizer; report
  // authority is read back from the final child env, never from a parallel
  // boolean.
  const requestedWriteAuthorization =
    process.env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES === "1";
  const initialLaunchEnv = buildChildLaunchEnv({
    userDataDirectory,
    forceLiveAi: useLiveDiscoveryAi,
    intermediateWritesAuthorized: requestedWriteAuthorization,
  });
  const relaunchEnv = buildChildLaunchEnv({
    userDataDirectory,
    forceLiveAi: false,
    intermediateWritesAuthorized: requestedWriteAuthorization,
  });
  const launchAuthorities = [initialLaunchEnv, relaunchEnv].map(
    childEnvAuthorizesIntermediateWrites,
  );
  if (new Set(launchAuthorities).size > 1) {
    throw new SafetyViolation(
      "Initial and relaunch child environments disagree on intermediate-write authority.",
    );
  }
  const report = {
    generatedAt: new Date().toISOString(),
    invocation: "electron_preload_bridge",
    outcome: "running",
    source: target,
    requestedRoles: targetRoles,
    isolation: {
      temporaryUserDataDirectory: true,
      realWorkspaceUsed: false,
      cleanedUp: false,
      retainedForInspection: keepTemporaryProfile,
      // Redacted to a basename: absolute local temp paths are not evidence.
      retainedPath: keepTemporaryProfile
        ? path.basename(userDataDirectory)
        : null,
    },
    phases: [],
    discovery: null,
    selectedJob: null,
    candidate: null,
    resume: null,
    application: null,
    blocker: null,
    assertions: null,
    acceptanceViolations: [],
    strictGate: null,
    capabilities: {
      intermediateAtsWritesAuthorized: launchAuthorities[0] === true,
      finalSubmitAuthorized: false,
      exactSourceJobRequired: expectExactSourceJob,
      finalCheckpointRequired: requireFinalCheckpoint,
      resumeApplicationMode,
      liveDiscoveryAi: useLiveDiscoveryAi,
      expectedBlockerCode,
    },
  };

  let app = null;
  let page = null;
  let latestWorkspace = null;
  let selectedJob = null;
  let safetyViolation = null;
  let acceptanceViolation = null;

  const closeCurrentApp = async () => {
    if (app) {
      await app.close().catch(() => undefined);
    }
    app = null;
    page = null;
  };

  const runPhase = async (stage, operation) => {
    const startedAt = Date.now();
    try {
      const result = await operation();
      report.phases.push({
        stage,
        ok: true,
        wallClockMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      report.phases.push({
        stage,
        ok: false,
        wallClockMs: Date.now() - startedAt,
        error: summarizeError(error),
      });
      throw new SmokeBlocker(stage, summarizeError(error), error);
    }
  };

  try {
    ({ app, page } = await runPhase("launch_discovery_app", () =>
      launchApp(initialLaunchEnv),
    ));

    latestWorkspace = await runPhase(
      "seed_isolated_alex_vanguard_workspace",
      () =>
        page.evaluate(
          async ({ profile, searchPreferences, settings }) => {
            await window.nestor.jobFinder.saveWorkspaceInputs({
              profile,
              searchPreferences,
            });
            await window.nestor.jobFinder.saveSettings(settings);
            return window.nestor.jobFinder.getWorkspace();
          },
          {
            profile: fixture.profile,
            searchPreferences: buildSearchPreferences(
              fixture.searchPreferences,
            ),
            settings: buildSettings(fixture.settings),
          },
        ),
    );

    if (resumeApplicationMode === "original_resume") {
      latestWorkspace = await runPhase("import_synthetic_original_resume", () =>
        page.evaluate(
          (sourcePath) =>
            window.nestor.jobFinder.test.importResumeFromPath({
              sourcePath,
              useVision: false,
            }),
          syntheticResumePath,
        ),
      );
      const importedLocationReviewItem =
        latestWorkspace.profileSetupState.reviewItems.find(
          (item) =>
            item.status === "pending" &&
            item.target.domain === "identity" &&
            item.target.key === "currentLocation" &&
            item.proposedValue === "Berlin, Germany",
        );
      if (!importedLocationReviewItem) {
        throw new SmokeBlocker(
          "find_synthetic_imported_location",
          "The synthetic resume import did not expose the expected Berlin, Germany location for confirmation.",
        );
      }
      latestWorkspace = await runPhase(
        "confirm_synthetic_imported_location",
        () =>
          page.evaluate(
            (reviewItemId) =>
              window.nestor.jobFinder.applyProfileSetupReviewAction(
                reviewItemId,
                "confirm",
              ),
            importedLocationReviewItem.id,
          ),
      );
      // A resume import never silently overwrites a real name, email or
      // phone already on the profile; it proposes them for review, the way
      // the setup screen shows them. Confirm each proposal like a user would.
      const importedIdentityReviewItems =
        latestWorkspace.profileSetupState.reviewItems.filter(
          (item) =>
            item.status === "pending" &&
            item.target.domain === "identity" &&
            ["fullName", "email", "phone"].includes(item.target.key),
        );
      for (const reviewItem of importedIdentityReviewItems) {
        latestWorkspace = await runPhase(
          `confirm_synthetic_imported_${reviewItem.target.key}`,
          () =>
            page.evaluate(
              (reviewItemId) =>
                window.nestor.jobFinder.applyProfileSetupReviewAction(
                  reviewItemId,
                  "confirm",
                ),
              reviewItem.id,
            ),
        );
      }
      report.candidate = {
        fullName: latestWorkspace.profile.fullName,
        email: latestWorkspace.profile.email,
        phone: latestWorkspace.profile.phone,
        currentLocation: latestWorkspace.profile.currentLocation,
        currentCountry: latestWorkspace.profile.currentCountry,
        preferredEmail:
          latestWorkspace.profile.applicationIdentity.preferredEmail,
        preferredPhone:
          latestWorkspace.profile.applicationIdentity.preferredPhone,
      };
      if (
        report.candidate.fullName !== "Jamie Rivers" ||
        report.candidate.email !== "jamie@example.com" ||
        report.candidate.phone !== "+49 555 0000000" ||
        report.candidate.currentLocation !== "Berlin, Germany" ||
        report.candidate.currentCountry !== "Germany" ||
        report.candidate.preferredEmail !== report.candidate.email ||
        report.candidate.preferredPhone !== report.candidate.phone
      ) {
        throw new SmokeBlocker(
          "verify_synthetic_candidate_tuple",
          "The imported synthetic candidate identity, contact, and location tuple was not coherent before Apply.",
        );
      }
      latestWorkspace = await runPhase(
        "restore_exact_search_after_resume_import",
        () =>
          page.evaluate(
            async ({ profile, searchPreferences, settings }) => {
              await window.nestor.jobFinder.saveWorkspaceInputs({
                profile,
                searchPreferences,
              });
              await window.nestor.jobFinder.saveSettings(settings);
              return window.nestor.jobFinder.getWorkspace();
            },
            {
              profile: latestWorkspace.profile,
              searchPreferences: buildSearchPreferences(
                latestWorkspace.searchPreferences,
              ),
              settings: buildSettings(latestWorkspace.settings),
            },
          ),
      );
    }

    const configuredTargets =
      latestWorkspace.searchPreferences.discovery.targets;
    if (
      configuredTargets.length !== 1 ||
      configuredTargets[0]?.id !== target.id ||
      configuredTargets[0]?.startingUrl !== target.startingUrl
    ) {
      throw new SmokeBlocker(
        "verify_source_scope",
        `The isolated workspace was not scoped exclusively to ${target.label}.`,
      );
    }

    const discoveryResult = await runPhase(
      "fast_configured_source_discovery",
      () =>
        withTimeout(
          page.evaluate(
            (targetId) =>
              window.nestor.jobFinder.runAgentDiscovery(undefined, targetId),
            target.id,
          ),
          discoveryTimeoutMs,
          `${target.label} fast discovery`,
          () =>
            page.evaluate(() => window.nestor.jobFinder.cancelAgentDiscovery()),
        ),
    );
    // The route answers with what changed; read the whole workspace.
    latestWorkspace =
      discoveryResult.snapshot ??
      (await page.evaluate(() => window.nestor.jobFinder.getWorkspace()));
    report.discovery = buildDiscoverySummary(latestWorkspace);
    selectedJob = selectTargetJob(latestWorkspace.discoveryJobs ?? []);

    if (!selectedJob) {
      throw new SmokeBlocker(
        "select_target_job",
        `${target.label} discovery returned no usable job. ${
          report.discovery.warning ?? "No target warning was recorded."
        }`,
      );
    }

    report.selectedJob = {
      id: selectedJob.id,
      title: selectedJob.title,
      company: selectedJob.company,
      canonicalUrl: selectedJob.canonicalUrl,
      applicationUrl: selectedJob.applicationUrl,
    };

    await closeCurrentApp();
    ({ app, page } = await runPhase("relaunch_with_deterministic_test_ai", () =>
      launchApp(relaunchEnv),
    ));
    latestWorkspace = await getWorkspace(page);
    if (latestWorkspace.agentProvider.kind !== "deterministic") {
      throw new SmokeBlocker(
        "verify_deterministic_resume_provider",
        `Expected deterministic AI provider, got '${latestWorkspace.agentProvider.kind}'.`,
      );
    }

    latestWorkspace = await runPhase("queue_discovered_job", () =>
      page.evaluate(
        (jobId) => window.nestor.jobFinder.queueJobForReview(jobId),
        selectedJob.id,
      ),
    );
    if (resumeApplicationMode === "original_resume") {
      const reviewItem = latestWorkspace.reviewQueue.find(
        (item) => item.jobId === selectedJob.id,
      );
      if (
        !reviewItem ||
        reviewItem.resumeApplicationMode !== "original_resume" ||
        reviewItem.resumeReview.status !== "original_resume"
      ) {
        throw new SmokeBlocker(
          "verify_original_resume_ready",
          "The shortlisted job did not retain the imported original CV as its application artifact.",
        );
      }
      report.resume = {
        providerKind: latestWorkspace.agentProvider.kind,
        mode: "original_resume",
        ...summarizeOriginalResumeEvidence(latestWorkspace.profile.baseResume),
        importedProfileName: latestWorkspace.profile.fullName,
        approved: true,
        unchanged: true,
        validationIssues: [],
      };
    } else {
      latestWorkspace = await runPhase("generate_deterministic_resume", () =>
        page.evaluate(
          (jobId) => window.nestor.jobFinder.generateResume(jobId),
          selectedJob.id,
        ),
      );
      latestWorkspace = await runPhase("export_resume_pdf", () =>
        page.evaluate(
          (jobId) => window.nestor.jobFinder.exportResumePdf(jobId),
          selectedJob.id,
        ),
      );
      let resumeWorkspace = await runPhase("read_exported_resume", () =>
        page.evaluate(
          (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
          selectedJob.id,
        ),
      );
      const exportedResume = resumeWorkspace.exports
        .slice()
        .sort(
          (left, right) =>
            new Date(right.exportedAt).getTime() -
            new Date(left.exportedAt).getTime(),
        )[0];
      if (!exportedResume) {
        throw new SmokeBlocker(
          "approve_resume_pdf",
          "No exported resume PDF was available to approve.",
        );
      }

      latestWorkspace = await runPhase("approve_resume_pdf", () =>
        page.evaluate(
          ({ jobId, exportId }) =>
            window.nestor.jobFinder.approveResume(jobId, exportId),
          { jobId: selectedJob.id, exportId: exportedResume.id },
        ),
      );
      resumeWorkspace = await page.evaluate(
        (jobId) => window.nestor.jobFinder.getResumeWorkspace(jobId),
        selectedJob.id,
      );
      report.resume = {
        providerKind: latestWorkspace.agentProvider.kind,
        mode: "tailored_per_job",
        draftId: resumeWorkspace.draft.id,
        draftStatus: resumeWorkspace.draft.status,
        generationMethod: resumeWorkspace.draft.generationMethod,
        sectionCount: resumeWorkspace.draft.sections.length,
        exportId: exportedResume.id,
        exportPageCount: exportedResume.pageCount,
        approved: resumeWorkspace.exports.some(
          (entry) => entry.id === exportedResume.id && entry.isApproved,
        ),
        validationIssues: (resumeWorkspace.validation?.issues ?? []).map(
          (issue) => ({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
          }),
        ),
      };
    }

    latestWorkspace = await runPhase("approve_apply_prepare_only", () =>
      withTimeout(
        page.evaluate(
          (jobId) =>
            window.nestor.jobFinder.startApplyCopilotRun({
              jobId,
              visualCheckpointsEnabled: false,
            }),
          selectedJob.id,
        ),
        applyTimeoutMs,
        "Prepare-only application flow",
      ),
    );
    const attempt = findLatestAttempt(latestWorkspace, selectedJob.id);
    if (!attempt) {
      throw new SmokeBlocker(
        "inspect_prepare_only_result",
        "Prepare-only execution returned without an application attempt record.",
      );
    }
    report.application = {
      attemptId: attempt.id,
      state: attempt.state,
      outcome: attempt.outcome,
      summary: attempt.summary,
      detail: attempt.detail,
      nextActionLabel: attempt.nextActionLabel,
      checkpoints: attempt.checkpoints,
      blocker: attempt.blocker,
      questionCount: attempt.questions.length,
      questionEvidence: attempt.questions.map((question) => ({
        kind: question.kind,
        required: question.isRequired,
        status: question.status,
        hasSubmittedAnswer: Boolean(question.submittedAnswer),
        suggestedSourceKinds: [
          ...new Set(
            question.suggestedAnswers.map((answer) => answer.sourceKind),
          ),
        ],
      })),
      resumeUploadVerified: attempt.questions.some(
        (question) =>
          question.kind === "resume" && question.status === "answered",
      ),
      finalControl: summarizeFinalControl(attempt),
    };
    // Classify any safe blocker before the outcome is chosen so the strict
    // gate can tell a truthful intermediate-write-guard handoff apart from an
    // unclassified early failure.
    report.application.safeBlocker = classifyApplicationSafeBlocker(
      report.application,
    );
    report.outcome = resolvePrepareOnlyOutcome({
      finalControlState: report.application.finalControl.state,
      expectedBlockerCode,
      attemptBlockerCode: attempt.blocker?.code ?? null,
      safeBlockerKind: report.application.safeBlocker?.kind ?? null,
    });
  } catch (error) {
    latestWorkspace = (await getWorkspaceSafely(page)) ?? latestWorkspace;
    report.outcome = "blocked_without_submit";
    report.blocker = {
      stage: error instanceof SmokeBlocker ? error.stage : "unexpected",
      summary: summarizeError(error),
    };
  } finally {
    latestWorkspace = (await getWorkspaceSafely(page)) ?? latestWorkspace;
    const safety = summarizeSafety(latestWorkspace);
    report.assertions = {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: report.isolation.cleanedUp === true,
      intermediateAtsWritesAuthorized:
        report.capabilities.intermediateAtsWritesAuthorized,
      finalSubmitAuthorized: false,
      accountCreationAuthorized: false,
      onlyConfiguredSource:
        latestWorkspace?.searchPreferences?.discovery?.targets?.length === 1 &&
        latestWorkspace.searchPreferences.discovery.targets[0]?.id ===
          target.id &&
        latestWorkspace.searchPreferences.discovery.targets[0]?.startingUrl ===
          target.startingUrl,
      deterministicResumeProvider:
        report.resume === null ||
        report.resume.providerKind === "deterministic",
      approvedResumeBeforeApply:
        report.application === null || report.resume?.approved === true,
      submittedNeverOccurred: safety.submittedNeverOccurred,
      submittedAttemptIds: safety.submittedAttemptIds,
      submittedJobIds: safety.submittedJobIds,
      submittedRecordIds: safety.submittedRecordIds,
    };
    if (!safety.submittedNeverOccurred) {
      safetyViolation = new SafetyViolation(
        "Prepare-only smoke detected submitted application state.",
      );
      report.outcome = "failed_submit_safety_assertion";
      report.blocker = {
        stage: "submit_safety_assertion",
        summary: safetyViolation.message,
      };
      report.acceptanceViolations.push(
        "safety:submitted application state was observed",
      );
    }
    await closeCurrentApp();
    if (!keepTemporaryProfile) {
      try {
        await rm(userDataDirectory, { recursive: true, force: true });
        report.isolation.cleanedUp = true;
      } catch (error) {
        report.isolation.cleanupError = summarizeError(error);
      }
    }
    report.assertions.isolationCleanedUp = report.isolation.cleanedUp === true;
    // Evaluate the strict safety/cleanup gate after closing the isolated app.
    report.strictGate = {
      requireFinalCheckpoint,
      expectedBlockerCode,
      evaluated: false,
      accepted: false,
      violations: [],
    };
    if (requireFinalCheckpoint || expectedBlockerCode) {
      report.strictGate.evaluated = true;
      report.strictGate.violations = collectStrictAcceptanceViolations({
        report,
        requireFinalCheckpoint,
        expectedBlockerCode,
      });
      report.strictGate.accepted = report.strictGate.violations.length === 0;
      if (!report.strictGate.accepted) {
        const message = `Strict prepare-only acceptance refused the outcome: ${report.strictGate.violations.join("; ")}.`;
        report.acceptanceViolations.push(...report.strictGate.violations);
        acceptanceViolation ??= new Error(message);
        report.blocker = report.blocker ?? {
          stage: "strict_prepare_only_acceptance",
          summary: message,
        };
        if (report.outcome.startsWith("passed_")) {
          report.outcome = "failed_strict_gate";
        }
      }
    }
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  process.stdout.write(`Prepare-only smoke outcome: ${report.outcome}\n`);
  process.stdout.write(`Saved prepare-only smoke report to ${reportPath}\n`);
  if (report.blocker) {
    process.stdout.write(
      `Blocker (${report.blocker.stage}): ${report.blocker.summary}\n`,
    );
  }
  if (safetyViolation) {
    throw safetyViolation;
  }
  if (acceptanceViolation) {
    throw acceptanceViolation;
  }
}

// The smoke still auto-runs on direct execution and on `await import()` from
// the flow wrappers; validation tooling opts out with this variable to reuse
// the exported safety helpers without launching Electron.
if (process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN !== "1") {
  await runPrepareOnlySmoke().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
