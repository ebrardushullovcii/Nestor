/* eslint-env node, browser */
/* global process, setTimeout, clearTimeout, window */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_VERSION,
  isInside,
  loadAcceptanceContext,
  sha256File,
  sourceFingerprint,
  stableJson,
  verifyAcceptedElectronApp,
  verifySealedAcceptanceBootstrap,
} from "./release-acceptance-harness.mjs";
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

class AcceptanceBindingError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = "AcceptanceBindingError";
    this.stage = stage;
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

const ACCEPTANCE_INTENT_ENV_VARS = [
  "JOB_FINDER_ACCEPTANCE_RUN_DIR",
  "JOB_FINDER_ACCEPTANCE_MANIFEST",
  "JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256",
  "JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256",
];
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

// Acceptance intent is all-or-nothing: any nonempty member of the quartet
// binds the run, so partial or malformed combinations must fail loudly (the
// diagnostic wrappers delete all four) rather than degrade to unbound mode.
export function resolveAcceptanceInput(env = process.env) {
  const values = Object.fromEntries(
    ACCEPTANCE_INTENT_ENV_VARS.map((name) => [name, env[name]?.trim() || null]),
  );
  const provided = ACCEPTANCE_INTENT_ENV_VARS.filter(
    (name) => values[name] !== null,
  );
  if (provided.length === 0) {
    return null;
  }
  const missing = ACCEPTANCE_INTENT_ENV_VARS.filter(
    (name) => values[name] === null,
  );
  const malformed = [
    "JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256",
    "JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256",
  ].filter(
    (name) =>
      values[name] !== null && !SHA256_DIGEST_PATTERN.test(values[name]),
  );
  if (missing.length > 0 || malformed.length > 0) {
    throw new AcceptanceBindingError(
      "acceptance_env_partial",
      `Bound acceptance variables are all-or-nothing; set ${ACCEPTANCE_INTENT_ENV_VARS.join(", ")} together with well-formed sha256 digests. Missing: ${JSON.stringify(missing)}. Malformed: ${JSON.stringify(malformed)}.`,
    );
  }
  return {
    manifestPath: path.resolve(values.JOB_FINDER_ACCEPTANCE_MANIFEST),
    runDir: path.resolve(values.JOB_FINDER_ACCEPTANCE_RUN_DIR),
    manifestSha256: values.JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256,
    expectedSealSha256: values.JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256,
  };
}

// Capture ambient binding intent only after every lexical dependency used by
// resolveAcceptanceInput has initialized. Bound wrappers import this module a
// second time without the no-launch query, so evaluating the capture above the
// constants/classes would turn a valid sealed run into a temporal-dead-zone
// blocker before Electron starts.
let acceptanceInput = null;
let acceptanceInputError = null;
try {
  acceptanceInput = resolveAcceptanceInput(process.env);
} catch (error) {
  // Surfaced during the bind phase so a partial environment fails the run
  // loudly instead of silently degrading to unbound diagnostic mode.
  acceptanceInputError = error;
}
// Bound runs launch the sealed accepted app; unbound strict/diagnostic runs
// keep launching the worktree output. The flag also forces intermediate ATS
// writes off in bound mode regardless of ambient diagnostic variables.
const boundSealedMode = acceptanceInput !== null;

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// loadAcceptanceContext reads its paths from the environment and validates
// that the manifest sits inside the acceptance run directory, which itself
// must sit inside the artifact root. Deriving the missing variable keeps a
// single validated code path; the variables are restored so they never leak
// into the launched Electron environment.
export async function loadBoundAcceptanceContext(resolvedInput) {
  const previousManifest = process.env.JOB_FINDER_ACCEPTANCE_MANIFEST;
  const previousRunDir = process.env.JOB_FINDER_ACCEPTANCE_RUN_DIR;
  const previousManifestSha256 =
    process.env.JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256;
  process.env.JOB_FINDER_ACCEPTANCE_MANIFEST = resolvedInput.manifestPath;
  process.env.JOB_FINDER_ACCEPTANCE_RUN_DIR = resolvedInput.runDir;
  if (resolvedInput.manifestSha256) {
    process.env.JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256 =
      resolvedInput.manifestSha256;
  }
  try {
    return loadAcceptanceContext("job_finder_prepare_only_smoke");
  } finally {
    restoreEnv("JOB_FINDER_ACCEPTANCE_MANIFEST", previousManifest);
    restoreEnv("JOB_FINDER_ACCEPTANCE_RUN_DIR", previousRunDir);
    restoreEnv("JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256", previousManifestSha256);
  }
}

