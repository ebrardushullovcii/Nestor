import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_VERSION,
  artifactFingerprint,
  artifactRoot,
  createFinalAcceptanceSeal,
  digestSeed,
  materializeSourceSnapshot,
  repositoryRoot,
  sha256File,
  sourceFingerprint,
  stableJson,
  treeFingerprint,
} from "./release-acceptance-harness.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const smokeScriptPath = path.join(
  scriptDir,
  "test-job-finder-prepare-only.mjs",
);

const FAKE_ARTIFACT_DIGEST = "b".repeat(64);
const BOGUS_EXPECTED_DIGEST = "0".repeat(64);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertThrows(operation, pattern, label) {
  let thrown = null;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, `${label} did not throw.`);
  const summary = thrown instanceof Error ? thrown.message : String(thrown);
  assert(
    pattern.test(summary),
    `${label} threw an unexpected message: ${summary}`,
  );
  return thrown;
}

async function createTemporaryRunDirectory(prefix) {
  return mkdir(
    path.join(artifactRoot, `${prefix}-${process.pid}-${Date.now()}`),
    { recursive: true },
  );
}

// The harness seals every acceptance manifest: loadAcceptanceContext verifies
// manifestSha256 against the canonical JSON digest. The fixture below mirrors
// that contract, including a live-worktree capturedWorktree inventory.
function buildFakeManifest(directory) {
  const manifest = {
    acceptanceVersion: ACCEPTANCE_VERSION,
    runDir: directory,
    pass: true,
    source: {
      afterBuild: { algorithm: "sha256", digest: "c".repeat(64) },
      capturedWorktree: {
        algorithm: "sha256",
        recipe: "stable-json-lines:path-kind-mode-bytes-sha256-or-link-target",
        digest: "a".repeat(64),
        fileCount: 0,
        files: [],
      },
    },
    artifacts: {
      algorithm: "sha256",
      digest: FAKE_ARTIFACT_DIGEST,
      fileCount: 0,
      files: [],
    },
  };
  return { manifest, manifestSha256: digestSeed(manifest) };
}

async function writeSealedFakeManifest(directory) {
  const { manifest, manifestSha256 } = buildFakeManifest(directory);
  await writeFile(
    path.join(directory, "build-manifest.json"),
    `${JSON.stringify({ ...manifest, manifestSha256 }, null, 2)}\n`,
    "utf8",
  );
  return manifestSha256;
}

async function runGit(args, cwd) {
  await execFileAsync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd,
    windowsHide: true,
  });
}

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Best-effort synchronous cleanup so failed validation never leaves temp
// trees behind, regardless of where the linear script throws.
import { rmSync } from "node:fs";
const temporaryDirectories = [];
function temporaryDirectoriesPush(directory) {
  if (directory) temporaryDirectories.push(directory);
}
process.on("exit", () => {
  for (const directory of temporaryDirectories.reverse()) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; validation failures already surfaced.
    }
  }
});

// Dependency inventories with zero roots reduce to the empty sha256 inventory;
// verifySealedAcceptanceBootstrap compares this shape against a recomputed one.
const EMPTY_DEPENDENCY_INVENTORY = Object.freeze({
  algorithm: "sha256",
  digest: sha256Bytes(""),
  fileCount: 0,
  roots: [],
  files: [],
});

// A minimal read-only accepted app whose inventory is computed exactly like
// the production exporter computes it (same entry shape and ordering).
async function buildSyntheticAcceptedApp(runDir) {
  const acceptedAppPath = "accepted-app";
  const appRoot = path.join(runDir, acceptedAppPath);
  await mkdir(path.join(appRoot, "out", "main"), { recursive: true });
  await mkdir(path.join(appRoot, "out", "preload"), { recursive: true });
  await mkdir(path.join(appRoot, "out", "renderer"), { recursive: true });
  const packageMetadata = {
    name: "@nestor/desktop",
    version: "0.1.0",
    description: "synthetic accepted-app fixture",
    author: "Nestor contributors",
    private: true,
    main: "out/main/index.cjs",
  };
  const files = [
    ["package.json", `${JSON.stringify(packageMetadata)}\n`],
    ["out/main/index.cjs", "// synthetic accepted main\n"],
    ["out/preload/index.js", "// synthetic accepted preload\n"],
    ["out/renderer/index.html", "<!doctype html>\n"],
  ];
  for (const [relative, contents] of files) {
    const filePath = path.join(appRoot, relative);
    await writeFile(filePath, contents, "utf8");
    await chmod(filePath, 0o444);
  }
  const inventory = await treeFingerprint(appRoot);
  return {
    ...inventory,
    path: acceptedAppPath,
    packageMetadata,
    sourceDigest: "",
    artifactDigest: "f".repeat(64),
    artifactFileCount: files.length - 1,
    runtimePackages: [],
    dependencyExportStrategy:
      "symlink-free-dereferenced-logical-node-modules-from-immutable-snapshot",
    launch: { args: ["."], cwd: acceptedAppPath, main: "out/main/index.cjs" },
    readOnly: true,
    verifiedAfterSnapshotCleanup: true,
  };
}