// Bound runs compare recomputed live fingerprints against the manifest's
// captured live-worktree inventory (the same sourceFingerprint() recipe the
// production acceptance records before building). Snapshot inventories
// describe the same bytes with different entry keys (sourceMode/snapshotMode
// instead of mode), so their digests are never comparable to a live run. The
// subject path and recipe below are pinned deliberately so a substituted or
// stale snapshot-only inventory fails closed instead of comparing across
// recipes.
const BOUND_SOURCE_SUBJECT = "manifest.source.capturedWorktree";
const BOUND_SOURCE_RECIPE =
  "stable-json-lines:path-kind-mode-bytes-sha256-or-link-target";

export { BOUND_SOURCE_SUBJECT, BOUND_SOURCE_RECIPE };

function requireManifestDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_incomplete",
      `The acceptance manifest has no valid sha256 digest at ${label}.`,
    );
  }
  return value;
}

function requireManifestFileCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_incomplete",
      `The acceptance manifest has no valid non-negative integer file count at ${label}.`,
    );
  }
  return value;
}

function requireBoundSourceInventory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_incomplete",
      `The acceptance manifest has no live worktree source inventory at ${BOUND_SOURCE_SUBJECT}.`,
    );
  }
  if (value.algorithm !== "sha256") {
    throw new AcceptanceBindingError(
      "acceptance_manifest_incomplete",
      `The acceptance manifest source inventory at ${BOUND_SOURCE_SUBJECT} does not declare the sha256 algorithm.`,
    );
  }
  if (value.recipe !== BOUND_SOURCE_RECIPE) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_source_recipe",
      `The acceptance manifest source inventory at ${BOUND_SOURCE_SUBJECT} uses fingerprint recipe ${JSON.stringify(value.recipe ?? null)}; bound runs require the live-worktree recipe '${BOUND_SOURCE_RECIPE}', so snapshot-only inventories cannot be substituted.`,
    );
  }
  const digest = requireManifestDigest(
    value.digest,
    `${BOUND_SOURCE_SUBJECT}.digest`,
  );
  const fileCount = requireManifestFileCount(
    value.fileCount,
    `${BOUND_SOURCE_SUBJECT}.fileCount`,
  );
  if (!Array.isArray(value.files) || value.files.length !== fileCount) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_incomplete",
      `The acceptance manifest source inventory at ${BOUND_SOURCE_SUBJECT} has no files list matching its declared file count, so it cannot be audited as a full live-worktree capture.`,
    );
  }
  return { digest, fileCount };
}

export function readAcceptanceExpectations(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_unreadable",
      "The acceptance manifest did not parse into an object.",
    );
  }
  if (manifest.acceptanceVersion !== ACCEPTANCE_VERSION) {
    throw new AcceptanceBindingError(
      "acceptance_manifest_version",
      `Unsupported acceptance manifest version: ${JSON.stringify(manifest.acceptanceVersion)}.`,
    );
  }
  const boundSource = requireBoundSourceInventory(
    manifest.source?.capturedWorktree,
  );
  return {
    sourceSubject: BOUND_SOURCE_SUBJECT,
    sourceRecipe: BOUND_SOURCE_RECIPE,
    sourceDigest: boundSource.digest,
    sourceFileCount: boundSource.fileCount,
    artifactDigest: requireManifestDigest(
      manifest.artifacts?.digest,
      "artifacts.digest",
    ),
    artifactFileCount: requireManifestFileCount(
      manifest.artifacts?.fileCount,
      "artifacts.fileCount",
    ),
  };
}

export function describeFingerprintMismatch(
  label,
  expectedDigest,
  expectedFileCount,
  actualDigest,
  actualFileCount,
) {
  if (
    expectedDigest === actualDigest &&
    expectedFileCount === actualFileCount
  ) {
    return null;
  }
  return `${label} fingerprint does not match the exact-build acceptance manifest: expected=${expectedDigest}/${expectedFileCount} actual=${actualDigest}/${actualFileCount}`;
}

export function collectFingerprintMismatches(
  expectations,
  actualSource,
  actualArtifacts,
) {
  return [
    describeFingerprintMismatch(
      `Source (${BOUND_SOURCE_SUBJECT})`,
      expectations.sourceDigest,
      expectations.sourceFileCount,
      actualSource?.digest,
      actualSource?.fileCount,
    ),
    describeFingerprintMismatch(
      "Build artifact",
      expectations.artifactDigest,
      expectations.artifactFileCount,
      actualArtifacts?.digest,
      actualArtifacts?.fileCount,
    ),
  ].filter(Boolean);
}

// Fingerprints are recomputed locally from disk before being stamped; digests
// supplied by callers are only ever used as comparison targets. The stamp is
// portable evidence: it records the run id and run-relative subjects, never
// absolute local run/manifest/accepted-app paths.
export function buildAcceptanceStamp({
  context,
  expectations,
  source,
  sealedReport,
  seal,
  launchPlan,
  expectedSealSha256,
}) {
  return {
    version: ACCEPTANCE_VERSION,
    bound: true,
    releaseEvidence: false,
    launchOrigin: launchPlan.kind,
    runId: path.basename(context.runDir),
    manifestSubject: "build-manifest.json",
    boundSourceSubject: expectations.sourceSubject,
    boundSourceRecipe: expectations.sourceRecipe,
    boundSourceManifestDigest: expectations.sourceDigest,
    boundSourceManifestFileCount: expectations.sourceFileCount,
    sourceFingerprint: source.digest,
    sourceFileCount: source.fileCount,
    acceptedAppSubject: "sealedReport.acceptedApp",
    acceptedAppPath: launchPlan.acceptedAppRelativePath,
    acceptedAppDigest: sealedReport.acceptedApp.digest,
    acceptedAppFileCount: sealedReport.acceptedApp.fileCount,
    sealSubject: "acceptance-seal.json",
    sealSha256: expectedSealSha256,
    electronSha256: seal.electron?.sha256 ?? null,
    electronBytes: seal.electron?.bytes ?? null,
    electronPackageVersion: seal.electron?.electronPackageVersion ?? null,
    matchedManifestBeforeLaunch: true,
    sourceFingerprintUnchangedAfterRun: null,
    acceptedAppUnchangedAfterRun: null,
    electronIdentityUnchangedAfterRun: null,
  };
}

function requireExpectedSealDigest(value) {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new AcceptanceBindingError(
      "acceptance_seal_required",
      "Bound strict ATS mode requires JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256 to hold the externally custodied acceptance seal SHA-256 for the run directory.",
    );
  }
  return value;
}

// Bound mode verifies the whole sealed bootstrap before anything launches:
// seal digest, final report custody, current worktree equality with the
// captured source/toolchain inventories, and Electron executable identity.
export async function loadSealedAcceptanceRun(resolvedInput) {
  const expectedSealSha256 = requireExpectedSealDigest(
    resolvedInput.expectedSealSha256,
  );
  const context = await loadBoundAcceptanceContext(resolvedInput);
  const { report: sealedReport, seal } = await verifySealedAcceptanceBootstrap({
    runDir: context.runDir,
    expectedSealSha256,
  });
  if (sealedReport.pass !== true) {
    throw new AcceptanceBindingError(
      "acceptance_seal_report_failed",
      "The sealed acceptance report recorded pass=false; it cannot ground a bound strict run.",
    );
  }
  return { context, sealedReport, seal, expectedSealSha256 };
}