// A full synthetic sealed bootstrap: exact-build manifest, acceptance report
// with captured worktree/dependency inventories, accepted app on disk, and a
// final seal binding all of them plus an Electron executable identity.
async function buildSyntheticSealedRun({ runDir, realSource }) {
  const manifest = {
    acceptanceVersion: ACCEPTANCE_VERSION,
    runDir,
    pass: true,
    source: {
      afterBuild: { algorithm: "sha256", digest: "c".repeat(64) },
      capturedWorktree: realSource,
    },
    artifacts: {
      algorithm: "sha256",
      digest: "f".repeat(64),
      fileCount: 3,
      files: [],
    },
  };
  const manifestSha256 = digestSeed(manifest);
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ ...manifest, manifestSha256 }, null, 2)}\n`,
    "utf8",
  );

  const acceptedApp = await buildSyntheticAcceptedApp(runDir);
  acceptedApp.sourceDigest = realSource.digest;

  const electronIdentity = {
    executablePath: process.execPath,
    bytes: (await stat(process.execPath)).size,
    sha256: await sha256File(process.execPath),
    electronPackageVersion: "0.0.0-synthetic-fixture",
    playwrightPackageVersion: "0.0.0-synthetic-fixture",
  };

  const sealedReport = {
    acceptanceVersion: ACCEPTANCE_VERSION,
    runDir,
    pass: true,
    initialManifestSha256: manifestSha256,
    source: { capturedWorktree: realSource },
    snapshot: {
      dependencies: {
        roots: [],
        originalBeforeCopy: EMPTY_DEPENDENCY_INVENTORY,
      },
    },
    acceptedApp,
    electron: { final: electronIdentity },
  };
  const reportCanonicalSha256 = digestSeed(sealedReport);
  const reportBytes = Buffer.from(
    `${JSON.stringify(sealedReport, null, 2)}\n`,
    "utf8",
  );

  const seal = createFinalAcceptanceSeal({
    runId: path.basename(runDir),
    runDir,
    sourceId: realSource.digest,
    artifactId: "f".repeat(64),
    initialBuildManifest: {
      path: "build-manifest.json",
      rawSha256: sha256Bytes(manifestBytes),
      canonicalSha256: manifestSha256,
    },
    finalReport: {
      path: "acceptance-report.json",
      rawSha256: sha256Bytes(reportBytes),
      canonicalSha256: reportCanonicalSha256,
    },
    acceptedApp: {
      path: acceptedApp.path,
      digest: acceptedApp.digest,
      fileCount: acceptedApp.fileCount,
    },
    electron: electronIdentity,
    evidence: { digest: "2".repeat(64), fileCount: 0 },
    runtimeProbeSha256: "3".repeat(64),
  });

  await writeFile(path.join(runDir, "build-manifest.json"), manifestBytes);
  await writeFile(path.join(runDir, "acceptance-report.json"), reportBytes);
  await writeFile(
    path.join(runDir, "acceptance-seal.json"),
    `${JSON.stringify(seal, null, 2)}\n`,
    "utf8",
  );
  return {
    manifestSha256,
    sealedReport,
    seal,
    acceptedApp,
    appRoot: path.join(runDir, "accepted-app"),
  };
}

for (const filePath of [smokeScriptPath]) {
  const result = await execFileAsync(process.execPath, ["--check", filePath], {
    windowsHide: true,
  });
  assert(
    !result.stderr,
    `prepare-only smoke failed syntax validation: ${result.stderr}`,
  );
}

const smokeSource = await readFile(smokeScriptPath, "utf8");
assert(
  smokeSource.includes("JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN"),
  "The prepare-only smoke lost its validation opt-out; binding tests could not import it safely.",
);

process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN = "1";
const smokeModule = await import(smokeScriptPath);
delete process.env.JOB_FINDER_PREPARE_ONLY_SKIP_SMOKE_RUN;
for (const exportName of [
  "resolveAcceptanceInput",
  "loadBoundAcceptanceContext",
  "loadSealedAcceptanceRun",
  "assertSealedManifestIdentity",
  "planSealedAcceptedAppLaunch",
  "verifySealedAcceptedAppReady",
  "verifySealedRunIntegrityAfterRun",
  "verifySealedElectronIdentity",
  "readAcceptanceExpectations",
  "describeFingerprintMismatch",
  "collectFingerprintMismatches",
  "buildAcceptanceStamp",
  "classifyApplicationSafeBlocker",
  "collectStrictAcceptanceViolations",
  "evaluateStrictPrepareOnlyAcceptance",
  "decideReleaseEvidence",
  "resolvePrepareOnlyOutcome",
  "requiresNonzeroExitForStop",
  "buildChildLaunchEnv",
  "childEnvAuthorizesIntermediateWrites",
  "summarizeOriginalResumeEvidence",
  "BOUND_SOURCE_SUBJECT",
  "BOUND_SOURCE_RECIPE",
  "SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD",
  "SAFE_BLOCKER_KIND_UNCLASSIFIED",
  "OUTCOME_STOPPED_UNCLASSIFIED",
]) {
  assert(
    smokeModule[exportName] !== undefined,
    `The prepare-only smoke no longer exports ${exportName}.`,
  );
}
for (const exportName of [
  "resolveAcceptanceInput",
  "loadBoundAcceptanceContext",
  "loadSealedAcceptanceRun",
  "assertSealedManifestIdentity",
  "planSealedAcceptedAppLaunch",
  "verifySealedAcceptedAppReady",
  "verifySealedRunIntegrityAfterRun",
  "verifySealedElectronIdentity",
  "readAcceptanceExpectations",
  "describeFingerprintMismatch",
  "collectFingerprintMismatches",
  "buildAcceptanceStamp",
  "classifyApplicationSafeBlocker",
  "collectStrictAcceptanceViolations",
  "evaluateStrictPrepareOnlyAcceptance",
  "decideReleaseEvidence",
  "resolvePrepareOnlyOutcome",
  "requiresNonzeroExitForStop",
  "buildChildLaunchEnv",
  "childEnvAuthorizesIntermediateWrites",
  "summarizeOriginalResumeEvidence",
]) {
  assert(
    typeof smokeModule[exportName] === "function",
    `The prepare-only smoke export ${exportName} is not a function.`,
  );
}

const {
  BOUND_SOURCE_SUBJECT,
  BOUND_SOURCE_RECIPE,
  CHILD_ENV_SECRET_VARS,
  OUTCOME_STOPPED_UNCLASSIFIED,
} = smokeModule;

// ---- Acceptance env: all-or-nothing intent matrix.

assert(
  smokeModule.resolveAcceptanceInput({}) === null &&
    smokeModule.resolveAcceptanceInput({
      JOB_FINDER_ACCEPTANCE_MANIFEST: "   ",
      JOB_FINDER_ACCEPTANCE_RUN_DIR: "",
      JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: " ",
      JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "\t",
    }) === null,
  "A fully empty/whitespace acceptance environment must keep unbound diagnostic mode.",
);

const completeInput = smokeModule.resolveAcceptanceInput({
  JOB_FINDER_ACCEPTANCE_RUN_DIR: "/tmp/fake-run",
  JOB_FINDER_ACCEPTANCE_MANIFEST: "/tmp/fake-run/custom-manifest.json",
  JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "a".repeat(64),
  JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "b".repeat(64),
});
assert(
  completeInput.manifestPath === "/tmp/fake-run/custom-manifest.json" &&
    completeInput.runDir === "/tmp/fake-run" &&
    completeInput.manifestSha256 === "a".repeat(64) &&
    completeInput.expectedSealSha256 === "b".repeat(64),
  "A complete acceptance environment must resolve verbatim.",
);

for (const [label, env] of Object.entries({
  runDirOnly: {
    JOB_FINDER_ACCEPTANCE_RUN_DIR: "/tmp/fake-run",
    JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "a".repeat(64),
    JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "b".repeat(64),
  },
  manifestOnly: {
    JOB_FINDER_ACCEPTANCE_MANIFEST: "/tmp/fake-run/build-manifest.json",
    JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "a".repeat(64),
    JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "b".repeat(64),
  },
  missingExpectedSeal: {
    JOB_FINDER_ACCEPTANCE_RUN_DIR: "/tmp/fake-run",
    JOB_FINDER_ACCEPTANCE_MANIFEST: "/tmp/fake-run/build-manifest.json",
    JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "a".repeat(64),
  },
  malformedManifestDigest: {
    JOB_FINDER_ACCEPTANCE_RUN_DIR: "/tmp/fake-run",
    JOB_FINDER_ACCEPTANCE_MANIFEST: "/tmp/fake-run/build-manifest.json",
    JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "not-a-digest",
    JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "b".repeat(64),
  },
  malformedSealDigest: {
    JOB_FINDER_ACCEPTANCE_RUN_DIR: "/tmp/fake-run",
    JOB_FINDER_ACCEPTANCE_MANIFEST: "/tmp/fake-run/build-manifest.json",
    JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256: "a".repeat(64),
    JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "zzz",
  },
})) {
  await assertThrows(
    () => Promise.resolve(smokeModule.resolveAcceptanceInput(env)),
    /acceptance variables are all-or-nothing/u,
    `A partial/malformed acceptance environment (${label}) must be refused.`,
  );
}
// A single stray variable alone is also intent and must not pass silently.
await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.resolveAcceptanceInput({
        JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256: "b".repeat(64),
      }),
    ),
  /acceptance variables are all-or-nothing/u,
  "An expected-seal-only environment must be refused as partial.",
);

// ---- Child launch env sanitizer under ambient pollution.

const pollutedEnv = {
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_RENDERER_URL: "http://localhost:5173",
  JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES: "1",
  NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES: "1",
  NESTOR_TEST_API_USE_LIVE_AI: "1",
  ...Object.fromEntries(
    CHILD_ENV_SECRET_VARS.map((name, index) => [name, `secret-${index}`]),
  ),
  NESTOR_BROWSER_AGENT: "0",
  NESTOR_ENABLE_TEST_API: "0",
  PATH: "/usr/bin:/bin",
};

const sanitizedStrict = smokeModule.buildChildLaunchEnv({
  userDataDirectory: "/tmp/user-data",
  forceLiveAi: false,
  intermediateWritesAuthorized: false,
  sourceEnv: pollutedEnv,
});
assert(
  sanitizedStrict.ELECTRON_RUN_AS_NODE === undefined &&
    sanitizedStrict.ELECTRON_RENDERER_URL === undefined &&
    sanitizedStrict.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES ===
      undefined &&
    sanitizedStrict.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES ===
      undefined &&
    sanitizedStrict.NESTOR_TEST_API_USE_LIVE_AI === undefined,
  "Ambient write/live-AI/routing overrides must be deleted from the strict child env.",
);
assert(
  CHILD_ENV_SECRET_VARS.every((name) => sanitizedStrict[name] === undefined),
  "Provider/API secret variables must never reach the child env.",
);
assert(
  sanitizedStrict.NESTOR_BROWSER_AGENT === "1" &&
    sanitizedStrict.NESTOR_BROWSER_HEADLESS === "1" &&
    sanitizedStrict.NESTOR_ENABLE_TEST_API === "1" &&
    sanitizedStrict.NESTOR_USER_DATA_DIR === "/tmp/user-data" &&
    sanitizedStrict.PATH === "/usr/bin:/bin",
  "Safe explicit browser/test/userData values must be set without nuking unrelated vars.",
);
assert(
  smokeModule.childEnvAuthorizesIntermediateWrites(sanitizedStrict) === false,
  "Sanitized strict env must read back as unauthorized.",
);

const authorizedDiagnostic = smokeModule.buildChildLaunchEnv({
  userDataDirectory: "/tmp/user-data",
  forceLiveAi: true,
  intermediateWritesAuthorized: true,
  sourceEnv: pollutedEnv,
});
assert(
  authorizedDiagnostic.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES ===
    "1" &&
    authorizedDiagnostic.NESTOR_TEST_API_USE_LIVE_AI === "1" &&
    smokeModule.childEnvAuthorizesIntermediateWrites(authorizedDiagnostic) ===
      true,
  "Explicit diagnostic authorization must be reflected in the final child env.",
);
assert(
  authorizedDiagnostic.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES ===
    undefined,
  "Wrapper-level authorization intent must still never reach the child.",
);
// Bound mode can never authorize writes, even with ambient opt-in.
assert(
  smokeModule.childEnvAuthorizesIntermediateWrites(
    smokeModule.buildChildLaunchEnv({
      userDataDirectory: "/tmp/user-data",
      forceLiveAi: false,
      intermediateWritesAuthorized: false,
      sourceEnv: pollutedEnv,
    }),
  ) === false,
  "Bound sealed mode must force intermediate writes off regardless of ambient variables.",
);

// ---- Outcome classification and stop semantics.

assert(
  smokeModule.resolvePrepareOnlyOutcome({
    finalControlState: "reached_without_submit",
    expectedBlockerCode: null,
    attemptBlockerCode: null,
    safeBlockerKind: null,
  }) === "passed_final_checkpoint_without_submit",
  "Reaching the final control must classify as the passed checkpoint outcome.",
);
assert(
  smokeModule.resolvePrepareOnlyOutcome({
    finalControlState: "blocked_before_final_control",
    expectedBlockerCode: "site_login_required",
    attemptBlockerCode: "site_login_required",
    safeBlockerKind: null,
  }) === "passed_expected_human_handoff_without_submit",
  "The Workday expected blocker must classify as the human handoff outcome.",
);
assert(
  smokeModule.resolvePrepareOnlyOutcome({
    finalControlState: "blocked_before_final_control",
    expectedBlockerCode: null,
    attemptBlockerCode: "requires_manual_review",
    safeBlockerKind: "intermediate_write_guard",
  }) === "passed_safe_blocker_without_submit",
  "A classified write-guard handoff must keep its passed outcome label.",
);
assert(
  smokeModule.resolvePrepareOnlyOutcome({
    finalControlState: "blocked_before_final_control",
    expectedBlockerCode: null,
    attemptBlockerCode: "unknown",
    safeBlockerKind: "unclassified",
  }) === OUTCOME_STOPPED_UNCLASSIFIED &&
    OUTCOME_STOPPED_UNCLASSIFIED === "stopped_unclassified_without_submit" &&
    !OUTCOME_STOPPED_UNCLASSIFIED.startsWith("passed_"),
  "An unclassified generic stop must get a non-passed outcome name.",
);
assert(
  smokeModule.requiresNonzeroExitForStop({
    outcome: "stopped_unclassified_without_submit",
    acceptanceMode: "bound_to_exact_build_manifest",
  }) === true &&
    smokeModule.requiresNonzeroExitForStop({
      outcome: "stopped_unclassified_without_submit",
      acceptanceMode: "unbound_diagnostic",
    }) === false &&
    smokeModule.requiresNonzeroExitForStop({
      outcome: "passed_final_checkpoint_without_submit",
      acceptanceMode: "unbound_diagnostic",
    }) === false,
  "Stopped outcomes exit nonzero except in explicitly diagnostic mode.",
);

// ---- Release-evidence conjunction ordering scenarios.

function buildGateState(overrides = {}) {
  return {
    evaluated: true,
    accepted: true,
    violations: [],
    requireFinalCheckpoint: true,
    expectedBlockerCode: null,
    ...overrides,
  };
}
const healthyDecisionInputs = {
  strictGate: buildGateState(),
  acceptedOutcome: true,
  bindingVerified: true,
  integrityVerified: true,
  childWritesAuthorized: false,
  submittedNeverOccurred: true,
  finalSubmitAuthorized: false,
  accountCreationAuthorized: false,
  isolatedTemporaryProfile: true,
  isolationCleanedUp: true,
};
assert(
  smokeModule.decideReleaseEvidence(healthyDecisionInputs).releaseEvidence ===
    true,
  "A fully healthy gated run must produce release evidence.",
);
for (const [label, overrides] of Object.entries({
  cleanupFailure: { isolationCleanedUp: false },
  submissionObserved: { submittedNeverOccurred: false },
  submitAuthorityElevated: { finalSubmitAuthorized: true },
  accountAuthorityElevated: { accountCreationAuthorized: true },
  diagnosticWriteMode: { childWritesAuthorized: true },
  bindingNotVerified: { bindingVerified: false },
  integrityNotVerified: { integrityVerified: false },
  stoppedOutcome: { acceptedOutcome: false },
  gateRefused: {
    strictGate: buildGateState({
      accepted: false,
      violations: ["generic stop"],
    }),
  },
})) {
  const decision = smokeModule.decideReleaseEvidence({
    ...healthyDecisionInputs,
    ...overrides,
  });
  assert(
    decision.releaseEvidence === false && decision.violations.length > 0,
    `Release evidence must be refused when '${label}' occurs.`,
  );
}
assert(
  smokeModule.decideReleaseEvidence({
    ...healthyDecisionInputs,
    strictGate: buildGateState({ evaluated: false }),
  }).releaseEvidence === true,
  "Ungated bound runs may earn release evidence only for an accepted outcome.",
);
assert(
  smokeModule.decideReleaseEvidence({
    ...healthyDecisionInputs,
    strictGate: buildGateState({ evaluated: false }),
    acceptedOutcome: false,
  }).releaseEvidence === false,
  "An ungated stopped outcome must never carry release evidence.",
);

// ---- Bound context loading and environment restoration.

const boundRunDir = await createTemporaryRunDirectory(
  "prepare-only-binding-valid",
);
temporaryDirectoriesPush(boundRunDir);
const fakeManifestSha256 = await writeSealedFakeManifest(boundRunDir);
const context = await smokeModule.loadBoundAcceptanceContext({
  manifestPath: path.join(boundRunDir, "build-manifest.json"),
  runDir: boundRunDir,
  manifestSha256: fakeManifestSha256,
});
assert(
  context.component === "job_finder_prepare_only_smoke" &&
    context.runDir === boundRunDir &&
    context.manifestPath === path.join(boundRunDir, "build-manifest.json") &&
    context.outputDir ===
      path.join(boundRunDir, "job_finder_prepare_only_smoke"),
  "The bound acceptance context does not match the exact-build contract.",
);
assert(
  process.env.JOB_FINDER_ACCEPTANCE_MANIFEST === undefined &&
    process.env.JOB_FINDER_ACCEPTANCE_RUN_DIR === undefined &&
    process.env.JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256 === undefined,
  "Binding must restore the acceptance environment after loading.",
);

const outsideDir = await mkdtemp(
  path.join(os.tmpdir(), "nestor-prepare-only-binding-escaped-"),
);
temporaryDirectoriesPush(outsideDir);
await assertThrows(
  () =>
    smokeModule.loadBoundAcceptanceContext({
      manifestPath: path.join(outsideDir, "build-manifest.json"),
      runDir: outsideDir,
    }),
  /escaped|run directory/iu,
  "An out-of-artifact-root run directory must be refused.",
);

// ---- Expectation extraction: bound subject is manifest.source.capturedWorktree.

const validExpectations = smokeModule.readAcceptanceExpectations({
  acceptanceVersion: ACCEPTANCE_VERSION,
  source: {
    capturedWorktree: {
      algorithm: "sha256",
      recipe: BOUND_SOURCE_RECIPE,
      digest: "a".repeat(64),
      fileCount: 3,
      files: [
        {
          path: "one.txt",
          kind: "file",
          mode: 420,
          bytes: 2,
          sha256: "d".repeat(64),
        },
        {
          path: "two.txt",
          kind: "file",
          mode: 493,
          bytes: 3,
          sha256: "e".repeat(64),
        },
        {
          path: "link",
          kind: "symlink",
          mode: 420,
          target: "one.txt",
          resolvedPath: "one.txt",
        },
      ],
    },
  },
  artifacts: { digest: FAKE_ARTIFACT_DIGEST, fileCount: 42 },
});
assert(
  validExpectations.sourceSubject === BOUND_SOURCE_SUBJECT &&
    validExpectations.sourceRecipe === BOUND_SOURCE_RECIPE &&
    validExpectations.sourceDigest === "a".repeat(64) &&
    validExpectations.sourceFileCount === 3 &&
    validExpectations.artifactDigest === FAKE_ARTIFACT_DIGEST &&
    validExpectations.artifactFileCount === 42,
  "Valid manifest expectations were not extracted verbatim from the captured worktree inventory.",
);

const expectationsFrom = (capturedWorktree, artifacts) => () =>
  Promise.resolve(
    smokeModule.readAcceptanceExpectations({
      acceptanceVersion: ACCEPTANCE_VERSION,
      source: { capturedWorktree },
      artifacts,
    }),
  );

await assertThrows(
  expectationsFrom(undefined, { digest: FAKE_ARTIFACT_DIGEST, fileCount: 1 }),
  new RegExp(
    `no live worktree source inventory at ${BOUND_SOURCE_SUBJECT.replace(/\./gu, "\\.")}`,
    "u",
  ),
  "A manifest without the captured worktree inventory must be refused.",
);
await assertThrows(
  expectationsFrom(
    {
      algorithm: "sha256",
      recipe: BOUND_SOURCE_RECIPE,
      digest: "not-a-digest",
      fileCount: 0,
      files: [],
    },
    { digest: FAKE_ARTIFACT_DIGEST, fileCount: 1 },
  ),
  new RegExp(`${BOUND_SOURCE_SUBJECT.replace(/\./gu, "\\.")}\\.digest`, "u"),
  "An invalid captured-worktree digest must be refused.",
);
await assertThrows(
  expectationsFrom(
    {
      algorithm: "sha256",
      recipe:
        "stable-json-lines:snapshot-inventory-with-source-and-snapshot-mode",
      digest: "a".repeat(64),
      fileCount: 1,
      files: [
        {
          path: "one.txt",
          kind: "file",
          sourceMode: 420,
          snapshotMode: 420,
          bytes: 2,
          sha256: "d".repeat(64),
        },
      ],
    },
    { digest: FAKE_ARTIFACT_DIGEST, fileCount: 1 },
  ),
  /snapshot-only inventories cannot be substituted/u,
  "A snapshot-recipe inventory substituted as the captured worktree must be refused.",
);
await assertThrows(
  expectationsFrom(
    {
      algorithm: "sha256",
      recipe: BOUND_SOURCE_RECIPE,
      digest: "a".repeat(64),
      fileCount: 1,
    },
    { digest: FAKE_ARTIFACT_DIGEST, fileCount: 1 },
  ),
  /cannot be audited as a full live-worktree capture/u,
  "A digest-only stub without its files list must be refused.",
);
await assertThrows(
  expectationsFrom(
    {
      algorithm: "sha256",
      recipe: BOUND_SOURCE_RECIPE,
      digest: "a".repeat(64),
      fileCount: 5,
      files: [],
    },
    { digest: FAKE_ARTIFACT_DIGEST, fileCount: 1 },
  ),
  /files list matching its declared file count/u,
  "A captured-worktree file count that contradicts its files list must be refused.",
);
await assertThrows(
  expectationsFrom(
    {
      algorithm: "sha256",
      recipe: BOUND_SOURCE_RECIPE,
      digest: "a".repeat(64),
      fileCount: 0,
      files: [],
    },
    {},
  ),
  /artifacts\.digest/u,
  "Missing artifact hashes must be refused.",
);
await assertThrows(
  () => Promise.resolve(smokeModule.readAcceptanceExpectations(null)),
  /did not parse into an object/u,
  "A non-object manifest must be refused.",
);

// ---- Real parity fixtures over a real fixture tree (not digest stubs).

const parityFixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "nestor-prepare-only-parity-source-"),
);
temporaryDirectoriesPush(parityFixtureRoot);
const paritySnapshotRoot = await mkdtemp(
  path.join(os.tmpdir(), "nestor-prepare-only-parity-snapshot-"),
);
temporaryDirectoriesPush(paritySnapshotRoot);
await runGit(["init", "-q"], parityFixtureRoot);
await mkdir(path.join(parityFixtureRoot, "nested"), { recursive: true });
await writeFile(
  path.join(parityFixtureRoot, "README.md"),
  "# prepare-only parity fixture\n",
  "utf8",
);
await writeFile(
  path.join(parityFixtureRoot, "nested", "entry.sh"),
  "#!/bin/sh\necho parity\n",
  "utf8",
);
await chmod(path.join(parityFixtureRoot, "nested", "entry.sh"), 0o755);

const fixtureLiveFingerprint = await sourceFingerprint(parityFixtureRoot);
assert(
  /^[0-9a-f]{64}$/u.test(fixtureLiveFingerprint.digest) &&
    fixtureLiveFingerprint.fileCount === fixtureLiveFingerprint.files.length &&
    fixtureLiveFingerprint.fileCount === 2 &&
    fixtureLiveFingerprint.recipe === BOUND_SOURCE_RECIPE,
  "The recomputed fixture fingerprint is unusable.",
);
// A real snapshot inventory of the same bytes/path/mode tree: same content,
// different recipe and entry keys (sourceMode/snapshotMode), so its digest
// can never stand in for the live-worktree recipe.
const fixtureSnapshotFingerprint = await materializeSourceSnapshot(
  parityFixtureRoot,
  paritySnapshotRoot,
  fixtureLiveFingerprint,
);
assert(
  fixtureSnapshotFingerprint.fileCount === fixtureLiveFingerprint.fileCount &&
    fixtureSnapshotFingerprint.digest !== fixtureLiveFingerprint.digest &&
    fixtureSnapshotFingerprint.recipe !== fixtureLiveFingerprint.recipe &&
    fixtureSnapshotFingerprint.files.every(
      (entry) =>
        entry.sourceMode !== undefined && entry.snapshotMode !== undefined,
    ),
  "The snapshot inventory of identical bytes must differ from the live-worktree recipe.",
);

const fixtureExpectations = smokeModule.readAcceptanceExpectations({
  acceptanceVersion: ACCEPTANCE_VERSION,
  source: { capturedWorktree: fixtureLiveFingerprint },
  artifacts: { digest: FAKE_ARTIFACT_DIGEST, fileCount: 7 },
});
assert(
  smokeModule.collectFingerprintMismatches(
    fixtureExpectations,
    fixtureLiveFingerprint,
    { digest: FAKE_ARTIFACT_DIGEST, fileCount: 7 },
  ).length === 0,
  "A manifest carrying the real live-worktree inventory must bind against recomputed fingerprints.",
);

await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.readAcceptanceExpectations({
        acceptanceVersion: ACCEPTANCE_VERSION,
        source: { capturedWorktree: fixtureSnapshotFingerprint },
        artifacts: { digest: FAKE_ARTIFACT_DIGEST, fileCount: 7 },
      }),
    ),
  /snapshot-only inventories cannot be substituted/u,
  "A real snapshot inventory must not be substitutable for the captured worktree.",
);
const substitutedMismatches = smokeModule.collectFingerprintMismatches(
  {
    sourceDigest: fixtureSnapshotFingerprint.digest,
    sourceFileCount: fixtureSnapshotFingerprint.fileCount,
    artifactDigest: FAKE_ARTIFACT_DIGEST,
    artifactFileCount: 7,
  },
  fixtureLiveFingerprint,
  { digest: FAKE_ARTIFACT_DIGEST, fileCount: 7 },
);
assert(
  substitutedMismatches.length === 1 &&
    substitutedMismatches[0].includes(BOUND_SOURCE_SUBJECT) &&
    substitutedMismatches[0].includes(
      `expected=${fixtureSnapshotFingerprint.digest}/${fixtureSnapshotFingerprint.fileCount}`,
    ) &&
    substitutedMismatches[0].includes(
      `actual=${fixtureLiveFingerprint.digest}/${fixtureLiveFingerprint.fileCount}`,
    ),
  "Even ignoring the recipe pin, a substituted snapshot digest must produce a truthful mismatch.",
);

const changedSourcePath = path.join(parityFixtureRoot, "README.md");
await writeFile(changedSourcePath, "# changed parity fixture\n", "utf8");
const changedFixtureFingerprint = await sourceFingerprint(parityFixtureRoot);
const changedSourceMismatches = smokeModule.collectFingerprintMismatches(
  fixtureExpectations,
  changedFixtureFingerprint,
  { digest: FAKE_ARTIFACT_DIGEST, fileCount: 7 },
);
assert(
  changedSourceMismatches.length === 1 &&
    changedSourceMismatches[0].includes(BOUND_SOURCE_SUBJECT) &&
    changedSourceMismatches[0].includes("expected=") &&
    changedSourceMismatches[0].includes("actual="),
  "Changed source bytes must fail the bound expectation.",
);

// ---- Repository-scale binding sanity against the real worktree/artifacts.

const realSource = await sourceFingerprint();
const realArtifacts = await artifactFingerprint();
assert(
  /^[0-9a-f]{64}$/u.test(realSource.digest) && realSource.fileCount > 0,
  "The recomputed source fingerprint is unusable.",
);
assert(
  /^[0-9a-f]{64}$/u.test(realArtifacts.digest),
  "The recomputed artifact fingerprint is unusable.",
);
const realVsFakeMismatches = smokeModule.collectFingerprintMismatches(
  {
    sourceDigest: BOGUS_EXPECTED_DIGEST,
    sourceFileCount: 1,
    artifactDigest: BOGUS_EXPECTED_DIGEST,
    artifactFileCount: 2,
  },
  realSource,
  realArtifacts,
);
assert(
  realVsFakeMismatches.length === 2 &&
    realVsFakeMismatches.every(
      (message) =>
        message.includes(
          `actual=${realSource.digest}/${realSource.fileCount}`,
        ) ||
        message.includes(
          `actual=${realArtifacts.digest}/${realArtifacts.fileCount}`,
        ),
    ),
  "A fake manifest versus real fingerprints must produce truthful expected/actual diagnostics.",
);
assert(
  realVsFakeMismatches.every((message) => !/\bpassed\b/iu.test(message)),
  "Binding mismatch diagnostics must never claim a passed outcome.",
);
assert(
  realVsFakeMismatches.some((message) =>
    message.includes(BOUND_SOURCE_SUBJECT),
  ),
  "Source mismatch diagnostics must name the bound manifest subject.",
);

// ---- Sealed accepted-app launch plan, integrity, and refusal cases.

const sealedRunDir = await createTemporaryRunDirectory(
  "prepare-only-sealed-run",
);
temporaryDirectoriesPush(sealedRunDir);
// Captured immediately before sealing so verifySealedAcceptanceBootstrap's
// current-worktree equality holds while this validator runs.
const freshRealSource = await sourceFingerprint();
const sealedFixture = await buildSyntheticSealedRun({
  runDir: sealedRunDir,
  realSource: freshRealSource,
});

await assertThrows(
  () =>
    smokeModule.loadSealedAcceptanceRun({
      manifestPath: path.join(sealedRunDir, "build-manifest.json"),
      runDir: sealedRunDir,
      manifestSha256: sealedFixture.manifestSha256,
      expectedSealSha256: null,
    }),
  /JOB_FINDER_ACCEPTANCE_EXPECTED_SEAL_SHA256/u,
  "A bound run without the expected-seal variable must be refused.",
);
await assertThrows(
  () =>
    smokeModule.loadSealedAcceptanceRun({
      manifestPath: path.join(sealedRunDir, "build-manifest.json"),
      runDir: sealedRunDir,
      manifestSha256: sealedFixture.manifestSha256,
      expectedSealSha256: "9".repeat(64),
    }),
  /[Ss]eal digest mismatch|seal/u,
  "A wrong expected seal must be refused by the seal verifier.",
);

const boundSealedRun = await smokeModule.loadSealedAcceptanceRun({
  manifestPath: path.join(sealedRunDir, "build-manifest.json"),
  runDir: sealedRunDir,
  manifestSha256: sealedFixture.manifestSha256,
  expectedSealSha256: sealedFixture.seal.sealSha256,
});
assert(
  boundSealedRun.context.runDir === sealedRunDir &&
    boundSealedRun.context.manifest.manifestSha256 ===
      sealedFixture.manifestSha256 &&
    boundSealedRun.sealedReport.pass === true &&
    boundSealedRun.expectedSealSha256 === sealedFixture.seal.sealSha256,
  "The sealed acceptance bootstrap did not load as expected.",
);
const sealedExpectations = smokeModule.readAcceptanceExpectations(
  boundSealedRun.context.manifest,
);
smokeModule.assertSealedManifestIdentity({
  context: boundSealedRun.context,
  expectations: sealedExpectations,
  sealedReport: boundSealedRun.sealedReport,
  seal: boundSealedRun.seal,
});

// Pairwise seal/report mismatches must each refuse.
for (const [field, value] of Object.entries({
  path: "other-app",
  digest: "9".repeat(64),
  fileCount: 999,
})) {
  await assertThrows(
    () =>
      Promise.resolve(
        smokeModule.assertSealedManifestIdentity({
          context: boundSealedRun.context,
          expectations: sealedExpectations,
          sealedReport: boundSealedRun.sealedReport,
          seal: {
            ...boundSealedRun.seal,
            acceptedApp: {
              ...boundSealedRun.seal.acceptedApp,
              [field]: value,
            },
          },
        }),
      ),
    new RegExp(`Accepted-app ${field} differs between seal`, "u"),
    `A seal/report accepted-app ${field} mismatch must be refused.`,
  );
}
for (const [field, value] of Object.entries({
  sha256: "9".repeat(64),
  bytes: 1,
  electronPackageVersion: "9.9.9-mismatch",
})) {
  await assertThrows(
    () =>
      Promise.resolve(
        smokeModule.assertSealedManifestIdentity({
          context: boundSealedRun.context,
          expectations: sealedExpectations,
          sealedReport: boundSealedRun.sealedReport,
          seal: {
            ...boundSealedRun.seal,
            electron: { ...boundSealedRun.seal.electron, [field]: value },
          },
        }),
      ),
    new RegExp(`Electron identity field '${field}' differs`, "u"),
    `A seal/report Electron ${field} mismatch must be refused.`,
  );
}
await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.assertSealedManifestIdentity({
        context: boundSealedRun.context,
        expectations: sealedExpectations,
        sealedReport: {
          ...boundSealedRun.sealedReport,
          initialManifestSha256: undefined,
        },
        seal: boundSealedRun.seal,
      }),
    ),
  /no well-formed initialManifestSha256/u,
  "A sealed report without initialManifestSha256 must be refused.",
);
await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.assertSealedManifestIdentity({
        context: {
          ...boundSealedRun.context,
          manifest: {
            ...boundSealedRun.context.manifest,
            manifestSha256: "9".repeat(64),
          },
        },
        expectations: sealedExpectations,
        sealedReport: boundSealedRun.sealedReport,
        seal: boundSealedRun.seal,
      }),
    ),
  /different initial manifest digest|does not bind the loaded exact-build manifest digest/u,
  "A seal that binds another manifest must be refused.",
);

const launchPlan = smokeModule.planSealedAcceptedAppLaunch({
  runDir: sealedRunDir,
  acceptedApp: sealedFixture.acceptedApp,
  seal: sealedFixture.seal,
});
assert(
  launchPlan.kind === "sealed_accepted_app" &&
    launchPlan.cwd === sealedFixture.appRoot &&
    stableJson(launchPlan.args) === stableJson(["."]) &&
    launchPlan.executablePath === process.execPath &&
    launchPlan.acceptedAppRelativePath === "accepted-app",
  "The launch plan must derive cwd/args/executable from the sealed report and seal.",
);
// The sealed executable lives outside the run directory by design; identity
// is hash+size bound rather than path-confined.
assert(
  !launchPlan.executablePath.startsWith(sealedRunDir),
  "The fixture executable is outside the run directory, exercising the non-confinement rule.",
);
const readyInventory = await smokeModule.verifySealedAcceptedAppReady(
  launchPlan,
  sealedFixture.acceptedApp,
);
assert(
  readyInventory.digest === sealedFixture.acceptedApp.digest,
  "Pre-launch accepted-app verification must reproduce the sealed inventory.",
);

for (const evilPath of ["../escaped-app", "/absolute/accepted-app", "", null]) {
  await assertThrows(
    () =>
      Promise.resolve(
        smokeModule.planSealedAcceptedAppLaunch({
          runDir: sealedRunDir,
          acceptedApp: { ...sealedFixture.acceptedApp, path: evilPath },
          seal: sealedFixture.seal,
        }),
      ),
    /run-relative path without traversal|escaped its run directory/u,
    `An unsafe accepted-app path (${JSON.stringify(evilPath)}) must be refused.`,
  );
}
await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.planSealedAcceptedAppLaunch({
        runDir: sealedRunDir,
        acceptedApp: {
          ...sealedFixture.acceptedApp,
          launch: {
            ...sealedFixture.acceptedApp.launch,
            args: [".", "--no-sandbox"],
          },
        },
        seal: sealedFixture.seal,
      }),
    ),
  /exactly \['\.'\]/u,
  "Extra launch arguments in the seal must fail closed.",
);
await assertThrows(
  () =>
    Promise.resolve(
      smokeModule.planSealedAcceptedAppLaunch({
        runDir: sealedRunDir,
        acceptedApp: sealedFixture.acceptedApp,
        seal: { ...sealedFixture.seal, electron: undefined },
      }),
    ),
  /Electron executable identity/u,
  "A seal without Electron identity must be refused.",
);

const integrity = await smokeModule.verifySealedRunIntegrityAfterRun(
  launchPlan,
  sealedFixture.acceptedApp,
  sealedFixture.seal,
);
assert(
  integrity.acceptedApp.digest === sealedFixture.acceptedApp.digest &&
    integrity.electron.sha256 === sealedFixture.seal.electron.sha256 &&
    integrity.electron.bytes === sealedFixture.seal.electron.bytes,
  "Post-run integrity verification must reproduce the sealed identities.",
);
const midRelaunchIdentity = await smokeModule.verifySealedElectronIdentity(
  sealedFixture.seal,
);
assert(
  midRelaunchIdentity.sha256 === sealedFixture.seal.electron.sha256,
  "Mid-relaunch Electron identity verification must succeed while untouched.",
);
await assertThrows(
  () =>
    smokeModule.verifySealedRunIntegrityAfterRun(
      launchPlan,
      sealedFixture.acceptedApp,
      {
        ...sealedFixture.seal,
        electron: { ...sealedFixture.seal.electron, sha256: "9".repeat(64) },
      },
    ),
  /identity mismatch|changed after the run/u,
  "An Electron hash drift must fail post-run integrity.",
);

// Mid-run tamper: flip a byte, expect refusal, restore exactly, expect pass.
const tamperedFilePath = path.join(
  sealedFixture.appRoot,
  "out",
  "renderer",
  "index.html",
);
const originalTamperedBytes = await readFile(tamperedFilePath);
await chmod(tamperedFilePath, 0o644);
await writeFile(tamperedFilePath, "<!doctype html><title>tampered</title>\n");
await assertThrows(
  () =>
    smokeModule.verifySealedAcceptedAppReady(
      launchPlan,
      sealedFixture.acceptedApp,
    ),
  /extra, missing, aliased, or changed files/u,
  "Tampered accepted-app content must fail pre-launch verification.",
);
await assertThrows(
  () =>
    smokeModule.verifySealedRunIntegrityAfterRun(
      launchPlan,
      sealedFixture.acceptedApp,
      sealedFixture.seal,
    ),
  /extra, missing, aliased, or changed files/u,
  "Tampered accepted-app content must fail post-run verification.",
);
await writeFile(tamperedFilePath, originalTamperedBytes);
await chmod(tamperedFilePath, 0o444);
assert(
  (
    await smokeModule.verifySealedAcceptedAppReady(
      launchPlan,
      sealedFixture.acceptedApp,
    )
  ).digest === sealedFixture.acceptedApp.digest,
  "Restoring exact bytes/modes must make the accepted app verify again.",
);

// ---- Portable stamp schema and redaction scans.

const stamp = smokeModule.buildAcceptanceStamp({
  context: {
    manifestPath: "/absolute/local/run/build-manifest.json",
    runDir: "/absolute/local/run",
  },
  expectations: fixtureExpectations,
  source: realSource,
  sealedReport: { acceptedApp: sealedFixture.acceptedApp },
  seal: sealedFixture.seal,
  launchPlan,
  expectedSealSha256: sealedFixture.seal.sealSha256,
});
assert(
  stamp.version === ACCEPTANCE_VERSION &&
    stamp.bound === true &&
    stamp.releaseEvidence === false &&
    stamp.matchedManifestBeforeLaunch === true &&
    stamp.launchOrigin === "sealed_accepted_app" &&
    stamp.runId === "run" &&
    stamp.manifestSubject === "build-manifest.json" &&
    stamp.manifestPath === undefined &&
    stamp.runDir === undefined &&
    stamp.boundSourceSubject === BOUND_SOURCE_SUBJECT &&
    stamp.boundSourceRecipe === BOUND_SOURCE_RECIPE &&
    stamp.boundSourceManifestDigest === fixtureExpectations.sourceDigest &&
    stamp.boundSourceManifestFileCount ===
      fixtureExpectations.sourceFileCount &&
    stamp.sourceFingerprint === realSource.digest &&
    stamp.sourceFileCount === realSource.fileCount &&
    stamp.acceptedAppSubject === "sealedReport.acceptedApp" &&
    stamp.acceptedAppPath === "accepted-app" &&
    stamp.acceptedAppDigest === sealedFixture.acceptedApp.digest &&
    stamp.acceptedAppFileCount === sealedFixture.acceptedApp.fileCount &&
    stamp.sealSubject === "acceptance-seal.json" &&
    stamp.sealSha256 === sealedFixture.seal.sealSha256 &&
    stamp.electronSha256 === sealedFixture.seal.electron.sha256 &&
    stamp.electronBytes === sealedFixture.seal.electron.bytes &&
    stamp.electronPackageVersion ===
      sealedFixture.seal.electron.electronPackageVersion &&
    !("buildArtifactFingerprint" in stamp) &&
    !("buildArtifactFileCount" in stamp) &&
    !("buildArtifactsUnchangedAfterRun" in stamp) &&
    stamp.sourceFingerprintUnchangedAfterRun === null &&
    stamp.acceptedAppUnchangedAfterRun === null &&
    stamp.electronIdentityUnchangedAfterRun === null,
  "The acceptance stamp schema drifted from the required sealed-launch contract.",
);
const serializedStamp = JSON.stringify(stamp);
assert(
  !serializedStamp.includes("/absolute/local") &&
    !serializedStamp.includes(os.tmpdir()) &&
    !serializedStamp.includes(repositoryRoot),
  "The serialized stamp must not leak absolute local run/repo paths.",
);

// Resume/isolation summaries are portable: basename/id/digest only.
const resumeSummary = smokeModule.summarizeOriginalResumeEvidence({
  id: "resume-doc-1",
  fileName: "jamie-rivers-cv.txt",
  storagePath:
    "/Users/someone/Library/Application Support/nestor/resumes/internal.pdf",
  sha256: "e".repeat(64),
  extractionStatus: "completed",
});
assert(
  resumeSummary.resumeDocumentId === "resume-doc-1" &&
    resumeSummary.fileName === "jamie-rivers-cv.txt" &&
    resumeSummary.resumeSha256 === "e".repeat(64) &&
    resumeSummary.extractionStatus === "completed" &&
    !("storagePath" in resumeSummary) &&
    !("filePath" in resumeSummary),
  "The resume summary must carry id/name/digest only, no storage path.",
);
const serializedPortable = JSON.stringify([
  resumeSummary,
  {
    retainedPath: path.basename("/var/folders/xx/T/nestor-job-finder-abc"),
  },
]);
assert(
  !serializedPortable.includes("/Users/") &&
    !serializedPortable.includes("/var/folders/") &&
    !serializedPortable.includes("storagePath"),
  "Serialized portable fixtures must not contain absolute local paths or storage paths.",
);

const sourceCountMismatch = smokeModule.describeFingerprintMismatch(
  `Source (${BOUND_SOURCE_SUBJECT})`,
  "a".repeat(64),
  100,
  "a".repeat(64),
  101,
);
assert(
  sourceCountMismatch !== null &&
    sourceCountMismatch.includes("expected=") &&
    sourceCountMismatch.includes("actual="),
  "A file-count-only drift must still be reported as a mismatch.",
);

// ---- Strict outcome gate: two safe outcomes, everything else fails.

const guardBlockerSummary =
  "The application page could not safely save a prepared field";
const guardCheckpointLabel =
  "Paused before the application field could be saved";
const guardBlockerDetail =
  "The application site tried to save 'Email' while it was being prepared, but this run did not have permission for that external save. Job Finder stopped and left the application open instead of risking a final submission.";

const classifiedGuardHandoff = smokeModule.classifyApplicationSafeBlocker({
  blocker: {
    code: "requires_manual_review",
    summary: guardBlockerSummary,
    detail: guardBlockerDetail,
  },
  checkpoints: [
    { label: "Started application preparation", detail: "ok" },
    { label: guardCheckpointLabel, detail: guardBlockerDetail },
  ],
  finalControl: { state: "blocked_before_final_control" },
  resumeUploadVerified: false,
});
assert(
  classifiedGuardHandoff?.kind ===
    smokeModule.SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD &&
    classifiedGuardHandoff.evidence.blockerCode === "requires_manual_review" &&
    classifiedGuardHandoff.evidence.blockerSummary === guardBlockerSummary &&
    classifiedGuardHandoff.evidence.checkpointLabel === guardCheckpointLabel,
  "A truthful intermediate-write-guard stop must classify as safe-blocker evidence.",
);
const resumeGuardHandoff = smokeModule.classifyApplicationSafeBlocker({
  blocker: {
    code: "requires_manual_review",
    summary: "Resume attachment needs your help",
    detail:
      "The application site tried to upload the approved CV while 'Resume' was being prepared, but this run did not have permission for that external save.",
  },
  checkpoints: [
    { label: "Paused before the resume could be attached", detail: "x" },
  ],
  finalControl: { state: "blocked_before_final_control" },
  resumeUploadVerified: false,
});
assert(
  resumeGuardHandoff?.kind ===
    smokeModule.SAFE_BLOCKER_KIND_INTERMEDIATE_WRITE_GUARD,
  "An interrupted resume attachment must also classify as a write-guard handoff.",
);
for (const [label, application] of Object.entries({
  genericManualReview: {
    blocker: {
      code: "requires_manual_review",
      summary: "A service worker can influence this application origin.",
      detail: "Stopped before further action.",
    },
    checkpoints: [
      { label: "Paused at a manual application gate", detail: "x" },
    ],
    finalControl: { state: "blocked_before_final_control" },
    resumeUploadVerified: false,
  },
  containmentPopupStop: {
    blocker: {
      code: "requires_manual_review",
      summary: "The application page attempted to open an unexpected popup",
      detail: "The application page tried to open a new popup window.",
    },
    checkpoints: [{ label: "Paused before an unexpected popup", detail: "x" }],
    finalControl: { state: "blocked_before_final_control" },
    resumeUploadVerified: false,
  },
  summaryWithoutCheckpointEvidence: {
    blocker: {
      code: "requires_manual_review",
      summary: guardBlockerSummary,
      detail: guardBlockerDetail,
    },
    checkpoints: [
      { label: "Paused at a manual application gate", detail: "x" },
    ],
    finalControl: { state: "blocked_before_final_control" },
    resumeUploadVerified: false,
  },
  missingClassificationInputs: {
    blocker: { code: "unknown", summary: "Something happened", detail: "" },
    checkpoints: [],
    finalControl: { state: "blocked_before_final_control" },
    resumeUploadVerified: false,
  },
  noBlockerAtAll: {
    blocker: null,
    checkpoints: [],
    finalControl: { state: "blocked_before_final_control" },
    resumeUploadVerified: false,
  },
})) {
  const classification =
    smokeModule.classifyApplicationSafeBlocker(application);
  if (application.blocker === null) {
    assert(
      classification === null,
      `${label}: a missing blocker must not produce a classification.`,
    );
  } else {
    assert(
      classification?.kind === smokeModule.SAFE_BLOCKER_KIND_UNCLASSIFIED,
      `${label}: a non-write-guard blocker must stay unclassified.`,
    );
  }
}

function buildStrictReport(overrides = {}) {
  return {
    outcome: "passed_final_checkpoint_without_submit",
    capabilities: { intermediateAtsWritesAuthorized: false },
    assertions: {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: true,
      submittedNeverOccurred: true,
      finalSubmitAuthorized: false,
      accountCreationAuthorized: false,
    },
    isolation: { temporaryUserDataDirectory: true, cleanedUp: true },
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "reached_without_submit" },
      resumeUploadVerified: false,
      blocker: null,
      safeBlocker: null,
    },
    ...overrides,
  };
}

const acceptedReached = smokeModule.evaluateStrictPrepareOnlyAcceptance({
  report: buildStrictReport(),
  requireFinalCheckpoint: true,
  expectedBlockerCode: null,
});
assert(
  acceptedReached === null,
  "Reaching the final control without submit must pass the strict gate.",
);

const acceptedGuardHandoff = smokeModule.evaluateStrictPrepareOnlyAcceptance({
  report: buildStrictReport({
    outcome: "passed_safe_blocker_without_submit",
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "blocked_before_final_control" },
      resumeUploadVerified: false,
      blocker: {
        code: "requires_manual_review",
        summary: guardBlockerSummary,
        detail: guardBlockerDetail,
      },
      checkpoints: [
        { label: guardCheckpointLabel, detail: guardBlockerDetail },
      ],
      safeBlocker: classifiedGuardHandoff,
    },
  }),
  requireFinalCheckpoint: true,
  expectedBlockerCode: null,
});
assert(
  acceptedGuardHandoff === null,
  "A classified truthful write-guard handoff must pass the strict gate.",
);

for (const [label, report] of Object.entries({
  genericBlockerCannotPass: buildStrictReport({
    outcome: OUTCOME_STOPPED_UNCLASSIFIED,
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "blocked_before_final_control" },
      resumeUploadVerified: false,
      blocker: {
        code: "requires_manual_review",
        summary: "A service worker can influence this application origin.",
        detail: "Stopped before further action.",
      },
      checkpoints: [
        { label: "Paused at a manual application gate", detail: "x" },
      ],
      safeBlocker: {
        kind: smokeModule.SAFE_BLOCKER_KIND_UNCLASSIFIED,
        evidence: {},
      },
    },
  }),
  legacyPassedLabelCannotReturn: buildStrictReport({
    outcome: "passed_safe_blocker_without_submit",
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "blocked_before_final_control" },
      resumeUploadVerified: false,
      blocker: {
        code: "requires_manual_review",
        summary: "A service worker can influence this application origin.",
        detail: "Stopped before further action.",
      },
      checkpoints: [
        { label: "Paused at a manual application gate", detail: "x" },
      ],
      safeBlocker: {
        kind: smokeModule.SAFE_BLOCKER_KIND_UNCLASSIFIED,
        evidence: {},
      },
    },
  }),
  missingClassificationCannotPass: buildStrictReport({
    outcome: "passed_safe_blocker_without_submit",
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "blocked_before_final_control" },
      resumeUploadVerified: false,
      blocker: {
        code: "requires_manual_review",
        summary: guardBlockerSummary,
        detail: guardBlockerDetail,
      },
      checkpoints: [
        { label: guardCheckpointLabel, detail: guardBlockerDetail },
      ],
      safeBlocker: null,
    },
  }),
  submittedOccurrenceCannotPass: buildStrictReport({
    assertions: {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: true,
      submittedNeverOccurred: false,
      finalSubmitAuthorized: false,
      accountCreationAuthorized: false,
    },
  }),
  diagnosticWriteModeCannotPass: buildStrictReport({
    capabilities: { intermediateAtsWritesAuthorized: true },
  }),
  cleanupFailureCannotPass: buildStrictReport({
    assertions: {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: false,
      submittedNeverOccurred: true,
      finalSubmitAuthorized: false,
      accountCreationAuthorized: false,
    },
  }),
  accountAuthorityElevationCannotPass: buildStrictReport({
    assertions: {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: true,
      submittedNeverOccurred: true,
      finalSubmitAuthorized: false,
      accountCreationAuthorized: true,
    },
  }),
  submitAuthorityElevationCannotPass: buildStrictReport({
    assertions: {
      isolatedTemporaryProfile: true,
      isolationCleanedUp: true,
      submittedNeverOccurred: true,
      finalSubmitAuthorized: true,
      accountCreationAuthorized: false,
    },
  }),
  earlyFailureCannotPass: buildStrictReport({
    outcome: "blocked_without_submit",
  }),
  bindingFailureCannotPass: buildStrictReport({
    outcome: "failed_acceptance_binding",
  }),
})) {
  const violations = smokeModule.collectStrictAcceptanceViolations({
    report,
    requireFinalCheckpoint: true,
    expectedBlockerCode: null,
  });
  assert(
    violations.length > 0,
    `${label}: the strict gate must refuse this report.`,
  );
  const violation = smokeModule.evaluateStrictPrepareOnlyAcceptance({
    report,
    requireFinalCheckpoint: true,
    expectedBlockerCode: null,
  });
  assert(
    violation instanceof Error,
    `${label}: the evaluator wrapper must surface an Error.`,
  );
  assert(
    !/\bpassed\b/u.test(violation.message.replace(/passed_/gu, "")),
    `${label}: refusal diagnostics must never claim a passed outcome.`,
  );
}

const uploadClaimingHandoffCannotPass =
  smokeModule.evaluateStrictPrepareOnlyAcceptance({
    report: buildStrictReport({
      outcome: "passed_safe_blocker_without_submit",
      application: {
        state: "paused",
        outcome: null,
        finalControl: { state: "blocked_before_final_control" },
        resumeUploadVerified: true,
        blocker: {
          code: "requires_manual_review",
          summary: guardBlockerSummary,
          detail: guardBlockerDetail,
        },
        checkpoints: [
          { label: guardCheckpointLabel, detail: guardBlockerDetail },
        ],
        safeBlocker: classifiedGuardHandoff,
      },
    }),
    requireFinalCheckpoint: true,
    expectedBlockerCode: null,
  });
assert(
  uploadClaimingHandoffCannotPass instanceof Error &&
    /upload/iu.test(uploadClaimingHandoffCannotPass.message) === false,
  "A write-guard handoff claiming verified upload must be refused without echoing the claim.",
);

// Workday's expected human handoff stays unchanged, under the same shared conjunction.
const workdayAccepted = smokeModule.evaluateStrictPrepareOnlyAcceptance({
  report: buildStrictReport({
    outcome: "passed_expected_human_handoff_without_submit",
    application: {
      state: "paused",
      outcome: null,
      finalControl: { state: "blocked_before_final_control" },
      resumeUploadVerified: false,
      blocker: {
        code: "site_login_required",
        summary: "Sign in to continue",
        detail: null,
      },
      checkpoints: [],
      safeBlocker: null,
    },
  }),
  requireFinalCheckpoint: false,
  expectedBlockerCode: "site_login_required",
});
assert(
  workdayAccepted === null,
  "The Workday site_login_required human handoff must remain accepted.",
);
const workdayWrongOutcome = smokeModule.evaluateStrictPrepareOnlyAcceptance({
  report: buildStrictReport({ outcome: "blocked_without_submit" }),
  requireFinalCheckpoint: false,
  expectedBlockerCode: "site_login_required",
});
assert(
  workdayWrongOutcome instanceof Error &&
    workdayWrongOutcome.message.includes("site_login_required"),
  "A Workday run without the expected blocker must be refused.",
);
const workdayDiagnosticWriteMode =
  smokeModule.evaluateStrictPrepareOnlyAcceptance({
    report: buildStrictReport({
      outcome: "passed_expected_human_handoff_without_submit",
      capabilities: { intermediateAtsWritesAuthorized: true },
    }),
    requireFinalCheckpoint: false,
    expectedBlockerCode: "site_login_required",
  });
assert(
  workdayDiagnosticWriteMode instanceof Error,
  "Diagnostic write mode must fail every gated acceptance.",
);

const ungatedReport = buildStrictReport({
  outcome: OUTCOME_STOPPED_UNCLASSIFIED,
});
assert(
  smokeModule.evaluateStrictPrepareOnlyAcceptance({
    report: ungatedReport,
    requireFinalCheckpoint: false,
    expectedBlockerCode: null,
  }) === null,
  "Ungated runs produce no strict-gate violation error.",
);
assert(
  smokeModule.collectStrictAcceptanceViolations({
    report: ungatedReport,
    requireFinalCheckpoint: false,
    expectedBlockerCode: null,
  }).length === 0,
  "Ungated runs have no strict-gate violations to record.",
);

process.stdout.write("Prepare-only report binding validation passed.\n");