// No-launch local custody preflight for strict bound ATS wrappers. Bound
// wrappers call this BEFORE any live board fetch so an incomplete/partial
// binding, an unreadable manifest, or a tampered seal/custody set fails
// locally without touching the network. It is pure local validation: no
// Electron launch, no live worktree fingerprint, no report stamp. The smoke's
// own bind phase runs the same preflight before launching the sealed app, so
// wrappers and smoke validate through one code path.
export async function preflightBoundAcceptanceRun(resolvedInput) {
  const sealedRun = await loadSealedAcceptanceRun(resolvedInput);
  const expectations = readAcceptanceExpectations(sealedRun.context.manifest);
  assertSealedManifestIdentity({
    context: sealedRun.context,
    expectations,
    sealedReport: sealedRun.sealedReport,
    seal: sealedRun.seal,
  });
  const launchPlan = planSealedAcceptedAppLaunch({
    runDir: sealedRun.context.runDir,
    acceptedApp: sealedRun.sealedReport.acceptedApp,
    seal: sealedRun.seal,
  });
  await verifySealedAcceptedAppReady(
    launchPlan,
    sealedRun.sealedReport.acceptedApp,
  );
  return { sealedRun, expectations, launchPlan };
}

// Wrapper-level bound-env gate used by the strict ATS flow wrappers before
// any live board fetch. Diagnostic-authorized runs stay unbound by design
// (the wrappers strip the acceptance variables), so they skip the local
// custody preflight and keep the existing developer workflow; every other run
// resolves the all-or-nothing acceptance binding intent and, when bound, must
// prove the local acceptance/custody binding before the network is touched.
// Returns the resolved binding input, or null for unbound runs, and throws
// (with no network traffic) on incomplete/tampered binding or unsafe env.
export async function preflightBoundAtsRun(env = process.env) {
  if (env.JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC === "1") {
    return null;
  }
  const boundInput = resolveAcceptanceInput(env);
  if (boundInput) {
    await preflightBoundAcceptanceRun(boundInput);
  }
  return boundInput;
}

// Cross-checks the loaded exact-build manifest against the sealed bootstrap
// report so the stamp, manifest, and seal all claim one identical identity.
export function assertSealedManifestIdentity({
  context,
  expectations,
  sealedReport,
  seal,
}) {
  const refuse = (detail) =>
    new AcceptanceBindingError("acceptance_seal_manifest_identity", detail);
  if (sealedReport.runDir !== context.runDir) {
    throw refuse(
      `Sealed acceptance report run directory mismatch: ${JSON.stringify(sealedReport.runDir)} !== ${JSON.stringify(context.runDir)}.`,
    );
  }
  if (
    typeof sealedReport.initialManifestSha256 !== "string" ||
    !SHA256_DIGEST_PATTERN.test(sealedReport.initialManifestSha256)
  ) {
    throw refuse(
      "The sealed acceptance report carries no well-formed initialManifestSha256.",
    );
  }
  if (sealedReport.initialManifestSha256 !== context.manifest.manifestSha256) {
    throw refuse(
      "The sealed acceptance report claims a different initial manifest digest than the loaded exact-build manifest.",
    );
  }
  if (
    seal.initialBuildManifest?.canonicalSha256 !==
    context.manifest.manifestSha256
  ) {
    throw refuse(
      "The acceptance seal does not bind the loaded exact-build manifest digest.",
    );
  }
  if (
    stableJson(sealedReport.source?.capturedWorktree) !==
    stableJson(context.manifest.source?.capturedWorktree)
  ) {
    throw refuse(
      `The sealed acceptance report ${BOUND_SOURCE_SUBJECT} inventory differs from the loaded exact-build manifest.`,
    );
  }
  if (
    expectations &&
    sealedReport.source?.capturedWorktree?.digest !== expectations.sourceDigest
  ) {
    throw refuse(
      `The sealed acceptance report source digest differs from the ${BOUND_SOURCE_SUBJECT} expectation.`,
    );
  }
  const sealAcceptedApp = seal.acceptedApp;
  const reportAcceptedApp = sealedReport.acceptedApp;
  for (const field of ["path", "digest", "fileCount"]) {
    if (sealAcceptedApp?.[field] !== reportAcceptedApp?.[field]) {
      throw refuse(
        `Accepted-app ${field} differs between seal (${JSON.stringify(sealAcceptedApp?.[field] ?? null)}) and report (${JSON.stringify(reportAcceptedApp?.[field] ?? null)}).`,
      );
    }
  }
  const sealElectron = seal.electron ?? {};
  const reportElectron = sealedReport.electron?.final ?? {};
  if (
    typeof sealElectron.sha256 !== "string" ||
    !SHA256_DIGEST_PATTERN.test(sealElectron.sha256) ||
    !Number.isInteger(sealElectron.bytes)
  ) {
    throw refuse(
      "The acceptance seal carries no well-formed Electron sha256/bytes identity.",
    );
  }
  // Compare every Electron identity field that exists on both sides; the
  // executable itself may live anywhere (identity is hash+size bound, not
  // path-confined), so only shared field values must agree.
  for (const field of Object.keys(sealElectron)) {
    if (
      reportElectron[field] !== undefined &&
      reportElectron[field] !== sealElectron[field]
    ) {
      throw refuse(
        `Electron identity field '${field}' differs between seal and report.`,
      );
    }
  }
}

// Pure launch-plan derivation: everything needed to start the sealed app must
// come from the seal/report pair, never from ambient worktree state.
export function planSealedAcceptedAppLaunch({ runDir, acceptedApp, seal }) {
  const relative = acceptedApp?.path;
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.split(/[/\\]/u).includes("..")
  ) {
    throw new AcceptanceBindingError(
      "accepted_app_path",
      `The sealed accepted-app path must be a non-empty run-relative path without traversal: ${JSON.stringify(relative ?? null)}.`,
    );
  }
  const root = path.resolve(runDir, relative);
  if (!isInside(runDir, root)) {
    throw new AcceptanceBindingError(
      "accepted_app_path",
      `The sealed accepted-app root escaped its run directory: ${relative}.`,
    );
  }
  // Note: only the accepted-app ROOT is confined to the run directory. The
  // sealed Electron executable may legitimately resolve outside it; its
  // identity is bound by sha256+bytes (+ recorded package versions), checked
  // by verifySealedElectronIdentity before launch, mid-relaunch, and post-run.
  const args = acceptedApp.launch?.args;
  if (!Array.isArray(args) || stableJson(args) !== stableJson(["."])) {
    throw new AcceptanceBindingError(
      "accepted_app_launch_args",
      `The sealed accepted-app launch args must be exactly ['.']; got ${JSON.stringify(args ?? null)}.`,
    );
  }
  const executablePath = seal?.electron?.executablePath;
  if (typeof executablePath !== "string" || executablePath.length === 0) {
    throw new AcceptanceBindingError(
      "acceptance_electron_identity",
      "The acceptance seal carries no Electron executable identity.",
    );
  }
  return {
    kind: "sealed_accepted_app",
    executablePath,
    args: [...args],
    cwd: root,
    acceptedAppRelativePath: relative,
  };
}

// Canonicality, inventory, read-only hardening, and package-metadata checks
// for the accepted app right before it is launched.
export async function verifySealedAcceptedAppReady(launchPlan, acceptedApp) {
  return verifyAcceptedElectronApp(launchPlan.cwd, acceptedApp);
}

// The sealed Electron executable is bound by hash+size (and package versions
// recorded in the seal), never by path confinement: it legitimately resolves
// outside the accepted-app root or even outside the run directory.
export async function verifySealedElectronIdentity(seal) {
  const electronIdentity = seal?.electron;
  if (
    !electronIdentity ||
    typeof electronIdentity.executablePath !== "string" ||
    electronIdentity.executablePath.length === 0
  ) {
    throw new AcceptanceBindingError(
      "acceptance_electron_identity",
      "The acceptance seal carries no Electron executable identity.",
    );
  }
  let bytes;
  try {
    bytes = (await stat(electronIdentity.executablePath)).size;
  } catch (error) {
    throw new AcceptanceBindingError(
      "sealed_electron_identity",
      `The sealed Electron executable disappeared: ${summarizeError(error)}`,
    );
  }
  const sha256 = await sha256File(electronIdentity.executablePath);
  if (sha256 !== electronIdentity.sha256 || bytes !== electronIdentity.bytes) {
    throw new AcceptanceBindingError(
      "sealed_electron_identity",
      `The sealed Electron executable identity mismatch: expected=${electronIdentity.sha256}/${electronIdentity.bytes} actual=${sha256}/${bytes}.`,
    );
  }
  return { sha256, bytes };
}

// Post-run authority: the accepted app inventory and the sealed Electron
// executable must be byte-for-byte unchanged after the run and cleanup.
export async function verifySealedRunIntegrityAfterRun(
  launchPlan,
  acceptedApp,
  seal,
) {
  const acceptedAppComponent = await verifyAcceptedElectronApp(
    launchPlan.cwd,
    acceptedApp,
  );
  const electron = await verifySealedElectronIdentity(seal);
  return { acceptedApp: acceptedAppComponent, electron };
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

async function launchApp(launchEnv, sealedLaunchPlan = null) {
  const launchOptions = sealedLaunchPlan
    ? {
        executablePath: sealedLaunchPlan.executablePath,
        cwd: sealedLaunchPlan.cwd,
        args: sealedLaunchPlan.args,
      }
    : { args: ["."], cwd: desktopDir };
  const app = await electron.launch({
    ...launchOptions,
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

// A stopped_unclassified outcome exits nonzero for bound/gated runs; unbound
// diagnostic runs keep exit zero but never claim a pass.
export function requiresNonzeroExitForStop(report) {
  return (
    String(report?.outcome ?? "").startsWith("stopped_") &&
    report?.acceptanceMode !== "unbound_diagnostic"
  );
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

// Release evidence is an all-pass conjunction decided after the strict gate:
// binding and sealed-runtime integrity must both hold alongside the gate,
// write authority, submission absence, authorities, and cleanup.
export function decideReleaseEvidence({
  strictGate,
  acceptedOutcome,
  bindingVerified,
  integrityVerified,
  childWritesAuthorized,
  submittedNeverOccurred,
  finalSubmitAuthorized,
  accountCreationAuthorized,
  isolatedTemporaryProfile,
  isolationCleanedUp,
}) {
  const violations = [];
  if (acceptedOutcome !== true) {
    violations.push("the run did not end in an accepted prepare-only outcome");
  }
  if (bindingVerified !== true) {
    violations.push(
      "the exact-build binding was not re-verified after the run",
    );
  }
  if (integrityVerified !== true) {
    violations.push(
      "sealed accepted-app/Electron integrity was not confirmed after the run",
    );
  }
  if (strictGate?.evaluated === true && strictGate.accepted !== true) {
    violations.push("the strict outcome gate refused this run");
  }
  if (childWritesAuthorized === true) {
    violations.push("intermediate ATS writes were authorized in the child env");
  }
  if (submittedNeverOccurred !== true) {
    violations.push("submitted application state was observed");
  }
  if (finalSubmitAuthorized !== false) {
    violations.push("final-submit authority was elevated");
  }
  if (accountCreationAuthorized !== false) {
    violations.push("account-creation authority was elevated");
  }
  if (isolatedTemporaryProfile !== true || isolationCleanedUp !== true) {
    violations.push("temporary user-data isolation cleanup did not pass");
  }
  return { releaseEvidence: violations.length === 0, violations };
}

async function runPrepareOnlySmoke() {
  await mkdir(outputDir, { recursive: true });
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-job-finder-prepare-only-"),
  );
  // Child environments are built once through the pure sanitizer; report
  // authority is read back from the final child env, never from a parallel
  // boolean. Bound sealed mode can never authorize intermediate writes.
  const requestedWriteAuthorization =
    !boundSealedMode &&
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
    acceptanceMode:
      acceptanceInput === null
        ? "unbound_diagnostic"
        : "bound_to_exact_build_manifest",
    releaseEvidence: false,
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
    acceptance: null,
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
  let acceptanceContext = null;
  let acceptanceExpectations = null;
  let sealedRun = null;
  let sealedLaunchPlan = null;

  const closeCurrentApp = async () => {
    if (app) {
      await app.close().catch(() => undefined);
    }
    app = null;
    page = null;
  };

  // Release evidence is decided last: it requires the strict gate, safety,
  // cleanup, binding re-verification, and sealed-runtime integrity to all
  // pass. Any violation is persisted in report.acceptanceViolations.
  const finalizeAcceptanceBinding = async () => {
    let bindingVerified = false;
    let integrityVerified = false;
    const violations = [];
    try {
      const sourceAfterRun = await sourceFingerprint();
      const sourceUnchanged =
        sourceAfterRun.digest === report.acceptance.sourceFingerprint &&
        sourceAfterRun.fileCount === report.acceptance.sourceFileCount;
      report.acceptance.sourceFingerprintUnchangedAfterRun = sourceUnchanged;
      if (!sourceUnchanged) {
        violations.push(
          describeFingerprintMismatch(
            `Source (${BOUND_SOURCE_SUBJECT})`,
            acceptanceExpectations.sourceDigest,
            acceptanceExpectations.sourceFileCount,
            sourceAfterRun.digest,
            sourceAfterRun.fileCount,
          ) ??
            "The exact-build fingerprints could not be confirmed unchanged after the run.",
        );
        throw new AcceptanceBindingError(
          "acceptance_binding_post_run",
          violations[0],
        );
      }
      await verifySealedRunIntegrityAfterRun(
        sealedLaunchPlan,
        sealedRun.sealedReport.acceptedApp,
        sealedRun.seal,
      );
      integrityVerified = true;
      report.acceptance.acceptedAppUnchangedAfterRun = true;
      report.acceptance.electronIdentityUnchangedAfterRun = true;
      bindingVerified = true;
    } catch (error) {
      const bindingError =
        error instanceof AcceptanceBindingError
          ? error
          : new AcceptanceBindingError(
              "acceptance_binding_post_run",
              `Unable to re-verify the exact-build binding after the run: ${summarizeError(error)}`,
            );
      report.acceptance.sourceFingerprintUnchangedAfterRun ??= false;
      report.acceptance.acceptedAppUnchangedAfterRun ??= false;
      report.acceptance.electronIdentityUnchangedAfterRun ??= false;
      report.acceptance.releaseEvidence = false;
      report.releaseEvidence = false;
      report.acceptanceViolations.push(
        `binding:${bindingError.stage}:${bindingError.message}`,
      );
      if (!report.blocker) {
        report.blocker = {
          stage: bindingError.stage,
          summary: bindingError.message,
        };
      }
      if (report.outcome.startsWith("passed_")) {
        report.outcome = "failed_acceptance_binding";
      }
      acceptanceViolation = bindingError;
      return;
    }
    const decision = decideReleaseEvidence({
      strictGate: report.strictGate,
      acceptedOutcome: report.outcome.startsWith("passed_"),
      bindingVerified,
      integrityVerified,
      childWritesAuthorized:
        report.capabilities.intermediateAtsWritesAuthorized === true,
      submittedNeverOccurred: report.assertions.submittedNeverOccurred === true,
      finalSubmitAuthorized: report.assertions.finalSubmitAuthorized === true,
      accountCreationAuthorized:
        report.assertions.accountCreationAuthorized === true,
      isolatedTemporaryProfile:
        report.assertions.isolatedTemporaryProfile === true,
      isolationCleanedUp: report.assertions.isolationCleanedUp === true,
    });
    report.acceptanceViolations.push(
      ...decision.violations.map(
        (violation) => `release_evidence:${violation}`,
      ),
    );
    if (decision.releaseEvidence) {
      report.acceptance.releaseEvidence = true;
      report.releaseEvidence = true;
      return;
    }
    report.acceptance.releaseEvidence = false;
    report.releaseEvidence = false;
    const failure = new AcceptanceBindingError(
      "release_evidence_refused",
      decision.violations.join("; "),
    );
    if (!report.blocker) {
      report.blocker = { stage: failure.stage, summary: failure.message };
    }
    if (report.outcome.startsWith("passed_")) {
      report.outcome = "failed_acceptance_binding";
    }
    acceptanceViolation ??= failure;
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
    if (acceptanceInputError) {
      throw acceptanceInputError;
    }
    if (acceptanceInput) {
      // Bound strict runs must be invoked through the `:built` wrapper
      // variants (for example `test:job-finder-complete-flow:built`). The
      // non-`:built` variants run `pnpm build` first, mutating worktree out/
      // and invalidating the sealed accepted-app contract, so docs and CI
      // citations must use only the `:built` commands.
      await runPhase("bind_exact_build_manifest", async () => {
        const preflight = await preflightBoundAcceptanceRun(acceptanceInput);
        sealedRun = preflight.sealedRun;
        acceptanceContext = sealedRun.context;
        acceptanceExpectations = preflight.expectations;
        sealedLaunchPlan = preflight.launchPlan;
        // Redundant live-worktree evidence only; the launched runtime is the
        // sealed accepted app, never worktree out/. A stale or absent out/ is
        // irrelevant here.
        const source = await sourceFingerprint();
        const sourceMismatch = describeFingerprintMismatch(
          `Source (${BOUND_SOURCE_SUBJECT})`,
          acceptanceExpectations.sourceDigest,
          acceptanceExpectations.sourceFileCount,
          source.digest,
          source.fileCount,
        );
        if (sourceMismatch) {
          throw new AcceptanceBindingError(
            "acceptance_binding_pre_launch",
            sourceMismatch,
          );
        }
        report.acceptance = buildAcceptanceStamp({
          context: acceptanceContext,
          expectations: acceptanceExpectations,
          source,
          sealedReport: sealedRun.sealedReport,
          seal: sealedRun.seal,
          launchPlan: sealedLaunchPlan,
          expectedSealSha256: sealedRun.expectedSealSha256,
        });
      });
    }

    ({ app, page } = await runPhase("launch_discovery_app", () =>
      launchApp(initialLaunchEnv, sealedLaunchPlan),
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
    if (sealedLaunchPlan) {
      // Mid-run authority: the accepted app and sealed Electron must still be
      // byte-identical before the deterministic relaunch.
      await runPhase("verify_sealed_runtime_before_relaunch", async () => {
        await verifySealedAcceptedAppReady(
          sealedLaunchPlan,
          sealedRun.sealedReport.acceptedApp,
        );
        await verifySealedElectronIdentity(sealedRun.seal);
      });
    }
    ({ app, page } = await runPhase("relaunch_with_deterministic_test_ai", () =>
      launchApp(relaunchEnv, sealedLaunchPlan),
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
    if (error instanceof AcceptanceBindingError) {
      report.outcome = "failed_acceptance_binding";
      report.blocker = {
        stage: error.stage,
        summary: summarizeError(error),
      };
      acceptanceViolation = error;
    } else {
      report.outcome = "blocked_without_submit";
      report.blocker = {
        stage: error instanceof SmokeBlocker ? error.stage : "unexpected",
        summary: summarizeError(error),
      };
    }
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
    // The strict safety/cleanup gate runs BEFORE the final binding stamp so
    // release evidence is decided with every violation already on record.
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
    if (report.acceptance && acceptanceExpectations) {
      await finalizeAcceptanceBinding();
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
  if (
    String(report.outcome).startsWith("stopped_") &&
    requiresNonzeroExitForStop(report)
  ) {
    // Bound/gated runs must never exit zero on an unclassified stop.
    acceptanceViolation ??= new Error(
      `Run ended as '${report.outcome}', which is not an accepted safe outcome.`,
    );
    report.acceptanceViolations.push(
      `outcome:${report.outcome} is not an accepted safe outcome`,
    );
    report.blocker = report.blocker ?? {
      stage: "unclassified_stop_outcome",
      summary: acceptanceViolation.message,
    };
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
// the exported binding helpers without launching Electron.
if (process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN !== "1") {
  await runPrepareOnlySmoke().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
