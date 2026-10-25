import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertReadOnlyInventoryTransform,
  assertComponentCompletion,
  assertFileInventoryUnchanged,
  assertNpmPackageNameShape,
  assertPrepareOnly,
  artifactFingerprint,
  assertViewportEvidence,
  CANONICAL_LATENCY_BUDGETS,
  createFinalAcceptanceSeal,
  DEPENDENCY_EXPORT_STRATEGY,
  digestSeed,
  evaluateClickablePointEvidence,
  dependencySnapshotFingerprint,
  exportAcceptedElectronApp,
  finalizeProcessOutput,
  finalizeFileEvidence,
  fingerprintSnapshot,
  isExcludedSource as isAcceptanceSourceExclude,
  makeEvidenceFilesReadOnly,
  makeTreeReadOnly,
  makeTreeWritable,
  materializeDependencySnapshot,
  materializeSourceSnapshot,
  PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
  PRODUCTION_RUNTIME_DEPENDENCY_SEEDS,
  repositoryRoot,
  resolvePrimaryRunError,
  sourceFingerprint,
  SYNTHETIC_SEED,
  SYNTHETIC_SEED_DIGEST,
  stableJson,
  verifyAcceptedElectronApp,
  verifyFinalAcceptanceSeal,
  VIEWPORT_CSS_TOLERANCE_PX,
} from "./release-acceptance-harness.mjs";
import {
  computeSourceFingerprint as collectorComputeSourceFingerprint,
  fingerprintEnumeratedSourcePaths,
  isExcludedSource as isCollectorSourceExclude,
  sourceFingerprintRecipe as collectorSourceFingerprintRecipe,
} from "../../../scripts/collect-release-evidence.mjs";
import {
  ACCEPTANCE_RUNTIME_MODULE_PROBE_SPECIFIERS,
  ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS,
  ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS,
  assertCanonicalArtifactRoot,
  auditTesterShellProbeRouteBinding,
  buildEvidenceInventory,
  CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS,
  CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS,
  collectShellHeaderGeometrySample,
  electronIdentityFromSnapshot,
  PRODUCTION_TESTER_GEOMETRY_REQUEST,
  PRODUCTION_TESTER_LAUNCH_ARGS,
  PRODUCTION_TESTER_SHELL_PROBE_ROUTE,
  REQUIRED_ERROR_RECOVERY_SCENARIOS,
  SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX,
  SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX,
  SHELL_HEADER_GEOMETRY_SAMPLE_KEYS,
  SHELL_HEADER_LIVE_ASSISTANT_HREF,
  SHELL_HEADER_LAYOUT_TRIO_NAMES,
  SHELL_HEADER_UTILITY_CONTROL_NAMES,
  compareTesterStartupGeometry,
  evaluateCdpVersionBody,
  evaluateCurrentWorktreeContinuity,
  evaluateErrorRecoveryCaptureEntries,
  evaluateRuntimeProbePassRequirement,
  evaluateShellHeaderGeometry,
  evaluateShellHeaderGeometryFixtureSuite,
  evaluateTesterChildEnvironmentAuthority,
  findDisallowedCaptureNativeZoomFactors,
  findEvaluateProcessDestructurings,
  parseDevToolsActivePortContents,
  parsePngMetadata,
  productionTesterEnvironment,
  probeAcceptedAppRuntimeModules,
  runTrackedCommand,
  terminateAndVerifyTrackedCommand,
} from "./run-job-finder-production-acceptance.mjs";
import {
  DESKTOP_BUILD_ARGS,
  resolveBuildInvocation,
} from "./resolve-build-invocation.mjs";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const files = [
  "release-acceptance-harness.mjs",
  "resolve-build-invocation.mjs",
  "run-job-finder-production-acceptance.mjs",
  "capture-fresh-flows.mjs",
  "capture-scale-500.mjs",
  "capture-job-finder-error-recovery.mjs",
];
for (const fileName of files) {
  const filePath = path.join(scriptDir, fileName);
  const result = await execFileAsync(process.execPath, ["--check", filePath], {
    windowsHide: true,
  });
  assert(
    !result.stderr,
    `${fileName} failed syntax validation: ${result.stderr}`,
  );
}

assert(
  stableJson({ b: 2, a: 1 }) === stableJson({ a: 1, b: 2 }),
  "Stable JSON hashing is not key-order independent.",
);
assert(
  digestSeed(SYNTHETIC_SEED) === SYNTHETIC_SEED_DIGEST,
  "Synthetic seed digest is not deterministic.",
);
async function mustReject(callback, pattern, message) {
  let thrown = null;
  try {
    await callback();
  } catch (error) {
    thrown = error;
  }
  assert(thrown && pattern.test(String(thrown.message)), message);
}
function mustThrow(callback, pattern, message) {
  let thrown = null;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  assert(thrown && pattern.test(String(thrown.message)), message);
}

// Dependency names double as node_modules path segments, so every seed and
// manifest key must match the strict npm grammar before it can influence a
// computed destination.
for (const validName of [
  "electron",
  "pdfjs-dist",
  "@mozilla/readability",
  "a",
  "a-b_c.d",
]) {
  assertNpmPackageNameShape(validName, "fixture");
}
for (const invalidName of [
  "",
  ".",
  "..",
  "/",
  "/absolute",
  "relative/",
  "a/..",
  "../escape",
  "./dot-slash",
  "back\\slash",
  "C:\\win-path",
  "@/empty-scope",
  "@scope/",
  "@scope/name/sub",
  "@scope//name",
  "nested/scope/name",
  "-leading-hyphen-is-invalid-per-new-npm",
]) {
  mustThrow(
    () => assertNpmPackageNameShape(invalidName, "fixture"),
    /dependency name/,
    `A poisoned dependency name was accepted: "${invalidName}".`,
  );
}

mustThrow(
  () => assertComponentCompletion({ summary: { pass: true } }, "fixture"),
  /pass=true/,
  "A component report with absent top-level pass=true must fail.",
);
mustThrow(
  () =>
    assertComponentCompletion(
      {
        pass: true,
        completedAt: new Date(0).toISOString(),
        processOwnership: {
          verified: true,
          trackedProcesses: [],
          leftoverPids: [],
        },
      },
      "fixture",
    ),
  /owned-process teardown/,
  "A component report with missing cleanup ownership must fail.",
);
mustThrow(
  () =>
    assertComponentCompletion(
      {
        pass: true,
        completedAt: new Date(0).toISOString(),
        processOwnership: {
          verified: true,
          trackedProcesses: [{ pid: 1 }],
          leftoverPids: [1],
        },
      },
      "fixture",
    ),
  /owned-process teardown/,
  "A component report with an owned-process survivor must fail.",
);
mustThrow(
  () =>
    assertViewportEvidence(
      {
        css: { width: 1440, height: 920 },
        physical: { width: 1440, height: 920 },
        nativeZoomFactor: 1,
        requested: {
          width: 1440,
          height: 920,
          zoomFactor: 2,
          slug: "zoom-200",
        },
      },
      { width: 1440, height: 920, zoomFactor: 2 },
    ),
  /native zoom/,
  "A misleading 200% label with native zoom factor 1 must fail.",
);
assert(
  assertViewportEvidence(
    {
      css: { width: 1152, height: 736 },
      physical: { width: 1440, height: 920 },
      nativeZoomFactor: 1.25,
      requested: {
        width: 1440,
        height: 920,
        zoomFactor: 1.25,
        slug: "native-125",
      },
    },
    { width: 1440, height: 920, zoomFactor: 1.25 },
  ) === true,
  "Exact native 1.25 zoom evidence (physical 1440x920, CSS 1152x736) must pass viewport binding.",
);
mustThrow(
  () =>
    assertViewportEvidence(
      {
        css: { width: 720, height: 460 },
        physical: { width: 1440, height: 920 },
        nativeZoomFactor: 1.25,
        requested: {
          width: 1440,
          height: 920,
          zoomFactor: 2,
          slug: "zoom-200",
        },
      },
      { width: 1440, height: 920, zoomFactor: 1.25 },
    ),
  /native zoom/,
  "A stale 200% request must fail against observed native 1.25 zoom evidence.",
);
assert(
  VIEWPORT_CSS_TOLERANCE_PX === 1,
  "Viewport CSS binding tolerance must stay pinned at ±1 CSS px, matching Chromium's whole-pixel innerWidth/innerHeight measurement.",
);
// Native-125 CSS binding fixtures: expected CSS = requested physical /
// expected native zoom within VIEWPORT_CSS_TOLERANCE_PX at every zoom factor.
// The pre-2026-08-24 failure shape — physically exact, native-zoom-exact
// evidence carrying stale CSS measured at a different zoom — must fail closed
// at 1.25 instead of passing on physical/native checks alone.
assert(
  assertViewportEvidence(
    {
      css: { width: 1153, height: 737 },
      physical: { width: 1440, height: 920 },
      nativeZoomFactor: 1.25,
      requested: {
        width: 1440,
        height: 920,
        zoomFactor: 1.25,
        slug: "native-125",
      },
    },
    { width: 1440, height: 920, zoomFactor: 1.25 },
  ) === true,
  "Native 1.25 evidence at the +1 CSS px tolerance edge (CSS 1153x737 for 1440x920/1.25) must pass viewport binding.",
);
assert(
  assertViewportEvidence(
    {
      css: { width: 1151, height: 735 },
      physical: { width: 1440, height: 920 },
      nativeZoomFactor: 1.25,
      requested: {
        width: 1440,
        height: 920,
        zoomFactor: 1.25,
        slug: "native-125",
      },
    },
    { width: 1440, height: 920, zoomFactor: 1.25 },
  ) === true,
  "Native 1.25 evidence at the -1 CSS px tolerance edge (CSS 1151x735 for 1440x920/1.25) must pass viewport binding.",
);
mustThrow(
  () =>
    assertViewportEvidence(
      {
        css: { width: 1440, height: 920 },
        physical: { width: 1440, height: 920 },
        nativeZoomFactor: 1.25,
        requested: {
          width: 1440,
          height: 920,
          zoomFactor: 1.25,
          slug: "native-125",
        },
      },
      { width: 1440, height: 920, zoomFactor: 1.25 },
    ),
  /viewport\/native zoom/,
  "Stale CSS 1440x920 recorded at native 1.25 (expected CSS 1152x736) is physically/CSS-inconsistent evidence and must fail closed.",
);
mustThrow(
  () =>
    assertViewportEvidence(
      {
        css: { width: 1154, height: 736 },
        physical: { width: 1440, height: 920 },
        nativeZoomFactor: 1.25,
        requested: {
          width: 1440,
          height: 920,
          zoomFactor: 1.25,
          slug: "native-125",
        },
      },
      { width: 1440, height: 920, zoomFactor: 1.25 },
    ),
  /viewport\/native zoom/,
  "CSS geometry more than ±1 CSS px away from physical/zoom (CSS 1154x736 for 1440x920/1.25) must fail the binding.",
);
// Retained zoom-1.0 behavior: expected CSS equals the requested physical size
// there, so exactly matching evidence keeps passing and drifted CSS still
// fails instead of riding on the physical/native checks alone.
assert(
  assertViewportEvidence(
    {
      css: { width: 1024, height: 768 },
      physical: { width: 1024, height: 768 },
      nativeZoomFactor: 1,
      requested: {
        width: 1024,
        height: 768,
        zoomFactor: 1,
        slug: "minimum",
      },
    },
    { width: 1024, height: 768, zoomFactor: 1 },
  ) === true,
  "Exact zoom-1.0 evidence (CSS equals the requested physical size) must keep passing viewport binding.",
);
mustThrow(
  () =>
    assertViewportEvidence(
      {
        css: { width: 1026, height: 769 },
        physical: { width: 1024, height: 768 },
        nativeZoomFactor: 1,
        requested: {
          width: 1024,
          height: 768,
          zoomFactor: 1,
          slug: "minimum",
        },
      },
      { width: 1024, height: 768, zoomFactor: 1 },
    ),
  /viewport\/native zoom/,
  "Zoom-1.0 evidence whose CSS drifts beyond the ±1 CSS px binding must fail closed.",
);
assert(
  evaluateClickablePointEvidence([
    { required: true, hit: false, label: "Sticky save" },
  ]).pass === false,
  "An occluded required control must fail clickable-point evidence.",
);
{
  const harnessSource = await readFile(
    path.join(scriptDir, "release-acceptance-harness.mjs"),
    "utf8",
  );
  assert(
    harnessSource.includes('element.closest("details:not([open])")') &&
      harnessSource.includes(":scope > summary") &&
      harnessSource.includes("!visibleSummary?.contains(element)") &&
      harnessSource.includes("clippingValues.has(ancestorStyle.overflowX)") &&
      harnessSource.includes("clippingValues.has(ancestorStyle.overflowY)") &&
      harnessSource.includes("clickablePointScopeSelector") &&
      harnessSource.includes("scope.querySelectorAll(selector)") &&
      harnessSource.includes("visibleWidth >= 2") &&
      harnessSource.includes("visibleHeight >= 2"),
    "Clickable-point evidence must exclude hidden closed-details descendants and content clipped by overflow ancestors.",
  );
}
const safeWorkspace = {
  userActionRequests: [],
  campaigns: [],
  applicationAttempts: [],
  applyJobResults: [],
  applicationRecords: [],
  discoveryJobs: [],
};
assert(
  assertPrepareOnly(safeWorkspace).pass === true,
  "Empty authoritative safety facts must pass.",
);
mustThrow(
  () =>
    assertPrepareOnly({
      ...safeWorkspace,
      applicationAttempts: [
        { id: "attempt-1", state: "submitted", outcome: "submitted" },
      ],
    }),
  /persisted authoritative submitted\/external-write facts/,
  "A persisted submitted attempt must fail prepare-only acceptance.",
);
mustThrow(
  () =>
    assertPrepareOnly({
      ...safeWorkspace,
      applyJobResults: [
        {
          id: "result-1",
          state: "prepared",
          privacyReceipt: {
            finalSubmitOccurred: false,
            finalSubmitAuthorized: false,
            accountCreationAuthorized: false,
            externalWrites: [{ category: "profile_field" }],
          },
        },
      ],
    }),
  /persisted authoritative submitted\/external-write facts/,
  "A persisted external-write receipt must fail prepare-only acceptance.",
);

// The fresh capture accepts exactly one Playwright inspector teardown line
// on main-process stderr. These fixtures prove the acceptance is exact: the
// lone line is stripped and recorded, any neighboring or near-miss output
// still fails the run, CRLF endings are covered, and reusing the shared
// pattern across finalize calls keeps working despite its /g flag.
assert(
  (() => {
    const report = {};
    finalizeProcessOutput(
      { stdout: [], stderr: ["Waiting for the debugger to disconnect...\n"] },
      report,
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    );
    return (
      report.mainProcess.unexpectedStderr === "" &&
      report.mainProcess.acceptedWarnings.includes(
        "playwright-inspector-disconnect-notice",
      )
    );
  })(),
  "The lone Playwright inspector disconnect notice must be accepted verbatim.",
);
assert(
  (() => {
    const report = {};
    finalizeProcessOutput(
      {
        stdout: [],
        stderr: ["Waiting for the debugger to disconnect...\r\n"],
      },
      report,
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    );
    return report.mainProcess.unexpectedStderr === "";
  })(),
  "The Playwright inspector disconnect notice must be accepted with CRLF endings.",
);
mustThrow(
  () =>
    finalizeProcessOutput(
      {
        stdout: [],
        stderr: [
          "Waiting for the debugger to disconnect...\nreal main-process failure\n",
        ],
      },
      {},
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    ),
  /real main-process failure/,
  "The inspector disconnect acceptance must not mask other main-process stderr output.",
);
mustThrow(
  () =>
    finalizeProcessOutput(
      { stdout: [], stderr: ["Waiting for the debugger to disconnect\n"] },
      {},
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    ),
  /Waiting for the debugger to disconnect/,
  "A truncated inspector disconnect notice without ellipsis must still fail the run.",
);
mustThrow(
  () =>
    finalizeProcessOutput(
      {
        stdout: [],
        stderr: ["prefix Waiting for the debugger to disconnect...\n"],
      },
      {},
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    ),
  /prefix Waiting for the debugger to disconnect/,
  "A non-line-anchored inspector disconnect notice must still fail the run.",
);
assert(
  (() => {
    // Two consecutive finalize calls share one /g pattern object; replace()
    // resets lastIndex per call, so the second call must still strip.
    const acceptedNames = [];
    for (let i = 0; i < 2; i += 1) {
      const report = { mainProcess: {} };
      finalizeProcessOutput(
        {
          stdout: [],
          stderr: ["Waiting for the debugger to disconnect...\n"],
        },
        report,
        {
          acceptedStderrPatterns: [
            PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
          ],
        },
      );
      if (report.mainProcess.unexpectedStderr !== "") return false;
      acceptedNames.push(...report.mainProcess.acceptedWarnings);
    }
    return acceptedNames.length === 2;
  })(),
  "Reusing the shared inspector disconnect pattern across finalize calls must keep accepting the exact line.",
);
// Exactness has no slack on either edge: a notice carrying trailing content
// on its line is not the teardown line and must still fail the run.
mustThrow(
  () =>
    finalizeProcessOutput(
      {
        stdout: [],
        stderr: ["Waiting for the debugger to disconnect...extra\n"],
      },
      {},
      {
        acceptedStderrPatterns: [
          PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN,
        ],
      },
    ),
  /Waiting for the debugger to disconnect/,
  "An inspector disconnect notice with trailing content on its line must still fail the run.",
);

// Masking precedence, exercised against the real helpers: when the scenario
// body threw and finalizeProcessOutput rejects during teardown, the thrown
// error must stay the original scenario error with the finalization error
// attached as cause, and the report must still carry the recorded stderr
// evidence because finalize records before it throws.
assert(
  (() => {
    const report = {};
    let primaryScenarioError = null;
    let finalizationError = null;
    let propagatedError = null;
    try {
      try {
        throw new Error("scenario body failed before teardown");
      } catch (error) {
        primaryScenarioError = error;
        throw error;
      } finally {
        try {
          finalizeProcessOutput(
            { stdout: [], stderr: ["teardown-only main-process noise\n"] },
            report,
            {},
          );
        } catch (error) {
          finalizationError = error;
        }
      }
    } catch (propagated) {
      propagatedError = propagated;
    }
    const resolved = resolvePrimaryRunError(
      primaryScenarioError,
      finalizationError,
    );
    return (
      resolved === primaryScenarioError &&
      resolved === propagatedError &&
      resolved.message === "scenario body failed before teardown" &&
      resolved.cause === finalizationError &&
      /teardown-only main-process noise/.test(finalizationError.message) &&
      report.mainProcess.stderr.includes("teardown-only main-process noise") &&
      report.mainProcess.unexpectedStderr.includes(
        "teardown-only main-process noise",
      )
    );
  })(),
  "A finalize-time failure must not mask the primary scenario error and must still record stderr evidence in the report.",
);
assert(
  (() => {
    const onlyScenario = new Error("scenario only");
    const onlyFinalize = new Error("finalize only");
    return (
      resolvePrimaryRunError(onlyScenario, null) === onlyScenario &&
      resolvePrimaryRunError(null, onlyFinalize) === onlyFinalize &&
      resolvePrimaryRunError(null, null) === null &&
      resolvePrimaryRunError(new Error("both"), onlyFinalize).cause instanceof
        Error
    );
  })(),
  "Teardown error resolution must fall through to whichever failure exists and prefer the scenario error with a cause when both exist.",
);

const approvedTempRoot = path.join(os.tmpdir(), "opencode");
await mkdir(approvedTempRoot, { recursive: true });
const snapshotFixtureRoot = await mkdtemp(
  path.join(approvedTempRoot, "acceptance-snapshot-static-"),
);
try {
  const sourceRoot = path.join(snapshotFixtureRoot, "source");
  const snapshotRoot = path.join(snapshotFixtureRoot, "snapshot");
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  const sourcePath = path.join(sourceRoot, "src", "input.txt");
  const initialContents = "captured source\n";
  await writeFile(sourcePath, initialContents, "utf8");
  await chmod(sourcePath, 0o644);
  const sourceEntry = {
    path: "src/input.txt",
    kind: "file",
    mode: 0o644,
    bytes: Buffer.byteLength(initialContents),
    sha256: createHash("sha256").update(initialContents).digest("hex"),
  };
  const captured = { files: [sourceEntry] };
  await materializeSourceSnapshot(sourceRoot, snapshotRoot, captured);
  await makeTreeReadOnly(snapshotRoot);
  const immutableDigest = (
    await fingerprintSnapshot(snapshotRoot, captured.files)
  ).digest;
  await writeFile(sourcePath, "concurrent original mutation\n", "utf8");
  assert(
    (await fingerprintSnapshot(snapshotRoot, captured.files)).digest ===
      immutableDigest,
    "Mutating the original worktree after snapshotting changed the build input.",
  );
  await mustReject(
    () => writeFile(path.join(snapshotRoot, sourceEntry.path), "mutation\n"),
    /EACCES|EPERM|permission denied/i,
    "The read-only source snapshot accepted an in-place mutation.",
  );
  await makeTreeWritable(snapshotRoot);
  await writeFile(path.join(snapshotRoot, sourceEntry.path), "mutation\n");
  await mustReject(
    () => fingerprintSnapshot(snapshotRoot, captured.files),
    /content differs/,
    "A changed snapshot digest did not abort integrity verification.",
  );

  const escapeRoot = path.join(snapshotFixtureRoot, "escape-source");
  const escapeSnapshot = path.join(snapshotFixtureRoot, "escape-snapshot");
  await mkdir(escapeRoot, { recursive: true });
  await writeFile(path.join(snapshotFixtureRoot, "outside.txt"), "outside");
  await symlink("../outside.txt", path.join(escapeRoot, "escape-link"));
  await mustReject(
    () =>
      materializeSourceSnapshot(escapeRoot, escapeSnapshot, {
        files: [
          {
            path: "escape-link",
            kind: "symlink",
            mode: 0o777,
            target: "../outside.txt",
            resolvedPath: "../outside.txt",
          },
        ],
      }),
    /escaped its root/,
    "A source symlink escape was accepted by snapshot verification.",
  );

  const omittedRoot = path.join(snapshotFixtureRoot, "omitted-snapshot");
  await mkdir(path.join(omittedRoot, "src"), { recursive: true });
  await writeFile(path.join(omittedRoot, "src", "target.txt"), "target");
  await symlink("target.txt", path.join(omittedRoot, "src", "link.txt"));
  await mustReject(
    () =>
      fingerprintSnapshot(omittedRoot, [
        {
          path: "src/link.txt",
          kind: "symlink",
          mode: 0o777,
          target: "target.txt",
          resolvedPath: "src/target.txt",
        },
      ]),
    /omitted.*inventory/,
    "A source symlink to an omitted input was accepted.",
  );

  const dependencySource = path.join(snapshotFixtureRoot, "dependency-source");
  const dependencySnapshot = path.join(
    snapshotFixtureRoot,
    "dependency-snapshot",
  );
  await mkdir(path.join(dependencySource, "node_modules", "pkg"), {
    recursive: true,
  });
  await writeFile(
    path.join(dependencySource, "node_modules", "pkg", "index.js"),
    "export const value = 1;\n",
  );
  await symlink("pkg", path.join(dependencySource, "node_modules", "pkg-link"));
  const dependencyMaterialization = await materializeDependencySnapshot(
    dependencySource,
    dependencySnapshot,
  );
  const dependencyBeforeReadOnly = await dependencySnapshotFingerprint(
    dependencySnapshot,
    dependencyMaterialization.relativeRoots,
    {
      sourceEntries: [{ path: "node_modules/pkg/index.js", kind: "file" }],
    },
  );
  assert(
    dependencyBeforeReadOnly.digest ===
      dependencyMaterialization.originalBeforeCopy.digest,
    "Copied dependency bytes and modes did not match the stable original.",
  );
  await makeTreeReadOnly(path.join(dependencySnapshot, "node_modules"));
  const dependencyIdentity = await dependencySnapshotFingerprint(
    dependencySnapshot,
    dependencyMaterialization.relativeRoots,
    {
      sourceEntries: [{ path: "node_modules/pkg/index.js", kind: "file" }],
    },
  );
  assert(
    dependencyIdentity.fileCount === 2 &&
      dependencyIdentity.files.some(
        (entry) =>
          entry.kind === "symlink" && entry.target === "pkg" && entry.mode,
      ),
    "Dependency identity does not record files, modes, and links.",
  );
  assertReadOnlyInventoryTransform(
    dependencyBeforeReadOnly,
    dependencyIdentity,
  );
  const hardenedFile = dependencyIdentity.files.find(
    (entry) => entry.kind === "file",
  );
  assert(
    hardenedFile && (hardenedFile.mode & 0o222) === 0,
    "Dependency hardening retained writable file mode bits.",
  );
  await writeFile(
    path.join(dependencySource, "node_modules", "pkg", "index.js"),
    "export const value = 2;\n",
  );
  assert(
    (
      await dependencySnapshotFingerprint(
        dependencySnapshot,
        dependencyMaterialization.relativeRoots,
        {
          sourceEntries: [{ path: "node_modules/pkg/index.js", kind: "file" }],
        },
      )
    ).digest === dependencyIdentity.digest,
    "Mutating original dependencies changed the independent dependency snapshot.",
  );
  await makeTreeWritable(path.join(dependencySnapshot, "node_modules"));

  const racingDependencySource = path.join(
    snapshotFixtureRoot,
    "racing-dependency-source",
  );
  const racingDependencySnapshot = path.join(
    snapshotFixtureRoot,
    "racing-dependency-snapshot",
  );
  await mkdir(path.join(racingDependencySource, "node_modules", "pkg"), {
    recursive: true,
  });
  const racingDependencyFile = path.join(
    racingDependencySource,
    "node_modules",
    "pkg",
    "index.js",
  );
  await writeFile(racingDependencyFile, "before\n");
  await mustReject(
    () =>
      materializeDependencySnapshot(
        racingDependencySource,
        racingDependencySnapshot,
        { afterCopy: () => writeFile(racingDependencyFile, "after\n") },
      ),
    /changed while.*materialized/,
    "A dependency mutation during materialization was accepted.",
  );

  const generatedRoot = path.join(dependencySnapshot, "generated");
  await mkdir(generatedRoot);
  await writeFile(path.join(generatedRoot, "mutable.js"), "mutable\n");
  await symlink(
    "../generated/mutable.js",
    path.join(dependencySnapshot, "node_modules", "generated-link"),
  );
  await mustReject(
    () =>
      dependencySnapshotFingerprint(
        dependencySnapshot,
        dependencyMaterialization.relativeRoots,
        {
          sourceEntries: [{ path: "node_modules/pkg/index.js", kind: "file" }],
          generatedRoots: [generatedRoot],
        },
      ),
    /writable generated root/,
    "A dependency symlink into a writable generated root was accepted.",
  );

  const artifactFixture = path.join(snapshotFixtureRoot, "artifacts");
  await mkdir(path.join(artifactFixture, "out", "main"), { recursive: true });
  await writeFile(path.join(artifactFixture, "out", "main", "index.js"), "ok");
  await symlink(
    path.join(snapshotFixtureRoot, "outside.txt"),
    path.join(artifactFixture, "out", "main", "escape.js"),
  );
  await mustReject(
    () => artifactFingerprint(artifactFixture),
    /must not contain symlinks/,
    "An out/main artifact symlink escape was accepted.",
  );
  await rm(path.join(artifactFixture, "out", "main", "escape.js"));
  await mkdir(path.join(artifactFixture, "out", "internal"));
  await symlink(
    snapshotFixtureRoot,
    path.join(artifactFixture, "out", "internal", "eventual-escape"),
  );
  await mustReject(
    () => artifactFingerprint(artifactFixture),
    /must not contain symlinks/,
    "An internal artifact symlink with an eventual escape was accepted.",
  );
  await rm(path.join(artifactFixture, "out", "internal", "eventual-escape"));
  await mkdir(
    path.join(artifactFixture, "dist", "resume-parser-sidecar", "bin"),
    { recursive: true },
  );
  const sidecarBinary = path.join(
    artifactFixture,
    "dist",
    "resume-parser-sidecar",
    "bin",
    "resume_parser_sidecar",
  );
  await writeFile(
    path.join(
      artifactFixture,
      "dist",
      "resume-parser-sidecar",
      "manifest.json",
    ),
    JSON.stringify({
      signature: "matching",
      targets: { host: { ready: true } },
    }),
  );
  await writeFile(sidecarBinary, "trusted-binary");
  const sidecarBeforeTamper = await artifactFingerprint(artifactFixture);
  await writeFile(sidecarBinary, "tampered-binary");
  const sidecarAfterTamper = await artifactFingerprint(artifactFixture);
  assert(
    sidecarBeforeTamper.digest !== sidecarAfterTamper.digest,
    "A sidecar binary mutation hidden behind a matching manifest was not detected.",
  );

  // Direct boundary proof for the sidecar build-intermediate exclusion table.
  // The table is keyed by the normalized forward-slash root path
  // artifactFingerprint derives on every platform, so this fixture pins the
  // exact narrow behavior: mutations, removals, and additions under
  // dist/resume-parser-sidecar/build/** never move the digest or file count,
  // while sibling directories and every runtime surface still bind.
  const sidecarBoundaryRoot = path.join(
    snapshotFixtureRoot,
    "sidecar-boundary",
  );
  const sidecarBoundarySidecarRoot = path.join(
    sidecarBoundaryRoot,
    "dist",
    "resume-parser-sidecar",
  );
  await mkdir(path.join(sidecarBoundaryRoot, "out", "main"), {
    recursive: true,
  });
  await mkdir(path.join(sidecarBoundarySidecarRoot, "bin", "darwin-arm64"), {
    recursive: true,
  });
  await mkdir(
    path.join(
      sidecarBoundarySidecarRoot,
      "python",
      "darwin-arm64",
      "site-packages",
      "pypdf",
    ),
    { recursive: true },
  );
  await mkdir(path.join(sidecarBoundarySidecarRoot, "build", "darwin-arm64"), {
    recursive: true,
  });
  await writeFile(
    path.join(sidecarBoundaryRoot, "out", "main", "index.js"),
    "runtime-shell\n",
  );
  await writeFile(
    path.join(sidecarBoundarySidecarRoot, "manifest.json"),
    '{"signature":"matching"}\n',
  );
  const sidecarBoundaryBinaryPath = path.join(
    sidecarBoundarySidecarRoot,
    "bin",
    "darwin-arm64",
    "resume_parser_sidecar",
  );
  await writeFile(sidecarBoundaryBinaryPath, "trusted-binary\n");
  const sidecarBoundaryPythonScriptPath = path.join(
    sidecarBoundarySidecarRoot,
    "python",
    "darwin-arm64",
    "resume_parser_sidecar.py",
  );
  await writeFile(sidecarBoundaryPythonScriptPath, "# parser entrypoint\n");
  const sidecarBoundarySitePackagePath = path.join(
    sidecarBoundarySidecarRoot,
    "python",
    "darwin-arm64",
    "site-packages",
    "pypdf",
    "__init__.py",
  );
  await writeFile(sidecarBoundarySitePackagePath, "PARSER_RUNTIME = True\n");
  const sidecarBoundarySpecPath = path.join(
    sidecarBoundarySidecarRoot,
    "build",
    "darwin-arm64",
    "resume_parser_sidecar.spec",
  );
  await writeFile(sidecarBoundarySpecPath, "a = Analysis(['entry.py'])\n");
  const sameDigestAndCount = (left, right) =>
    left.digest === right.digest && left.fileCount === right.fileCount;
  const sidecarBoundaryBaseline =
    await artifactFingerprint(sidecarBoundaryRoot);
  assert(
    !sidecarBoundaryBaseline.files.some((entry) =>
      entry.path.startsWith("dist/resume-parser-sidecar/build/"),
    ) &&
      sidecarBoundaryBaseline.fileCount === 5 &&
      sidecarBoundaryBaseline.roots.find(
        (rootEntry) => rootEntry.path === "dist/resume-parser-sidecar",
      )?.fileCount === 4,
    "The sidecar build-intermediate exclusion did not hide dist/resume-parser-sidecar/build/** from the artifact fingerprint.",
  );
  await writeFile(sidecarBoundarySpecPath, "a = Analysis(['mutated.py'])\n");
  assert(
    sameDigestAndCount(
      await artifactFingerprint(sidecarBoundaryRoot),
      sidecarBoundaryBaseline,
    ),
    "A build-intermediate mutation changed the artifact fingerprint.",
  );
  await rm(sidecarBoundarySpecPath);
  assert(
    sameDigestAndCount(
      await artifactFingerprint(sidecarBoundaryRoot),
      sidecarBoundaryBaseline,
    ),
    "A build-intermediate removal changed the artifact fingerprint.",
  );
  await writeFile(
    path.join(sidecarBoundarySidecarRoot, "build", "extra-workfile.dat"),
    "new-intermediate\n",
  );
  assert(
    sameDigestAndCount(
      await artifactFingerprint(sidecarBoundaryRoot),
      sidecarBoundaryBaseline,
    ),
    "A new build-intermediate file changed the artifact fingerprint.",
  );
  const sidecarBoundarySiblingDir = path.join(
    sidecarBoundarySidecarRoot,
    "build-old",
  );
  await mkdir(sidecarBoundarySiblingDir);
  await writeFile(
    path.join(sidecarBoundarySiblingDir, "stale.bin"),
    "sibling\n",
  );
  const sidecarBoundaryAfterSibling =
    await artifactFingerprint(sidecarBoundaryRoot);
  assert(
    sidecarBoundaryAfterSibling.digest !== sidecarBoundaryBaseline.digest &&
      sidecarBoundaryAfterSibling.fileCount ===
        sidecarBoundaryBaseline.fileCount + 1,
    "A sibling build-old directory was wrongly swept into the build-intermediate exclusion.",
  );
  await rm(sidecarBoundarySiblingDir, { recursive: true });
  for (const [label, runtimePath] of [
    ["sidecar binary", sidecarBoundaryBinaryPath],
    ["copied Python entrypoint", sidecarBoundaryPythonScriptPath],
    ["site-package file", sidecarBoundarySitePackagePath],
    [
      "sidecar manifest",
      path.join(sidecarBoundarySidecarRoot, "manifest.json"),
    ],
  ]) {
    const originalContents = await readFile(runtimePath, "utf8");
    await writeFile(runtimePath, `${originalContents}mutated\n`);
    const afterRuntimeMutation = await artifactFingerprint(sidecarBoundaryRoot);
    assert(
      afterRuntimeMutation.digest !== sidecarBoundaryBaseline.digest &&
        afterRuntimeMutation.fileCount === sidecarBoundaryBaseline.fileCount,
      `A ${label} mutation was not detected by the artifact fingerprint.`,
    );
    await writeFile(runtimePath, originalContents);
  }

  // Artifact fingerprints are mode-aware: flipping permission bits alone must
  // change the digest and break manifest binding even though bytes stay
  // byte-for-byte identical, and restoring the mode must restore the digest.
  const modeTamperRelative =
    "dist/resume-parser-sidecar/bin/darwin-arm64/resume_parser_sidecar";
  const identityOf = (fingerprint, relativePath) => {
    const entry = fingerprint.files.find((file) => file.path === relativePath);
    assert(entry, `Artifact fingerprint lost ${relativePath}.`);
    return `${entry.bytes}:${entry.sha256}`;
  };
  const modeTamperPriorMode =
    (await lstat(sidecarBoundaryBinaryPath)).mode & 0o777;
  await chmod(sidecarBoundaryBinaryPath, 0o755);
  const modeTampered = await artifactFingerprint(sidecarBoundaryRoot);
  assert(
    modeTampered.digest !== sidecarBoundaryBaseline.digest &&
      modeTampered.fileCount === sidecarBoundaryBaseline.fileCount &&
      identityOf(modeTampered, modeTamperRelative) ===
        identityOf(sidecarBoundaryBaseline, modeTamperRelative) &&
      stableJson(modeTampered.files) !==
        stableJson(sidecarBoundaryBaseline.files),
    "A mode-only artifact tamper did not change the artifact fingerprint while leaving bytes identical.",
  );
  await chmod(sidecarBoundaryBinaryPath, modeTamperPriorMode);
  assert(
    (await artifactFingerprint(sidecarBoundaryRoot)).digest ===
      sidecarBoundaryBaseline.digest,
    "Restoring the original artifact mode did not restore the artifact fingerprint.",
  );

  const acceptedSource = path.join(snapshotFixtureRoot, "accepted-source");
  const acceptedDestination = path.join(
    snapshotFixtureRoot,
    "run",
    "accepted-app",
  );
  await mkdir(path.join(acceptedSource, "out", "main"), { recursive: true });
  await mkdir(path.join(acceptedSource, "out", "preload"), {
    recursive: true,
  });
  await mkdir(path.join(acceptedSource, "out", "renderer"), {
    recursive: true,
  });
  await writeFile(
    path.join(acceptedSource, "package.json"),
    JSON.stringify({
      name: "accepted-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(acceptedSource, "out", "main", "index.cjs"),
    'const name = "dynamic-fixture"; require(name); require("peer-fixture/feature"); require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"); require("native-fixture");',
  );
  await writeFile(
    path.join(acceptedSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(acceptedSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  // Faithful sidecar layout: the runtime binary, manifest, copied Python
  // entrypoint, and site-packages ship, while the PyInstaller
  // --workpath/--specpath intermediates under build/ embed the original
  // absolute roots and must never reach the accepted app.
  await mkdir(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "bin",
      "darwin-arm64",
    ),
    {
      recursive: true,
    },
  );
  await mkdir(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "build",
      "darwin-arm64",
      "spec",
    ),
    { recursive: true },
  );
  await writeFile(
    path.join(acceptedSource, "dist", "resume-parser-sidecar", "manifest.json"),
    JSON.stringify({
      signature: "matching",
      targets: { host: { ready: true } },
    }),
  );
  await writeFile(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "bin",
      "darwin-arm64",
      "resume_parser_sidecar",
    ),
    "trusted-binary",
  );
  await mkdir(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "python",
      "darwin-arm64",
      "site-packages",
      "pypdf",
    ),
    { recursive: true },
  );
  await writeFile(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "python",
      "darwin-arm64",
      "resume_parser_sidecar.py",
    ),
    "# resume parser source entrypoint\n",
  );
  await writeFile(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "python",
      "darwin-arm64",
      "site-packages",
      "pypdf",
      "__init__.py",
    ),
    "PARSER_RUNTIME = True\n",
  );
  await writeFile(
    path.join(
      acceptedSource,
      "dist",
      "resume-parser-sidecar",
      "build",
      "darwin-arm64",
      "spec",
      "resume_parser_sidecar.spec",
    ),
    `a = Analysis(['${path.join(snapshotFixtureRoot, "python", "resume_parser_sidecar.py")}'],)\n`,
  );
  const fixturePackages = {
    "dynamic-fixture": {
      package: {
        name: "dynamic-fixture",
        version: "1.0.0",
        main: "index.js",
        dependencies: { "nested-version": "1.0.0" },
      },
      files: { "index.js": 'module.exports = require("nested-version");' },
    },
    "peer-fixture": {
      package: {
        name: "peer-fixture",
        version: "1.0.0",
        exports: { "./feature": "./feature.js" },
        dependencies: { "nested-version": "2.0.0" },
        peerDependencies: { "dynamic-fixture": "*" },
      },
      files: { "feature.js": 'module.exports = "peer-subpath";' },
    },
    "pdfjs-dist": {
      package: {
        name: "pdfjs-dist",
        version: "4.0.0",
        exports: {
          "./build/pdf.worker.mjs": "./build/pdf.worker.mjs",
          "./legacy/build/pdf.worker.mjs": "./legacy/build/pdf.worker.mjs",
        },
      },
      files: {
        "build/pdf.worker.mjs": "export const WorkerMessageHandler = {};",
        "legacy/build/pdf.worker.mjs":
          "export const WorkerMessageHandler = { legacy: true };",
      },
    },
    "native-fixture": {
      package: { name: "native-fixture", version: "1.0.0", main: "index.js" },
      files: {
        "index.js": 'module.exports = require("./binding.node");',
        "binding.node": "native-bytes",
        // pnpm dropped a concrete versioned workspace-state file inside this
        // package directory; it embeds original absolute roots and must be
        // excluded from the export by its versioned name alone.
        ".pnpm-workspace-state-v1.json": JSON.stringify({
          projects: { [repositoryRoot]: {}, [snapshotFixtureRoot]: {} },
        }),
      },
    },
  };
  for (const [name, fixture] of Object.entries(fixturePackages)) {
    const packageRoot = path.join(acceptedSource, "node_modules", name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify(fixture.package),
    );
    for (const [relativePath, contents] of Object.entries(fixture.files)) {
      await mkdir(path.dirname(path.join(packageRoot, relativePath)), {
        recursive: true,
      });
      await writeFile(path.join(packageRoot, relativePath), contents);
    }
  }
  for (const [owner, version, value] of [
    ["dynamic-fixture", "1.0.0", "one"],
    ["peer-fixture", "2.0.0", "two"],
  ]) {
    const nested = path.join(
      acceptedSource,
      "node_modules",
      owner,
      "node_modules/nested-version",
    );
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, "package.json"),
      JSON.stringify({ name: "nested-version", version, main: "index.js" }),
    );
    await writeFile(
      path.join(nested, "index.js"),
      `module.exports = "${value}";`,
    );
  }
  // pnpm writes install-state bookkeeping directly into node_modules roots and
  // embeds machine-local absolute paths there. A faithful fixture embeds both
  // forbidden original roots; the export itself must omit these files —
  // including concrete versioned workspace-state names — instead of copying
  // them into the accepted runtime.
  await writeFile(
    path.join(acceptedSource, "node_modules", ".pnpm-workspace-state.json"),
    JSON.stringify({
      lastValidatedTimestamp: 0,
      projects: {
        [repositoryRoot]: { name: "nestor", version: "0.1.0" },
        [snapshotFixtureRoot]: { name: "fixture", version: "1.0.0" },
      },
    }),
  );
  await writeFile(
    path.join(acceptedSource, "node_modules", ".pnpm-workspace-state-v1.json"),
    JSON.stringify({
      lastValidatedTimestamp: 0,
      projects: {
        [repositoryRoot]: { name: "nestor", version: "0.1.0" },
        [snapshotFixtureRoot]: { name: "fixture", version: "1.0.0" },
      },
    }),
  );
  await writeFile(
    path.join(acceptedSource, "node_modules", ".modules.yaml"),
    `storeDir: ${path.join(snapshotFixtureRoot, "pnpm-store", "v10")}\n`,
  );
  const acceptedArtifacts = await artifactFingerprint(acceptedSource);
  const acceptedContract = await exportAcceptedElectronApp({
    sourceDesktopDir: acceptedSource,
    destinationRoot: acceptedDestination,
    artifacts: acceptedArtifacts,
    sourceDigest: "a".repeat(64),
    dependencySeeds: [
      "dynamic-fixture",
      "native-fixture",
      "peer-fixture",
      "pdfjs-dist",
    ],
  });
  await makeTreeWritable(acceptedSource);
  await rm(acceptedSource, { recursive: true });
  await verifyAcceptedElectronApp(
    await import("node:fs/promises").then(({ realpath }) =>
      realpath(acceptedDestination),
    ),
    acceptedContract,
  );
  assert(
    acceptedContract.artifactDigest === acceptedArtifacts.digest &&
      acceptedContract.launch.args[0] === "." &&
      acceptedContract.files.some((entry) => entry.path === "package.json"),
    "Accepted app export is not self-contained and bound to the exact build.",
  );
  const acceptedRequire = createRequire(
    path.join(acceptedDestination, "package.json"),
  );
  const acceptedCanonicalDestination = await realpath(acceptedDestination);
  assert(
    acceptedRequire
      .resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
      .startsWith(acceptedCanonicalDestination),
    "Accepted dependency export lost the mandatory runtime PDF.js legacy worker subpath.",
  );
  assert(
    acceptedRequire
      .resolve("pdfjs-dist/build/pdf.worker.mjs")
      .startsWith(acceptedCanonicalDestination),
    "Accepted dependency export lost the modern PDF.js worker subpath alongside the mandatory legacy one.",
  );
  assert(
    acceptedRequire("peer-fixture/feature") === "peer-subpath",
    "Accepted dependency export lost peer/subpath exports.",
  );
  assert(
    acceptedRequire("dynamic-fixture") === "one",
    "Accepted dependency export lost a computed loader dependency.",
  );
  assert(
    acceptedRequire(
      path.join(
        acceptedDestination,
        "node_modules/peer-fixture/node_modules/nested-version",
      ),
    ) === "two",
    "Accepted dependency export flattened a nested package version.",
  );
  assert(
    (await readFile(
      path.join(
        acceptedDestination,
        "node_modules/native-fixture/binding.node",
      ),
      "utf8",
    )) === "native-bytes",
    "Accepted dependency export lost a native asset.",
  );
  const exportedAcceptedPaths = new Set(
    acceptedContract.files.map((entry) => entry.path),
  );
  for (const managerStateFile of [
    ".modules.yaml",
    ".pnpm-workspace-state.json",
    ".pnpm-workspace-state-v1.json",
  ]) {
    assert(
      !exportedAcceptedPaths.has(`node_modules/${managerStateFile}`),
      `Accepted app export shipped package-manager-only install state (${managerStateFile}).`,
    );
  }
  assert(
    !exportedAcceptedPaths.has(
      "node_modules/native-fixture/.pnpm-workspace-state-v1.json",
    ),
    "Accepted app export shipped a versioned pnpm workspace-state file embedded inside a runtime package.",
  );
  assert(
    ![...exportedAcceptedPaths].some((exported) =>
      exported.startsWith("dist/resume-parser-sidecar/build/"),
    ),
    "Accepted app export shipped PyInstaller build intermediates that embed absolute build-host paths.",
  );
  for (const requiredSidecarExport of [
    "dist/resume-parser-sidecar/bin/darwin-arm64/resume_parser_sidecar",
    "dist/resume-parser-sidecar/manifest.json",
    "dist/resume-parser-sidecar/python/darwin-arm64/resume_parser_sidecar.py",
    "dist/resume-parser-sidecar/python/darwin-arm64/site-packages/pypdf/__init__.py",
  ]) {
    assert(
      [...exportedAcceptedPaths].includes(requiredSidecarExport),
      `Sidecar build-intermediate exclusion dropped the runtime sidecar file ${requiredSidecarExport} from the accepted app export.`,
    );
  }

  // Accepted-app hardening is mode-preserving: masking write bits keeps sealed
  // executable modes (0555 stays 0555, 0755 drops to 0555) while generated
  // docs become 0444, and because the accepted-app inventory binds modes, a
  // blanket 0444 flattening is detected even when bytes are identical.
  const modeBindSource = path.join(snapshotFixtureRoot, "mode-bind-source");
  const modeBindDestination = path.join(
    snapshotFixtureRoot,
    "run",
    "mode-bind-app",
  );
  await mkdir(path.join(modeBindSource, "out", "main"), { recursive: true });
  await mkdir(path.join(modeBindSource, "out", "preload"), { recursive: true });
  await mkdir(path.join(modeBindSource, "out", "renderer"), {
    recursive: true,
  });
  await mkdir(path.join(modeBindSource, "node_modules", "exec-fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(modeBindSource, "package.json"),
    JSON.stringify({
      name: "mode-bind-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  const modeBindMain = path.join(modeBindSource, "out", "main", "index.cjs");
  await writeFile(modeBindMain, 'require("exec-fixture");');
  await chmod(modeBindMain, 0o555);
  await writeFile(
    path.join(modeBindSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(modeBindSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  await writeFile(
    path.join(modeBindSource, "node_modules", "exec-fixture", "package.json"),
    JSON.stringify({
      name: "exec-fixture",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    path.join(modeBindSource, "node_modules", "exec-fixture", "index.js"),
    "module.exports = 'executable-runtime';",
  );
  const modeBindDependencyBin = path.join(
    modeBindSource,
    "node_modules",
    "exec-fixture",
    "bin",
    "run.sh",
  );
  await mkdir(path.dirname(modeBindDependencyBin), { recursive: true });
  await writeFile(modeBindDependencyBin, "#!/bin/sh\nexit 0\n");
  await chmod(modeBindDependencyBin, 0o755);
  const modeBindArtifacts = await artifactFingerprint(modeBindSource);
  assert(
    modeBindArtifacts.files.length > 0 &&
      modeBindArtifacts.files.every((entry) => Number.isInteger(entry.mode)),
    "Artifact fingerprints do not record modes for ordinary artifact files.",
  );
  await chmod(modeBindMain, 0o644);
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: modeBindSource,
        destinationRoot: modeBindDestination,
        artifacts: modeBindArtifacts,
        sourceDigest: "c".repeat(64),
        dependencySeeds: ["exec-fixture"],
      }),
    /do not exactly match/,
    "An accepted-app export ignored a mode-only generated-artifact change.",
  );
  await makeTreeWritable(modeBindDestination);
  await rm(modeBindDestination, { recursive: true, force: true });
  await chmod(modeBindMain, 0o555);
  const modeBindContract = await exportAcceptedElectronApp({
    sourceDesktopDir: modeBindSource,
    destinationRoot: modeBindDestination,
    artifacts: modeBindArtifacts,
    sourceDigest: "c".repeat(64),
    dependencySeeds: ["exec-fixture"],
  });
  const modeBindCanonical = await realpath(modeBindDestination);
  await verifyAcceptedElectronApp(modeBindCanonical, modeBindContract);
  const expectedModeBindModes = {
    "package.json": 0o444,
    "out/main/index.cjs": 0o555,
    "out/preload/index.cjs": 0o444,
    "out/renderer/index.html": 0o444,
    "node_modules/exec-fixture/package.json": 0o444,
    "node_modules/exec-fixture/index.js": 0o444,
    "node_modules/exec-fixture/bin/run.sh": 0o555,
  };
  for (const [relativePath, expectedMode] of Object.entries(
    expectedModeBindModes,
  )) {
    const contractEntry = modeBindContract.files.find(
      (entry) => entry.path === relativePath,
    );
    assert(
      contractEntry &&
        contractEntry.mode === expectedMode &&
        ((await lstat(path.join(modeBindCanonical, relativePath))).mode &
          0o777) ===
          expectedMode,
      `Accepted-app hardening did not preserve ${relativePath} at mode ${expectedMode.toString(8)} on disk and in the contract.`,
    );
  }
  const flatteningTargets = modeBindContract.files.filter(
    (entry) => entry.kind === "file" && entry.mode !== 0o444,
  );
  assert(
    flatteningTargets.length > 0,
    "The mode-binding fixture lost its executable entries before flattening.",
  );
  for (const entry of flatteningTargets)
    await chmod(path.join(modeBindCanonical, entry.path), 0o444);
  await mustReject(
    () => verifyAcceptedElectronApp(modeBindCanonical, modeBindContract),
    /extra, missing, aliased, or changed files/,
    "A blanket 0444 flattening of sealed accepted-app files was not detected by mode-aware verification.",
  );
  for (const entry of flatteningTargets)
    await chmod(path.join(modeBindCanonical, entry.path), entry.mode);
  await verifyAcceptedElectronApp(modeBindCanonical, modeBindContract);

  const evidenceHardeningRoot = path.join(
    snapshotFixtureRoot,
    "evidence-hardening",
  );
  await mkdir(evidenceHardeningRoot, { recursive: true });
  const evidenceHardeningCases = [
    ["run.sh", "#!/bin/sh\nexit 0\n", 0o755, 0o555],
    ["sealed-launcher", "sealed-bytes\n", 0o555, 0o555],
    ["notes.md", "generated notes\n", 0o644, 0o444],
    ["data.json", '{"pass":true}\n', 0o444, 0o444],
  ];
  const evidenceHardeningInventory = [];
  for (const [name, contents, mode] of evidenceHardeningCases) {
    const filePath = path.join(evidenceHardeningRoot, name);
    await writeFile(filePath, contents);
    await chmod(filePath, mode);
    evidenceHardeningInventory.push({
      component: "fixture",
      kind: "file",
      path: name,
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  await makeEvidenceFilesReadOnly(
    evidenceHardeningRoot,
    evidenceHardeningInventory,
  );
  for (const [name, contents, , expectedMode] of evidenceHardeningCases) {
    const filePath = path.join(evidenceHardeningRoot, name);
    const hardenedStat = await lstat(filePath);
    assert(
      (hardenedStat.mode & 0o777) === expectedMode &&
        hardenedStat.size === Buffer.byteLength(contents) &&
        (await readFile(filePath, "utf8")) === contents,
      `Evidence hardening produced an unexpected result for ${name}.`,
    );
  }
  await mustReject(
    () =>
      makeEvidenceFilesReadOnly(evidenceHardeningRoot, [
        { path: "../outside.txt" },
      ]),
    /escaped its root/,
    "Evidence hardening followed a path outside its root.",
  );
  await symlink("notes.md", path.join(evidenceHardeningRoot, "notes-link"));
  await mustReject(
    () =>
      makeEvidenceFilesReadOnly(evidenceHardeningRoot, [
        { path: "notes-link" },
      ]),
    /not an ordinary file/,
    "Evidence hardening treated a non-ordinary entry as hardenable evidence.",
  );
  await rm(path.join(evidenceHardeningRoot, "notes-link"));

  // The manager-state exclusion must stay copy-side only. A real runtime file
  // inside a dependency that embeds an original absolute root still fails the
  // export scan exactly as before.
  const taintedSource = path.join(
    snapshotFixtureRoot,
    "tainted-runtime-source",
  );
  const taintedDestination = path.join(
    snapshotFixtureRoot,
    "run",
    "tainted-app",
  );
  await mkdir(path.join(taintedSource, "out", "main"), { recursive: true });
  await mkdir(path.join(taintedSource, "out", "preload"), { recursive: true });
  await mkdir(path.join(taintedSource, "out", "renderer"), { recursive: true });
  await mkdir(path.join(taintedSource, "node_modules", "runtime-fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(taintedSource, "package.json"),
    JSON.stringify({
      name: "tainted-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(taintedSource, "out", "main", "index.cjs"),
    'require("runtime-fixture");',
  );
  await writeFile(
    path.join(taintedSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(taintedSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  await writeFile(
    path.join(taintedSource, "node_modules", "runtime-fixture", "package.json"),
    JSON.stringify({
      name: "runtime-fixture",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    path.join(taintedSource, "node_modules", "runtime-fixture", "config.json"),
    JSON.stringify({ originalWorkspaceRoot: snapshotFixtureRoot }),
  );
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: taintedSource,
        destinationRoot: taintedDestination,
        artifacts: await artifactFingerprint(taintedSource),
        sourceDigest: "b".repeat(64),
        dependencySeeds: ["runtime-fixture"],
      }),
    /unsafe original absolute path: node_modules\/runtime-fixture\/config\.json$/,
    "Package-manager metadata exclusion weakened the strict original absolute-path runtime scan.",
  );

  // The versioned workspace-state exclusion is name-anchored, not a broad
  // dotfile skip: a lookalike dotfile outside that exact family is copied like
  // any runtime file, and the strict byte scanner must reject it for embedding
  // an original absolute root.
  const dotfileStrictSource = path.join(
    snapshotFixtureRoot,
    "dotfile-strict-source",
  );
  const dotfileStrictDestination = path.join(
    snapshotFixtureRoot,
    "run",
    "dotfile-strict-app",
  );
  await mkdir(path.join(dotfileStrictSource, "out", "main"), {
    recursive: true,
  });
  await mkdir(path.join(dotfileStrictSource, "out", "preload"), {
    recursive: true,
  });
  await mkdir(path.join(dotfileStrictSource, "out", "renderer"), {
    recursive: true,
  });
  await mkdir(
    path.join(dotfileStrictSource, "node_modules", "dotfile-fixture"),
    {
      recursive: true,
    },
  );
  await writeFile(
    path.join(dotfileStrictSource, "package.json"),
    JSON.stringify({
      name: "dotfile-strict-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(dotfileStrictSource, "out", "main", "index.cjs"),
    'require("dotfile-fixture");',
  );
  await writeFile(
    path.join(dotfileStrictSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(dotfileStrictSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  await writeFile(
    path.join(
      dotfileStrictSource,
      "node_modules",
      "dotfile-fixture",
      "package.json",
    ),
    JSON.stringify({
      name: "dotfile-fixture",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    path.join(
      dotfileStrictSource,
      "node_modules",
      "dotfile-fixture",
      "index.js",
    ),
    "module.exports = true;",
  );
  await writeFile(
    path.join(
      dotfileStrictSource,
      "node_modules",
      "dotfile-fixture",
      ".pnpm-workspace-state-v1.json.old",
    ),
    JSON.stringify({ projects: { [snapshotFixtureRoot]: {} } }),
  );
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: dotfileStrictSource,
        destinationRoot: dotfileStrictDestination,
        artifacts: await artifactFingerprint(dotfileStrictSource),
        sourceDigest: "b".repeat(64),
        dependencySeeds: ["dotfile-fixture"],
      }),
    /unsafe original absolute path[\s\S]*\.pnpm-workspace-state-v1\.json\.old$/,
    "The workspace-state exclusion skipped arbitrary dotfiles instead of staying anchored to the exact file family.",
  );

  // The export scan reads bytes of every ordinary exported file — maps,
  // extensionless files, and binaries included — and expands every forbidden
  // root to both its resolved and realpath aliases before matching. Each
  // tainted file below was invisible to the previous extension-allowlisted,
  // resolve-only scanner; removing them one at a time must surface exactly
  // the remaining taint, and the clean tree must then export.
  const aliasTaintSource = path.join(snapshotFixtureRoot, "alias-taint-source");
  await mkdir(path.join(aliasTaintSource, "out", "main"), { recursive: true });
  await mkdir(path.join(aliasTaintSource, "out", "preload"), {
    recursive: true,
  });
  await mkdir(path.join(aliasTaintSource, "out", "renderer"), {
    recursive: true,
  });
  await mkdir(path.join(aliasTaintSource, "node_modules", "runtime-fixture"), {
    recursive: true,
  });
  await writeFile(
    path.join(aliasTaintSource, "package.json"),
    JSON.stringify({
      name: "alias-taint-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(aliasTaintSource, "out", "main", "index.cjs"),
    'require("runtime-fixture");',
  );
  await writeFile(
    path.join(aliasTaintSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(aliasTaintSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  await writeFile(
    path.join(
      aliasTaintSource,
      "node_modules",
      "runtime-fixture",
      "package.json",
    ),
    JSON.stringify({
      name: "runtime-fixture",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    path.join(aliasTaintSource, "node_modules", "runtime-fixture", "index.js"),
    "module.exports = true;",
  );
  // The map embeds the realpath alias (macOS /private/var versus /var); the
  // extensionless and binary files embed the resolved form.
  const aliasTaintFiles = [
    {
      relativePath: "node_modules/runtime-fixture/aaa-sourcemap.map",
      contents: JSON.stringify({
        originalRoot: await realpath(snapshotFixtureRoot),
      }),
      digest: "e",
    },
    {
      relativePath: "node_modules/runtime-fixture/bbb-notes",
      contents: `original workspace root: ${snapshotFixtureRoot}\n`,
      digest: "f",
    },
    {
      relativePath: "node_modules/runtime-fixture/ccc-payload.bin",
      contents: `binary-header-${snapshotFixtureRoot}`,
      digest: "1",
    },
  ];
  for (const [taintIndex, taint] of aliasTaintFiles.entries()) {
    for (const earlier of aliasTaintFiles.slice(0, taintIndex)) {
      await rm(path.join(aliasTaintSource, earlier.relativePath), {
        force: true,
      });
    }
    await mkdir(path.dirname(path.join(aliasTaintSource, taint.relativePath)), {
      recursive: true,
    });
    await writeFile(
      path.join(aliasTaintSource, taint.relativePath),
      taint.contents,
    );
    const escapedRelative = taint.relativePath.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    await mustReject(
      async () =>
        exportAcceptedElectronApp({
          sourceDesktopDir: aliasTaintSource,
          destinationRoot: path.join(
            snapshotFixtureRoot,
            "run",
            `alias-taint-app-${taintIndex}`,
          ),
          artifacts: await artifactFingerprint(aliasTaintSource),
          sourceDigest: taint.digest.repeat(64),
          dependencySeeds: ["runtime-fixture"],
        }),
      new RegExp(`unsafe original absolute path: ${escapedRelative}$`, "u"),
      `A tainted nonstandard exported file escaped the byte scan: ${taint.relativePath}.`,
    );
  }
  for (const taint of aliasTaintFiles)
    await rm(path.join(aliasTaintSource, taint.relativePath), {
      force: true,
    });
  const aliasCleanContract = await exportAcceptedElectronApp({
    sourceDesktopDir: aliasTaintSource,
    destinationRoot: path.join(snapshotFixtureRoot, "run", "alias-taint-clean"),
    artifacts: await artifactFingerprint(aliasTaintSource),
    sourceDigest: "2".repeat(64),
    dependencySeeds: ["runtime-fixture"],
  });
  assert(
    aliasCleanContract.runtimePackages.includes("runtime-fixture") &&
      stableJson(aliasCleanContract.dependencyClosure.seeds) ===
        stableJson(["runtime-fixture"]),
    "Removing the tainted files did not leave a clean exportable accepted app.",
  );

  // --- pnpm isolated-topology closure fixtures --------------------------------
  // A faithful virtual-store layout: direct desktop dependencies are symlinks
  // into a root .pnpm store, and every transitive package lives only as a
  // virtual-store sibling of its dependent. The flat top-level dereference
  // this export replaced resolved none of those siblings, so these fixtures
  // fail against the old strategy by construction.
  const pnpmSourceRoot = path.join(snapshotFixtureRoot, "pnpm-topology-source");
  const pnpmDesktopDir = path.join(pnpmSourceRoot, "apps", "desktop");
  const pnpmDestination = path.join(
    snapshotFixtureRoot,
    "run",
    "pnpm-accepted-app",
  );
  const storeNodeModules = (...parts) =>
    path.join(pnpmSourceRoot, "node_modules", ".pnpm", ...parts);
  const writeStorePackage = async (storeSlot, packageName, manifest, files) => {
    const packageRoot = storeNodeModules(
      storeSlot,
      "node_modules",
      packageName,
    );
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );
    for (const [relativePath, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(packageRoot, relativePath)), {
        recursive: true,
      });
      await writeFile(path.join(packageRoot, relativePath), contents);
    }
    return packageRoot;
  };
  await writeStorePackage(
    "left-pad@2.0.0",
    "left-pad",
    {
      name: "left-pad",
      version: "2.0.0",
      main: "index.js",
    },
    { "index.js": 'module.exports = "left-pad-2";' },
  );
  await writeStorePackage(
    "left-pad@1.0.0",
    "left-pad",
    {
      name: "left-pad",
      version: "1.0.0",
      main: "index.js",
    },
    { "index.js": 'module.exports = "left-pad-1";' },
  );
  await writeStorePackage(
    "mitt@3.0.1",
    "mitt",
    {
      name: "mitt",
      version: "3.0.1",
      main: "index.js",
    },
    { "index.js": 'module.exports = "mitt-core";' },
  );
  await writeStorePackage(
    "app-a@1.0.0",
    "app-a",
    {
      name: "app-a",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "left-pad": "^2.0.0", mitt: "^3.0.1" },
    },
    {
      "index.js":
        'module.exports = { leftPad: require("left-pad"), mitt: require("mitt") };',
    },
  );
  await writeStorePackage(
    "app-b@1.0.0",
    "app-b",
    {
      name: "app-b",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "left-pad": "^1.0.0" },
      optionalDependencies: { "ghost-dep": "^1.0.0" },
    },
    { "index.js": 'module.exports = { leftPad: require("left-pad") };' },
  );
  await writeStorePackage(
    "app-missing@1.0.0",
    "app-missing",
    {
      name: "app-missing",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "absent-dep": "^1.0.0" },
    },
    { "index.js": "module.exports = true;" },
  );
  // Faithful pnpm isolated layout: every transitive dependency is a relative
  // symlink sibling inside its dependent's virtual-store node_modules, so the
  // closure must resolve them exactly like Node climbs the store at runtime.
  const linkStoreSibling = async (dependentSlot, name, targetSlot) => {
    await symlink(
      path.relative(
        storeNodeModules(dependentSlot, "node_modules"),
        storeNodeModules(targetSlot, "node_modules", name),
      ),
      storeNodeModules(dependentSlot, "node_modules", name),
    );
  };
  await linkStoreSibling("app-a@1.0.0", "left-pad", "left-pad@2.0.0");
  await linkStoreSibling("app-a@1.0.0", "mitt", "mitt@3.0.1");
  await linkStoreSibling("app-b@1.0.0", "left-pad", "left-pad@1.0.0");
  // pnpm never links transitive packages at an app root; only the two direct
  // desktop dependencies are linked into the desktop node_modules.
  for (const [packageName, storeSlot] of [
    ["app-a", "app-a@1.0.0"],
    ["app-b", "app-b@1.0.0"],
    ["app-missing", "app-missing@1.0.0"],
  ]) {
    await mkdir(path.join(pnpmDesktopDir, "node_modules"), {
      recursive: true,
    });
    await symlink(
      path.relative(
        path.join(pnpmDesktopDir, "node_modules"),
        storeNodeModules(storeSlot, "node_modules", packageName),
      ),
      path.join(pnpmDesktopDir, "node_modules", packageName),
    );
  }
  // Package-manager-only state at the node_modules root plus a stray file
  // inside the store: none of it may ever reach the accepted runtime.
  await writeFile(
    path.join(pnpmSourceRoot, "node_modules", ".modules.yaml"),
    `storeDir: ${path.join(snapshotFixtureRoot, "pnpm-store", "v10")}\n`,
  );
  await writeFile(
    path.join(pnpmSourceRoot, "node_modules", ".pnpm-workspace-state.json"),
    JSON.stringify({ projects: { [repositoryRoot]: {} } }),
  );
  await writeFile(
    path.join(pnpmSourceRoot, "node_modules", ".pnpm-workspace-state-v1.json"),
    JSON.stringify({ projects: { [repositoryRoot]: {} } }),
  );
  await writeFile(
    storeNodeModules("STRAY-STORE-FILE.txt"),
    "virtual-store bookkeeping that is not a package\n",
  );
  await mkdir(path.join(pnpmDesktopDir, "out", "main"), { recursive: true });
  await mkdir(path.join(pnpmDesktopDir, "out", "preload"), {
    recursive: true,
  });
  await mkdir(path.join(pnpmDesktopDir, "out", "renderer"), {
    recursive: true,
  });
  await writeFile(
    path.join(pnpmDesktopDir, "package.json"),
    JSON.stringify({
      name: "pnpm-closure-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(pnpmDesktopDir, "out", "main", "index.cjs"),
    'require("app-a");\nrequire("app-b");\n',
  );
  await writeFile(
    path.join(pnpmDesktopDir, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(pnpmDesktopDir, "out", "renderer", "index.html"),
    "<html></html>",
  );
  const pnpmContract = await exportAcceptedElectronApp({
    sourceDesktopDir: pnpmDesktopDir,
    destinationRoot: pnpmDestination,
    artifacts: await artifactFingerprint(pnpmDesktopDir),
    sourceDigest: "c".repeat(64),
    snapshotRoot: pnpmSourceRoot,
    dependencySeeds: ["app-a", "app-b"],
  });
  const pnpmCanonicalDestination = await realpath(pnpmDestination);
  await verifyAcceptedElectronApp(pnpmCanonicalDestination, pnpmContract);
  assert(
    pnpmContract.dependencyClosure.strategy === DEPENDENCY_EXPORT_STRATEGY &&
      stableJson(pnpmContract.dependencyClosure.seeds) ===
        stableJson(["app-a", "app-b"]),
    "The pnpm closure contract lost its explicit seed set or strategy.",
  );
  assert(
    stableJson(pnpmContract.runtimePackages) ===
      stableJson(["app-a", "app-b", "left-pad", "mitt"]),
    "The pnpm closure inventory must list exactly the reachable production packages.",
  );
  const pnpmPackageVersions = Object.fromEntries(
    pnpmContract.dependencyClosure.packages.map((entry) => [
      `${entry.name}@${entry.version}`,
      entry.destination,
    ]),
  );
  assert(
    pnpmPackageVersions["left-pad@2.0.0"] === "node_modules/left-pad" &&
      pnpmPackageVersions["left-pad@1.0.0"] ===
        "node_modules/app-b/node_modules/left-pad",
    "Conflicting dependency versions must hoist when free and nest under their dependent on conflict.",
  );
  assert(
    (
      pnpmContract.dependencyClosure.packages.find(
        (entry) => entry.name === "mitt",
      )?.requiredBy ?? []
    ).includes("node_modules/app-a") &&
      (
        pnpmContract.dependencyClosure.packages.find(
          (entry) => entry.name === "app-a",
        )?.requiredBy ?? []
      ).includes("apps/desktop"),
    "The closure audit must record each package's requirers.",
  );
  const ghostSkips = pnpmContract.dependencyClosure.skippedOptional.filter(
    (entry) => entry.specifier === "ghost-dep",
  );
  assert(
    ghostSkips.length === 1 &&
      ghostSkips[0].reason === "optional-dependency" &&
      ghostSkips[0].requirer.startsWith("app-b@"),
    "A declared-but-absent optional dependency must be skipped with an explicit requirer-tagged record.",
  );
  const pnpmExportedPaths = new Set(
    pnpmContract.files.map((entry) => entry.path),
  );
  for (const forbiddenRelative of [
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state.json",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/app-missing",
  ]) {
    assert(
      ![...pnpmExportedPaths].some(
        (exported) =>
          exported.startsWith(
            `${forbiddenRelative}${forbiddenRelative.endsWith("/") ? "" : "/"}`,
          ) || exported === forbiddenRelative,
      ),
      `Accepted app export leaked non-runtime entry ${forbiddenRelative}.`,
    );
  }
  assert(
    ![...pnpmExportedPaths].some((exported) =>
      exported.includes("STRAY-STORE-FILE.txt"),
    ),
    "Virtual-store bookkeeping leaked into the accepted app export.",
  );
  // Representative roots must resolve AND load from the exported tree alone:
  // every realpath stays inside the export, proving no workspace/snapshot
  // fallback exists.
  const pnpmRequire = createRequire(path.join(pnpmDestination, "package.json"));
  for (const [specifier, expected] of [
    ["mitt", "mitt-core"],
    ["left-pad", "left-pad-2"],
    ["app-a", { leftPad: "left-pad-2", mitt: "mitt-core" }],
    ["app-b", { leftPad: "left-pad-1" }],
  ]) {
    const resolvedPath = pnpmRequire.resolve(specifier);
    assert(
      resolvedPath.startsWith(`${pnpmCanonicalDestination}${path.sep}`),
      `Exported root ${specifier} resolved outside the accepted app: ${resolvedPath}`,
    );
    assert(
      stableJson(pnpmRequire(specifier)) === stableJson(expected),
      `Exported root ${specifier} did not load its topology-faithful content.`,
    );
  }
  assert(
    JSON.parse(
      await readFile(
        path.join(
          pnpmDestination,
          "node_modules",
          "app-b",
          "node_modules",
          "left-pad",
          "package.json",
        ),
        "utf8",
      ),
    ).version === "1.0.0",
    "The nested conflicting left-pad copy was not materialized under its dependent.",
  );
  // Missing required dependency fails closed, naming requirer and specifier.
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: pnpmDesktopDir,
        destinationRoot: path.join(
          snapshotFixtureRoot,
          "run",
          "pnpm-missing-app",
        ),
        artifacts: await artifactFingerprint(pnpmDesktopDir),
        sourceDigest: "d".repeat(64),
        snapshotRoot: pnpmSourceRoot,
        dependencySeeds: ["app-missing"],
      }),
    /absent-dep[\s\S]*app-missing/,
    "A missing required dependency was accepted without failing closed on requirer and specifier.",
  );
  // Pre-launch module containment probes over the same exported tree.
  const pnpmContainment = await probeAcceptedAppRuntimeModules({
    acceptedAppRoot: pnpmDestination,
    specifiers: ["app-a", "mitt"],
  });
  assert(
    pnpmContainment.pass === true &&
      pnpmContainment.probes.length === 2 &&
      pnpmContainment.probes.every(
        (probe) =>
          probe.pass === true && probe.resolvedInsideAcceptedApp === true,
      ),
    "Module containment probes must pass for resolvable exported roots.",
  );
  const ghostContainment = await probeAcceptedAppRuntimeModules({
    acceptedAppRoot: pnpmDestination,
    specifiers: ["ghost-dep"],
  });
  assert(
    ghostContainment.pass === false &&
      ghostContainment.probes.length === 1 &&
      ghostContainment.probes[0].pass === false &&
      ghostContainment.probes[0].error.includes("ghost-dep") &&
      typeof ghostContainment.failure === "string" &&
      ghostContainment.failure.includes("ghost-dep"),
    "Module containment probes must fail closed with the missing specifier named.",
  );

  // --- closure topology edge cases -------------------------------------------
  // An explicitly optional peer may be absent: the export tolerates it and
  // must record the skip with requirer, specifier, and reason.
  await writeStorePackage(
    "peer-optional@1.0.0",
    "peer-optional",
    {
      name: "peer-optional",
      version: "1.0.0",
      main: "index.js",
      peerDependencies: { "absent-optional-peer": "^1.0.0" },
      peerDependenciesMeta: { "absent-optional-peer": { optional: true } },
    },
    { "index.js": "module.exports = 'peer-optional';" },
  );
  await mkdir(path.join(pnpmDesktopDir, "node_modules"), { recursive: true });
  await symlink(
    path.relative(
      path.join(pnpmDesktopDir, "node_modules"),
      storeNodeModules("peer-optional@1.0.0", "node_modules", "peer-optional"),
    ),
    path.join(pnpmDesktopDir, "node_modules", "peer-optional"),
  );
  const peerOptionalContract = await exportAcceptedElectronApp({
    sourceDesktopDir: pnpmDesktopDir,
    destinationRoot: path.join(
      snapshotFixtureRoot,
      "run",
      "pnpm-peer-optional",
    ),
    artifacts: await artifactFingerprint(pnpmDesktopDir),
    sourceDigest: "6".repeat(64),
    snapshotRoot: pnpmSourceRoot,
    dependencySeeds: ["peer-optional"],
  });
  const optionalPeerSkips =
    peerOptionalContract.dependencyClosure.skippedOptional.filter(
      (entry) => entry.specifier === "absent-optional-peer",
    );
  assert(
    optionalPeerSkips.length === 1 &&
      optionalPeerSkips[0].reason === "optional-peer" &&
      optionalPeerSkips[0].requirer === "peer-optional@1.0.0",
    "An absent optional peer must be tolerated and recorded as an explicit requirer-tagged skip.",
  );
  // A non-optional peer that is absent fails closed like any other required
  // dependency, naming both specifier and requirer.
  await writeStorePackage(
    "peer-required@1.0.0",
    "peer-required",
    {
      name: "peer-required",
      version: "1.0.0",
      main: "index.js",
      peerDependencies: { "absent-required-peer": "^1.0.0" },
    },
    { "index.js": "module.exports = 'peer-required';" },
  );
  await symlink(
    path.relative(
      path.join(pnpmDesktopDir, "node_modules"),
      storeNodeModules("peer-required@1.0.0", "node_modules", "peer-required"),
    ),
    path.join(pnpmDesktopDir, "node_modules", "peer-required"),
  );
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: pnpmDesktopDir,
        destinationRoot: path.join(
          snapshotFixtureRoot,
          "run",
          "pnpm-peer-required",
        ),
        artifacts: await artifactFingerprint(pnpmDesktopDir),
        sourceDigest: "7".repeat(64),
        snapshotRoot: pnpmSourceRoot,
        dependencySeeds: ["peer-required"],
      }),
    /Required dependency "absent-required-peer" of peer-required@1\.0\.0/,
    "An absent required peer was accepted without failing closed.",
  );
  // A seed reachable only through a resolved-seed sibling (pnpm virtual-store
  // layout) resolves without any workspace fallback, and its provenance is
  // auditable in the contract. sibling-seed lives beside app-a inside app-a's
  // virtual-store node_modules and is never linked at the desktop root.
  await writeStorePackage(
    "app-a@1.0.0",
    "sibling-seed",
    {
      name: "sibling-seed",
      version: "1.0.0",
      main: "index.js",
    },
    { "index.js": "module.exports = 'sibling-seed';" },
  );
  const siblingContract = await exportAcceptedElectronApp({
    sourceDesktopDir: pnpmDesktopDir,
    destinationRoot: path.join(snapshotFixtureRoot, "run", "pnpm-sibling-seed"),
    artifacts: await artifactFingerprint(pnpmDesktopDir),
    sourceDigest: "8".repeat(64),
    snapshotRoot: pnpmSourceRoot,
    dependencySeeds: ["app-a", "sibling-seed"],
  });
  const siblingProvenance =
    siblingContract.dependencyClosure.seedProvenance.find(
      (entry) => entry.name === "sibling-seed",
    );
  assert(
    siblingProvenance?.via === "resolved-seed:app-a" &&
      siblingContract.runtimePackages.includes("sibling-seed"),
    "A seed resolvable only through a resolved-seed sibling must succeed with recorded provenance.",
  );
  assert(
    siblingContract.dependencyClosure.seedProvenance.some(
      (entry) => entry.name === "app-a" && entry.via === "source-desktop",
    ),
    "Directly resolved seeds must record their desktop-root provenance.",
  );
  const siblingRequire = createRequire(
    path.join(snapshotFixtureRoot, "run", "pnpm-sibling-seed", "package.json"),
  );
  const siblingDestinationRoot = await realpath(
    path.join(snapshotFixtureRoot, "run", "pnpm-sibling-seed"),
  );
  assert(
    siblingRequire("sibling-seed") === "sibling-seed" &&
      siblingRequire.resolve("sibling-seed").startsWith(siblingDestinationRoot),
    "The sibling-fallback seed did not materialize inside the export.",
  );
  // A closure dependency whose symlink escapes the immutable snapshot fails
  // closed instead of dereferencing outside content into the accepted app.
  await writeStorePackage(
    "escaper@1.0.0",
    "escaper",
    {
      name: "escaper",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "escape-dep": "^1.0.0" },
    },
    { "index.js": 'module.exports = require("escape-dep");' },
  );
  const outsideEscapeDep = path.join(
    snapshotFixtureRoot,
    "outside-escape",
    "escape-dep",
  );
  await mkdir(outsideEscapeDep, { recursive: true });
  await writeFile(
    path.join(outsideEscapeDep, "package.json"),
    JSON.stringify({ name: "escape-dep", version: "1.0.0", main: "index.js" }),
  );
  await writeFile(
    path.join(outsideEscapeDep, "index.js"),
    "module.exports = 1;",
  );
  await symlink(
    path.relative(
      storeNodeModules("escaper@1.0.0", "node_modules"),
      outsideEscapeDep,
    ),
    storeNodeModules("escaper@1.0.0", "node_modules", "escape-dep"),
  );
  await symlink(
    path.relative(
      path.join(pnpmDesktopDir, "node_modules"),
      storeNodeModules("escaper@1.0.0", "node_modules", "escaper"),
    ),
    path.join(pnpmDesktopDir, "node_modules", "escaper"),
  );
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: pnpmDesktopDir,
        destinationRoot: path.join(snapshotFixtureRoot, "run", "pnpm-escape"),
        artifacts: await artifactFingerprint(pnpmDesktopDir),
        sourceDigest: "9".repeat(64),
        snapshotRoot: pnpmSourceRoot,
        dependencySeeds: ["escaper"],
      }),
    /escape-dep[\s\S]*resolves outside the immutable snapshot/,
    "A closure dependency symlink escaping the immutable snapshot was accepted.",
  );

  // --- poisoned dependency names --------------------------------------------
  // Seeds and manifest dependency keys are node_modules path segments. A
  // traversal-shaped seed or manifest key must be rejected before anything is
  // written outside the intended accepted-app destination root.
  const poisonRunRoot = path.join(snapshotFixtureRoot, "run");
  const listRunEntries = async () => (await readdir(poisonRunRoot)).sort();
  const poisonSource = path.join(snapshotFixtureRoot, "poison-source");
  await mkdir(path.join(poisonSource, "out", "main"), { recursive: true });
  await writeFile(
    path.join(poisonSource, "package.json"),
    JSON.stringify({
      name: "poison-fixture",
      version: "1.0.0",
      private: true,
      main: "out/main/index.cjs",
    }),
  );
  await writeFile(
    path.join(poisonSource, "out", "main", "index.cjs"),
    "module.exports = null;",
  );
  const runEntriesBeforePoison = await listRunEntries();
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: poisonSource,
        destinationRoot: path.join(poisonRunRoot, "poison-seed-app"),
        artifacts: await artifactFingerprint(poisonSource),
        sourceDigest: "a".repeat(64),
        dependencySeeds: ["../poison-escape"],
      }),
    /dependency name/,
    "A traversal-shaped dependency seed was accepted.",
  );
  assert(
    !existsSync(path.join(poisonRunRoot, "poison-seed-app")),
    "A poisoned seed created its accepted-app destination before name validation.",
  );
  const poisonManifestPackage = path.join(
    poisonSource,
    "node_modules",
    "manifest-trap-fixture",
  );
  await mkdir(poisonManifestPackage, { recursive: true });
  await writeFile(
    path.join(poisonManifestPackage, "package.json"),
    JSON.stringify({
      name: "manifest-trap-fixture",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "../../escape-victim": "^1.0.0" },
    }),
  );
  await writeFile(
    path.join(poisonManifestPackage, "index.js"),
    "module.exports = true;",
  );
  await mkdir(path.join(poisonSource, "out", "preload"), { recursive: true });
  await mkdir(path.join(poisonSource, "out", "renderer"), { recursive: true });
  await writeFile(
    path.join(poisonSource, "out", "preload", "index.cjs"),
    'require("electron");',
  );
  await writeFile(
    path.join(poisonSource, "out", "renderer", "index.html"),
    "<html></html>",
  );
  await mustReject(
    async () =>
      exportAcceptedElectronApp({
        sourceDesktopDir: poisonSource,
        destinationRoot: path.join(poisonRunRoot, "poison-manifest-app"),
        artifacts: await artifactFingerprint(poisonSource),
        sourceDigest: "b".repeat(64),
        dependencySeeds: ["manifest-trap-fixture"],
      }),
    /dependency name[\s\S]*\.\.\/\.\.\/escape-victim/s,
    "A traversal-shaped manifest dependency key was accepted.",
  );
  assert(
    stableJson(await listRunEntries()) ===
      stableJson([...runEntriesBeforePoison, "poison-manifest-app"].sort()) &&
      !existsSync(path.join(poisonRunRoot, "poison-escape")) &&
      !existsSync(path.join(poisonRunRoot, "escape-victim")),
    "A poisoned dependency name caused writes outside its intended accepted-app destination.",
  );

  const seal = createFinalAcceptanceSeal({
    runId: "fixture",
    report: "a".repeat(64),
  });
  assert(
    verifyFinalAcceptanceSeal(seal, seal.sealSha256),
    "Canonical final seal did not verify.",
  );
  await mustReject(
    async () =>
      verifyFinalAcceptanceSeal(
        { ...seal, report: "b".repeat(64) },
        seal.sealSha256,
      ),
    /seal digest mismatch/,
    "Final seal subject tampering was accepted.",
  );
  for (const reservedField of [
    "schemaVersion",
    "digestRecipe",
    "threatModel",
    "sealSha256",
  ]) {
    mustThrow(
      () => createFinalAcceptanceSeal({ [reservedField]: "override" }),
      /reserved fields/,
      `A final seal subject overriding the reserved ${reservedField} field was accepted.`,
    );
  }
  mustThrow(
    () => createFinalAcceptanceSeal("not-an-object"),
    /plain object/,
    "A non-object final seal subject was accepted.",
  );

  // --- electron identity containment -----------------------------------------
  const identityFixtureRoot = path.join(
    snapshotFixtureRoot,
    "electron-identity",
  );
  const identityDesktopDir = path.join(identityFixtureRoot, "apps", "desktop");
  const electronPackageRoot = path.join(
    identityDesktopDir,
    "node_modules",
    "electron",
  );
  const playwrightRoot = path.join(
    identityDesktopDir,
    "node_modules",
    "playwright",
  );
  await mkdir(path.join(electronPackageRoot, "dist"), { recursive: true });
  await mkdir(playwrightRoot, { recursive: true });
  await writeFile(
    path.join(electronPackageRoot, "package.json"),
    JSON.stringify({ name: "electron", version: "33.0.0", main: "index.js" }),
  );
  await writeFile(
    path.join(electronPackageRoot, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", "electron");`,
  );
  await writeFile(
    path.join(electronPackageRoot, "dist", "electron"),
    "MACHO-BYTES",
  );
  await writeFile(
    path.join(playwrightRoot, "package.json"),
    JSON.stringify({ name: "playwright", version: "1.0.0" }),
  );
  const containedIdentity =
    await electronIdentityFromSnapshot(identityDesktopDir);
  assert(
    containedIdentity.electronPackageVersion === "33.0.0" &&
      containedIdentity.playwrightPackageVersion === "1.0.0" &&
      containedIdentity.bytes === Buffer.byteLength("MACHO-BYTES") &&
      /^[a-f0-9]{64}$/.test(containedIdentity.sha256),
    "Electron identity capture lost its executable bytes or package versions.",
  );
  const invalidateIdentityModuleCache = () => {
    const cacheOwner = createRequire(import.meta.url);
    // Module cache keys are stored under the realpath of each file, so the
    // prefix must be compared against the canonical directory too.
    return realpath(identityDesktopDir).then((canonicalDesktopDir) => {
      for (const cachedPath of Object.keys(cacheOwner.cache)) {
        if (
          cachedPath.startsWith(identityDesktopDir + path.sep) ||
          cachedPath.startsWith(canonicalDesktopDir + path.sep)
        )
          delete cacheOwner.cache[cachedPath];
      }
    });
  };
  const outsideBinary = path.join(
    snapshotFixtureRoot,
    "outside-electron-binary",
  );
  await writeFile(outsideBinary, "FOREIGN-BINARY");
  await writeFile(
    path.join(electronPackageRoot, "index.js"),
    `module.exports = ${JSON.stringify(outsideBinary)};`,
  );
  await invalidateIdentityModuleCache();
  await mustReject(
    async () => electronIdentityFromSnapshot(identityDesktopDir),
    /Electron executable escaped the accepted root/,
    "An Electron executable resolving outside the accepted root was sealed as runtime identity.",
  );
  await writeFile(
    path.join(electronPackageRoot, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", "electron");`,
  );
  await invalidateIdentityModuleCache();
  // A playwright manifest that symlinks out of the identity root must fail
  // containment even though its textual resolution path stays inside.
  const foreignPlaywrightManifestDir = path.join(
    snapshotFixtureRoot,
    "foreign-playwright",
  );
  await mkdir(foreignPlaywrightManifestDir, { recursive: true });
  await writeFile(
    path.join(foreignPlaywrightManifestDir, "package.json"),
    JSON.stringify({ name: "playwright", version: "9.9.9" }),
  );
  await rm(path.join(playwrightRoot, "package.json"));
  await symlink(
    path.relative(
      playwrightRoot,
      path.join(foreignPlaywrightManifestDir, "package.json"),
    ),
    path.join(playwrightRoot, "package.json"),
  );
  await mustReject(
    async () => electronIdentityFromSnapshot(identityDesktopDir),
    /Playwright package manifest escaped the accepted root/,
    "A Playwright manifest resolving outside the accepted root was sealed as runtime identity.",
  );

  const evidenceRoot = path.join(snapshotFixtureRoot, "evidence");
  await mkdir(evidenceRoot);
  for (const [name, initial, mutation] of [
    ["capture.png", "png-before", "png-after"],
    ["report.json", '{"pass":true}', '{"pass":false}'],
  ]) {
    const evidencePath = path.join(evidenceRoot, name);
    await writeFile(evidencePath, initial);
    const evidenceInventory = {
      files: [
        {
          path: name,
          bytes: Buffer.byteLength(initial),
          sha256: createHash("sha256").update(initial).digest("hex"),
        },
      ],
    };
    await writeFile(evidencePath, mutation);
    await mustReject(
      () => assertFileInventoryUnchanged(evidenceRoot, evidenceInventory),
      /Inventoried evidence changed/,
      `${name} mutation after inventory was accepted.`,
    );
    await writeFile(evidencePath, initial);
    const inventoryFactory = async () => ({
      files: [
        {
          path: name,
          bytes: Buffer.byteLength(initial),
          sha256: createHash("sha256").update(initial).digest("hex"),
        },
      ],
    });
    const assertExpectedContents = async () => {
      assert(
        (await readFile(evidencePath, "utf8")) === initial,
        `${name} consistency changed after initial verification.`,
      );
    };
    await mustReject(
      () =>
        finalizeFileEvidence({
          root: evidenceRoot,
          verifyConsistency: assertExpectedContents,
          buildInventory: async () => {
            const inventory = await inventoryFactory();
            await writeFile(evidencePath, mutation);
            return inventory;
          },
        }),
      /consistency changed/,
      `${name} mutation between initial verification and inventory was accepted.`,
    );
    await writeFile(evidencePath, initial);
    let consistencyChecks = 0;
    await mustReject(
      () =>
        finalizeFileEvidence({
          root: evidenceRoot,
          verifyConsistency: async () => {
            await assertExpectedContents();
            consistencyChecks += 1;
            if (consistencyChecks === 2)
              await writeFile(evidencePath, mutation);
          },
          buildInventory: inventoryFactory,
        }),
      /Inventoried evidence changed/,
      `${name} mutation between final consistency verification and rehash was accepted.`,
    );
  }
} finally {
  await makeTreeWritable(snapshotFixtureRoot);
  await rm(snapshotFixtureRoot, { recursive: true, force: true });
}

// Generated release-evidence mirrors under docs/audits/evidence-manifests are
// collector output, not product input. Both fingerprint algorithms (this
// harness's acceptance inventory and the collector in
// scripts/collect-release-evidence.mjs) must exclude exactly that directory
// and nothing else under docs/, otherwise writing a mirror would change the
// very source fingerprint it evidences while human-authored audits would slip
// out of scope. Parity is asserted per path, then the ignore-mirror versus
// detect-adjacent-edit behavior is proven end to end against both algorithms.
// The release-evidence collector must enumerate source paths NUL-safely,
// classify every enumerated path into an explicit kind (ordinary file,
// contained symlink, or Git-declared worktree deletion), and fail closed on
// undeclared races, escaping/broken symlinks, and unsupported entry types;
// these tokens pin that contract statically so a regression back to
// line-splitting, silent skips, or sentinel digests cannot pass the
// exclusion-parity probes below.
const collectorScriptSource = await readFile(
  path.join(repositoryRoot, "scripts", "collect-release-evidence.mjs"),
  "utf8",
);
for (const requiredCollectorToken of [
  '"ls-files", "-z", "-co", "--exclude-standard"',
  '"ls-files", "-z", "-d"',
  '.split("\\0")',
  "disappeared between enumeration and hashing",
  "Unsupported source entry type for",
  "symlinkCount",
  "deletedCount",
]) {
  assert(
    collectorScriptSource.includes(requiredCollectorToken),
    `Release-evidence collector lost its NUL-safe, fail-closed enumeration contract: missing ${requiredCollectorToken}.`,
  );
}
assert(
  collectorSourceFingerprintRecipe ===
    "nul-enumerated-stable-json-lines-v3:file-mode-sha256-or-contained-symlink-or-git-declared-deletion",
  "The collector source-fingerprint recipe must stay at the v3 id that binds permission bits into ordinary-file and symlink records.",
);
assert(
  collectorScriptSource.includes("realpath(fileURLToPath(import.meta.url))"),
  "Direct-invocation detection must canonicalize import.meta.url through realpath so aliased roots cannot bypass it.",
);
assert(
  !collectorScriptSource.includes(
    "import.meta.url === pathToFileURL(path.resolve(process.argv[1]))",
  ),
  "The alias-sensitive direct-invocation comparison must not return: a /var-spelled entry point used to silently exit 0.",
);

const FINGERPRINT_EXCLUDE_PARITY_PROBES = Object.freeze([
  // Excluded by both algorithms: generated mirrors plus pre-existing excludes.
  { path: "docs/audits/evidence-manifests", excluded: true },
  {
    path: "docs/audits/evidence-manifests/release-run.manifest.json",
    excluded: true,
  },
  {
    path: "docs/audits/evidence-manifests/nested/deep/run.manifest.json",
    excluded: true,
  },
  { path: "node_modules/pkg/index.js", excluded: true },
  { path: "test-artifacts/release/run/log.txt", excluded: true },
  {
    path: "apps/test-artifacts/persona-wave/run/evidence.json",
    excluded: true,
  },
  { path: "packages/browser-agent/tsconfig.tsbuildinfo", excluded: true },
  { path: ".git/config", excluded: true },
  { path: "dist/bundle.js", excluded: true },
  // Included by both algorithms: human-authored docs stay fully bound.
  { path: "docs/TESTING.md", excluded: false },
  {
    path: "docs/audits/DESKTOP_APP_COMPUTER_USE_USABILITY_AUDIT_2026-08-10.md",
    excluded: false,
  },
  {
    path: "docs/audits/assets/desktop-app-computer-use-usability-2026-08-10/overview.png",
    excluded: false,
  },
  // Narrow anchoring: lookalike neighbors are not swept into the exclusion.
  { path: "docs/audits/evidence-manifests-backup/old.json", excluded: false },
  { path: "scripts/collect-release-evidence.mjs", excluded: false },
]);
for (const probe of FINGERPRINT_EXCLUDE_PARITY_PROBES) {
  assert(
    isCollectorSourceExclude(probe.path) ===
      isAcceptanceSourceExclude(probe.path),
    `Source-fingerprint exclude parity broke for ${probe.path}: collector=${isCollectorSourceExclude(probe.path)} acceptance=${isAcceptanceSourceExclude(probe.path)}.`,
  );
  assert(
    isCollectorSourceExclude(probe.path) === probe.excluded,
    `Collector source fingerprint misclassified ${probe.path} as ${isCollectorSourceExclude(probe.path) ? "excluded" : "included"}.`,
  );
  assert(
    isAcceptanceSourceExclude(probe.path) === probe.excluded,
    `Acceptance source inventory misclassified ${probe.path} as ${isAcceptanceSourceExclude(probe.path) ? "excluded" : "included"}.`,
  );
}

const fingerprintFixtureRoot = await mkdtemp(
  path.join(approvedTempRoot, "acceptance-fingerprint-parity-"),
);
try {
  await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    ["init", "-q"],
    { cwd: fingerprintFixtureRoot, windowsHide: true },
  );
  const writeFingerprintProbeFile = async (relativePath, contents) => {
    const fullPath = path.join(fingerprintFixtureRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  };
  await writeFingerprintProbeFile("src/product.ts", "export const x = 1;\n");
  await writeFingerprintProbeFile(
    "docs/audits/HUMAN_REVIEW.md",
    "# human-authored review\n",
  );
  await writeFingerprintProbeFile(
    "src/new\nline-name.txt",
    "newline-bearing filename\n",
  );
  const baseline = await sourceFingerprint(fingerprintFixtureRoot);
  const collectorBaseline = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  assert(
    collectorBaseline.fileCount === baseline.fileCount,
    "The collector and acceptance inventories disagree on the enumerated source file count for the parity fixture, including its newline-bearing filename.",
  );
  await writeFingerprintProbeFile(
    "docs/audits/evidence-manifests/release-fixture.manifest.json",
    "{\n}\n",
  );
  const withMirror = await sourceFingerprint(fingerprintFixtureRoot);
  const collectorWithMirror = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  assert(
    withMirror.digest === baseline.digest &&
      withMirror.pathSetDigest === baseline.pathSetDigest &&
      withMirror.fileCount === baseline.fileCount,
    "Creating a generated evidence mirror changed the acceptance source fingerprint it is supposed to evidence.",
  );
  assert(
    stableJson(collectorBaseline) === stableJson(collectorWithMirror),
    "Creating a generated evidence mirror changed the collector source fingerprint it is supposed to evidence.",
  );
  await writeFingerprintProbeFile(
    "docs/audits/HUMAN_REVIEW.md",
    "# human-authored review\nedited\n",
  );
  const afterAdjacentEdit = await sourceFingerprint(fingerprintFixtureRoot);
  assert(
    afterAdjacentEdit.digest !== baseline.digest &&
      afterAdjacentEdit.fileCount === baseline.fileCount,
    "An adjacent human-authored docs/audits edit was not detected by the acceptance source fingerprint.",
  );
  await writeFingerprintProbeFile(
    "docs/audits/SECOND_HUMAN_NOTE.md",
    "another human-authored audit note\n",
  );
  const afterNewHumanDoc = await sourceFingerprint(fingerprintFixtureRoot);
  assert(
    afterNewHumanDoc.digest !== baseline.digest &&
      afterNewHumanDoc.pathSetDigest !== baseline.pathSetDigest,
    "A new human-authored docs/audits file was not detected by the acceptance source fingerprint.",
  );
  const collectorAfterNewHumanDoc = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  assert(
    stableJson(collectorAfterNewHumanDoc) !== stableJson(collectorBaseline),
    "A new human-authored docs/audits file was not detected by the collector source fingerprint.",
  );

  // Mode binding under the v3 collector recipe: flipping only permission bits
  // must move the collector digest while leaving every count untouched, and
  // restoring the bits must restore the exact prior fingerprint.
  if (process.platform !== "win32") {
    const collectorChmodProbe = path.join(
      fingerprintFixtureRoot,
      "src",
      "product.ts",
    );
    const collectorChmodPriorMode =
      (await lstat(collectorChmodProbe)).mode & 0o777;
    await chmod(collectorChmodProbe, collectorChmodPriorMode ^ 0o200);
    const collectorAfterChmod = await collectorComputeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    assert(
      collectorAfterChmod.digest !== collectorAfterNewHumanDoc.digest &&
        collectorAfterChmod.fileCount === collectorAfterNewHumanDoc.fileCount &&
        collectorAfterChmod.symlinkCount === 0 &&
        collectorAfterChmod.deletedCount === 0 &&
        stableJson(collectorAfterChmod) !==
          stableJson(collectorAfterNewHumanDoc),
      "A chmod-only source mutation did not change the collector digest under the mode-bound recipe.",
    );
    await chmod(collectorChmodProbe, collectorChmodPriorMode);
    assert(
      stableJson(
        await collectorComputeSourceFingerprint(fingerprintFixtureRoot),
      ) === stableJson(collectorAfterNewHumanDoc),
      "Restoring the original permission bits did not restore the exact collector fingerprint.",
    );
  }

  // Selection-policy divergence is intentional and pinned: the acceptance
  // inventory snapshots symlinks as metadata entries, while the collector
  // records a symlink only when it is contained and resolves back to an
  // enumerated ordinary file; broken, escaping, and non-enumerated targets
  // fail closed. Both algorithms treat an undeclared vanished path as a race
  // failure, and a Git-declared unstaged deletion fingerprints stably as an
  // explicit deleted kind without touching the index.
  await symlink(
    "HUMAN_REVIEW.md",
    path.join(fingerprintFixtureRoot, "docs", "audits", "HUMAN_LINK.md"),
  );
  // The acceptance inventory resolves symlink targets against its root, so it
  // needs the canonical root spelling here (mkdtemp roots can be /var aliases
  // of their realpaths on macOS); the collector canonicalizes its own root.
  const withSymlink = await sourceFingerprint(
    await realpath(fingerprintFixtureRoot),
  );
  assert(
    withSymlink.files.some(
      (entry) =>
        entry.path === "docs/audits/HUMAN_LINK.md" && entry.kind === "symlink",
    ),
    "The acceptance inventory stopped recording symlink metadata entries.",
  );
  const collectorWithSymlink = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  assert(
    collectorWithSymlink.symlinkCount === 1 &&
      collectorWithSymlink.deletedCount === 0 &&
      collectorWithSymlink.fileCount === collectorAfterNewHumanDoc.fileCount &&
      collectorWithSymlink.digest !== collectorAfterNewHumanDoc.digest,
    "The collector did not record a contained symlink as an explicit kind-bound fingerprint entry.",
  );
  await rm(
    path.join(fingerprintFixtureRoot, "docs", "audits", "HUMAN_LINK.md"),
  );
  if (process.platform !== "win32") {
    await symlink(
      "../../outside-parity.txt",
      path.join(fingerprintFixtureRoot, "src", "escape-link.ts"),
    );
    await mustReject(
      () => collectorComputeSourceFingerprint(fingerprintFixtureRoot),
      /escapes/,
      "The collector accepted an escaping symlink.",
    );
    await rm(path.join(fingerprintFixtureRoot, "src", "escape-link.ts"));
    await symlink(
      "missing-target.ts",
      path.join(fingerprintFixtureRoot, "src", "broken-link.ts"),
    );
    await mustReject(
      () => collectorComputeSourceFingerprint(fingerprintFixtureRoot),
      /is broken/,
      "The collector accepted a broken symlink.",
    );
    await rm(path.join(fingerprintFixtureRoot, "src", "broken-link.ts"));
  }
  await mustReject(
    () =>
      fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, [
        "vanished-between-enumeration-and-hash.txt",
      ]),
    /disappeared between enumeration and hashing/,
    "The collector hashed a deleted sentinel for a path that disappeared between enumeration and read.",
  );
  await mustReject(
    () => fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, ["src"]),
    /Unsupported source entry type/,
    "The collector accepted a directory as a fingerprintable source entry.",
  );
  await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    ["add", "docs/audits/SECOND_HUMAN_NOTE.md"],
    { cwd: fingerprintFixtureRoot, windowsHide: true },
  );
  await rm(
    path.join(fingerprintFixtureRoot, "docs/audits/SECOND_HUMAN_NOTE.md"),
  );
  const collectorDeletedFirst = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  const collectorDeletedSecond = await collectorComputeSourceFingerprint(
    fingerprintFixtureRoot,
  );
  assert(
    stableJson(collectorDeletedFirst) === stableJson(collectorDeletedSecond) &&
      collectorDeletedFirst.deletedCount === 1 &&
      collectorDeletedFirst.symlinkCount === 0 &&
      collectorDeletedFirst.fileCount ===
        collectorAfterNewHumanDoc.fileCount - 1,
    "A Git-declared tracked unstaged deletion did not fingerprint stably as an explicit deleted kind.",
  );
} finally {
  await rm(fingerprintFixtureRoot, { recursive: true, force: true });
}

// Direct-invocation detection must survive aliased path spellings: Node loads
// the ESM entry through its realpath while process.argv[1] keeps whatever
// spelling the caller used (on macOS, os.tmpdir() roots are commonly reached
// as /var/... while their realpaths are /private/var/...). A symlinked
// entry-point spelling reproduces that split deterministically: the old
// resolve-and-compare guard compared the alias against the realpath and
// silently exited 0 without ever running main().
if (process.platform !== "win32") {
  const aliasInvocationFixtureRoot = await mkdtemp(
    path.join(approvedTempRoot, "collector-alias-invocation-"),
  );
  try {
    const aliasedEntry = path.join(
      aliasInvocationFixtureRoot,
      "collector-through-alias.mjs",
    );
    await symlink(
      path.join(repositoryRoot, "scripts", "collect-release-evidence.mjs"),
      aliasedEntry,
    );
    const aliasedRun = await execFileAsync(
      process.execPath,
      [aliasedEntry, "--dry-run"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    let aliasedPlan = null;
    try {
      aliasedPlan = JSON.parse(aliasedRun.stdout);
    } catch {
      aliasedPlan = null;
    }
    assert(
      aliasedPlan !== null &&
        aliasedPlan.repositoryRoot === "." &&
        Array.isArray(aliasedPlan.stages),
      "Invoking the evidence collector through an aliased entry-point spelling must still execute main() (--dry-run plan printed) instead of silently exiting 0.",
    );
    const importProbe = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const mod = await import(${JSON.stringify(pathToFileURL(aliasedEntry).href)}); console.log("IMPORTED:" + Object.keys(mod).sort().join(","));`,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    assert(
      importProbe.stdout.startsWith("IMPORTED:") &&
        importProbe.stdout.includes("computeSourceFingerprint") &&
        !importProbe.stdout.includes('"repositoryRoot"'),
      "Importing the collector module must expose its exports without ever triggering a collection run.",
    );
  } finally {
    await rm(aliasInvocationFixtureRoot, { recursive: true, force: true });
  }
}

// The exact-build wrapper must reject a non-canonical artifact-root override
// before the multi-hour build/capture sequence starts, with a message naming
// JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT; downstream canonical assertions stay in
// force. Prove both behaviorally and by static call-site ordering in main().
const artifactRootFixtureRoot = await mkdtemp(
  path.join(approvedTempRoot, "acceptance-artifact-root-"),
);
try {
  const realArtifactRootDir = path.join(artifactRootFixtureRoot, "real");
  await mkdir(realArtifactRootDir, { recursive: true });
  // mkdtemp roots can be /var aliases of their realpaths on macOS, so the
  // positive control uses the canonical spelling exactly like a compliant
  // override would; the alias spellings below must be rejected.
  const realArtifactRoot = await realpath(realArtifactRootDir);
  const returnedArtifactRoot =
    await assertCanonicalArtifactRoot(realArtifactRoot);
  assert(
    returnedArtifactRoot === realArtifactRoot,
    "Canonical artifact-root preflight did not pass through its resolved root.",
  );
  const aliasedArtifactRoot = path.join(artifactRootFixtureRoot, "alias");
  await symlink(
    path.join(artifactRootFixtureRoot, "real"),
    aliasedArtifactRoot,
  );
  await mkdir(path.join(realArtifactRoot, "nested", "deeper"), {
    recursive: true,
  });
  await mustReject(
    () => assertCanonicalArtifactRoot(aliasedArtifactRoot),
    /Artifact root is not canonical/,
    "An aliased artifact-root override was accepted and would only fail canonical custody checks hours later.",
  );
  await mustReject(
    () =>
      assertCanonicalArtifactRoot(
        path.join(aliasedArtifactRoot, "nested", "deeper"),
      ),
    /Artifact root is not canonical/,
    "An artifact root under an aliased parent was accepted by the canonical preflight.",
  );
  let aliasMessage = null;
  try {
    await assertCanonicalArtifactRoot(aliasedArtifactRoot);
  } catch (error) {
    aliasMessage = error instanceof Error ? error.message : String(error);
  }
  assert(
    aliasMessage?.includes("JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT") === true,
    "Canonical artifact-root rejection does not name the override variable.",
  );
} finally {
  await rm(artifactRootFixtureRoot, { recursive: true, force: true });
}

// Evidence-inventory containment: capture screenshot full paths and additional
// evidence files are containment-checked against the run directory before any
// stat or hash, so an escaped candidate can never enter the sealed evidence
// inventory (downstream hardening re-checks remain in force).
const evidenceInventoryRunDir = await mkdtemp(
  path.join(approvedTempRoot, "acceptance-evidence-inventory-"),
);
const escapedEvidencePath = path.join(
  evidenceInventoryRunDir,
  "..",
  "escaped-evidence.bin",
);
try {
  const freshDir = path.join(evidenceInventoryRunDir, "fresh");
  await mkdir(freshDir);
  const reportPath = path.join(freshDir, "capture-report.json");
  await writeFile(reportPath, '{"pass":true}\n');
  const shotPath = path.join(freshDir, "shot.png");
  await writeFile(shotPath, "png-bytes");
  const probePath = path.join(
    evidenceInventoryRunDir,
    "accepted-app-runtime-probe.json",
  );
  await writeFile(probePath, "{}\n");
  await writeFile(escapedEvidencePath, "outside-bytes");
  const positiveInventory = await buildEvidenceInventory(
    evidenceInventoryRunDir,
    { fresh: { __reportPath: reportPath } },
    {
      fresh: [
        { scenarioId: "s-file", fileName: "shot.png", pass: true },
        { scenarioId: "s-full", fullPath: shotPath, pass: true },
      ],
    },
    { path: "accepted-app", files: [] },
    probePath,
    [],
  );
  assert(
    positiveInventory.fileCount === 4 &&
      /^[a-f0-9]{64}$/u.test(positiveInventory.digest) &&
      positiveInventory.files.every((entry) =>
        /^(?:fresh\/|accepted-app-runtime-probe\.json$)/u.test(entry.path),
      ),
    "Evidence inventory lost its positive-path accounting or digest shape.",
  );
  await mustReject(
    () =>
      buildEvidenceInventory(
        evidenceInventoryRunDir,
        { fresh: { __reportPath: reportPath } },
        {
          fresh: [
            {
              scenarioId: "s-escape",
              fullPath: escapedEvidencePath,
              pass: true,
            },
          ],
        },
        { path: "accepted-app", files: [] },
        probePath,
        [],
      ),
    /fresh screenshot path escaped the acceptance run directory/,
    "A capture screenshot resolving outside the run directory was stat'd and hashed into the evidence inventory.",
  );
  await mustReject(
    () =>
      buildEvidenceInventory(
        evidenceInventoryRunDir,
        { fresh: { __reportPath: reportPath } },
        {
          fresh: [
            {
              scenarioId: "s-traversal",
              fileName: "../../escaped-evidence.bin",
              pass: true,
            },
          ],
        },
        { path: "accepted-app", files: [] },
        probePath,
        [],
      ),
    /fresh screenshot path escaped the acceptance run directory/,
    "A traversal screenshot fileName escaping the run directory was accepted into the evidence inventory.",
  );
  await mustReject(
    () =>
      buildEvidenceInventory(
        evidenceInventoryRunDir,
        { fresh: { __reportPath: reportPath } },
        { fresh: [] },
        { path: "accepted-app", files: [] },
        probePath,
        [
          {
            component: "build",
            kind: "build-log",
            path: escapedEvidencePath,
          },
        ],
      ),
    /build build-log path escaped the acceptance run directory/,
    "An additional evidence file outside the run directory was stat'd and hashed into the evidence inventory.",
  );
} finally {
  await rm(evidenceInventoryRunDir, { recursive: true, force: true });
  await rm(escapedEvidencePath, { force: true });
}

if (process.platform !== "win32") {
  const abruptScript = [
    'const { spawn } = require("node:child_process")',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
    "child.unref()",
    "setTimeout(() => process.exit(7), 80)",
  ].join(";");
  const abruptResult = await runTrackedCommand(
    process.execPath,
    ["-e", abruptScript],
    { cwd: approvedTempRoot },
  );
  assert(
    abruptResult.exitCode === 7 && abruptResult.trackedProcesses.length >= 2,
    "Abrupt capture fixture did not retain its spawned survivor ownership tree.",
  );
  const cleanup = await terminateAndVerifyTrackedCommand(
    abruptResult,
    "abrupt capture fixture",
  );
  assert(
    cleanup.verified && cleanup.leftoverPids.length === 0,
    "Abrupt capture survivor was not terminated and rechecked.",
  );
}
const wrapper = await readFile(
  path.join(scriptDir, "run-job-finder-production-acceptance.mjs"),
  "utf8",
);
{
  const mainBodyIndex = wrapper.indexOf("async function main()");
  const preflightCallIndex = wrapper.indexOf(
    "await assertCanonicalArtifactRoot()",
  );
  const snapshotPreparationIndex = wrapper.indexOf(
    "preparedSnapshot = await prepareSnapshot(snapshotRoot, acceptanceReport)",
  );
  const buildInvocationIndex = wrapper.indexOf(
    "const buildResult = await runCommand(buildCommand",
  );
  assert(
    mainBodyIndex !== -1 &&
      preflightCallIndex > mainBodyIndex &&
      preflightCallIndex < snapshotPreparationIndex &&
      preflightCallIndex < buildInvocationIndex,
    "The canonical artifact-root preflight must run inside main() before immutable-snapshot preparation and the exact build so alias overrides fail closed immediately instead of after hours of captures.",
  );
}

// --- Live-worktree continuity gate -------------------------------------------
// Production acceptance binds every artifact to the worktree exactly as
// captured into the immutable snapshot, so pass/seal must require
// currentWorktreeDiverged to be false. A dirty baseline is legal: uncommitted
// files simply define the captured baseline digest. These deterministic
// fixtures prove both directions of the gate and its fail-closed edges
// without touching git state; structural asserts then pin the gate before the
// success latch and before seal creation in the shipped wrapper.
{
  const dirtyBaselineFingerprint = Object.freeze({
    algorithm: "sha256",
    digest: "b".repeat(64),
    fileCount: 7,
  });
  const unchangedDirtyTree = evaluateCurrentWorktreeContinuity(
    dirtyBaselineFingerprint,
    { ...dirtyBaselineFingerprint },
  );
  assert(
    unchangedDirtyTree.measurable === true &&
      unchangedDirtyTree.diverged === false &&
      unchangedDirtyTree.pass === true &&
      unchangedDirtyTree.violation === null,
    "An unchanged dirty worktree baseline must pass the live-worktree continuity gate.",
  );
  const midRunDrift = evaluateCurrentWorktreeContinuity(
    dirtyBaselineFingerprint,
    { algorithm: "sha256", digest: "c".repeat(64), fileCount: 8 },
  );
  assert(
    midRunDrift.measurable === true &&
      midRunDrift.diverged === true &&
      midRunDrift.pass === false &&
      /changed during the immutable acceptance run/.test(midRunDrift.violation),
    "A worktree edited mid-run must fail the live-worktree continuity gate with drift evidence.",
  );
  const unmeasurableCases = [
    ["missing baseline", null, dirtyBaselineFingerprint],
    ["unmeasurable live worktree", dirtyBaselineFingerprint, null],
    ["non-record sides", {}, {}],
    ["empty baseline digest", { digest: "" }, dirtyBaselineFingerprint],
  ];
  for (const [label, captured, current] of unmeasurableCases) {
    const verdict = evaluateCurrentWorktreeContinuity(captured, current);
    assert(
      verdict.measurable === false &&
        verdict.diverged === true &&
        verdict.pass === false &&
        typeof verdict.violation === "string" &&
        verdict.violation.length > 0,
      `A ${label} must fail the live-worktree continuity gate closed.`,
    );
  }

  // Structural proof on the shipped wrapper: divergence truth is recorded by
  // exactly one dedicated helper, the continuity verdict is asserted inside
  // main()'s try body strictly before the success latch (and therefore before
  // any seal exists), and the only other recompute is guarded to already-
  // failed runs so it can never resurrect pass or reach seal creation.
  const helperDefAt = wrapper.indexOf(
    "async function recordCurrentWorktreeContinuity(acceptanceReport)",
  );
  const evaluatorDefAt = wrapper.indexOf(
    "export function evaluateCurrentWorktreeContinuity(",
  );
  const divergenceAssignments = [
    ...wrapper.matchAll(
      /acceptanceReport\.source\.currentWorktreeDiverged\s*=(?!=)/gu,
    ),
  ].map((match) => match.index);
  assert(
    helperDefAt !== -1 &&
      evaluatorDefAt > helperDefAt &&
      divergenceAssignments.length === 2 &&
      divergenceAssignments.every(
        (index) => index > helperDefAt && index < evaluatorDefAt,
      ),
    "Raw worktree divergence truth must be recorded only inside the dedicated continuity helper.",
  );
  assert(
    wrapper.includes(
      "acceptanceReport.source.capturedWorktree = capturedSource;",
    ),
    "The continuity baseline must be the exact pre-build worktree fingerprint captured into the immutable snapshot.",
  );
  const gateCallAt = wrapper.indexOf(
    "await recordCurrentWorktreeContinuity(acceptanceReport);",
  );
  const continuityRecordAt = wrapper.indexOf(
    "acceptanceReport.source.currentWorktreeContinuity =",
  );
  const continuityAssertAt = wrapper.indexOf(
    "acceptanceReport.source.currentWorktreeContinuity.pass === true",
  );
  const latchAt = wrapper.indexOf("acceptanceReport.pass = true;");
  const sealCreationAt = wrapper.indexOf("createFinalAcceptanceSeal({");
  assert(
    gateCallAt !== -1 &&
      gateCallAt < continuityRecordAt &&
      continuityRecordAt < continuityAssertAt &&
      continuityAssertAt !== -1 &&
      latchAt !== -1 &&
      continuityAssertAt < latchAt &&
      sealCreationAt !== -1 &&
      sealCreationAt > latchAt,
    "Live-worktree continuity must be asserted before the success latch and therefore before any seal creation.",
  );
  const forensicGuardAt = wrapper.indexOf(
    "acceptanceReport.source.currentWorktreeDiverged === undefined",
  );
  const forensicCallAt = wrapper.lastIndexOf(
    "await recordCurrentWorktreeContinuity(acceptanceReport);",
  );
  assert(
    forensicGuardAt !== -1 &&
      wrapper.indexOf(
        "acceptanceReport.source.currentWorktreeDiverged === undefined",
        forensicGuardAt + 1,
      ) === -1 &&
      forensicGuardAt > latchAt &&
      forensicGuardAt < forensicCallAt,
    "The forensic worktree recompute must stay guarded to runs that failed before the continuity gate.",
  );
}

// --- Production tester shell-header geometry contract ------------------------
{
  assert(
    Object.isFrozen(SHELL_HEADER_GEOMETRY_SAMPLE_KEYS) &&
      stableJson(SHELL_HEADER_GEOMETRY_SAMPLE_KEYS) ===
        stableJson([
          "brand",
          "documentOverflow",
          "focusableControls",
          "frame",
          "groups",
          "header",
          "liveAssistant",
          "layoutTrio",
          "moduleNav",
          "theme",
          "utilityControls",
        ]),
    "The frozen shell-header sample key set drifted from the exact 11-key contract including documentOverflow.",
  );
  assert(
    Object.isFrozen(SHELL_HEADER_UTILITY_CONTROL_NAMES) &&
      stableJson(SHELL_HEADER_UTILITY_CONTROL_NAMES) ===
        stableJson(["needsYou", "search", "taskCenter"]),
    "The frozen utility control trio drifted from needsYou/search/taskCenter.",
  );
  assert(
    Object.isFrozen(SHELL_HEADER_LAYOUT_TRIO_NAMES) &&
      stableJson(SHELL_HEADER_LAYOUT_TRIO_NAMES) ===
        stableJson(["liveAssistant", "planning", "routeScroller"]),
    "The frozen layout trio drifted from liveAssistant/planning/routeScroller.",
  );
  for (const [value, expected] of [
    [SHELL_HEADER_LIVE_ASSISTANT_HREF, "#/live-assistant"],
    [PRODUCTION_TESTER_SHELL_PROBE_ROUTE, "#/job-finder/campaigns"],
    [SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX, 0.5],
    [SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX, 0.5],
  ]) {
    assert(
      value === expected,
      `A shell-header geometry constant drifted: expected ${JSON.stringify(expected)}, found ${JSON.stringify(value)}.`,
    );
  }
  assert(
    wrapper.includes(
      'export const PRODUCTION_TESTER_SHELL_PROBE_ROUTE = "#/job-finder/campaigns";',
    ) &&
      wrapper.includes(
        'export const SHELL_HEADER_LIVE_ASSISTANT_HREF = "#/live-assistant";',
      ) &&
      wrapper.includes(
        "export const SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX = 0.5;",
      ) &&
      wrapper.includes(
        "export const SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX = 0.5;",
      ),
    "Shell-header constant declarations drifted in the acceptance wrapper source.",
  );

  const fixtureSuite = evaluateShellHeaderGeometryFixtureSuite();
  assert(
    fixtureSuite.pass === true &&
      fixtureSuite.kind === "shell-header-geometry-fixture-suite" &&
      fixtureSuite.schemaVersion === 1 &&
      !("failures" in fixtureSuite),
    `Shipped shell-header geometry fixture suite failed: ${JSON.stringify(fixtureSuite.failures ?? [])}`,
  );
  const shellHeaderFixtureExpectations = [
    ["healthy-sampler-shaped-sample-passes", true],
    ["missing-live-assistant-href-fails", false],
    ["wrong-live-assistant-href-fails", false],
    ["opacity-zero-utility-control-fails", false],
    ["pointer-events-none-live-assistant-fails", false],
    ["unrendered-brand-fails", false],
    ["escaping-focusable-control-fails", false],
    ["missing-sample-key-fails", false],
    ["post-navigation-document-horizontal-overflow-fails", false],
    ["brand-internal-horizontal-overflow-fails", false],
    ["header-internal-horizontal-overflow-fails", false],
    ["rendered-module-nav-fully-contained-passes", true],
    ["rendered-module-nav-escaping-frame-fails", false],
    ["chip-clipped-by-sanctioned-route-scroller-is-recorded-not-fatal", true],
    ["layout-trio-overlap-fails", false],
    ["layout-trio-overlapping-utility-group-fails", false],
    ["window-controls-rendered-off-frame-fail-their-gate", false],
    ["sub-pixel-frame-rounding-still-passes", true],
  ];
  assert(
    fixtureSuite.cases.length === shellHeaderFixtureExpectations.length,
    `Shipped shell-header fixture suite must keep exactly ${shellHeaderFixtureExpectations.length} cases; found ${fixtureSuite.cases.length}.`,
  );
  assert(
    stableJson(
      fixtureSuite.cases.map(({ name, shouldPass }) => ({ name, shouldPass })),
    ) ===
      stableJson(
        shellHeaderFixtureExpectations.map(([name, shouldPass]) => ({
          name,
          shouldPass,
        })),
      ),
    "Shipped shell-header fixture cases were dropped, renamed, or weakened; every regression case must stay pinned with its pass expectation.",
  );
  assert(
    fixtureSuite.cases.every(
      (fixture) =>
        fixture.outcome.passMatches === true &&
        fixture.outcome.expectMatches === true,
    ),
    "A shipped shell-header fixture case no longer matches its pinned expectation.",
  );

  const serializedSampler = collectShellHeaderGeometrySample.toString();
  for (const requiredToken of [
    "[data-job-finder-shell-header]",
    "[data-job-finder-compact-navigation-scroll]",
    "[data-desktop-module-navigation]",
    "[data-desktop-brand]",
    "[data-resolved-theme]",
    'getAttribute("data-appearance-theme")',
    "prefers-color-scheme: dark",
    '[role="group"][aria-label="Notifications and actions"]',
    '[role="group"][aria-label="Window controls"]',
    'a[aria-label="Open Live Assistant"],button[aria-label="Open Live Assistant"]',
    'button[aria-label^="More"]',
    'button[aria-label^="Needs you"]',
    'button[aria-label="Search current plan and workspace"]',
    'summary[aria-label^="Task center"]',
    'a[href], button:not([disabled]), summary:not([disabled]), [tabindex]:not([tabindex="-1"])',
    'element.tagName.toLowerCase() === "a"',
    'element.closest("details:not([open])")',
    '":scope > summary"',
    'element.getAttribute("href")',
    'style.opacity !== "0"',
    'style.pointerEvents !== "none"',
    "document.documentElement.scrollWidth",
    "document.documentElement.clientWidth",
    "documentOverflow",
    "focusableControls",
    "insideCompactNavigationScroller",
    "scrollableX",
    "centerHit",
  ]) {
    assert(
      serializedSampler.includes(requiredToken),
      `Serialized shell-header sampler lost a required selector/field token: ${requiredToken}`,
    );
  }
  const moduleBoundNames = [
    ...[
      ...wrapper.matchAll(
        /^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gmu,
      ),
    ]
      .map((match) => match[1])
      .filter((name) => name !== "collectShellHeaderGeometrySample"),
    "isRecord",
    "hasExactKeys",
    "geometryRectIsFinite",
    "geometryRectWithinFrame",
    "geometryRectContainsRect",
    "geometryRectsOverlap",
  ];
  const leakedModuleReferences = moduleBoundNames.filter((name) =>
    new RegExp(`\\b${name}\\b`, "u").test(serializedSampler),
  );
  assert(
    leakedModuleReferences.length === 0,
    `Serialized shell-header sampler references module-scope bindings Playwright cannot serialize: ${JSON.stringify(leakedModuleReferences)}`,
  );

  const shellRect = (left, top, right, bottom) => ({
    bottom,
    left,
    right,
    top,
  });
  const usableShellControl = (left, top, right, bottom, extra = {}) => ({
    ariaLabel: null,
    centerHit: { reached: true, x: (left + right) / 2, y: (top + bottom) / 2 },
    href: null,
    present: true,
    rect: shellRect(left, top, right, bottom),
    rendered: true,
    visibility: { opaque: true, pointerEnabled: true },
    ...extra,
  });
  const healthyShellHeaderSample = () => ({
    brand: {
      overflow: { x: 0, y: 0 },
      present: true,
      rect: shellRect(88, 8, 220, 48),
      rendered: true,
    },
    documentOverflow: { x: 0 },
    focusableControls: [],
    frame: { height: 360, width: 640 },
    groups: {
      utility: usableShellControl(470, 56, 636, 116, {
        ariaLabel: "Notifications and actions",
      }),
      windowControls: {
        present: false,
        rect: null,
        rendered: false,
        visibility: { opaque: false, pointerEnabled: false },
      },
    },
    header: {
      overflow: { x: 0, y: 0 },
      present: true,
      rect: shellRect(0, 0, 640, 116),
    },
    liveAssistant: usableShellControl(350, 64, 458, 100, {
      ariaLabel: "Open Live Assistant",
      href: SHELL_HEADER_LIVE_ASSISTANT_HREF,
    }),
    layoutTrio: {
      planning: usableShellControl(304, 64, 346, 100, {
        ariaLabel: "More",
      }),
      routeScroller: {
        present: true,
        rect: shellRect(8, 60, 296, 112),
        rendered: true,
        scroll: { clientWidth: 288, scrollWidth: 288, scrollableX: false },
        visibility: { opaque: true, pointerEnabled: true },
      },
    },
    moduleNav: {
      present: true,
      rect: null,
      rendered: false,
      visibility: { opaque: false, pointerEnabled: false },
    },
    theme: {
      appearancePreference: "system",
      prefersDark: false,
      resolvedTheme: "light",
    },
    utilityControls: {
      needsYou: usableShellControl(590, 62, 634, 110, {
        ariaLabel: "Needs you: 0 unresolved",
      }),
      search: usableShellControl(470, 62, 508, 110, {
        ariaLabel: "Search current plan and workspace",
      }),
      taskCenter: usableShellControl(512, 62, 550, 110, {
        ariaLabel: "Task center: 0 active",
      }),
    },
  });
  const healthyShellVerdict = evaluateShellHeaderGeometry(
    healthyShellHeaderSample(),
  );
  assert(
    healthyShellVerdict.pass === true &&
      healthyShellVerdict.kind === "shell-header-geometry" &&
      healthyShellVerdict.schemaVersion === 1 &&
      healthyShellVerdict.clippedInRouteScrollerCount === 0 &&
      healthyShellVerdict.violations.length === 0 &&
      stableJson(healthyShellVerdict.viewport) ===
        stableJson({ height: 360, width: 640 }) &&
      stableJson(Object.keys(healthyShellVerdict.facts).sort()) ===
        stableJson([
          "brandInternalOverflowZero",
          "brandRenderedWithinHeaderAndViewport",
          "documentHorizontalOverflowZero",
          "headerInternalOverflowZero",
          "headerPresentAndWithinFrame",
          "liveAssistantCenterHitReached",
          "liveAssistantContainedInHeaderAndViewport",
          "liveAssistantHrefExact",
          "liveAssistantRendered",
          "layoutTrioClearOfRenderedGroups",
          "layoutTrioPairwiseNonOverlapping",
          "layoutTrioWithinHeaderAndViewport",
          "moduleNavigationHiddenOrContained",
          "noOffFrameFocusableHeaderControls",
          "themeFactsRecorded",
          "utilityControlsFullyContainedAndHitReachable",
          "utilityGroupRenderedWithinViewportFrame",
          "windowControlsGatePass",
        ]) &&
      Object.values(healthyShellVerdict.facts).every((fact) => fact === true),
    "A locally mirrored healthy shell-header sample failed the shipped evaluator; evaluator gates or the mirror drifted.",
  );
  assert(
    healthyShellVerdict.facts.noOffFrameFocusableHeaderControls === true,
    "An empty focusable scan beside a present shell header must prove the no-off-frame fact rather than skip it.",
  );
  const rejectShellSample = (name, mutate, pattern) => {
    const sample = healthyShellHeaderSample();
    mutate(sample);
    const verdict = evaluateShellHeaderGeometry(sample);
    assert(
      verdict.pass === false &&
        verdict.violations.length > 0 &&
        pattern.test(verdict.violations.join("\n")),
      `Shell-header evaluator accepted the "${name}" regression or lost its violation marker.`,
    );
  };
  rejectShellSample(
    "non-string Live Assistant href",
    (sample) => {
      sample.liveAssistant.href = 7;
    },
    /Open Live Assistant href .* is not exactly/u,
  );
  rejectShellSample(
    "deleted Live Assistant href key",
    (sample) => {
      delete sample.liveAssistant.href;
    },
    /Open Live Assistant href .* is not exactly/u,
  );
  rejectShellSample(
    "missing control visibility",
    (sample) => {
      delete sample.liveAssistant.visibility;
    },
    /computes opacity 0 while claimed rendered[\S\s]*computes pointer-events none while claimed rendered/u,
  );
  rejectShellSample(
    "absent module navigation element",
    (sample) => {
      sample.moduleNav.present = false;
    },
    /desktop module navigation element is absent/u,
  );
  rejectShellSample(
    "null theme host",
    (sample) => {
      sample.theme.appearancePreference = null;
      sample.theme.resolvedTheme = null;
    },
    /appearance theme facts were not recorded/u,
  );
  rejectShellSample(
    "above-epsilon layout-trio overlap",
    (sample) => {
      sample.layoutTrio.planning.rect = shellRect(295.25, 64, 337.25, 100);
    },
    /overlap each other/u,
  );
  {
    const exactEpsilonSample = healthyShellHeaderSample();
    exactEpsilonSample.layoutTrio.planning.rect = shellRect(
      295.5,
      64,
      337.5,
      100,
    );
    const exactEpsilonVerdict = evaluateShellHeaderGeometry(exactEpsilonSample);
    assert(
      exactEpsilonVerdict.pass === true &&
        exactEpsilonVerdict.facts.layoutTrioPairwiseNonOverlapping === true,
      "A layout-trio overlap of exactly SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX must stay clear of the strict overlap gate.",
    );
  }

  const geometryHelpers = new Function(
    `"use strict";${topLevelFunctionSlice(wrapper, "isRecord")}${topLevelFunctionSlice(wrapper, "geometryRectIsFinite")}${topLevelFunctionSlice(wrapper, "geometryRectWithinFrame")}${topLevelFunctionSlice(wrapper, "geometryRectContainsRect")}${topLevelFunctionSlice(wrapper, "geometryRectsOverlap")}return { containsRect: geometryRectContainsRect, overlaps: geometryRectsOverlap, withinFrame: geometryRectWithinFrame };`,
  )();
  assert(
    geometryHelpers.overlaps(
      shellRect(0, 0, 10, 10),
      shellRect(9.5, 0, 20, 10),
      SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX,
    ) === false &&
      geometryHelpers.overlaps(
        shellRect(0, 0, 10, 10),
        shellRect(9.25, 0, 20, 10),
        SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX,
      ) === true &&
      geometryHelpers.overlaps(
        shellRect(0, 0, 10, 10),
        shellRect(10, 0, 20, 10),
        SHELL_HEADER_GEOMETRY_OVERLAP_EPSILON_PX,
      ) === false,
    "Extracted overlap helper must treat exactly-epsilon contact as clear and strictly-greater overlap as colliding.",
  );
  assert(
    geometryHelpers.withinFrame(
      shellRect(-0.5, 0, 640.5, 100),
      { height: 360, width: 640 },
      SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX,
    ) === true &&
      geometryHelpers.withinFrame(
        shellRect(-0.75, 0, 640.75, 100),
        { height: 360, width: 640 },
        SHELL_HEADER_GEOMETRY_FRAME_TOLERANCE_PX,
      ) === false,
    "Extracted frame containment must honor exactly the pinned sub-pixel tolerance at fractional-zoom rounding boundaries.",
  );

  const shellEvidenceAssignmentAt = wrapper.indexOf(
    "shellHeaderEvidence = shellHeaderVerdict;",
  );
  const shellVerdictAssertAt = wrapper.indexOf(
    "shellHeaderVerdict.pass === true",
  );
  const testerScreenshotAt = wrapper.indexOf(
    "await page.screenshot({ path: screenshotPath });",
  );
  const shellReportBindingAt = wrapper.indexOf(
    "shellHeaderGeometry: shellHeaderEvidence ?? {",
  );
  assert(
    wrapper.includes("let shellHeaderEvidence = null;") &&
      shellEvidenceAssignmentAt !== -1 &&
      shellVerdictAssertAt > shellEvidenceAssignmentAt &&
      testerScreenshotAt > shellVerdictAssertAt &&
      shellReportBindingAt !== -1,
    "Tester shell-header proof must assign evidence before the hard assert, screenshot only after proof, and bind the full verdict into the probe report.",
  );

  const routeBindingAudit = auditTesterShellProbeRouteBinding(wrapper);
  assert(
    routeBindingAudit.pass === true && routeBindingAudit.boundCallCount === 1,
    `Tester shell-probe route binding audit failed on the shipped wrapper source: ${JSON.stringify(routeBindingAudit.violations)}`,
  );

  const selfTestFlagAt = wrapper.indexOf(
    'process.argv.includes("--self-test-shell-header-geometry")',
  );
  const elseMainAt = wrapper.indexOf("} else await main();");
  const selfTestSlice =
    selfTestFlagAt >= 0 && elseMainAt > selfTestFlagAt
      ? wrapper.slice(selfTestFlagAt, elseMainAt)
      : "";
  assert(
    selfTestSlice.includes("evaluateShellHeaderGeometryFixtureSuite()") &&
      selfTestSlice.includes("auditTesterShellProbeRouteBinding(source)") &&
      !/_electron\b|\bchromium\b|\bfirefox\b|\bwebkit\b|playwright|\.launch\(/u.test(
        selfTestSlice,
      ),
    "The shell-header self-test branch must stay Electron-free and mutually exclusive with the production main() run.",
  );
  const selfTestCli = await execFileAsync(
    process.execPath,
    [
      path.join(scriptDir, "run-job-finder-production-acceptance.mjs"),
      "--self-test-shell-header-geometry",
    ],
    { windowsHide: true },
  );
  assert(
    !selfTestCli.stderr,
    `Shell-header self-test CLI wrote stderr: ${selfTestCli.stderr}`,
  );
  const selfTestReport = JSON.parse(selfTestCli.stdout.trim());
  assert(
    selfTestReport.kind === "shell-header-self-test" &&
      selfTestReport.pass === true &&
      selfTestReport.fixtureSuite?.pass === true &&
      selfTestReport.routeAudit?.pass === true,
    "The shipped --self-test-shell-header-geometry entrypoint did not pass end to end.",
  );
}
const safetySource = await readFile(
  path.join(scriptDir, "release-acceptance-harness.mjs"),
  "utf8",
);
// --- Evidence hardening and artifact mode binding ----------------------------
{
  assert(
    safetySource.includes("export async function makeEvidenceFilesReadOnly") &&
      safetySource.includes(
        "await chmod(filePath, modeOf(fileStat) & ~0o222)",
      ) &&
      safetySource.includes(`if (!fileStat.isFile())`),
    "Evidence hardening must be an exported mask-based helper that lstats ordinary files instead of flattening modes.",
  );
  const evidenceFinalization = wrapper.indexOf(
    "acceptanceReport.evidence = await finalizeFileEvidence",
  );
  const evidenceHardening = wrapper.indexOf(
    "await makeEvidenceFilesReadOnly(runDir, acceptanceReport.evidence.files)",
  );
  const postHardeningAcceptedVerify = wrapper.indexOf(
    "path.join(runDir, acceptanceReport.acceptedApp.path)",
  );
  const sealCreation = wrapper.indexOf("createFinalAcceptanceSeal({");
  assert(
    evidenceFinalization !== -1 &&
      evidenceHardening > evidenceFinalization &&
      postHardeningAcceptedVerify > evidenceHardening &&
      sealCreation > postHardeningAcceptedVerify,
    "Acceptance sealing must finalize the evidence inventory, harden it with mode masking, re-verify the accepted app after hardening, and only then create the final seal.",
  );
  const explicitReadonlyMatches = [...wrapper.matchAll(/0o444/g)];
  assert(
    explicitReadonlyMatches.length === 2 &&
      wrapper.includes("await chmod(reportPath, 0o444);") &&
      wrapper.includes("await chmod(sealPath, 0o444);"),
    "Only the final report and seal may use an explicit 0444; every other read-only transition must mask write bits from each file's current mode.",
  );
  const artifactHardeningLoop = wrapper.indexOf(
    "if (existsSync(root)) await makeTreeReadOnly(root)",
  );
  const artifactCapture = wrapper.indexOf(
    "acceptanceReport.artifacts = await artifactFingerprint(snapshotDesktopDir)",
  );
  assert(
    artifactHardeningLoop !== -1 && artifactCapture > artifactHardeningLoop,
    "Build-artifact fingerprinting must bind the hardened read-only runtime state so manifest modes match every later recompute.",
  );
}
const sidecarPrepareSource = await readFile(
  path.join(scriptDir, "prepare-resume-parser-sidecar.mjs"),
  "utf8",
);
const sidecarRuntimeSource = await readFile(
  path.join(
    scriptDir,
    "..",
    "src",
    "main",
    "adapters",
    "resume-document-sidecar.ts",
  ),
  "utf8",
);
const errorRecovery = await readFile(
  path.join(scriptDir, "capture-job-finder-error-recovery.mjs"),
  "utf8",
);
const resolver = await readFile(
  path.join(scriptDir, "resolve-build-invocation.mjs"),
  "utf8",
);
assert(
  /export const DESKTOP_BUILD_ARGS = Object\.freeze\(\[\s*"--filter",\s*"@nestor\/desktop",\s*"build",?\s*\]\)/.test(
    resolver,
  ),
  "Acceptance resolver does not have one explicit desktop build command.",
);
assert(
  resolver.includes("environment.npm_execpath"),
  "Acceptance resolver does not prefer npm_execpath when a cached pnpm entry point is supplied.",
);
assert(
  resolver.includes("nodeExecutable"),
  "Acceptance resolver does not run a cached JavaScript package-manager entry point through Node.",
);
assert(
  resolver.includes('source: "npm_execpath"') &&
    resolver.includes('source: "path-fallback"'),
  "Acceptance resolver does not record both package-manager resolution paths.",
);
assert(
  resolver.includes('platform === "win32" ? "pnpm.cmd" : "pnpm"'),
  "Acceptance resolver has no explicit pnpm PATH fallback.",
);
assert(
  stableJson(DESKTOP_BUILD_ARGS) ===
    stableJson(["--filter", "@nestor/desktop", "build"]),
  "Acceptance resolver changed the desktop build arguments.",
);
const cachedResolverProbe = resolveBuildInvocation({
  environment: { npm_execpath: path.join(scriptDir, "pnpm.cjs") },
  platform: "win32",
  nodeExecutable: "C:/node/node.exe",
  repositoryRoot: path.dirname(scriptDir),
  fileExists: () => true,
});
assert(
  cachedResolverProbe.source === "npm_execpath" &&
    cachedResolverProbe.command === "C:/node/node.exe",
  "Acceptance resolver did not select the cached npm_execpath through Node.",
);
assert(
  cachedResolverProbe.args[0].toLowerCase().endsWith("pnpm.cjs"),
  "Acceptance resolver did not pass the cached pnpm JavaScript entry point.",
);
const fallbackResolverProbe = resolveBuildInvocation({
  environment: {},
  platform: "win32",
  nodeExecutable: "C:/node/node.exe",
  repositoryRoot: path.dirname(scriptDir),
  fileExists: () => false,
});
assert(
  fallbackResolverProbe.source === "path-fallback" &&
    fallbackResolverProbe.command === "pnpm.cmd",
  "Acceptance resolver fallback is not explicit and deterministic.",
);
assert(
  wrapper.includes("resolveBuildInvocation"),
  "Acceptance wrapper does not use the package-manager resolver.",
);
assert(
  wrapper.includes("rendererUrlEnvironmentRemoved: true"),
  "Acceptance wrapper does not record renderer URL isolation.",
);
assert(
  wrapper.includes(
    "afterRunArtifacts.digest === acceptanceReport.artifacts.digest",
  ),
  "Acceptance wrapper does not rehash build artifacts after capture.",
);
assert(
  wrapper.includes("exportAcceptedElectronApp") &&
    wrapper.includes("verifyAcceptedElectronApp") &&
    wrapper.includes("verifiedAfterSnapshotCleanup"),
  "Acceptance wrapper does not preserve and reverify a sealed app after snapshot cleanup.",
);
assert(
  wrapper.includes("runAcceptedAppRuntimeProbe") &&
    wrapper.includes('"pdfjs-dist/legacy/build/pdf.worker.mjs"') &&
    !wrapper.includes("workerCandidates") &&
    wrapper.includes('route: "#/job-finder/campaigns"') &&
    wrapper.includes("sidecarManifestPath") &&
    wrapper.includes("preProbeCleanupError"),
  "Acceptance wrapper does not require the post-snapshot accepted-app runtime probe contract.",
);
// --- Production-like tester probe (second isolated launch) ------------------
assert(
  stableJson(PRODUCTION_TESTER_GEOMETRY_REQUEST) ===
    stableJson({ height: 720, width: 1280, zoomFactor: 1.25 }),
  "Production tester probe no longer requests the canonical 1280x720 native-1.25 geometry.",
);
{
  const testerHardening = productionTesterEnvironment(
    {
      DISPLAY: ":0",
      ELECTRON_RENDERER_URL: "http://127.0.0.1:5173",
      HOME: "/Users/tester",
      HTTPS_PROXY: "http://proxy.example:8080",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "secret-value",
      PATH: "/usr/bin:/bin",
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_STARTUP_ZOOM_FACTOR: "9",
      NESTOR_TESTER_SESSION_GEOMETRY: "0",
    },
    "/isolated/production-tester-user-data",
  );
  assert(
    testerHardening.env.PATH === "/usr/bin:/bin" &&
      testerHardening.env.LANG === "en_US.UTF-8" &&
      testerHardening.env.DISPLAY === ":0" &&
      stableJson(testerHardening.copiedNames) ===
        stableJson(["DISPLAY", "LANG", "PATH"]),
    "Production tester environment must copy exactly the ambient allowlist.",
  );
  assert(
    !("ELECTRON_RENDERER_URL" in testerHardening.env),
    "Production tester environment must drop the ambient renderer URL override.",
  );
  for (const forbiddenName of [
    "HOME",
    "HTTPS_PROXY",
    "OPENAI_API_KEY",
    "NESTOR_ENABLE_TEST_API",
  ]) {
    assert(
      !(forbiddenName in testerHardening.env),
      `Production tester environment must never carry ${forbiddenName}.`,
    );
    assert(
      testerHardening.strippedNames.includes(forbiddenName),
      `Production tester authority facts must record stripping ${forbiddenName}.`,
    );
  }
  for (const geometryName of [
    "NESTOR_STARTUP_ZOOM_FACTOR",
    "NESTOR_TESTER_SESSION_GEOMETRY",
  ]) {
    assert(
      testerHardening.strippedNames.includes(geometryName),
      `Production tester authority facts must record stripping ambient ${geometryName}.`,
    );
  }
  assert(
    testerHardening.env.NESTOR_USER_DATA_DIR ===
      "/isolated/production-tester-user-data" &&
      testerHardening.env.NESTOR_TEST_API_USE_LIVE_AI === "0" &&
      testerHardening.env.NESTOR_BROWSER_AGENT === "0" &&
      testerHardening.env
        .JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES === "0" &&
      testerHardening.env
        .JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC === "0" &&
      testerHardening.env.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES === "0",
    "Production tester environment must isolate user data and force browser agent/live AI/intermediate writes/ATS writes/diagnostics off.",
  );
  assert(
    testerHardening.injectedNames.includes(
      "NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES",
    ),
    "The ATS intermediate-write authorization flag must be an explicitly injected authority fact.",
  );
  assert(
    testerHardening.env.NESTOR_TESTER_SESSION_GEOMETRY === "1" &&
      testerHardening.env.NESTOR_STARTUP_WINDOW_WIDTH ===
        String(PRODUCTION_TESTER_GEOMETRY_REQUEST.width) &&
      testerHardening.env.NESTOR_STARTUP_WINDOW_HEIGHT ===
        String(PRODUCTION_TESTER_GEOMETRY_REQUEST.height) &&
      testerHardening.env.NESTOR_STARTUP_ZOOM_FACTOR ===
        String(PRODUCTION_TESTER_GEOMETRY_REQUEST.zoomFactor),
    "Production tester environment must inject the canonical geometry marker and values.",
  );
}
{
  const portCases = [
    ["48321\n/devtools/browser/guid\n", 48321],
    ["48321\r\n/devtools/browser/guid\r\n", 48321],
    ["65535", 65535],
    ["0\n/x\n", null],
    ["65536\n/x\n", null],
    ["abc\n/x\n", null],
    ["12.5\n/x\n", null],
    ["", null],
    [null, null],
  ];
  for (const [contents, expected] of portCases) {
    assert(
      parseDevToolsActivePortContents(contents) === expected,
      `DevToolsActivePort parsing changed for ${JSON.stringify(contents)}.`,
    );
  }
}
{
  // PNG magic + IHDR dimensions: a synthetic 3x2 header and negative cases.
  const pngHeader = Buffer.alloc(24, 0);
  pngHeader.writeUInt32BE(0x89504e47, 0);
  pngHeader.write("PNG", 1, "ascii");
  pngHeader.writeUInt32BE(3, 16);
  pngHeader.writeUInt32BE(2, 20);
  const validPng = parsePngMetadata(pngHeader);
  assert(
    validPng.magicValid === true &&
      validPng.width === 3 &&
      validPng.height === 2,
    "PNG metadata parsing must read magic plus IHDR dimensions.",
  );
  assert(
    parsePngMetadata(Buffer.alloc(0)).magicValid === false,
    "Empty screenshot buffers must fail the PNG magic check.",
  );
  const notPng = Buffer.alloc(24, 7);
  assert(
    parsePngMetadata(notPng).magicValid === false &&
      parsePngMetadata(notPng).width === null,
    "Non-PNG bytes must produce null dimensions.",
  );
}
{
  // Reachable /json/version bodies without both required keys are NOT ready:
  // the resolver must keep polling until its deadline instead of accepting.
  assert(
    evaluateCdpVersionBody({
      Browser: "Chrome/126.0.0.0",
      webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/guid",
    }).ready === true,
    "A complete CDP version body must evaluate ready.",
  );
  const missingKeys = evaluateCdpVersionBody({ Browser: "Chrome/126" });
  assert(
    missingKeys.ready === false &&
      missingKeys.requiredKeys.Browser === true &&
      missingKeys.requiredKeys.webSocketDebuggerUrl === false,
    "A CDP version body without webSocketDebuggerUrl must stay unresolved with per-key truth.",
  );
  assert(
    evaluateCdpVersionBody({}).ready === false &&
      evaluateCdpVersionBody(null).ready === false &&
      evaluateCdpVersionBody("text").ready === false,
    "Empty or non-object CDP bodies must never count as ready.",
  );
}
{
  // Behavioral network dead-end proof over the exact exported launch args:
  // every host maps to the unroutable 0.0.0.0, localhost resolution is
  // excluded, and the proxy is a loopback discard-port dead end.
  assert(
    stableJson([...ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS]) ===
      stableJson([
        "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost",
        "--proxy-server=127.0.0.1:9",
      ]),
    "Zero-network launch args changed shape.",
  );
  const resolverRule = ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS.find((argument) =>
    argument.startsWith("--host-resolver-rules="),
  )?.slice("--host-resolver-rules=".length);
  assert(
    resolverRule !== undefined && resolverRule.length > 0,
    "The zero-network rules must carry a host-resolver mapping.",
  );
  const mapClauses = resolverRule.split(",");
  const mappedAll = mapClauses.find((clause) => clause.startsWith("MAP "));
  assert(
    mappedAll !== undefined &&
      mappedAll.trim() === "MAP * 0.0.0.0" &&
      mapClauses.some((clause) => clause.trim() === "EXCLUDE localhost"),
    "Host resolution must map every host to the unroutable 0.0.0.0 dead end and exclude localhost.",
  );
  const proxyRule = ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS.find((argument) =>
    argument.startsWith("--proxy-server="),
  )?.slice("--proxy-server=".length);
  assert(
    proxyRule !== undefined &&
      proxyRule.startsWith("127.0.0.1:") &&
      Number(proxyRule.slice("127.0.0.1:".length)) === 9,
    "The proxy dead end must be loopback port 9 (discard), which can never answer.",
  );
  // The tester launch composes app positional + zero-network rules + loopback
  // ephemeral CDP endpoint; duplicates from Playwright are tolerated at
  // runtime, so only presence of these exact custom args is required.
  assert(
    PRODUCTION_TESTER_LAUNCH_ARGS.includes(".") &&
      ACCEPTANCE_ZERO_NETWORK_LAUNCH_ARGS.every((argument) =>
        PRODUCTION_TESTER_LAUNCH_ARGS.includes(argument),
      ) &&
      PRODUCTION_TESTER_LAUNCH_ARGS.includes(
        "--remote-debugging-address=127.0.0.1",
      ) &&
      PRODUCTION_TESTER_LAUNCH_ARGS.includes("--remote-debugging-port=0"),
    "Tester launch args must compose the app positional, zero-network rules, and loopback ephemeral CDP.",
  );
}
{
  // Child main-process environment authority: safe booleans/count verdicts
  // over one nested record whose launch switches come from exact
  // app.commandLine checks inside the child itself.
  const passingSample = {
    homeAbsent: true,
    launchSwitches: {
      hostResolverRulesDeadEnd: true,
      proxyLoopbackDiscard: true,
      remoteDebuggingAddressLoopback: true,
      remoteDebuggingPortEphemeral: true,
    },
    providerSecretNameCount: 0,
    testApiAbsent: true,
    userDataDirConfigured: true,
    writeAuthorizationFlagsZero: true,
  };
  assert(
    evaluateTesterChildEnvironmentAuthority(passingSample).pass === true,
    "A fully hardened child environment sample must pass authority evaluation.",
  );
  assert(
    Object.isFrozen(CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS) &&
      stableJson([...CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS]) ===
        stableJson([
          "homeAbsent",
          "launchSwitches",
          "providerSecretNameCount",
          "testApiAbsent",
          "userDataDirConfigured",
          "writeAuthorizationFlagsZero",
        ]) &&
      Object.isFrozen(CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS) &&
      stableJson([...CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS]) ===
        stableJson([
          "hostResolverRulesDeadEnd",
          "proxyLoopbackDiscard",
          "remoteDebuggingAddressLoopback",
          "remoteDebuggingPortEphemeral",
        ]),
    "The child environment authority accepted key sets must stay frozen and pinned to the exact flat sample keys and nested launch-switch keys.",
  );
  for (const switchName of [
    "hostResolverRulesDeadEnd",
    "proxyLoopbackDiscard",
    "remoteDebuggingAddressLoopback",
    "remoteDebuggingPortEphemeral",
  ]) {
    const falseCase = evaluateTesterChildEnvironmentAuthority({
      ...passingSample,
      launchSwitches: {
        ...passingSample.launchSwitches,
        [switchName]: false,
      },
    });
    const absentCase = evaluateTesterChildEnvironmentAuthority({
      ...passingSample,
      launchSwitches: Object.fromEntries(
        Object.entries(passingSample.launchSwitches).filter(
          ([name]) => name !== switchName,
        ),
      ),
    });
    assert(
      falseCase.pass === false &&
        falseCase.facts.launchSwitchesExact === false &&
        falseCase.facts.launchSwitchesKeysExact === true &&
        absentCase.pass === false &&
        absentCase.facts.launchSwitchesExact === false &&
        absentCase.facts.launchSwitchesKeysExact === false,
      `Child environment authority must fail closed when launch switch ${switchName} is false or absent.`,
    );
  }
  for (const mutation of [
    { homeAbsent: false },
    { providerSecretNameCount: 1 },
    { testApiAbsent: false },
    { userDataDirConfigured: false },
    { writeAuthorizationFlagsZero: false },
  ]) {
    assert(
      evaluateTesterChildEnvironmentAuthority({
        ...passingSample,
        ...mutation,
      }).pass === false,
      `Child environment authority must fail on ${JSON.stringify(mutation)}.`,
    );
  }
  assert(
    evaluateTesterChildEnvironmentAuthority(null).pass === false &&
      evaluateTesterChildEnvironmentAuthority(undefined).pass === false,
    "A missing child environment sample must fail closed.",
  );
  // A composite wrapper handed to the evaluator by mistake (the whole applied
  // record instead of its nested authority member), a legacy flat sample
  // without the nested launch-switch record, an empty switch record, and an
  // empty object all fail closed instead of passing accidentally.
  for (const composite of [
    {},
    { childEnvironmentAuthority: passingSample },
    {
      homeAbsent: true,
      providerSecretNameCount: 0,
      testApiAbsent: true,
      userDataDirConfigured: true,
      writeAuthorizationFlagsZero: true,
    },
    { ...passingSample, launchSwitches: {} },
  ]) {
    assert(
      evaluateTesterChildEnvironmentAuthority(composite).pass === false,
      `A composite or legacy child environment sample must fail closed: ${stableJson(composite)}`,
    );
  }
  // Fail-closed shape authority over the pinned exact key sets: unknown extra
  // or missing keys anywhere in the record fail through dedicated shape facts
  // without coercion, while genuine field facts stay intact so evidence names
  // the exact defect instead of cascading.
  const extraTopLevelKeyCase = evaluateTesterChildEnvironmentAuthority({
    ...passingSample,
    spawnargsEcho: 1,
  });
  const missingTopLevelKeyCase = evaluateTesterChildEnvironmentAuthority({
    homeAbsent: true,
    launchSwitches: passingSample.launchSwitches,
    providerSecretNameCount: 0,
    testApiAbsent: true,
    writeAuthorizationFlagsZero: true,
  });
  assert(
    extraTopLevelKeyCase.pass === false &&
      extraTopLevelKeyCase.facts.sampleKeysExact === false &&
      extraTopLevelKeyCase.facts.homeAbsent === true &&
      extraTopLevelKeyCase.facts.launchSwitchesExact === true &&
      missingTopLevelKeyCase.pass === false &&
      missingTopLevelKeyCase.facts.sampleKeysExact === false &&
      missingTopLevelKeyCase.facts.userDataDirConfigured === false,
    "Child environment authority must fail closed on unknown or missing flat-sample keys while keeping genuine field facts intact.",
  );
  const extraNestedKeyCase = evaluateTesterChildEnvironmentAuthority({
    ...passingSample,
    launchSwitches: {
      ...passingSample.launchSwitches,
      processSpawnargsEcho: true,
    },
  });
  assert(
    extraNestedKeyCase.pass === false &&
      extraNestedKeyCase.facts.sampleKeysExact === true &&
      extraNestedKeyCase.facts.launchSwitchesKeysExact === false &&
      extraNestedKeyCase.facts.launchSwitchesExact === true,
    "Child environment authority must fail closed on an unknown nested launch-switch key through the nested shape fact.",
  );
  for (const [fieldName, truthyValue] of [
    ["homeAbsent", "true"],
    ["testApiAbsent", "yes"],
    ["userDataDirConfigured", 1],
    ["writeAuthorizationFlagsZero", "0"],
  ]) {
    const truthyCase = evaluateTesterChildEnvironmentAuthority({
      ...passingSample,
      [fieldName]: truthyValue,
    });
    assert(
      truthyCase.pass === false && truthyCase.facts[fieldName] === false,
      `Child environment authority must reject the truthy non-boolean ${fieldName} value ${JSON.stringify(truthyValue)} without coercion.`,
    );
  }
  for (const badCount of ["0", 1, 1.5, Number.NaN, null]) {
    const countCase = evaluateTesterChildEnvironmentAuthority({
      ...passingSample,
      providerSecretNameCount: badCount,
    });
    assert(
      countCase.pass === false &&
        countCase.facts.providerSecretNameCountExact === false,
      `Child environment authority must reject the provider secret name count ${JSON.stringify(badCount)} unless it is exactly the number zero.`,
    );
  }
  for (const garbage of [
    null,
    undefined,
    "all-exact",
    42,
    [true, true, true, true],
    new Date(0),
  ]) {
    const garbageCase = evaluateTesterChildEnvironmentAuthority({
      ...passingSample,
      launchSwitches: garbage,
    });
    assert(
      garbageCase.pass === false &&
        garbageCase.facts.launchSwitchesKeysExact === false &&
        garbageCase.facts.launchSwitchesExact === false,
      `A garbage launch-switch record (${String(JSON.stringify(garbage))}) must fail both nested shape and switch-value facts.`,
    );
  }
  // Modeled failure result: the production wrapper captures the raw sample
  // before any verdict, so a failing evaluation still carries its raw
  // per-switch evidence, and the failure message names each failing fact.
  const failingSample = {
    ...passingSample,
    launchSwitches: {
      ...passingSample.launchSwitches,
      remoteDebuggingPortEphemeral: false,
    },
  };
  let modeledRawEvidence = null;
  const modeledFailure = (() => {
    modeledRawEvidence = failingSample;
    return evaluateTesterChildEnvironmentAuthority(modeledRawEvidence);
  })();
  const modeledFailingFacts = Object.entries(modeledFailure.facts)
    .filter(([, value]) => value !== true && value !== 0)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  assert(
    modeledFailure.pass === false &&
      modeledRawEvidence === failingSample &&
      modeledRawEvidence.launchSwitches.remoteDebuggingPortEphemeral ===
        false &&
      modeledFailure.facts.launchSwitchesExact === false &&
      stableJson(modeledFailingFacts) ===
        stableJson(["launchSwitchesExact=false"]),
    "A modeled authority failure must retain the raw per-switch sample and name its failing per-field facts.",
  );
}
{
  const exactGeometry = compareTesterStartupGeometry(
    PRODUCTION_TESTER_GEOMETRY_REQUEST,
    {
      contentBounds: { height: 704, width: 1280, x: 0, y: 16 },
      displayMode: "normal",
      outerBounds: { height: 720, width: 1280, x: 100, y: 60 },
      visible: true,
      workArea: { height: 1053, width: 1920, x: 0, y: 27 },
      zoomFactor: 1.25,
    },
  );
  assert(
    exactGeometry.pass === true &&
      exactGeometry.outerBoundsMatchRequest === true &&
      exactGeometry.zoomFactorExact === true &&
      exactGeometry.displayModeNormal === true &&
      exactGeometry.divergences.length === 0,
    "Production tester geometry comparison must pass on an exact 1280x720 native-1.25 window.",
  );
  const clampedGeometry = compareTesterStartupGeometry(
    PRODUCTION_TESTER_GEOMETRY_REQUEST,
    {
      contentBounds: { height: 688, width: 1024, x: 0, y: 32 },
      displayMode: "normal",
      outerBounds: { height: 720, width: 1024, x: 0, y: 0 },
      visible: true,
      workArea: { height: 600, width: 1024, x: 0, y: 0 },
      zoomFactor: 1.25,
    },
  );
  assert(
    clampedGeometry.pass === true &&
      clampedGeometry.outerBoundsMatchRequest === false &&
      clampedGeometry.expectedOuterBounds.width === 1024 &&
      clampedGeometry.expectedOuterBounds.height === 720,
    "Production tester geometry comparison must apply the 1024x720 BrowserWindow minimum after the work-area clamp while recording the exact-request divergence.",
  );
  const subMinGeometry = compareTesterStartupGeometry(
    PRODUCTION_TESTER_GEOMETRY_REQUEST,
    {
      contentBounds: { height: 688, width: 1024, x: 0, y: 32 },
      displayMode: "normal",
      outerBounds: { height: 720, width: 1024, x: 0, y: 0 },
      visible: true,
      workArea: { height: 500, width: 900, x: 0, y: 0 },
      zoomFactor: 1.25,
    },
  );
  assert(
    subMinGeometry.pass === true &&
      subMinGeometry.outerBoundsMatchRequest === false &&
      subMinGeometry.expectedOuterBounds.width === 1024 &&
      subMinGeometry.expectedOuterBounds.height === 720,
    "A work area smaller than the window minimum must resolve to the constrained minimum.",
  );
  const divergentGeometry = compareTesterStartupGeometry(
    PRODUCTION_TESTER_GEOMETRY_REQUEST,
    {
      contentBounds: { height: 704, width: 1280, x: 0, y: 16 },
      displayMode: "maximized",
      outerBounds: { height: 920, width: 1440, x: 0, y: 0 },
      visible: false,
      workArea: { height: 1053, width: 1920, x: 0, y: 27 },
      zoomFactor: 1,
    },
  );
  assert(
    divergentGeometry.pass === false &&
      divergentGeometry.displayModeNormal === false &&
      divergentGeometry.zoomFactorExact === false &&
      divergentGeometry.divergences.length >= 3,
    "Production tester geometry comparison must fail closed on wrong zoom/display-mode/visibility.",
  );
}
assert(
  wrapper.includes('"--remote-debugging-address=127.0.0.1"') &&
    wrapper.includes('"--remote-debugging-port=0"'),
  "Production tester probe does not request a loopback ephemeral CDP endpoint.",
);
assert(
  wrapper.includes("NESTOR_TESTER_SESSION_GEOMETRY") &&
    wrapper.includes("NESTOR_STARTUP_WINDOW_WIDTH") &&
    wrapper.includes("NESTOR_STARTUP_WINDOW_HEIGHT") &&
    wrapper.includes("NESTOR_STARTUP_ZOOM_FACTOR"),
  "Production tester probe does not inject the explicit startup-geometry environment.",
);
{
  const testerEnvironmentSource = wrapper.slice(
    wrapper.indexOf("export function productionTesterEnvironment"),
    wrapper.indexOf("export function parseDevToolsActivePortContents"),
  );
  assert(
    testerEnvironmentSource.length > 0 &&
      testerEnvironmentSource.includes("delete env.NESTOR_ENABLE_TEST_API") &&
      !testerEnvironmentSource.includes('NESTOR_ENABLE_TEST_API = "1"') &&
      !testerEnvironmentSource.includes("NESTOR_AI_API_KEY"),
    "Production tester environment builder must prove test API and provider keys stay absent by construction.",
  );
}
assert(
  wrapper.includes("webContents.getZoomFactor()"),
  "Production tester probe does not measure the native main-process zoom factor.",
);
assert(
  wrapper.includes("DevToolsActivePort") &&
    wrapper.includes("/json/version") &&
    wrapper.includes("webSocketDebuggerUrl") &&
    wrapper.includes("devtools-active-port-file"),
  "Production tester probe does not resolve and verify a live CDP endpoint.",
);
assert(
  wrapper.includes("accepted-app-production-tester.png") &&
    wrapper.includes('component: "accepted-app-production-tester"') &&
    wrapper.includes('kind: "screenshot"'),
  "Production tester screenshot is not bound into the evidence inventory.",
);
assert(
  wrapper.includes("createOwnedProcessLedger()") &&
    wrapper.includes('"production-tester"') &&
    wrapper.includes("userDataCleanedUp"),
  "Production tester probe does not prove owned-process teardown and isolated user-data cleanup.",
);
assert(
  wrapper.split("stopAndVerifyOwnedElectron(").length >= 3 &&
    wrapper.includes('"accepted-app-runtime-probe"') &&
    wrapper.includes("runtime-probe-user-data"),
  "Both accepted-app launches must use owned-process teardown and remove their isolated user-data directories.",
);
assert(
  wrapper.split("attachProcessOutput(").length >= 3 &&
    wrapper.split("finalizeProcessOutput(").length >= 3 &&
    wrapper.includes("PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN") &&
    wrapper.includes("resolvePrimaryRunError("),
  "Main-process output must be captured and finalized for both launches with only the shared inspector-disconnect allowlist, and primary failures must survive teardown errors.",
);
assert(
  wrapper.includes('kind: "component-log"') &&
    wrapper.includes("${capture.id}-stdout.log") &&
    wrapper.includes("${capture.id}-stderr.log"),
  "Build/component stdout and stderr logs must be explicit evidence inventory entries.",
);
assert(
  wrapper.includes("parsePngMetadata(await readFile(screenshotPath))") &&
    wrapper.includes('format: "png"'),
  "The tester screenshot must be PNG magic/dimension verified and its metadata recorded.",
);
{
  // The child authority record is evaluated once through its nested member
  // (never the bare applied composite), and the report emits both the
  // evaluation and the raw per-switch evidence even when the probe fails.
  const normalizedWrapper = wrapper.replace(/\s+/g, " ").replace(/, \)/g, " )");
  assert(
    !normalizedWrapper.includes(
      "evaluateTesterChildEnvironmentAuthority(applied)",
    ) &&
      normalizedWrapper.includes(
        "evaluateTesterChildEnvironmentAuthority( applied.childEnvironmentAuthority )",
      ),
    "The tester probe must pass only the nested child authority record to its evaluator.",
  );
  assert(
    normalizedWrapper.includes(
      "childMainProcess: { evaluation: evaluateTesterChildEnvironmentAuthority( rawChildEnvironmentAuthority ), raw: rawChildEnvironmentAuthority ?? null, }",
    ),
    "The tester report must always emit an explicit raw child authority field beside its evaluation, even when no sample was captured.",
  );
}
assert(
  wrapper.includes("reloadZoomFactorExact") &&
    wrapper.includes("postReload.zoomFactor = reloadZoomFactor"),
  "Native zoom must be re-measured after reload and recorded exactly at the requested native factor.",
);
assert(
  wrapper.includes("accepted-app-production-tester-shell") &&
    wrapper.includes("postProbeCollisionScan"),
  "The tester screenshot must join the cross-component collision scan under its own component.",
);
assert(
  wrapper.split("verifyAcceptedElectronApp(acceptedAppRoot, acceptedAppRecord)")
    .length >= 3,
  "Production tester probe must reverify the sealed app before and after its isolated launch.",
);
// --- P0 closure: runtime probe pass gates, throw ordering, latch pinning ----
assert(
  wrapper.includes("runtimeProbeSha256"),
  "The final acceptance seal must keep binding the runtime probe report bytes.",
);
{
  // Behavioral proof of the pure runtime-pass gate used by main(): every
  // missing or non-true pass flag must fail closed.
  assert(
    evaluateRuntimeProbePassRequirement({
      pass: true,
      productionTesterProbe: { pass: true },
    }) === true,
    "A fully passing runtime probe must satisfy the runtime pass requirement.",
  );
  for (const broken of [
    null,
    undefined,
    {},
    { pass: false, productionTesterProbe: { pass: true } },
    { pass: true },
    { pass: "true", productionTesterProbe: { pass: true } },
    { pass: true, productionTesterProbe: null },
    { pass: true, productionTesterProbe: {} },
    { pass: true, productionTesterProbe: { pass: false } },
    { pass: true, productionTesterProbe: { pass: "true" } },
  ]) {
    assert(
      evaluateRuntimeProbePassRequirement(broken) === false,
      `Runtime pass requirement must fail on ${JSON.stringify(broken)}.`,
    );
  }
}
{
  // Ordering proof inside runAcceptedAppRuntimeProbe: the probe JSON is
  // written before the exactly-prefixed tester-failure throw, and primary
  // versus teardown resolution happens before the function may return.
  const runtimeProbeSource = wrapper.slice(
    wrapper.indexOf("async function runAcceptedAppRuntimeProbe"),
    wrapper.indexOf("async function verifyFinalEvidence"),
  );
  assert(
    runtimeProbeSource.length > 0,
    "runAcceptedAppRuntimeProbe source slice is missing from the wrapper.",
  );
  const writeAt = runtimeProbeSource.indexOf(
    "await writeJson(outputPath, probe)",
  );
  const testerThrowAt = runtimeProbeSource.indexOf(
    "`Production-like tester probe failed: ${",
  );
  const testerGateAt = runtimeProbeSource.indexOf(
    "probe.productionTesterProbe.pass !== true",
  );
  const primaryResolveAt = runtimeProbeSource.indexOf(
    "resolvePrimaryRunError(",
  );
  const returnAt = runtimeProbeSource.lastIndexOf("return probe;");
  assert(
    writeAt >= 0 &&
      testerGateAt > writeAt &&
      testerThrowAt > testerGateAt &&
      primaryResolveAt > testerThrowAt &&
      returnAt > primaryResolveAt,
    "The runtime probe must write its JSON diagnostic, then treat any non-true tester pass as an exactly-prefixed failure thrown through resolvePrimaryRunError before returning.",
  );
  assert(
    runtimeProbeSource.includes('"no production tester record"'),
    "The tester-failure throw must fall back to a recorded-failure placeholder when no record exists.",
  );
}
{
  // Freeze v11 regression guards: ElectronApplication.evaluate callbacks that
  // destructure a `process` property out of the Electron namespace are
  // unsupported and fail deterministically. Every destructuring evaluate
  // callback anywhere in the wrapper — arrow or function expression, sync or
  // async — must take Electron modules only from the namespace and read
  // process data from the ambient global; there is no compatibility fallback.
  const evaluateDestructurings = findEvaluateProcessDestructurings(wrapper);
  assert(
    evaluateDestructurings.length >= 3,
    "Expected the runtime identity, production tester, and reload-zoom ElectronApplication.evaluate callbacks in the wrapper.",
  );
  for (const names of evaluateDestructurings)
    assert(
      !/(^|[^\w$.])process(?![\w$])/.test(names),
      `ElectronApplication.evaluate must never destructure process from the Electron namespace: ({ ${names.trim()} })`,
    );
  // The guard itself is pinned behaviorally: function-expression callbacks
  // are rejected exactly like arrows, while ambient process property access
  // inside a callback body never flags.
  const guardCases = [
    {
      expectFlagged: true,
      source: "app.evaluate(({ process }) => {})",
    },
    {
      expectFlagged: true,
      source: "app.evaluate(async ({ process }) => {})",
    },
    {
      expectFlagged: true,
      source: "app.evaluate(function ({ process }) {})",
    },
    {
      expectFlagged: true,
      source: "app.evaluate(async function ({ process }) {})",
    },
    {
      expectFlagged: true,
      source: "app.evaluate(function named ({ app, process }) {})",
    },
    {
      expectFlagged: false,
      source:
        "app.evaluate(function named ({ BrowserWindow, screen }) { return Object.keys(process.env).length + process.spawnargs.length; })",
    },
    {
      expectFlagged: false,
      source: "app.evaluate(async ({ app }) => process.versions.electron)",
    },
    {
      expectFlagged: false,
      source:
        "app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows())",
    },
  ];
  for (const guardCase of guardCases) {
    const destructuredNames = findEvaluateProcessDestructurings(
      guardCase.source,
    );
    const flagged =
      destructuredNames.length === 1 &&
      /(^|[^\w$.])process(?![\w$])/.test(destructuredNames[0]);
    assert(
      flagged === guardCase.expectFlagged,
      `The evaluate-process-destructure guard must ${
        guardCase.expectFlagged ? "reject" : "accept"
      }: ${guardCase.source}`,
    );
  }
}
{
  // Positive pin of the supported identity split plus its fail-closed shape
  // and equality proof: the accepted-app runtime probe reads the executable
  // through the app namespace, versions through the ambient process global,
  // then re-realpaths the reported executable after evaluate, asserts both
  // electron versions are non-empty strings, and only then asserts equality
  // unconditionally against the already-bound accepted identity.
  const runtimeIdentitySlice = wrapper.slice(
    wrapper.indexOf("async function runAcceptedAppRuntimeProbe"),
    wrapper.indexOf("async function verifyFinalEvidence"),
  );
  const evaluateAt = runtimeIdentitySlice.indexOf("app.evaluate(({ app })");
  const executableAssertAt = runtimeIdentitySlice.indexOf(
    "const runtimeExecutablePath = await realpath(runtime.execPath)",
  );
  assert(
    runtimeIdentitySlice.length > 0 &&
      evaluateAt >= 0 &&
      runtimeIdentitySlice.includes('execPath: app.getPath("exe")') &&
      runtimeIdentitySlice.includes("process.versions.electron") &&
      runtimeIdentitySlice.includes("process.versions.chrome") &&
      runtimeIdentitySlice.includes("process.versions.node"),
    "Accepted-app runtime identity must use the supported split: app.getPath(exe) from the Electron namespace plus ambient process.versions evidence.",
  );
  const runtimeVersionShapeAt = runtimeIdentitySlice.indexOf(
    'typeof runtime.electronVersion === "string"',
  );
  const runtimeVersionLengthAt = runtimeIdentitySlice.indexOf(
    "runtime.electronVersion.length > 0",
  );
  const packageVersionShapeAt = runtimeIdentitySlice.indexOf(
    'typeof electronIdentity.electronPackageVersion === "string"',
  );
  const packageVersionLengthAt = runtimeIdentitySlice.indexOf(
    "electronIdentity.electronPackageVersion.length > 0",
  );
  const versionEqualityAt = runtimeIdentitySlice.indexOf(
    "runtime.electronVersion === electronIdentity.electronPackageVersion",
  );
  assert(
    executableAssertAt >= 0 &&
      evaluateAt >= 0 &&
      executableAssertAt > evaluateAt &&
      runtimeIdentitySlice.includes(
        "runtimeExecutablePath === before.executablePath",
      ) &&
      versionEqualityAt > 0,
    "Runtime identity must be proven equal to the bound accepted executable path and electron package version after the evaluate.",
  );
  assert(
    runtimeVersionShapeAt > executableAssertAt &&
      runtimeVersionLengthAt > runtimeVersionShapeAt &&
      packageVersionShapeAt > runtimeVersionLengthAt &&
      packageVersionLengthAt > packageVersionShapeAt &&
      versionEqualityAt > packageVersionLengthAt &&
      runtimeIdentitySlice.includes(
        "did not report a non-empty Electron version",
      ) &&
      runtimeIdentitySlice.includes(
        "did not record a non-empty Electron package version",
      ),
    "Electron version evidence must fail closed on a non-empty string shape for both the reported runtime version and the bound package version before asserting equality.",
  );
  assert(
    !/\bif\s*\(/.test(
      runtimeIdentitySlice.slice(runtimeVersionShapeAt, versionEqualityAt),
    ),
    "The electron-version equality assertion must be unconditional: no conditional guard may sit between the shape assertions and the equality assert.",
  );
}
{
  // Freeze v12 regression guards for the production tester child environment
  // gate. The evaluate callback must take app/BrowserWindow/screen from the
  // Electron namespace and environment authority from the ambient process
  // global; launch-switch proof must be exact app.commandLine
  // hasSwitch/getSwitchValue equality (the nonexistent process.spawnargs
  // global is banned); the raw child sample must be assigned after the
  // applied-window assert and before the evaluator call and its verdict
  // assert; and the failure must name per-field facts.
  assert(
    !wrapper.includes("process.spawnargs") &&
      !wrapper.includes("{ BrowserWindow, process, screen }") &&
      !wrapper.includes("evaluateTesterChildEnvironmentAuthority(applied)") &&
      wrapper.includes("({ app, BrowserWindow, screen }) => {") &&
      wrapper.includes("Object.keys(process.env)"),
    "Production tester evaluate must keep app/BrowserWindow/screen from the Electron namespace and environment authority from the ambient process global, with exact app.commandLine switch checks instead of process.spawnargs.",
  );
  const testerSessionSource = wrapper.slice(
    wrapper.indexOf("async function runAcceptedAppProductionTesterSession"),
    wrapper.indexOf("// Pre-launch module containment contract"),
  );
  assert(
    testerSessionSource.length > 0,
    "Production tester session source slice is missing from the wrapper.",
  );
  const normalizedTesterSession = testerSessionSource
    .replace(/\s+/g, " ")
    .replace(/, \)/g, " )");
  for (const [switchName, expectedValue] of [
    ["host-resolver-rules", "MAP * 0.0.0.0,EXCLUDE localhost"],
    ["proxy-server", "127.0.0.1:9"],
    ["remote-debugging-address", "127.0.0.1"],
    ["remote-debugging-port", "0"],
  ]) {
    assert(
      normalizedTesterSession.includes(
        `app.commandLine.hasSwitch("${switchName}")`,
      ) &&
        normalizedTesterSession.includes(
          `app.commandLine.getSwitchValue("${switchName}") === "${expectedValue}"`,
        ),
      `The tester probe must prove --${switchName}=${expectedValue} through an exact app.commandLine hasSwitch/getSwitchValue equality check.`,
    );
  }
  const appliedAssertAt = normalizedTesterSession.indexOf(
    '"No live BrowserWindow answered the tester geometry probe."',
  );
  const rawAssignmentAt = normalizedTesterSession.indexOf(
    "rawChildEnvironmentAuthority = applied.childEnvironmentAuthority;",
  );
  const nestedEvaluatorCallAt = normalizedTesterSession.indexOf(
    "evaluateTesterChildEnvironmentAuthority( applied.childEnvironmentAuthority )",
  );
  const authorityFailureAt = normalizedTesterSession.indexOf(
    "environment authority failed (",
  );
  assert(
    appliedAssertAt >= 0 &&
      rawAssignmentAt > appliedAssertAt &&
      nestedEvaluatorCallAt > rawAssignmentAt &&
      authorityFailureAt > nestedEvaluatorCallAt,
    "The tester probe must assign its raw child authority evidence after the applied-window assert and before the nested evaluator call and its verdict assert.",
  );
  assert(
    normalizedTesterSession.includes(
      '${childEnvironmentFailingFacts.join(", ") || "no failing fact"}',
    ),
    "The child authority failure message must enumerate the failing per-field facts.",
  );
  const authorityEvaluatorSource = wrapper
    .slice(
      wrapper.indexOf(
        "export function evaluateTesterChildEnvironmentAuthority",
      ),
      wrapper.indexOf("// Pure requested-versus-applied geometry truth."),
    )
    .replace(/\s+/g, " ")
    .replace(/, \)/g, " )");
  assert(
    authorityEvaluatorSource.includes(
      "hasExactKeys( sample, CHILD_ENVIRONMENT_AUTHORITY_SAMPLE_KEYS )",
    ) &&
      authorityEvaluatorSource.includes(
        "hasExactKeys( launchSwitches, CHILD_LAUNCH_SWITCH_AUTHORITY_KEYS )",
      ) &&
      !authorityEvaluatorSource.includes("?? {}") &&
      !authorityEvaluatorSource.includes("Number.isInteger"),
    "The tester child environment evaluator must fail closed through the pinned exact key sets with no defaulting or numeric coercion.",
  );
}
{
  // Main-side gate ordering: both pass flags are asserted (through the pure
  // helper) immediately after the runtime probe lands and strictly before
  // evidence finalization, which itself precedes sealing.
  const gateAt = wrapper.indexOf(
    "evaluateRuntimeProbePassRequirement(acceptanceReport.runtimeProbe)",
  );
  const evidenceFinalizeAt = wrapper.indexOf(
    "acceptanceReport.evidence = await finalizeFileEvidence",
  );
  const sealAt = wrapper.indexOf("createFinalAcceptanceSeal({");
  assert(
    gateAt >= 0 && evidenceFinalizeAt > gateAt && sealAt > evidenceFinalizeAt,
    "main must hard-gate on the full runtime probe pass before evidence finalization and sealing.",
  );
}
{
  // Success-latch pinning: exactly one pass=true latch, placed only after
  // every throw-capable final assertion; the outer catch resets pass=false
  // before recording failure or exit code.
  assert(
    wrapper.split("acceptanceReport.pass = true").length - 1 === 1,
    "Acceptance success must have exactly one explicit latch point.",
  );
  const collisionGateAt = wrapper.indexOf(
    "finalCollisionScan.collisions.length === 0",
  );
  const passLatchAt = wrapper.indexOf("acceptanceReport.pass = true");
  assert(
    collisionGateAt >= 0 && passLatchAt > collisionGateAt,
    "The success latch must come only after the final cross-component collision assertion.",
  );
  assert(
    wrapper.includes(
      "} catch (error) {\n    acceptanceReport.pass = false;\n    acceptanceReport.failedAt = now();",
    ),
    "The outer catch must reset pass=false first, then record failure.",
  );
}
assert(
  wrapper.includes('kind: "build-log"') &&
    wrapper.includes('"build-stdout.log"') &&
    wrapper.includes('"build-stderr.log"'),
  "Build stdout/stderr logs must be exact evidence inventory entries alongside component logs.",
);
assert(
  wrapper.includes("createFinalAcceptanceSeal") &&
    wrapper.includes("initialBuildManifest") &&
    wrapper.includes("canonicalSha256") &&
    wrapper.includes("Externally custody expected acceptance seal SHA-256"),
  "Acceptance wrapper does not finalize and expose the canonical custody seal.",
);
assert(
  !safetySource.includes("externalPackageNames"),
  "Accepted-app export still relies on the unsound literal import scanner.",
);
assert(
  safetySource.includes("PRODUCTION_RUNTIME_DEPENDENCY_SEEDS") &&
    safetySource.includes("planProductionDependencyClosure") &&
    !safetySource.includes("exportLogicalNodeModules"),
  "Accepted-app export must plan an explicit manifest-driven dependency closure instead of a flat node_modules walk.",
);
{
  // The auditable seed set must stay pinned to the authoritative build
  // configuration: every electron.vite rollup external plus the Electron
  // runtime and the pdfjs worker package, nothing else.
  const viteConfigSource = await readFile(
    path.join(scriptDir, "..", "electron.vite.config.ts"),
    "utf8",
  );
  const externalsBlock = viteConfigSource.match(/external:\s*\[([\s\S]*?)\]/);
  assert(
    externalsBlock !== null,
    "electron.vite.config.ts no longer declares a rollup external array for the main process.",
  );
  const configuredExternals = [...externalsBlock[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    configuredExternals.length === 5,
    `Expected exactly five electron.vite externals; found ${JSON.stringify(configuredExternals)}.`,
  );
  const expectedSeeds = [
    ...new Set([...configuredExternals, "electron", "pdfjs-dist"]),
  ].sort((left, right) => left.localeCompare(right));
  assert(
    stableJson(PRODUCTION_RUNTIME_DEPENDENCY_SEEDS) ===
      stableJson(expectedSeeds),
    `Production runtime dependency seeds drifted from electron.vite.config.ts externals: ${stableJson(PRODUCTION_RUNTIME_DEPENDENCY_SEEDS)} !== ${stableJson(expectedSeeds)}.`,
  );
  const expectedProbeSpecifiers = [
    ...expectedSeeds.filter((name) => name !== "pdfjs-dist"),
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
  ].sort((left, right) => left.localeCompare(right));
  assert(
    stableJson(ACCEPTANCE_RUNTIME_MODULE_PROBE_SPECIFIERS) ===
      stableJson(expectedProbeSpecifiers),
    "Pre-launch containment probes must cover every production runtime seed with the pdfjs worker pinned to its mandatory legacy runtime subpath.",
  );
}
{
  // Pre-launch ordering: containment probes run inside the runtime probe
  // before electron.launch ever executes.
  const runtimeProbeSlice = wrapper.slice(
    wrapper.indexOf("async function runAcceptedAppRuntimeProbe"),
    wrapper.indexOf("async function verifyFinalEvidence"),
  );
  const containmentAt = runtimeProbeSlice.indexOf(
    "probeAcceptedAppRuntimeModules({",
  );
  const launchAt = runtimeProbeSlice.indexOf("await electron.launch({");
  assert(
    containmentAt >= 0 && launchAt > containmentAt,
    "Accepted-app module containment probes must fail closed before the Electron launch.",
  );
}
assert(
  wrapper.includes("moduleContainment") &&
    wrapper.includes('kind: "module-containment"'),
  "The accepted-app runtime probe record must bind pre-launch module containment evidence.",
);
assert(
  wrapper.includes("entry.pass === true"),
  "Acceptance wrapper does not require pass=true for every capture.",
);
assert(
  sidecarPrepareSource.includes("getManifestPath(binaryPath)") &&
    sidecarPrepareSource.includes("getManifestPath(pythonRoot)") &&
    sidecarRuntimeSource.includes("path.resolve(manifestRoot, pythonRoot)"),
  "Resume-parser sidecar manifests must use relocatable bundle paths that the runtime resolves from the manifest root.",
);
assert(
  wrapper.includes("assertComponentCompletion(captureReport, capture.id)"),
  "Acceptance wrapper does not require explicit component pass and cleanup ownership.",
);
assert(
  wrapper.includes("assertProductSurfaceViewportMatrix") &&
    wrapper.includes('surface: "Resume Studio"') &&
    wrapper.includes('surface: "Applications"') &&
    wrapper.includes(
      "viewport?.physical?.width === expectation.viewport.width",
    ) &&
    wrapper.includes(
      "viewport?.physical?.height === expectation.viewport.height",
    ) &&
    !wrapper.includes("viewport?.css?.width === expectation.viewport.width") &&
    !wrapper.includes("viewport?.css?.height === expectation.viewport.height"),
  "Acceptance wrapper does not behaviorally require Applications and Resume Studio viewport coverage.",
);
assert(
  wrapper.includes("immutableManifest.manifestSha256") &&
    wrapper.includes("buildEvidenceInventory"),
  "Acceptance wrapper does not retain an immutable initial manifest digest and final evidence inventory digest.",
);
assert(
  wrapper.includes(
    "Array.isArray(entry.failures) && entry.failures.length === 0",
  ),
  "Acceptance wrapper does not require an explicit empty capture-failures list.",
);
assert(
  wrapper.includes("entry.insideViewport === true"),
  "Acceptance wrapper does not require insideViewport=true.",
);
assert(
  wrapper.includes("entry.noClip === true"),
  "Acceptance wrapper does not require noClip=true.",
);
assert(
  wrapper.includes("Array.isArray(report.requiredScenarioCompletionIds)") &&
    wrapper.includes("Array.isArray(report.scenarioCompletionIds)"),
  "Acceptance wrapper does not require explicit required/completed scenario lists.",
);
assert(
  wrapper.includes("CANONICAL_LATENCY_BUDGETS") &&
    wrapper.includes("EXPECTED_SCALE_ROUTE_SWITCH_COUNT") &&
    wrapper.includes("Number.isFinite(rendererTiming.start)"),
  "Acceptance wrapper does not enforce canonical route/latency timing evidence.",
);
assert(
  wrapper.includes("REQUIRED_SCALE_JOB_COUNT = 5_000") &&
    wrapper.includes("PRIOR_SCALE_CAP_BOUNDARY_COUNT = 1_001") &&
    wrapper.includes("assertScaleDataContract(captureReport)"),
  "Acceptance wrapper does not enforce the hydrated 5,000-job scale data contract.",
);
assert(
  stableJson(CANONICAL_LATENCY_BUDGETS) ===
    stableJson({ coldToUsableShellMs: 2_000, warmRouteSwitchMs: 500 }),
  "Canonical acceptance latency budgets changed unexpectedly.",
);
assert(
  wrapper.includes("real wheel-and-keyboard scroll-chain proof"),
  "Acceptance wrapper does not enforce real scroll-chain evidence.",
);
for (const fileName of [
  "capture-fresh-flows.mjs",
  "capture-scale-500.mjs",
  "capture-job-finder-error-recovery.mjs",
]) {
  const source = await readFile(path.join(scriptDir, fileName), "utf8");
  assert(
    source.includes("ensureFreshOutputDir"),
    `${fileName} does not reject stale output directories.`,
  );
  assert(
    source.includes("verifyAcceptanceArtifacts"),
    `${fileName} does not bind captures to the exact build.`,
  );
  assert(
    source.includes("assertFileRenderer"),
    `${fileName} does not enforce the file renderer.`,
  );
  assert(
    source.includes("screenshotMetadata"),
    `${fileName} does not record screenshot evidence metadata.`,
  );
  assert(
    !source.includes("re-audit-2026-08-20"),
    `${fileName} still uses a fixed stale artifact directory.`,
  );
}
const scaleSource = await readFile(
  path.join(scriptDir, "capture-scale-500.mjs"),
  "utf8",
);
const paginationClickSlice = topLevelFunctionSlice(
  scaleSource,
  "clickPaginationNextInPage",
);
assert(
  paginationClickSlice.includes("page.evaluate(") &&
    paginationClickSlice.includes('candidate.getAttribute("aria-label")') &&
    paginationClickSlice.includes('"Next page"') &&
    paginationClickSlice.includes("nextButton.click();") &&
    !paginationClickSlice.includes(".click({"),
  "Scale pagination must dispatch Next through an in-page HTMLElement.click without Playwright actionability scrolling.",
);
const paginationFindJobsProbeStart =
  paginationClickSlice.indexOf("if (isFindJobs) {");
const paginationFindJobsProbeEnd = paginationClickSlice.indexOf(
  "nextButton.click();",
  paginationFindJobsProbeStart,
);
const paginationFindJobsProbe =
  paginationFindJobsProbeStart >= 0 &&
  paginationFindJobsProbeEnd > paginationFindJobsProbeStart
    ? paginationClickSlice.slice(
        paginationFindJobsProbeStart,
        paginationFindJobsProbeEnd,
      )
    : "";
assert(
  paginationClickSlice.includes("const isFindJobs =") &&
    paginationClickSlice.includes("{ paginationLabel, heading, isFindJobs }") &&
    paginationFindJobsProbe.includes('"[data-locked-screen-scroll-area]"') &&
    paginationFindJobsProbe.includes('document.querySelectorAll("h1")') &&
    paginationClickSlice.includes(
      "return geometry\n        ? { ok: true, reason: null, before: geometry }\n        : { ok: true, reason: null };",
    ) &&
    paginationClickSlice.lastIndexOf("if (isFindJobs) {") >
      paginationClickSlice.indexOf("nextButton.click();"),
  "Scale pagination must require and return outer-scroll/H1 geometry only for Find Jobs while allowing other surfaces to use the same in-page click helper.",
);
const paginationAdvanceSlice = topLevelFunctionSlice(
  scaleSource,
  "advancePagination",
);
assert(
  paginationAdvanceSlice.includes(
    "await clickPaginationNextInPage(page, config);",
  ) && paginationAdvanceSlice.includes("await waitForPaginationPage("),
  "Scale pagination advances must use the in-page click helper and settle each expected page before continuing.",
);
const paginationWaitSlice = topLevelFunctionSlice(
  scaleSource,
  "waitForPaginationPage",
);
assert(
  paginationWaitSlice.includes("page.waitForFunction(") &&
    paginationWaitSlice.includes("expectedRows") &&
    paginationWaitSlice.includes("expectedText") &&
    paginationWaitSlice.includes("paginationLabel"),
  "Scale pagination clicks must wait for the expected row count and range text.",
);
const paginationGeometryReadSlice = topLevelFunctionSlice(
  scaleSource,
  "readFindJobsPaginationGeometry",
);
const paginationGeometryDiffSlice = topLevelFunctionSlice(
  scaleSource,
  "paginationGeometryDifferences",
);
assert(
  paginationGeometryReadSlice.includes('"[data-locked-screen-scroll-area]"') &&
    paginationGeometryReadSlice.includes("outerScrollTop") &&
    paginationGeometryReadSlice.includes("findJobsH1") &&
    paginationGeometryReadSlice.includes("getBoundingClientRect()") &&
    paginationGeometryDiffSlice.includes("outerScrollTop") &&
    paginationGeometryDiffSlice.includes("Find Jobs H1"),
  "Scale Find Jobs pagination evidence must read the real outer scrollTop and H1 geometry.",
);
assert(
  scaleSource.includes(
    "const native125PaginationGeometry = assertFindJobsPaginationGeometryStable(",
  ) &&
    scaleSource.includes("native125Page1Geometry") &&
    scaleSource.includes("native125Page2Geometry") &&
    /clickPaginationNextInPage\(\s*page,\s*native125FindJobsPagination,\s*\)/u.test(
      scaleSource,
    ) &&
    scaleSource.includes(
      "await waitForPaginationPage(page, native125FindJobsPagination, 2);",
    ),
  "Scale native125 page 1 -> page 2 must use semantic pagination settlement and the same geometry guard.",
);
assert(
  scaleSource.includes("planningMenuScrollRegion:") &&
    scaleSource.includes('"[data-job-finder-more-menu-scroll-region]"'),
  "Scale acceptance must bind expanded Planning shortcuts geometry to the explicit inner scroll region.",
);
assert(
  scaleSource.includes(
    `applications: '[aria-label="Applications"] [data-collection-item-id]'`,
  ),
  "Scale acceptance must collect mounted Application row identities from the tested full-row action, not its id-less list-item parent.",
);
const headingWaitStart = scaleSource.indexOf("async function waitForHeading");
const headingWaitEnd = scaleSource.indexOf(
  "async function waitForWorkspaceHydrationComplete",
);
const headingWaitSource = scaleSource.slice(headingWaitStart, headingWaitEnd);
const switchRouteStart = scaleSource.indexOf("async function switchRoute");
const switchRouteEnd = scaleSource.indexOf("async function setViewportAndZoom");
const switchRouteSource = scaleSource.slice(switchRouteStart, switchRouteEnd);
const headingReadyAt = switchRouteSource.indexOf(
  "const headingReady = waitForHeading(",
);
const clickAt = switchRouteSource.indexOf("button.click({ timeout: 10_000 })");
assert(
  headingWaitStart >= 0 &&
    headingWaitEnd > headingWaitStart &&
    switchRouteStart >= 0 &&
    switchRouteEnd > switchRouteStart &&
    headingReadyAt >= 0 &&
    clickAt > headingReadyAt &&
    switchRouteSource.includes(
      "const [, headingReadiness] = await Promise.all",
    ),
  "Scale route timing must install external heading readiness before click dispatch and await both concurrently.",
);
assert(
  headingWaitSource.includes("return await page.evaluate(") &&
    headingWaitSource.includes("new Promise((resolve, reject)") &&
    headingWaitSource.includes("new MutationObserver") &&
    headingWaitSource.includes("requestAnimationFrame") &&
    !headingWaitSource.includes(".getByRole(") &&
    !headingWaitSource.includes(".waitFor("),
  "Scale route heading readiness must use a renderer page-context observer instead of Playwright locator polling.",
);
assert(
  headingWaitSource.includes('document.querySelectorAll("h1")') &&
    headingWaitSource.includes(
      "candidate.textContent?.trim() === expectedHeading",
    ) &&
    headingWaitSource.includes("candidate.getClientRects().length > 0") &&
    headingWaitSource.includes("bounds.width > 0") &&
    headingWaitSource.includes("bounds.height > 0") &&
    headingWaitSource.includes('style.visibility !== "hidden"') &&
    headingWaitSource.includes('headingElement.tagName === "H1"') &&
    switchRouteSource.includes(
      "headingReadiness.headingText === definition.heading",
    ) &&
    switchRouteSource.includes(
      "headingReadiness.observedRoute === `#${definition.route}`",
    ),
  "Scale route heading readiness must check the exact visible destination level-1 heading.",
);
assert(
  headingWaitSource.indexOf("if (startMark) performance.mark(startMark);") >=
    0 &&
    headingWaitSource.indexOf("const startTime = performance.now();") >
      headingWaitSource.indexOf(
        "if (startMark) performance.mark(startMark);",
      ) &&
    headingWaitSource.includes("const observedAt = performance.now();") &&
    headingWaitSource.includes("elapsedMs: observedAt - startTime") &&
    switchRouteSource.includes(
      "const headingObservedLatencyMs = headingReadiness.elapsedMs",
    ) &&
    switchRouteSource.includes("durationMs: headingReadiness.elapsedMs") &&
    switchRouteSource.includes("const latencyMs = rendererTiming.durationMs") &&
    !switchRouteSource.includes("const startedAt = performance.now()") &&
    !switchRouteSource.includes("() => performance.now() - startedAt"),
  "Scale route elapsed time must come from renderer performance.now() at exact h1 visibility, not a post-driver timing calculation or optimistic feedback mark.",
);
assert(
  headingWaitSource.includes("Renderer heading readiness timed out") &&
    headingWaitSource.includes("report.routeDebug") &&
    headingWaitSource.includes("debugError"),
  "Scale route heading readiness must retain timeout and route-debug diagnostics.",
);
assert(
  scaleSource.includes("const requiredJobCount = 5_000") &&
    scaleSource.includes("const priorCapBoundaryCount = 1_001") &&
    scaleSource.includes("priorSilentCap: 1_000"),
  "Scale acceptance no longer proves a 5,000-job axis against the 1,001-record prior-cap boundary.",
);
assert(
  scaleSource.includes("hydrationProof.jobs === requiredJobCount") &&
    scaleSource.includes("hydrationProof.shortlisted >= priorCapBoundaryCount"),
  "Scale acceptance does not prove hydrated job and boundary-collection totals after cold launch.",
);
assert(
  scaleSource.includes("MAX_PAGINATION_FAST_FORWARD_CLICKS") &&
    scaleSource.includes('"bounded-head-tail"') &&
    scaleSource.includes('"exhaustive-walk"'),
  "Scale acceptance does not keep its rendered pagination walk bounded.",
);
assert(
  scaleSource.includes('phase === "complete"'),
  "Scale acceptance asserts counts before hydration completes.",
);
assert(
  scaleSource.includes("CANONICAL_LATENCY_BUDGETS"),
  "Scale acceptance has no hard canonical latency budgets.",
);
assert(
  scaleSource.includes("rendererTiming"),
  "Scale acceptance does not capture actual warm-route timing marks.",
);
assert(
  scaleSource.includes(
    "headingObservedLatencyMs <= CANONICAL_LATENCY_BUDGETS.warmRouteSwitchMs",
  ),
  "Scale acceptance gates the optimistic renderer feedback mark instead of externally observed heading readiness.",
);
assert(
  wrapper.includes("routeEntry.headingObservedLatencyMs >= 0") &&
    wrapper.includes("externally observed heading readiness"),
  "Acceptance wrapper does not gate externally observed heading readiness.",
);
assert(
  wrapper.includes(
    "afterRunSource.digest === acceptanceReport.source.afterBuild?.digest",
  ),
  "Acceptance wrapper does not rebind evidence to the recorded source after every capture component finished.",
);
assert(
  wrapper.includes("materializeSourceSnapshot") &&
    wrapper.includes("materializeDependencySnapshot") &&
    wrapper.includes("currentWorktreeDiverged") &&
    wrapper.includes("snapshotScriptDir"),
  "Acceptance wrapper does not build/capture from an immutable snapshot while reporting checkout divergence.",
);
assert(
  !wrapper.includes("postCaptureSource = await sourceFingerprint()"),
  "Acceptance capture still imports mutable original-worktree source as its integrity boundary.",
);
assert(
  wrapper.includes("runTrackedCommand") && wrapper.includes("childPid"),
  "Acceptance wrapper does not spawn capture components as tracked child processes.",
);
assert(
  wrapper.includes('{ level: 1, name: "Search plans", exact: true }') &&
    wrapper.includes('.locator("[data-job-finder-shell]")') &&
    wrapper.includes(
      "Accepted-app lazy-route heading did not become visible",
    ) &&
    wrapper.includes('observedText: "Search plans"') &&
    wrapper.includes('"#/job-finder/campaigns"'),
  "Lazy-route probe must observe the campaigns screen h1 (Search plans) while keeping its route pinned exactly.",
);
assert(
  wrapper.includes("assertNoSurvivingTrackedProcesses"),
  "Acceptance wrapper does not recheck tracked acceptance-owned processes after teardown.",
);
assert(
  scaleSource.includes("snapshotOwnedProcessTree") &&
    scaleSource.includes("verifyZeroLeftoverOwnedProcesses") &&
    scaleSource.includes("processOwnership"),
  "Scale acceptance does not track and prove teardown of its acceptance-owned Electron process tree.",
);
assert(
  scaleSource.includes("captureApplicationsLifecycleView") &&
    scaleSource.includes("geometryStable") &&
    scaleSource.includes("lifecycleEvidence"),
  "Scale acceptance does not record open-state semantic and geometry-stability evidence for the applications lifecycle dropdown.",
);
assert(
  scaleSource.includes('"Applications workspace view"') &&
    scaleSource.includes('"Stages", exact: true') &&
    scaleSource.includes('"Preparation", exact: true'),
  "Scale applications lifecycle capture must switch through the Stages workspace view and restore Preparation afterwards.",
);
assert(
  scaleSource.includes("resolvePrimaryRunError("),
  "Scale teardown can still discard the primary scenario error behind a finalize failure.",
);
assert(
  scaleSource.includes("expectRoute") &&
    scaleSource.includes("does not match expected"),
  "Scale acceptance does not gate capture labels on the observed route.",
);
assert(
  scaleSource.includes('!document.querySelector("[data-job-sources-library]")'),
  "Scale sidebar evidence does not prove the sources library detached before capture.",
);
assert(
  scaleSource.includes('scenarioId: "scale-sidebar-1440"') &&
    scaleSource.includes('screenshotStateId: "1440-profile-baseline"'),
  "Scale sidebar evidence must retain its completion scenario while binding the shared profile-shell screenshot to the baseline visual state.",
);
for (const [captureName, screenshotStateId] of [
  ["findJobs-p1-native125", "findJobs-p1-native125"],
  ["final-native125-overview", "findJobs-p1-native125"],
]) {
  const captureBlock =
    scaleSource.match(
      new RegExp(
        `captureScreenshot\\(page, "${captureName}", \\{([\\s\\S]*?)\\n    \\}\\);`,
        "u",
      ),
    )?.[1] ?? "";
  assert(
    captureBlock.includes(`screenshotStateId: "${screenshotStateId}",`),
    `Scale capture ${captureName} must bind to screenshot state ${screenshotStateId} while retaining its distinct capture scenario ID.`,
  );
}
assert(
  scaleSource.includes('completeScenario("scale-find-jobs-native125")'),
  "Scale Find Jobs native125 capture must retain its existing completion scenario.",
);

// The two scale acceptance scenarios added for rapid review and review-queue
// batch actions must be registered as required completions and must actually
// complete through matching capture paths. Closure is checked both ways:
// every literal completion/capture ID in the capture script must be
// registered, and every registered ID must have a literal or templated
// (planning-settings viewport loop) completion path.
const SCALE_RAPID_REVIEW_SCENARIO_ID = "scale-rapid-review-pagination";
const SCALE_BATCH_ACTIONS_SCENARIO_ID = "scale-review-queue-batch-actions";
const scaleRequiredScenarioMatch = scaleSource.match(
  /requiredScenarioCompletionIds:\s*\[([\s\S]*?)\]/,
);
assert(
  scaleRequiredScenarioMatch !== null,
  "Scale acceptance does not declare an explicit requiredScenarioCompletionIds manifest.",
);
const scaleRequiredScenarioIds = [
  ...new Set(
    (scaleRequiredScenarioMatch[1].match(/"[^"]+"/g) ?? []).map((value) =>
      value.slice(1, -1),
    ),
  ),
].sort((left, right) => left.localeCompare(right));
assert(
  scaleRequiredScenarioIds.length === 13,
  `Scale acceptance must register exactly 13 unique required scenario completion IDs; found ${scaleRequiredScenarioIds.length}: ${JSON.stringify(scaleRequiredScenarioIds)}.`,
);
for (const scenarioId of [
  SCALE_RAPID_REVIEW_SCENARIO_ID,
  SCALE_BATCH_ACTIONS_SCENARIO_ID,
]) {
  assert(
    scaleRequiredScenarioIds.includes(scenarioId),
    `Scale requiredScenarioCompletionIds must register ${scenarioId}.`,
  );
}
assert(
  scaleSource.includes(`scenarioId: "${SCALE_RAPID_REVIEW_SCENARIO_ID}"`),
  "Scale rapid-review completion and per-page capture evidence must flow through its registered scenario ID.",
);
assert(
  scaleSource.includes(
    `completeScenario("${SCALE_BATCH_ACTIONS_SCENARIO_ID}")`,
  ),
  "Scale batch-actions scenario must be completed through its registered scenario ID.",
);
const scaleCompletedScenarioIds = new Set([
  ...[...scaleSource.matchAll(/completeScenario\("([^"]+)"\)/g)].map(
    (match) => match[1],
  ),
  ...[...scaleSource.matchAll(/scenarioId:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  ),
]);
const scaleUnregisteredCompletions = [...scaleCompletedScenarioIds].filter(
  (scenarioId) => !scaleRequiredScenarioIds.includes(scenarioId),
);
assert(
  scaleUnregisteredCompletions.length === 0,
  `Scale capture completes unregistered scenario IDs: ${JSON.stringify(scaleUnregisteredCompletions)}.`,
);
assert(
  stableJson(
    [...scaleSource.matchAll(/completeScenario\(`([^`]+)`\)/g)].map(
      (match) => match[1],
    ),
  ) === stableJson(["scale-planning-settings-${viewportLabel}"]),
  "The only templated scale completion must stay the planning-settings viewport loop.",
);
for (const viewportLabel of ["native125", "minimum-width"]) {
  assert(
    scaleSource.includes(
      `verifyPlanningSettingsMenu(page, "${viewportLabel}")`,
    ) && scaleSource.includes(`scale-planning-settings-${viewportLabel}`),
    `Scale planning-settings loop must complete its registered ${viewportLabel} scenario.`,
  );
}
const scaleCoveredScenarioIds = new Set([
  ...scaleCompletedScenarioIds,
  "scale-planning-settings-native125",
  "scale-planning-settings-minimum-width",
]);
const scaleUncoveredRequirements = scaleRequiredScenarioIds.filter(
  (scenarioId) => !scaleCoveredScenarioIds.has(scenarioId),
);
assert(
  scaleUncoveredRequirements.length === 0,
  `Scale required scenarios without any completion path: ${JSON.stringify(scaleUncoveredRequirements)}.`,
);
const scaleCountsBlock = scaleSource.match(/const counts = \{([\s\S]*?)\};/);
assert(
  scaleCountsBlock !== null &&
    scaleCountsBlock[1].includes("jobs: requiredJobCount") &&
    scaleCountsBlock[1].includes("shortlisted: priorCapBoundaryCount") &&
    scaleCountsBlock[1].includes("applications: priorCapBoundaryCount") &&
    scaleCountsBlock[1].includes("sources: priorCapBoundaryCount"),
  "Scale counts must bind jobs to requiredJobCount and every other collection to priorCapBoundaryCount.",
);

// Behavioral validation: execute the actual pure helpers shipped inside the
// harnesses instead of only matching source strings, so renamed or regressed
// logic fails here against deterministic fixtures.
function topLevelFunctionSlice(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(
    start >= 0,
    `Could not locate function ${name} for behavioral validation.`,
  );
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert(false, `Function ${name} has unbalanced braces.`);
}

function extractTopLevelFunction(source, name) {
  return new Function(
    `"use strict"; return (${topLevelFunctionSlice(source, name)});`,
  )();
}

const paginationVisitPlan = extractTopLevelFunction(
  scaleSource,
  "paginationVisitPlan",
);
assert(
  stableJson(paginationVisitPlan({ pageCount: 3 })) === stableJson([1, 2, 3]),
  "Scale pagination walk must visit every page in order when unsampled.",
);
assert(
  stableJson(
    paginationVisitPlan({ pageCount: 41, sampling: { headPages: [1, 2] } }),
  ) === stableJson([1, 2, 41]),
  "Scale sampled pagination walk must pin head pages plus the final boundary page.",
);
assert(
  stableJson(
    paginationVisitPlan({
      pageCount: 2,
      sampling: { headPages: [5, 2, 1, 2] },
    }),
  ) === stableJson([1, 2]),
  "Scale sampled pagination walk must clamp out-of-range pages, deduplicate, and sort.",
);
const paginationGeometryDifferences = extractTopLevelFunction(
  scaleSource,
  "paginationGeometryDifferences",
);
const stablePaginationGeometry = {
  outerScrollTop: 0,
  findJobsH1: {
    left: 280,
    top: 32,
    right: 520,
    bottom: 68,
    width: 240,
    height: 36,
  },
};
assert(
  stableJson(
    paginationGeometryDifferences(
      stablePaginationGeometry,
      stablePaginationGeometry,
    ),
  ) === stableJson([]),
  "Scale pagination geometry helper must accept an unchanged outer scrollTop and Find Jobs H1 rect.",
);
const scrollDrift = paginationGeometryDifferences(stablePaginationGeometry, {
  ...stablePaginationGeometry,
  outerScrollTop: 24,
});
assert(
  scrollDrift.length === 1 && scrollDrift[0].includes("outer scrollTop"),
  "Scale pagination geometry helper must report outer scrollTop drift.",
);
const headingDrift = paginationGeometryDifferences(stablePaginationGeometry, {
  ...stablePaginationGeometry,
  findJobsH1: { ...stablePaginationGeometry.findJobsH1, top: 56 },
});
assert(
  headingDrift.length === 1 && headingDrift[0].includes("Find Jobs H1 top"),
  "Scale pagination geometry helper must report Find Jobs H1 drift.",
);
const fastForwardBudgetMatch = scaleSource.match(
  /MAX_PAGINATION_FAST_FORWARD_CLICKS = (\d+)/,
);
assert(
  fastForwardBudgetMatch !== null &&
    Number(fastForwardBudgetMatch[1]) >= Math.ceil(5_000 / 40) - 2,
  "Scale fast-forward budget cannot reach the 40-row-per-page rapid-review boundary page 125, which requires 123 Next clicks, through the bounded walk.",
);
// Rapid Review pagination semantics: route, stable row selectors, page size,
// exact pagination label, range text, page counter, boundary screenshots, and
// Previous/Next disabled states. Source tokens pin the shipped helper config
// without line numbers; the visit plan itself is exercised behaviorally
// against the extracted shipped logic below.
const rapidReviewSlice = topLevelFunctionSlice(
  scaleSource,
  "assertRapidReviewPagination",
);
for (const requiredToken of [
  'id: "rapidReview"',
  'scenarioId: "scale-rapid-review-pagination"',
  'route: "/job-finder/rapid-review"',
  'heading: "Rapid review"',
  'surface: "rapidReview"',
  "const pageCount = Math.ceil(counts.jobs / 40);",
  "sampling: { headPages: [1, 2] }",
  'paginationLabel: "jobs pagination"',
  "Math.min(40, counts.jobs - (pageNumber - 1) * 40)",
  "(pageNumber - 1) * 40 + 1",
  "Math.min(pageNumber * 40, counts.jobs)",
  "`Showing ${first}–${last} of ${counts.jobs} jobs`",
  'el.getAttribute("aria-label") === "jobs pagination"',
  "?.querySelector('[aria-current=\"page\"]')",
  "pageCounter === `Page ${pageNumber} of ${pageCount}`",
  "screenshotOnPages: [1, pageCount]",
]) {
  assert(
    rapidReviewSlice.includes(requiredToken),
    `Scale rapid-review scenario lost a required pin: ${requiredToken}`,
  );
}
const jobsToReviewSelectorOccurrences = scaleSource.match(
  /rapidReview: 'ul\[aria-label="Jobs to review"\] > li'/g,
);
assert(
  (jobsToReviewSelectorOccurrences?.length ?? 0) === 2,
  "The stable Jobs-to-review row selector must stay pinned in both surface maps (readSurface and the pagination settlement wait).",
);
const assertPaginationSlice = topLevelFunctionSlice(
  scaleSource,
  "assertPagination",
);
for (const requiredToken of [
  'b.label === "Next"',
  'b.label === "Previous"',
  "next.disabled === (pageNumber === config.pageCount)",
  "previous.disabled === (pageNumber === 1)",
]) {
  assert(
    assertPaginationSlice.includes(requiredToken),
    `The shared pagination walker lost a Previous/Next boundary pin used by rapid review: ${requiredToken}`,
  );
}
const scaleConstantValue = (name) => {
  const match = scaleSource.match(new RegExp(`const ${name} = ([\\d_]+);`));
  assert(match !== null, `Scale acceptance lost its ${name} constant.`);
  return Number(match[1].replaceAll("_", ""));
};
const scaleJobTotal = scaleConstantValue("requiredJobCount");
const scaleBoundaryTotal = scaleConstantValue("priorCapBoundaryCount");
assert(
  scaleJobTotal === 5_000 && scaleBoundaryTotal === 1_001,
  "Scale axis constants drifted from the accepted 5,000-job / 1,001-boundary contract.",
);
assert(
  scaleSource.includes("jobs[counts.shortlisted + index]") &&
    scaleBoundaryTotal * 2 <= scaleJobTotal,
  "Scale Applications records must use the distinct post-Shortlisted job range and stay inside the generated job axis.",
);
const rapidReviewPageCount = Math.ceil(scaleJobTotal / 40);
assert(
  rapidReviewPageCount === 125,
  "Rapid review must paginate the 5,000-job axis into exactly 125 pages of 40 rows.",
);
assert(
  stableJson(
    paginationVisitPlan({
      pageCount: rapidReviewPageCount,
      sampling: { headPages: [1, 2] },
    }),
  ) === stableJson([1, 2, 125]),
  "The shipped rapid-review visit plan must yield head pages [1, 2] plus the boundary page 125.",
);
// Shortlisted all-jobs actions: generation cap, remainder, enabled-but-
// unclicked Create action, no Apply-to-all action without ready resumes, and
// no removed disclosure or per-row batch controls.
const batchActionsSlice = topLevelFunctionSlice(
  scaleSource,
  "assertReviewQueueBatchActions",
);
const reviewQueueLimitMatch = scaleSource.match(
  /REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT = (\d+)/,
);
assert(
  reviewQueueLimitMatch !== null && Number(reviewQueueLimitMatch[1]) === 10,
  "Scale batch generation must keep the exact 10-draft preparation cap.",
);
for (const requiredToken of [
  "counts.shortlisted - REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT",
  "`Create ${REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT} missing resumes`",
  "`About a minute each, ${REVIEW_QUEUE_DRAFT_PREPARATION_LIMIT} at a time; ${draftRemainder} more after that.`",
  '[data-testid="shortlisted-all-jobs"]',
  '[data-testid="create-missing-resumes"]',
  '[data-testid="apply-all-ready"]',
  "batchActionsEvidence.panelMounted",
  "batchActionsEvidence.helpText === expectedHelpText",
  "batchActionsEvidence.createButtonLabel === expectedCreateLabel",
  "batchActionsEvidence.createButtonDisabled === false",
  "!batchActionsEvidence.applyButtonPresent",
  "!batchActionsEvidence.removedBatchDisclosurePresent",
  "batchActionsEvidence.removedBatchSelectionCount === 0",
  "...batchActionsEvidence,",
]) {
  assert(
    batchActionsSlice.includes(requiredToken),
    `Scale batch-actions scenario lost a required pin: ${requiredToken}`,
  );
}
assert(
  scaleBoundaryTotal - Number(reviewQueueLimitMatch[1]) === 991,
  "Shortlisted generation accounting must keep a 10-job cap leaving 991 resumes after the first run.",
);
const batchClickReceivers = [
  ...batchActionsSlice.matchAll(/([A-Za-z_$][\w$]*)\.click\(/g),
].map((match) => match[1]);
assert(
  batchClickReceivers.length === 0,
  `The Shortlisted all-jobs scenario must not trigger Create or Apply; unexpected click receivers: ${JSON.stringify(batchClickReceivers)}.`,
);
assert(
  !/\.dispatchEvent\(|\.check\(|\.setChecked\(|keyboard\.press\(/.test(
    batchActionsSlice,
  ),
  "The batch-actions scenario must never trigger the Prepare action through synthetic events or keyboard input.",
);
{
  // Canonical scale screenshot accounting derived from the shipped structure:
  // loop-driven captures come from the extracted visit-plan logic intersected
  // with each helper's screenshotOnPages config, while single-execution sites
  // are anchored by their unique capture names instead of raw call positions.
  const sampledWalkScreenshots = (pageCount, shotPages) =>
    paginationVisitPlan({ pageCount, sampling: { headPages: [1, 2] } }).filter(
      (page) => shotPages.includes(page),
    ).length;
  const exhaustiveWalkScreenshots = (pageCount, shotPages) =>
    paginationVisitPlan({ pageCount }).filter((page) =>
      shotPages.includes(page),
    ).length;
  const rapidReviewScreenshots = sampledWalkScreenshots(rapidReviewPageCount, [
    1,
    rapidReviewPageCount,
  ]);
  const batchActionsScreenshots = (
    batchActionsSlice.match(/captureScreenshot\(/g) ?? []
  ).length;
  assert(
    rapidReviewScreenshots === 2 && batchActionsScreenshots === 1,
    "The two new scale scenarios must add exactly three screenshots: rapid-review pages 1 and 125 plus the batch-actions disclosure.",
  );
  const scaleStaticCaptureNames = [
    "1440-profile-baseline",
    "sidebar-1440",
    "findJobs-p1-native125",
    "findJobs-p2-native125",
    "shortlisted-p1-native125",
    "applications-crm-p1-native125",
    "profile-sources-p1-native125",
    "final-native125-overview",
    "minimum-width-discovery-populated",
    "minimum-width-applications-populated",
    "final-1440-overview",
  ];
  for (const captureName of scaleStaticCaptureNames) {
    const occurrences = scaleSource.match(
      new RegExp(`captureScreenshot\\([^\\n]*"${captureName}"`, "g"),
    );
    assert(
      (occurrences?.length ?? 0) === 1,
      `Scale single-run capture site "${captureName}" drifted: found ${occurrences?.length ?? 0} call sites.`,
    );
  }
  for (const [label, pattern] of [
    [
      "shortlisted final-boundary",
      "captureScreenshot\\(\\s*page,\\s*`shortlisted-final-p\\$\\{shortlistedFinalPage\\}-1440`",
    ],
    [
      "applications CRM final-boundary",
      "captureScreenshot\\(\\s*page,\\s*`applications-crm-final-p\\$\\{applicationsFinalPage\\}-1440`",
    ],
    [
      "profile-sources final-boundary",
      "captureScreenshot\\(\\s*page,\\s*`profile-sources-final-p\\$\\{sourcesFinalPage\\}-1440`",
    ],
    [
      "applications lifecycle open-state",
      "captureScreenshot\\(\\s*page,\\s*`applications-lifecycle-\\$\\{selectedValue\\}-1440`",
    ],
    [
      "planning-settings menu per viewport",
      "captureScreenshot\\(page, `planning-settings-menu-\\$\\{viewportLabel\\}`",
    ],
  ]) {
    const occurrences = scaleSource.match(new RegExp(pattern, "g"));
    assert(
      (occurrences?.length ?? 0) === 1,
      `Scale ${label} capture site drifted: found ${occurrences?.length ?? 0} call sites.`,
    );
  }
  const shortlistedBoundaryScreenshots =
    exhaustiveWalkScreenshots(Math.ceil(scaleBoundaryTotal / 40), [1]) + 1;
  const applicationsBoundaryScreenshots =
    exhaustiveWalkScreenshots(Math.ceil(scaleBoundaryTotal / 40), [1]) + 1;
  const profileSourcesBoundaryScreenshots =
    exhaustiveWalkScreenshots(Math.ceil(scaleBoundaryTotal / 25), [1, 2]) + 1;
  const scaleExpectedScreenshotCount =
    scaleStaticCaptureNames.length +
    sampledWalkScreenshots(Math.ceil(scaleJobTotal / 50), [1, 2]) +
    shortlistedBoundaryScreenshots +
    applicationsBoundaryScreenshots +
    profileSourcesBoundaryScreenshots +
    rapidReviewScreenshots +
    batchActionsScreenshots +
    // applications lifecycle open-state view
    1 +
    // planning-settings menu captured once per viewport (native125, minimum-width)
    2;
  assert(
    scaleExpectedScreenshotCount === 26,
    `Scale screenshot accounting drifted: derived ${scaleExpectedScreenshotCount} runtime screenshots instead of the canonical 26.`,
  );
}

// --- Scale compact-navigation evidence tokens (parsed, never imported) -------
{
  const compactTokensBlockMatch = scaleSource.match(
    /const COMPACT_NAVIGATION_EVIDENCE_TOKENS = Object\.freeze\(\{[\s\S]*?\n\}\);/u,
  );
  assert(
    compactTokensBlockMatch !== null,
    "Scale capture lost the COMPACT_NAVIGATION_EVIDENCE_TOKENS block that this validator pins from source text instead of importing the harness.",
  );
  const compactTokensBlock = compactTokensBlockMatch[0];
  for (const requiredToken of [
    "selectors: Object.freeze({",
    "navigation: 'nav[aria-label=\"Job Finder sections\"]',",
    'panel: "[data-job-finder-compact-navigation]",',
    'scroller: "[data-job-finder-compact-navigation-scroll]",',
    'content: "[data-job-finder-compact-navigation-content]",',
    'fadeStart: "[data-job-finder-compact-navigation-fade-start]",',
    'fadeEnd: "[data-job-finder-compact-navigation-fade-end]",',
    "planningButton: 'button[aria-label^=\"More\"]',",
    "liveAssistantLink: 'a[aria-label=\"Open Live Assistant\"]',",
    '\'[role="group"][aria-label="Notifications and actions"]\',',
    'windowControlsGroup: \'[role="group"][aria-label="Window controls"]\',',
    'planningMenu: \'[role="navigation"][aria-label="More"]\',',
    'shortcutsMenuEntry: "[data-job-finder-more-menu-shortcuts-entry]",',
    'shortcutsDialog: "[data-job-finder-shortcuts-dialog]",',
    'shortcutsDialogRow: "[data-job-finder-shortcut-row]",',
    "viewportEpsilonPx: 2,",
    "containmentEpsilonPx: 2,",
    "edgeFadeEpsilonPx: 1,",
    "overlapTolerancePx: 1,",
    "minUsableRouteStripWidthPx: 320,",
    "minRouteChipHeightPx: 32,",
  ]) {
    assert(
      compactTokensBlock.includes(requiredToken),
      `COMPACT_NAVIGATION_EVIDENCE_TOKENS lost a required selector/limit pin: ${requiredToken}`,
    );
  }
  const compactNumericToken = (name) => {
    const match = compactTokensBlock.match(new RegExp(`${name}: ([\\d]+),`));
    assert(match !== null, `COMPACT_NAVIGATION_EVIDENCE_TOKENS lost ${name}.`);
    return Number(match[1]);
  };
  assert(
    compactNumericToken("viewportEpsilonPx") === 2 &&
      compactNumericToken("containmentEpsilonPx") === 2 &&
      compactNumericToken("edgeFadeEpsilonPx") === 1 &&
      compactNumericToken("overlapTolerancePx") === 1,
    "Compact-navigation evidence limits drifted from the accepted 2/2/1/1 contract.",
  );

  const jobFinderShellSource = await readFile(
    path.join(
      scriptDir,
      "..",
      "src",
      "renderer",
      "src",
      "features",
      "job-finder",
      "components",
      "job-finder-shell.tsx",
    ),
    "utf8",
  );
  assert(
    jobFinderShellSource.includes("data-job-finder-more-menu-shortcuts-entry"),
    "The shell source no longer renders the More menu's keyboard-shortcuts entry, so the scale harness cannot reach the shortcuts dialog.",
  );
  // The >=1440 sidebar lists every destination inline. A dropdown inside a
  // persistent navigation column only added a click and a second mental model,
  // so the sidebar must own no More trigger, must render the shortcuts entry
  // itself, and must own its own vertical scrolling instead of clipping rows.
  assert(
    !jobFinderShellSource.includes("data-job-finder-sidebar-more") &&
      jobFinderShellSource.includes(
        "data-job-finder-sidebar-shortcuts-entry",
      ) &&
      jobFinderShellSource.includes("data-job-finder-sidebar-scroll-region") &&
      jobFinderShellSource.includes("data-job-finder-sidebar-secondary"),
    "The expanded sidebar must list every secondary destination inline with its own scroll region and no More trigger.",
  );
  assert(
    scaleSource.includes("moreTriggerCount") &&
      scaleSource.includes("data-job-finder-sidebar-scroll-region") &&
      scaleSource.includes('"Keyboard shortcuts",'),
    "Scale acceptance must bind the inline wide-sidebar navigation contract (no More trigger, own scroll owner, shortcuts entry).",
  );
  const shellFadeStartMatch = jobFinderShellSource.match(
    /start: element\.scrollLeft > (\d+)/u,
  );
  const shellFadeEndMatch = jobFinderShellSource.match(
    /end: element\.scrollLeft < maxScrollLeft - (\d+)/u,
  );
  assert(
    shellFadeStartMatch !== null &&
      shellFadeEndMatch !== null &&
      shellFadeStartMatch[1] === shellFadeEndMatch[1] &&
      Number(shellFadeStartMatch[1]) ===
        compactNumericToken("edgeFadeEpsilonPx"),
    "Capture fade epsilon no longer mirrors the shell source's scroll-edge fade thresholds.",
  );

  // Breakpoint tripwire: the shell grid must switch to its wide layout at
  // exactly 1440/1439 CSS px so it stays aligned with the shell component's
  // min-[1440px] variants. The stale [1120,1440) regime left a broken band
  // where the grid reserved a sidebar column the sidebar did not occupy,
  // collapsing the compact route strip to ~8px at native 125% zoom.
  const globalsCssSource = await readFile(
    path.join(
      scriptDir,
      "..",
      "src",
      "renderer",
      "src",
      "styles",
      "globals.css",
    ),
    "utf8",
  );
  const wideShellGridQuery = globalsCssSource.match(
    /@media \(min-width: (\d+)px\)\s*\{\s*\.job-finder-shell-grid/u,
  );
  const compactShellGridQuery = globalsCssSource.match(
    /@media \(min-width: (\d+)px\) and \(max-width: (\d+)px\)\s*\{\s*\.job-finder-shell-grid/u,
  );
  assert(
    wideShellGridQuery !== null &&
      compactShellGridQuery !== null &&
      Number(wideShellGridQuery[1]) === 1440 &&
      Number(compactShellGridQuery[2]) === Number(wideShellGridQuery[1]) - 1 &&
      Number(compactShellGridQuery[1]) < Number(compactShellGridQuery[2]),
    "Shell-grid breakpoints must stay partitioned at exactly min-width 1440 / max-width 1439 CSS px so the grid never drifts from the shell's 1440px Tailwind variants.",
  );
  assert(
    !/@media[^{]*\b11(?:20|19)\b/u.test(globalsCssSource),
    "A stale 1120/1119px shell-grid media query resurfaced in globals.css; the only accepted desktop bound is 1440/1439.",
  );

  const compactRailSlice = topLevelFunctionSlice(
    scaleSource,
    "verifyCompactNavigationRail",
  );
  for (const requiredToken of [
    "(scroller.computedPaddingLeftPx ?? 0)",
    "(scroller.computedPaddingRightPx ?? 0)",
    "scroller.scrollWidth - (scroller.contentScrollWidth + paddingPx)",
    "Math.abs(contentSpanDeltaPx) <= tokens.containmentEpsilonPx",
    "scroller overflow dimensions disagree with the padded chip content",
    "contentSpanDeltaPx:",
    'classification === "partial"',
    "partial.length === 0",
    "partial.length <= 1",
    "straddlesLeftEdge || straddlesRightEdge",
    '!partial.some((chip) => chip.ariaCurrent === "page")',
    "state.activeChipCount === 1 && state.activeChip",
    "!forcedDiagnosticPhase ||",
    "const forcedDiagnosticPhase =",
    'phase === "scrolled-to-end" || phase === "scrolled-to-start"',
    '? "forced-diagnostic"',
    ': "app-reveal"',
    "scroller.scrollLeft > tokens.edgeFadeEpsilonPx",
    "scroller.scrollLeft < scroller.maxScrollLeft - tokens.edgeFadeEpsilonPx",
    "!scrolledToEnd.fades.end.visible",
    "!scrolledToStart.fades.start.visible",
    "both edge fades must hide when the scroller has no LTR overflow",
    "assertUsableGeometry(state, phase);",
    "tokens.minUsableRouteStripWidthPx",
    "compact route strip lost its usable width",
    "tokens.minRouteChipHeightPx",
    "compact route buttons lost full-button geometry",
    "original scroll position was not recovered",
  ]) {
    assert(
      compactRailSlice.includes(requiredToken),
      `Compact rail verification lost a required pin: ${requiredToken}`,
    );
  }

  const shortcutsSlice = topLevelFunctionSlice(
    scaleSource,
    "verifyPlanningShortcutsEvidence",
  );
  for (const requiredToken of [
    "menu.style.maxHeight",
    "collectShortcutsEntryEvidence(page, label)",
  ]) {
    assert(
      shortcutsSlice.includes(requiredToken),
      `Planning shortcuts verification lost a required pin: ${requiredToken}`,
    );
  }
  // The shortcut table left the More menu for a dedicated dialog, so the
  // evidence is now: exactly one entry, no keycaps left behind in the menu,
  // and a real modal dialog with keycapped rows inside the viewport.
  const shortcutsEntrySlice = topLevelFunctionSlice(
    scaleSource,
    "collectShortcutsEntryEvidence",
  );
  for (const requiredToken of [
    "selectors.shortcutsMenuEntry",
    "selectors.shortcutsDialog",
    "selectors.shortcutsDialogRow",
    "residualTable.kbdCount === 0",
    'dialogEvidence.role === "dialog" && dialogEvidence.ariaModal === "true"',
    "dialogEvidence.withinViewport",
    "escapeClosedDialog: true",
  ]) {
    assert(
      shortcutsEntrySlice.includes(requiredToken),
      `Shortcuts entry verification lost a required pin: ${requiredToken}`,
    );
  }
  const endPressAt = shortcutsEntrySlice.indexOf(
    'await page.keyboard.press("End");',
  );
  const endSettleAt = shortcutsEntrySlice.indexOf(
    "document.activeElement === document.querySelector(entrySelector)",
  );
  assert(
    endPressAt !== -1 &&
      endSettleAt > endPressAt &&
      shortcutsEntrySlice
        .slice(endPressAt, endSettleAt)
        .includes("waitForFunction(") &&
      shortcutsEntrySlice.slice(endPressAt).includes("timeout: 5_000"),
    "Shortcuts focus proof must deterministically wait for the More menu's shortcuts entry after pressing End.",
  );

  const activeRouteSlice = topLevelFunctionSlice(
    scaleSource,
    "verifyCompactActiveRoute",
  );
  for (const requiredToken of [
    'button[aria-current="page"]',
    'evidence.ariaCurrent === "page" && evidence.observedLabel === expectedLabel',
    "evidence.contained === true",
    "containmentEpsilonPx: tokens.containmentEpsilonPx",
  ]) {
    assert(
      activeRouteSlice.includes(requiredToken),
      `Compact active-route probe lost a required pin: ${requiredToken}`,
    );
  }
  const compactActiveRoutePairs = [
    ...scaleSource.matchAll(
      /verifyCompactActiveRoute\(page,\s*\{\s*label: "([^"]+)",\s*expectedLabel: "([^"]+)",\s*\}\);/gu,
    ),
  ].map((match) => ({ expectedLabel: match[2], label: match[1] }));
  assert(
    stableJson(compactActiveRoutePairs) ===
      stableJson([
        { expectedLabel: "Find jobs", label: "native125-find-jobs" },
        { expectedLabel: "Shortlisted", label: "native125-shortlisted" },
        { expectedLabel: "Applications", label: "native125-applications" },
        { expectedLabel: "Profile", label: "native125-profile-sources" },
      ]),
    "Compact active-route probes must bind exactly the four pinned label↔expected-route pairs in order.",
  );
  const expectedActiveRouteSet = scaleSource.match(
    /const expectedCompactActiveRouteLabels = \[([\s\S]*?)\];/u,
  );
  assert(
    expectedActiveRouteSet !== null &&
      stableJson(expectedActiveRouteSet[1].match(/"[^"]+"/gu)) ===
        stableJson([
          '"native125-applications"',
          '"native125-find-jobs"',
          '"native125-profile-sources"',
          '"native125-shortlisted"',
        ]),
    "The compact-rail final gate must expect exactly the four canonical active-route labels in sorted order.",
  );

  for (const requiredGateToken of [
    "compactNavigationChecks.length === 2 &&",
    "compactRailChecks.length === 2 &&",
    "planningShortcutsChecks.length === 2 &&",
    "const compactNavigationEvidencePassed =",
    "compactNavigationEvidencePassed,",
  ]) {
    assert(
      scaleSource.includes(requiredGateToken),
      `Scale final gate lost a compact-navigation pass requirement: ${requiredGateToken}`,
    );
  }

  assert(
    /verifyCompactNavigationRail\(page, "native125", \{\s*width: 1152,\s*height: 736,\s*\}\);/u.test(
      scaleSource,
    ) &&
      /verifyCompactNavigationRail\(page, "minimum-width", \{\s*width: 1024,\s*height: 768,\s*\}\);/u.test(
        scaleSource,
      ),
    "Compact rail verification must run at exactly CSS 1152x736 (native125) and 1024x768 (minimum-width).",
  );
  assert(
    /verifyPlanningShortcutsEvidence\(page, \{\s*label: "native125",\s*expectedCssViewport: \{ width: 1152, height: 736 \},\s*\}\);/u.test(
      scaleSource,
    ) &&
      /verifyPlanningShortcutsEvidence\(page, \{\s*label: "minimum-width",\s*expectedCssViewport: \{ width: 1024, height: 768 \},\s*\}\);/u.test(
        scaleSource,
      ),
    "Planning shortcuts evidence must run at exactly CSS 1152x736 (native125 keeps the desktop-like layout) and CSS 1024x768 (minimum-width).",
  );
}
const findScreenshotStateCollisions = extractTopLevelFunction(
  scaleSource,
  "findScreenshotStateCollisions",
);
const digestEntryStart = scaleSource.indexOf("const digestEntry = {");
const digestEntryEnd = scaleSource.indexOf("  };", digestEntryStart);
assert(
  digestEntryStart >= 0 &&
    digestEntryEnd > digestEntryStart &&
    scaleSource
      .slice(digestEntryStart, digestEntryEnd)
      .includes(
        "screenshotStateId: meta.screenshotStateId ?? meta.scenarioId ?? name,",
      ),
  "Scale capture must carry each capture's semantic screenshot state into collision detection; scenario-only metadata cannot bind shared-shell evidence to its host state.",
);
{
  const collisions = findScreenshotStateCollisions([
    {
      scenarioId: "applications-crm-final-p26",
      screenshotStateId: "state-a",
      fileName: "07-a.png",
      digest: "sha-x",
    },
    {
      scenarioId: "applications-lifecycle-open",
      screenshotStateId: "state-b",
      fileName: "08-b.png",
      digest: "sha-x",
    },
    { scenarioId: "distinct", fileName: "09-c.png", digest: "sha-y" },
  ]);
  assert(
    collisions.length === 1 &&
      collisions[0].digest === "sha-x" &&
      collisions[0].occurrences.length === 2 &&
      collisions[0].occurrences.some((o) => o.fileName === "07-a.png") &&
      collisions[0].occurrences.some((o) => o.fileName === "08-b.png") &&
      stableJson(collisions[0].distinctScenarioIds) ===
        stableJson([
          "applications-crm-final-p26",
          "applications-lifecycle-open",
        ]) &&
      stableJson(collisions[0].distinctScreenshotStateIds) ===
        stableJson(["state-a", "state-b"]),
    "Scale capture must reject byte-identical screenshots claiming distinct scenario states and report both IDs/files.",
  );
  assert(
    findScreenshotStateCollisions([
      { scenarioId: "a", fileName: "01.png", digest: "sha-a" },
      { scenarioId: "b", fileName: "02.png", digest: "sha-b" },
    ]).length === 0,
    "Scale capture must not reject genuinely distinct screenshots.",
  );
  assert(
    findScreenshotStateCollisions([
      {
        scenarioId: "1440-profile-baseline",
        screenshotStateId: "1440-profile-baseline",
        fileName: "01-profile.png",
        digest: "shared-profile",
      },
      {
        scenarioId: "scale-sidebar-1440",
        screenshotStateId: "1440-profile-baseline",
        fileName: "15-sidebar.png",
        digest: "shared-profile",
      },
    ]).length === 0,
    "Scale capture must allow a shared-shell assertion to reuse its host screenshot state while retaining a distinct completion scenario.",
  );
}
const findCrossComponentScreenshotCollisions = extractTopLevelFunction(
  wrapper,
  "findCrossComponentScreenshotCollisions",
);
{
  const scan = findCrossComponentScreenshotCollisions({
    fresh: [
      {
        scenarioId: "fresh-x",
        fileName: "f.png",
        screenshot: { sha256: "dup" },
      },
    ],
    scale: [
      {
        scenarioId: "scale-y",
        fileName: "s.png",
        screenshot: { sha256: "dup" },
      },
      {
        scenarioId: "scale-z",
        fileName: "t.png",
        screenshot: { sha256: "uniq" },
      },
    ],
  });
  assert(
    scan.collisions.length === 1 &&
      scan.collisions[0].digest === "dup" &&
      scan.collisions[0].occurrences.length === 2 &&
      scan.collisions[0].occurrences.some((o) => o.component === "fresh") &&
      scan.collisions[0].occurrences.some((o) => o.component === "scale"),
    "Acceptance wrapper must detect byte-identical screenshots across components and report both IDs/files.",
  );
  assert(
    findCrossComponentScreenshotCollisions({
      scale: [
        {
          scenarioId: "a",
          fileName: "a.png",
          screenshot: { sha256: "one" },
        },
      ],
    }).collisions.length === 0,
    "Acceptance wrapper collision scan must pass genuinely distinct evidence.",
  );
  assert(
    findCrossComponentScreenshotCollisions({
      scale: [
        {
          scenarioId: "1440-profile-baseline",
          fileName: "01-profile.png",
          screenshot: { sha256: "shared-profile" },
        },
        {
          scenarioId: "scale-sidebar-1440",
          screenshotStateId: "1440-profile-baseline",
          fileName: "15-sidebar.png",
          screenshot: { sha256: "shared-profile" },
        },
      ],
    }).collisions.length === 0,
    "Acceptance wrapper collision scan must allow shared-shell evidence bound to one screenshot state.",
  );
}
const freshSource = await readFile(
  path.join(scriptDir, "capture-fresh-flows.mjs"),
  "utf8",
);
assert(
  freshSource.includes("PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN"),
  "Fresh acceptance finalize does not bind the shared Playwright inspector disconnect pattern.",
);
assert(
  freshSource.includes("resolvePrimaryRunError("),
  "Fresh acceptance teardown can still discard the primary scenario error behind a finalize failure.",
);
assert(
  !freshSource.includes("name: /Today/"),
  "Fresh acceptance still waits on a removed dashboard heading instead of the h1 Home heading.",
);
assert(
  freshSource.includes('getByRole("heading", { level: 1, name: "Home" })'),
  "Fresh acceptance home waits do not target the product-rendered h1 Home heading.",
);
assert(
  freshSource.includes(
    `clickablePointScopeSelector: '[role="navigation"][aria-label="More"]'`,
  ),
  "Open More-menu acceptance must scope clickable-point evidence to the foreground navigation instead of covered background controls.",
);
assert(
  freshSource.includes("moreTriggerCount") &&
    freshSource.includes("data-job-finder-sidebar-scroll-region") &&
    freshSource.includes('"Keyboard shortcuts",'),
  "Fresh acceptance must bind the inline wide-sidebar navigation contract (no More trigger, own scroll owner, shortcuts entry).",
);
assert(
  freshSource.includes("collectWordmarkEvidence") &&
    freshSource.includes('"[data-desktop-brand-wordmark]"') &&
    freshSource.includes('text !== "NESTOR"') &&
    freshSource.includes("expectWordmark: true") &&
    freshSource.includes(
      "wordmarkEvidence: await collectWordmarkEvidence(page)",
    ),
  "Fresh minimum-width acceptance must prove the actual NESTOR wordmark remains visible and contained when navigation collapses.",
);
assert(
  freshSource.includes("collectWorkspaceStateGeometry") &&
    freshSource.includes('"[data-workspace-state-screen]"') &&
    freshSource.includes('"[data-workspace-state-title]"') &&
    freshSource.includes('"[data-workspace-state-message]"') &&
    freshSource.includes('scenarioId: "opening-workspace-desktop"') &&
    freshSource.includes("expectWorkspaceStateGeometry: true") &&
    freshSource.includes('NESTOR_TEST_WORKSPACE_OPENING_HOLD_MS: "750"'),
  "Fresh acceptance must capture and geometry-gate the centered opening workspace state.",
);
assert(
  freshSource.includes("collectOpeningHeaderEvidence") &&
    freshSource.includes('"[data-job-finder-opening-shell]"') &&
    freshSource.includes('"[data-desktop-brand-wordmark]"') &&
    freshSource.includes("isMac && macControlClearancePx < 88") &&
    freshSource.includes("navigationCenterDelta > 2") &&
    freshSource.includes("expectOpeningHeader: true") &&
    freshSource.includes("openingHeaderEvidence"),
  "Fresh acceptance must prove the opening shell uses the production wordmark, clears macOS controls, and keeps module navigation centered.",
);
assert(
  freshSource.includes("collectProfileFirstViewportEvidence") &&
    freshSource.includes('"[data-profile-resume-summary]"') &&
    freshSource.includes("profile-section-panel[aria-labelledby") &&
    freshSource.includes("firstViewport: true") &&
    freshSource.includes("resumePopulated") &&
    freshSource.includes("activeHeadingAboveFold") &&
    freshSource.includes("expectProfileFirstViewport") &&
    freshSource.includes("profileFirstViewportEvidence") &&
    freshSource.includes(
      'scenarioId: "profile-basics-populated-first-viewport"',
    ) &&
    freshSource.includes(
      'scenarioId: "profile-experience-populated-first-viewport"',
    ),
  "Fresh acceptance must capture populated Profile Basics plus a populated non-Basics tab with deterministic first-viewport resume/content evidence.",
);
assert(
  freshSource.includes("collectGuidedSetupPrimaryActionEvidence") &&
    freshSource.includes('"Choose my resume file…"') &&
    freshSource.includes('"Enter details manually"') &&
    freshSource.includes("clippingValues.has(style.overflowY)") &&
    freshSource.includes("fullyInsideViewport") &&
    freshSource.includes("fullyUnclipped") &&
    freshSource.includes("hitTestInsideTarget") &&
    freshSource.includes("elementFromPoint") &&
    freshSource.includes(
      "Guided setup primary-action visibility evidence failed",
    ),
  "Fresh acceptance must prove both pristine Guided setup primary actions are rendered, unobscured, and fully inside the native-125 viewport rather than merely reachable in a nested scroller.",
);
const guidedSetupNative125CaptureStart = freshSource.indexOf(
  'await capture(page, "guided-setup-empty-native125", {',
);
const guidedSetupNative125CaptureEnd = freshSource.indexOf(
  "    });",
  guidedSetupNative125CaptureStart,
);
assert(
  guidedSetupNative125CaptureStart >= 0 &&
    guidedSetupNative125CaptureEnd > guidedSetupNative125CaptureStart &&
    freshSource
      .slice(guidedSetupNative125CaptureStart, guidedSetupNative125CaptureEnd)
      .includes("expectGuidedSetupPrimaryActions: true"),
  "The pristine Guided setup native-125 capture must opt into the primary-action viewport gate.",
);
assert(
  freshSource.includes("async function clickNavigationControl(page, name)") &&
    freshSource.includes("async function ensureLocatorText(page, text)"),
  "Fresh acceptance profile captures must define their local navigation and text-wait helpers.",
);
const freshCaptureResetAt = freshSource.indexOf("await resetScroll(page);");
const freshProfileEvidenceAt = freshSource.indexOf(
  "await collectProfileFirstViewportEvidence(\n        page,\n        profileFirstViewportOptions,",
);
const freshCaptureScreenshotAt = freshSource.indexOf(
  'await page.screenshot({ animations: "disabled", path: fullPath });',
);
assert(
  freshCaptureResetAt >= 0 &&
    freshProfileEvidenceAt > freshCaptureResetAt &&
    freshCaptureScreenshotAt > freshProfileEvidenceAt,
  "Fresh profile first-viewport evidence must be collected after capture scroll reset and before its screenshot.",
);
assert(
  !freshSource.includes(
    "profileFirstViewportEvidence: await collectProfileFirstViewportEvidence(",
  ),
  "Fresh profile first-viewport evidence must not be collected before capture performs its scroll reset.",
);
assert(
  freshSource.includes('"collapsed-shell-wordmark-minimum"') &&
    freshSource.includes(
      'completeScenario("collapsed-shell-wordmark-minimum", freshHomeMinimum)',
    ) &&
    freshSource.includes("expectWordmark: true") &&
    freshSource.includes(
      "wordmarkEvidence: await collectWordmarkEvidence(page)",
    ),
  "Fresh acceptance must name and complete a dedicated collapsed-shell wordmark assertion.",
);
assert(
  !freshSource.includes('customInstructions: ""'),
  "Fresh acceptance synthetic target template writes an empty customInstructions string, violating the NonEmptyString|null contract.",
);
assert(
  !freshSource.includes("campaign_synth_1"),
  "Fresh acceptance still fabricates an out-of-schema synthetic campaign fallback.",
);
assert(
  freshSource.includes(
    "Discovery scenario found no existing campaign in the apply-queue demo snapshot",
  ),
  "Fresh acceptance discovery scenario no longer fails fast when the demo snapshot has no campaign.",
);
assert(
  !freshSource.includes("linkedin.com"),
  "Fresh acceptance still uses a real-looking LinkedIn URL for synthetic data.",
);
assert(
  !freshSource.includes('filter((c) => !c.label.includes("Settings"))'),
  "Fresh acceptance still excludes Settings from the Planning menu.",
);
assert(
  !freshSource.includes("more-menu-zoom200-fallback"),
  "Fresh acceptance still has a fallback More-menu capture.",
);
assert(
  freshSource.includes("page.mouse.wheel"),
  "Fresh acceptance does not exercise real wheel scrolling.",
);
assert(
  freshSource.includes('page.keyboard.press("PageDown")'),
  "Fresh acceptance does not exercise keyboard scrolling.",
);
const longLabelScenarioIds = [
  "long-label-desktop",
  "long-label-minimum",
  "long-label-native125",
  "long-label-sources-native125",
];
const requiredScenarioMatch = freshSource.match(
  /requiredScenarioCompletionIds:\s*\[([\s\S]*?)\]/,
);
assert(
  requiredScenarioMatch !== null,
  "Fresh acceptance does not declare an explicit requiredScenarioCompletionIds manifest.",
);
for (const scenarioId of longLabelScenarioIds) {
  assert(
    requiredScenarioMatch[1].includes(`"${scenarioId}"`),
    `Fresh acceptance requiredScenarioCompletionIds is missing long-label scenario ${scenarioId}.`,
  );
  assert(
    freshSource.includes(`scenarioId: "${scenarioId}"`),
    `Fresh acceptance never completes the registered long-label scenario ${scenarioId}.`,
  );
}
assert(
  freshSource.includes("expectLongLabelScenario") &&
    freshSource.includes("collectLongLabelEvidence") &&
    freshSource.includes("collectSourceLabelEvidence"),
  "Fresh acceptance long-label scenarios do not bind explicit semantic evidence to their captures.",
);
assert(
  freshSource.includes("reachableWithinScrollers") &&
    freshSource.includes('"text-content"') &&
    freshSource.includes("truncatedPx"),
  "Fresh acceptance long-label evidence does not prove reachable controls and truthful full labels alongside intended truncation.",
);
assert(
  freshSource.includes(
    "Intended ellipsis truncation did not engage for any long source label",
  ),
  "Fresh acceptance does not require ellipsis truncation to actually engage for long source labels.",
);
assert(
  freshSource.includes("LONG_LABEL_JOB_TITLES") &&
    freshSource.includes("LONG_LABEL_SOURCE_NAMES") &&
    freshSource.includes("buildSyntheticJobs(") &&
    freshSource.includes("buildSyntheticTargets(") &&
    freshSource.includes("resetWorkspaceState("),
  "Fresh acceptance long-label scenarios must use isolated synthetic data through the harness reset path.",
);
const longLabelCaptureLoopStart = freshSource.indexOf(
  "for (const target of longLabelViewports) {",
);
const longLabelCaptureLoopEnd = freshSource.indexOf(
  "report.scenarios.longLabelsFindJobs",
  longLabelCaptureLoopStart,
);
const longLabelCaptureLoop =
  longLabelCaptureLoopStart >= 0 &&
  longLabelCaptureLoopEnd > longLabelCaptureLoopStart
    ? freshSource.slice(longLabelCaptureLoopStart, longLabelCaptureLoopEnd)
    : "";
const longLabelContentTargetBlock = longLabelCaptureLoop.match(
  /contentTarget:\s*\{[\s\S]*?block:\s*"([^"]+)"/,
);
assert(
  longLabelContentTargetBlock?.[1] === "nearest",
  "Fresh acceptance long-label capture must use nearest alignment after clicking the already-visible first result; center alignment can scroll the outer route under the fixed app header.",
);
assert(
  /slug:\s*"native-125",\s*width:\s*1440,\s*height:\s*920,\s*zoomFactor:\s*1\.25/.test(
    freshSource,
  ),
  "Fresh acceptance lost its native Electron 125% zoom viewport definition.",
);
// Fresh profile-sources pagination must settle semantically before screenshots.
// A bare range-text wait or filename match is not acceptable proof of page 2.
for (const token of [
  "waitForSemanticSourcesPagination",
  "sameIdentityList",
  "observedRangeText",
  "expectedRowIds",
  "observedRowIds",
  "observedRowLabels",
  "geometryStableAcrossAnimationFrames",
]) {
  assert(
    freshSource.includes(token),
    `Fresh acceptance semantic pagination settlement is missing ${token}.`,
  );
}
assert(
  (freshSource.match(/requestAnimationFrame/g) ?? []).length >= 2 &&
    freshSource.includes("scrollHeight"),
  "Fresh acceptance must gate paginated screenshots on scrollHeight/geometry stability across at least two animation frames.",
);
const freshP1SettlementIndex = freshSource.indexOf(
  "profileP1Settlement = await waitForSemanticSourcesPagination",
);
const freshP1CaptureIndex = freshSource.indexOf(
  '"profile-sources-25rows-p1-desktop"',
);
const freshNextClickIndex = freshSource.indexOf("await nextBtn.click()");
const freshP2SettlementIndex = freshSource.indexOf(
  "profileP2Settlement = await waitForSemanticSourcesPagination",
);
const freshP2CaptureIndex = freshSource.indexOf(
  '"profile-sources-25rows-p2-desktop"',
);
assert(
  freshP1SettlementIndex !== -1 &&
    freshP1CaptureIndex !== -1 &&
    freshP1SettlementIndex < freshP1CaptureIndex,
  "Fresh acceptance must settle profile-sources page 1 semantically (page/range text plus visible row identities) before capturing it.",
);
assert(
  freshNextClickIndex !== -1 &&
    freshP2SettlementIndex > freshNextClickIndex &&
    freshP2CaptureIndex !== -1 &&
    freshP2CaptureIndex > freshP2SettlementIndex,
  "Fresh acceptance must settle observed page/range text and visible row identities between clicking Next and taking the page-2 screenshot.",
);
assert(
  !freshSource.includes("[–-]32"),
  "Fresh acceptance regressed to a bare page-range text wait without row-identity settlement.",
);
assert(
  (freshSource.match(/expectSemanticPaginationEvidence: true/g) ?? [])
    .length === 2 &&
    freshSource.includes("semanticPaginationEvidence: profileP1Settlement") &&
    freshSource.includes("semanticPaginationEvidence: profileP2Settlement") &&
    freshSource.includes("metadata.semanticPaginationEvidence?.pass === true"),
  "Fresh paginated captures must bind observed page/range and row-identity evidence to their pass/fail gating instead of an expected count alone.",
);
// Per-component screenshot collision guard over PNG sha256 digests.
assert(
  freshSource.includes("registerScreenshotCollisionGuard(entry);") &&
    freshSource.includes("entry.screenshot?.sha256"),
  "Fresh acceptance lacks a per-component screenshot collision guard over real PNG sha256 digests.",
);
for (const collisionToken of [
  "identical PNG sha256",
  "owner.scenarioId",
  "owner.fileName",
  "entry.scenarioId",
  "entry.fileName",
]) {
  assert(
    freshSource.includes(collisionToken),
    `Fresh acceptance screenshot collision guard failure must report both colliding scenario IDs and files (${collisionToken} missing).`,
  );
}
assert(
  freshSource.includes(
    "DECLARED_DUPLICATE_SCREENSHOT_SCENARIO_PAIRS = Object.freeze([])",
  ),
  "Deliberate duplicate fresh screenshots must be narrowly declared through an explicitly frozen, empty-by-default pair list.",
);
// Expected fresh capture/scenario accounting: 17 literal capture scenario IDs
// (one capture per required scenario except the three shared shell-navigation
// completions) plus the templated long-label loop site executed once per
// long-label viewport (3) equals 20 runtime captures, which complete 23
// required scenario IDs together with wide-sidebar-1440,
// compact-planning-settings-minimum, and collapsed-shell-wordmark-minimum.
const freshScenarioIdLiterals = [
  ...freshSource.matchAll(/scenarioId:\s*"([^"]+)"/g),
].map((match) => match[1]);
const longLabelViewportLoopScenarioIds = [
  "long-label-desktop",
  "long-label-minimum",
  "long-label-native125",
];
const freshCaptureScenarioIds = freshScenarioIdLiterals.filter(
  (scenarioId) => !longLabelViewportLoopScenarioIds.includes(scenarioId),
);
const freshTemplatedCaptureSites = (
  freshSource.match(/capture\(page,\s*`[^`]*`\s*,/g) ?? []
).length;
assert(
  freshTemplatedCaptureSites === 1,
  `Fresh acceptance must keep exactly one templated long-label capture site; found ${freshTemplatedCaptureSites}.`,
);
const FRESH_EXPECTED_CAPTURE_COUNT =
  freshCaptureScenarioIds.length + longLabelViewportLoopScenarioIds.length;
assert(
  FRESH_EXPECTED_CAPTURE_COUNT === 20,
  `Fresh acceptance capture accounting changed: derived ${FRESH_EXPECTED_CAPTURE_COUNT} runtime captures instead of the required 20.`,
);
assert(
  new Set(freshCaptureScenarioIds).size === freshCaptureScenarioIds.length,
  "Fresh acceptance reuses a capture scenario ID across multiple capture sites.",
);
const freshRequiredScenarioIds = (
  requiredScenarioMatch[1].match(/"[^"]+"/g) ?? []
).map((value) => value.slice(1, -1));
assert(
  freshRequiredScenarioIds.length === 23 &&
    new Set(freshRequiredScenarioIds).size === 23,
  `Fresh acceptance must declare exactly 23 unique required scenario completion IDs; found ${freshRequiredScenarioIds.length}.`,
);
for (const scenarioId of freshCaptureScenarioIds) {
  assert(
    freshRequiredScenarioIds.includes(scenarioId),
    `Fresh capture scenario ${scenarioId} is not registered in requiredScenarioCompletionIds.`,
  );
}
for (const sharedScenarioId of [
  "wide-sidebar-1440",
  "compact-planning-settings-minimum",
  "collapsed-shell-wordmark-minimum",
]) {
  assert(
    freshRequiredScenarioIds.includes(sharedScenarioId) &&
      !freshCaptureScenarioIds.includes(sharedScenarioId),
    `Fresh shared navigation scenario ${sharedScenarioId} must complete through its host capture.`,
  );
}
assert(
  FRESH_EXPECTED_CAPTURE_COUNT + 3 === freshRequiredScenarioIds.length,
  "Fresh acceptance required-scenario accounting must equal its capture count plus the three shared navigation completions.",
);
assert(
  safetySource.includes("Notifications and actions"),
  "Safety probe does not cover notifications/actions.",
);
assert(
  /document\.addEventListener\(\s*["']keydown["']/.test(safetySource),
  "Safety probe does not observe keyboard risk events.",
);
for (const requiredSafetyToken of [
  "preventDefault",
  "stopImmediatePropagation",
  "window.open",
  "requestSubmit",
  '"submit"',
]) {
  assert(
    safetySource.includes(requiredSafetyToken),
    `Safety probe does not intercept ${requiredSafetyToken}.`,
  );
}
for (const requiredErrorToken of [
  "REQUIRED_SCENARIO_COMPLETION_IDS",
  "requiredScenarioCompletionIds",
  "scenarioCompletionIds",
  "scenarioId",
  "insideViewport",
  "noClip",
  "failures",
  "pass",
  "completeScenario",
]) {
  assert(
    errorRecovery.includes(requiredErrorToken),
    `Error/recovery capture is missing ${requiredErrorToken}.`,
  );
}
assert(
  errorRecovery.includes("PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN") &&
    errorRecovery.includes("expected-preview-render-failure") &&
    errorRecovery.includes("resolvePrimaryRunError("),
  "Error/recovery finalize must accept exactly the shared inspector notice plus the scripted preview failure without discarding the primary scenario error.",
);
// --- Recovered live-preview content evidence ---------------------------------
{
  assert(
    errorRecovery.includes(
      `const LIVE_PREVIEW_IFRAME_SELECTOR = 'iframe[title="Live resume preview"]';`,
    ),
    "Error/recovery capture does not pin the exact live-resume-preview iframe target.",
  );
  assert(
    errorRecovery.includes(".scrollIntoViewIfNeeded()"),
    "Error/recovery capture must scroll the recovered live preview into view before screenshotting.",
  );
  const minimumVisibleMatch = errorRecovery.match(
    /\bMINIMUM_VISIBLE_PREVIEW_CSS_PX = (\d+)\b/,
  );
  assert(
    minimumVisibleMatch !== null,
    "Error/recovery capture must declare an explicit minimum visible recovered-preview CSS pixel budget.",
  );
  const minimumVisibleCssPx = Number(minimumVisibleMatch[1]);
  assert(
    Number.isInteger(minimumVisibleCssPx) && minimumVisibleCssPx > 0,
    "Error/recovery minimum visible recovered-preview budget must be a positive integer.",
  );
  const sampleTimeoutMatch = errorRecovery.match(
    /\bPREVIEW_SAMPLE_TIMEOUT_MS = (\d[\d_]*)\b/,
  );
  const sampleTimeoutMs =
    sampleTimeoutMatch === null
      ? 0
      : Number(sampleTimeoutMatch[1].replaceAll("_", ""));
  assert(
    sampleTimeoutMs > 0 &&
      errorRecovery.includes("Promise.race([") &&
      errorRecovery.includes("clearTimeout(sampleTimer)"),
    "The two-animation-frame preview sample must be bounded by an explicit timeout that clears its timer.",
  );
  assert(
    errorRecovery.includes('Number.parseFloat(style.opacity || "1") !== 0'),
    "A fully transparent (opacity 0) recovered preview must be rejected as not rendered/visible.",
  );
  const previewEvidenceCollectionAt = errorRecovery.indexOf(
    "await collectPreviewContentEvidence(page)",
  );
  const recoveryScreenshotAt = errorRecovery.indexOf(
    'await page.screenshot({ path: fullPath, animations: "disabled" })',
  );
  assert(
    previewEvidenceCollectionAt >= 0 &&
      recoveryScreenshotAt > previewEvidenceCollectionAt,
    "Error/recovery capture must collect structured preview content evidence before taking each screenshot.",
  );
  for (const evidenceToken of [
    "selector: LIVE_PREVIEW_IFRAME_SELECTOR",
    "scrolledIntoView: true",
    "visibleHeight",
    "renderedContentHeight",
    "horizontallyContained",
    "previewContentEvidence,",
    "recovered live preview content evidence failed:",
    "bounded recovered-preview sample failed:",
    "teardownSecondaryFailures",
    "secondaryTeardownFailures.length > 0",
  ]) {
    assert(
      errorRecovery.includes(evidenceToken),
      `Error/recovery capture entries must record and gate on structured recovered-preview evidence (${evidenceToken} missing).`,
    );
  }
  // Behavioral verdict fixtures over the shipped pure helper on the canonical
  // CSS 720x460 viewport: a fully visible same-origin frame passes; below-fold,
  // sub-budget, horizontally clipped, unstable, empty-content, hidden
  // (including opacity 0), no-box, and missing frames all reject.
  const evaluateRecoveredPreviewEvidence = extractTopLevelFunction(
    errorRecovery,
    "evaluatePreviewContentEvidence",
  );
  const passingFacts = {
    found: true,
    layoutStableAcrossAnimationFrames: true,
    displayVisible: true,
    boxRendered: true,
    rect: { left: 24, top: 32, right: 600, bottom: 400 },
    viewport: { width: 720, height: 460 },
    renderedContentHeight: 352,
    contentElementCount: 3,
  };
  const passingVerdict = evaluateRecoveredPreviewEvidence(
    passingFacts,
    minimumVisibleCssPx,
  );
  assert(
    passingVerdict.pass === true &&
      passingVerdict.visibleHeight === 368 &&
      passingVerdict.horizontallyContained === true &&
      passingVerdict.renderedContentHeight === 352,
    "A fully visible same-origin recovered preview with rendered content must pass preview content evidence at CSS 720x460.",
  );
  const verdictFailuresFor = (facts) =>
    evaluateRecoveredPreviewEvidence(facts, minimumVisibleCssPx);
  const rejectedCases = [
    {
      name: "below-fold",
      facts: {
        ...passingFacts,
        rect: { left: 24, top: 520, right: 600, bottom: 1200 },
      },
      expect: (verdict) =>
        verdict.pass === false && verdict.visibleHeight === 0,
      message:
        "A recovered preview left entirely below the fold at CSS 720x460 must fail preview content evidence.",
    },
    {
      name: "below-budget",
      facts: {
        ...passingFacts,
        rect: { left: 24, top: 380, right: 600, bottom: 1104 },
      },
      expect: (verdict) =>
        verdict.pass === false &&
        verdict.visibleHeight === 80 &&
        verdict.visibleHeight < minimumVisibleCssPx,
      message:
        "An 80px sliver of recovered preview at CSS 720x460 must fail the 96px visible budget.",
    },
    {
      name: "horizontal-clip",
      facts: {
        ...passingFacts,
        rect: { left: -40, top: 32, right: 800, bottom: 400 },
      },
      expect: (verdict) =>
        verdict.pass === false && verdict.horizontallyContained === false,
      message:
        "A horizontally clipped recovered preview must fail preview content evidence.",
    },
    {
      name: "unstable-layout",
      facts: { ...passingFacts, layoutStableAcrossAnimationFrames: false },
      expect: (verdict) =>
        verdict.pass === false &&
        verdict.layoutStableAcrossAnimationFrames === false,
      message:
        "Unsettled preview geometry across animation frames must fail preview content evidence.",
    },
    {
      name: "empty-content",
      facts: {
        ...passingFacts,
        renderedContentHeight: null,
        contentElementCount: 0,
      },
      expect: (verdict) =>
        verdict.pass === false && verdict.renderedContentHeight === null,
      message:
        "A same-origin preview document without rendered content must fail preview content evidence.",
    },
    {
      name: "opacity-zero",
      facts: { ...passingFacts, displayVisible: false },
      expect: (verdict) => verdict.pass === false,
      message:
        "A fully transparent (opacity 0) recovered preview must fail preview content evidence.",
    },
    {
      name: "no-box",
      facts: { ...passingFacts, boxRendered: false },
      expect: (verdict) => verdict.pass === false,
      message:
        "A recovered preview without a rendered box must fail preview content evidence.",
    },
    {
      name: "missing-frame",
      facts: { found: false },
      expect: (verdict) => verdict.pass === false && verdict.found === false,
      message:
        "A missing recovered preview iframe must fail preview content evidence.",
    },
  ];
  for (const rejectedCase of rejectedCases) {
    const verdict = verdictFailuresFor(rejectedCase.facts);
    assert(
      verdict.pass === false &&
        verdict.failures.length > 0 &&
        rejectedCase.expect(verdict),
      rejectedCase.message,
    );
  }
  // The two-rAF sample wait itself is bounded: a never-settling page rejects
  // within its explicit budget instead of hanging acceptance, and a settled
  // sample passes through unchanged.
  const withinPreviewSampleBudget = extractTopLevelFunction(
    errorRecovery,
    "withinPreviewSampleBudget",
  );
  await mustReject(
    () => withinPreviewSampleBudget(new Promise(() => {}), 20),
    /did not settle within 20ms/,
    "A throttled or occluded page must reject the bounded preview sample instead of hanging acceptance.",
  );
  assert(
    (await withinPreviewSampleBudget(Promise.resolve("settled"), 500)) ===
      "settled",
    "A settled preview sample must pass through the bounded-sample race unchanged.",
  );
}

// --- Error/recovery exact-scenario wrapper enforcement -----------------------
{
  assert(
    stableJson(REQUIRED_ERROR_RECOVERY_SCENARIOS) ===
      stableJson([
        {
          scenario: "recovery",
          scenarioId: "error-preview-recovered-native125",
        },
        { scenario: "recovery", scenarioId: "error-preview-recovered-minimum" },
      ]),
    "Wrapper recovery enforcement must bind exactly the native125 and minimum recovered scenario IDs.",
  );
  const healthyEntries = [
    {
      label: "01-preview-error-1440.png",
      scenario: "error",
      scenarioId: "error-preview-1440",
      previewContentEvidence: null,
    },
    {
      label: "02-preview-recovered-native125.png",
      scenario: "recovery",
      scenarioId: "error-preview-recovered-native125",
      previewContentEvidence: { pass: true, failures: [] },
    },
    {
      label: "03-preview-recovered-minimum-width.png",
      scenario: "recovery",
      scenarioId: "error-preview-recovered-minimum",
      previewContentEvidence: { pass: true, failures: [] },
    },
  ];
  assert(
    evaluateErrorRecoveryCaptureEntries(healthyEntries).pass === true,
    "The healthy error/recovery entry set (exempt error entry plus two evidenced recoveries) must pass the exact-scenario contract.",
  );
  for (const brokenCase of [
    {
      name: "missing-native125",
      entries: healthyEntries.filter(
        (entry) => entry.scenarioId !== "error-preview-recovered-native125",
      ),
      pattern:
        /missing required recovery entry error-preview-recovered-native125/,
    },
    {
      name: "duplicate-minimum",
      entries: [
        ...healthyEntries,
        {
          scenario: "recovery",
          scenarioId: "error-preview-recovered-minimum",
          previewContentEvidence: { pass: true, failures: [] },
        },
      ],
      pattern: /duplicate recovery entries for error-preview-recovered-minimum/,
    },
    {
      name: "mislabeled-label-only-binding",
      entries: healthyEntries.map((entry) =>
        entry.scenarioId === "error-preview-recovered-minimum"
          ? { ...entry, scenario: "error" }
          : entry,
      ),
      pattern: /mislabeled scenario "error"/,
    },
    {
      name: "failing-evidence",
      entries: healthyEntries.map((entry) =>
        entry.scenarioId === "error-preview-recovered-native125"
          ? { ...entry, previewContentEvidence: { pass: false } }
          : entry,
      ),
      pattern: /lacks passing previewContentEvidence/,
    },
    {
      name: "stray-recovery-label",
      entries: [
        ...healthyEntries,
        {
          scenario: "recovery",
          scenarioId: "error-preview-1440",
          previewContentEvidence: { pass: true, failures: [] },
        },
      ],
      pattern:
        /claims scenario "recovery" without a required recovered-preview scenarioId/,
    },
    {
      name: "missing-scenario-id",
      entries: [...healthyEntries, { scenario: "recovery" }],
      pattern: /is missing scenarioId/,
    },
  ]) {
    const verdict = evaluateErrorRecoveryCaptureEntries(brokenCase.entries);
    assert(
      verdict.pass === false &&
        brokenCase.pattern.test(verdict.violations.join("\n")),
      `Exact-ID recovery enforcement must reject ${brokenCase.name}.`,
    );
  }
  const captureEntryLoopAt = wrapper.indexOf(
    "for (const entry of captureEntries) {",
  );
  const recoveryContractCallAt = wrapper.indexOf(
    "evaluateErrorRecoveryCaptureEntries(captureEntries)",
  );
  const scenarioContractCallAt = wrapper.indexOf(
    "assertScenarioContract(capture.id, captureReport, captureEntries)",
  );
  assert(
    captureEntryLoopAt >= 0 &&
      recoveryContractCallAt > captureEntryLoopAt &&
      recoveryContractCallAt < scenarioContractCallAt,
    "The wrapper must enforce the exact-ID recovery contract after per-entry gates and before the scenario-contract assertion.",
  );
  const enforcementSlice = wrapper.slice(
    captureEntryLoopAt,
    scenarioContractCallAt,
  );
  assert(
    enforcementSlice.includes('capture.id === "error-recovery"') &&
      enforcementSlice.includes("recoveryEntryContract.pass") &&
      enforcementSlice.includes("recoveryEntryContract.violations"),
    "The acceptance wrapper must hard-fail error-recovery captures on any exact-ID recovery-contract violation.",
  );
  assert(
    !wrapper.includes('entry.scenario === "recovery"'),
    "Wrapper recovery enforcement must bind scenario IDs, not the mutable scenario label.",
  );
}
// --- Capture-entry native-zoom binding authority ------------------------------
// The wrapper must fail closed on ANY capture entry whose recorded
// viewportMetadata.nativeZoomFactor is not exactly 1 or 1.25. Required-row
// checks cannot see extra rows, so these pins prove extra 2.0 rows (and any
// other non-finite or off-set factor) are rejected with component/scenario
// attribution, and that the sweep gates every current capture component once,
// inside the shared loop after report loading.
{
  assert(
    Object.isFrozen(ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS) &&
      stableJson(ACCEPTED_CAPTURE_NATIVE_ZOOM_FACTORS) ===
        stableJson([1, 1.25]),
    "Accepted capture native zoom factors must stay frozen at exactly [1, 1.25].",
  );
  const zoomEntry = (factor, overrides = {}) => ({
    fileName: "01-fixture.png",
    pass: true,
    scenarioId: "fixture-scenario",
    viewportMetadata: {
      css: {
        height: factor === 1 ? 920 : 736,
        width: factor === 1 ? 1440 : 1152,
      },
      nativeZoomFactor: factor,
      physical: { height: 920, width: 1440 },
    },
    ...overrides,
  });
  assert(
    stableJson(
      findDisallowedCaptureNativeZoomFactors("fresh", [
        zoomEntry(1),
        zoomEntry(1.25),
        zoomEntry(1.25, { fileName: "02-fixture.png", scenarioId: "another" }),
      ]),
    ) === "[]",
    "A healthy capture entry set recorded at native zoom exactly 1 and 1.25 must produce no disallowed-zoom findings.",
  );
  // Required-row existence is insufficient: one healthy row plus one extra
  // 2.0 row must fail closed naming component, scenario, and observed value.
  const extraRowVerdict = findDisallowedCaptureNativeZoomFactors("scale", [
    zoomEntry(1.25, { scenarioId: "required-native125-row" }),
    zoomEntry(2, { scenarioId: "stale-extra-row" }),
  ]);
  assert(
    extraRowVerdict.length === 1 &&
      extraRowVerdict[0].includes("scale") &&
      extraRowVerdict[0].includes("stale-extra-row") &&
      extraRowVerdict[0].includes("2"),
    "An extra capture row bound to native zoom 2 must be rejected even when every required row exists.",
  );
  for (const badFactor of [0.5, 1.5, 3, "1.25", null]) {
    const verdict = findDisallowedCaptureNativeZoomFactors("error-recovery", [
      zoomEntry(1),
      {
        scenarioId: "bad-factor-row",
        viewportMetadata: { nativeZoomFactor: badFactor },
      },
    ]);
    assert(
      verdict.length === 1 && verdict[0].includes("bad-factor-row"),
      `A capture row recording nativeZoomFactor ${JSON.stringify(badFactor)} must be rejected by the binding audit.`,
    );
  }
  assert(
    findDisallowedCaptureNativeZoomFactors("fresh", [
      { scenarioId: "no-metadata-row" },
    ]).length === 1 &&
      findDisallowedCaptureNativeZoomFactors("fresh", [
        { scenarioId: "missing-factor-row", viewportMetadata: {} },
      ]).length === 1 &&
      findDisallowedCaptureNativeZoomFactors("fresh", null).length === 1,
    "A capture entry without viewport metadata or a non-array entry list must fail the native-zoom binding audit closed.",
  );

  // Wiring: one shared gate per capture component, after report loading and
  // entry extraction, before the generic per-entry gates.
  const completionAt = wrapper.indexOf(
    "assertComponentCompletion(captureReport, capture.id)",
  );
  const extractionAt = wrapper.indexOf(
    "captureEntriesByComponent[capture.id] = captureEntries;",
  );
  const zoomGateCall =
    "findDisallowedCaptureNativeZoomFactors(capture.id, captureEntries)";
  const zoomGateAt = wrapper.indexOf(zoomGateCall);
  const perEntryLoopAt = wrapper.indexOf(
    "for (const entry of captureEntries) {",
  );
  assert(
    completionAt >= 0 &&
      extractionAt > completionAt &&
      wrapper.split(zoomGateCall).length === 2 &&
      zoomGateAt > extractionAt &&
      zoomGateAt < perEntryLoopAt,
    "The native-zoom binding audit must gate every capture component exactly once inside the shared loop after report loading and entry extraction.",
  );
}
// --- Native-200% removal rejection -------------------------------------------
// Native Electron 200% zoom was removed from current acceptance by user
// decision: no component executed by ui:job-finder-production-acceptance may
// request zoom factor 2 or carry a current scenario ID containing zoom200.
// Literal scenario-ID tokens are matched verbatim; numeric binding forms are
// matched whitespace-tolerantly through regexes so spacing variants such as
// zoomFactor:2, zoomFactor : 2.0, or setZoomFactor( 2 ) cannot slip through.
// These checks reject any reintroduction of stale 2.0 assumptions across all
// four current producer surfaces — fresh, scale, error/recovery captures, and
// the acceptance wrapper; historical artifacts are not re-litigated here.
{
  const staleZoomLiteralTokens = ["zoom200", "zoom-200", "zoom200pct"];
  const staleZoomBindingDetectors = [
    [
      /\bzoomFactor\s*:\s*2(?:\.\d+)?\b/u,
      "a zoomFactor binding to a numeric literal beginning with 2",
    ],
    [
      /\bsetZoomFactor\s*\(\s*2(?:\.\d+)?\s*\)/u,
      "a setZoomFactor call with a numeric literal beginning with 2",
    ],
  ];
  const assertNoStaleZoomBinding = (sourceName, source) => {
    for (const token of staleZoomLiteralTokens) {
      assert(
        !source.includes(token),
        `Current acceptance ${sourceName} must not reference native-200% zoom binding "${token}"; native 1.25 is the only accepted zoomed leg.`,
      );
    }
    for (const [detector] of staleZoomBindingDetectors) {
      assert(
        !detector.test(source),
        `Current acceptance ${sourceName} must not reference native-200% zoom bindings matching ${String(detector)} (${String(detector.source)}); native 1.25 is the only accepted zoomed leg.`,
      );
    }
  };
  const CURRENT_ZOOM_TRIPWIRE_SOURCES = [
    ["fresh-flow capture", freshSource],
    ["scale capture", scaleSource],
    ["error/recovery capture", errorRecovery],
    ["acceptance wrapper", wrapper],
  ];
  for (const [sourceName, source] of CURRENT_ZOOM_TRIPWIRE_SOURCES) {
    assertNoStaleZoomBinding(sourceName, source);
  }
  // Negative controls: legitimate current zoom usage at the accepted factors
  // and unrelated identifiers must never fire the detectors.
  for (const benign of [
    "zoomFactor: 1",
    "zoomFactor: 1.25",
    '"zoomFactor": 1',
    "zoomFactor: vp.zoomFactor",
    "getZoomFactor()",
    "reloadZoomFactorExact",
    'NESTOR_STARTUP_ZOOM_FACTOR = "9"',
  ]) {
    let fired = false;
    try {
      assertNoStaleZoomBinding("negative control", benign);
    } catch {
      fired = true;
    }
    assert(
      !fired,
      `The stale-200% detector wrongly flagged benign zoom usage: ${JSON.stringify(benign)}.`,
    );
  }
  // Fixture proof: every current producer surface fails closed on every
  // reintroduction variant — literal IDs plus whitespace-tolerant numeric
  // bindings. Historical docs and non-sealed harnesses
  // (capture-shell-zoom-sweep.mjs, capture-job-finder-phase-two.mjs,
  // capture-job-finder-deep-acceptance.mjs, capture-action-inbox.mjs, and the
  // blind-persona tooling) intentionally stay outside this source tripwire so
  // their factual historical 200% coverage never gates the sealed path.
  const staleZoomPoisonVariants = [
    "zoom200",
    "zoom-200",
    "zoom200pct",
    "zoomFactor: 2",
    "zoomFactor:2",
    "zoomFactor : 2.0",
    "zoomFactor:\t2",
    "zoomFactor: 2.5",
    "setZoomFactor(2)",
    "setZoomFactor( 2 )",
    "setZoomFactor(2.0)",
  ];
  for (const [sourceName] of CURRENT_ZOOM_TRIPWIRE_SOURCES) {
    for (const variant of staleZoomPoisonVariants) {
      mustThrow(
        () =>
          assertNoStaleZoomBinding(
            sourceName,
            // Direct interpolation, not JSON.stringify: stringify would
            // escape a raw tab into the two-character "\t" sequence and hide
            // the whitespace-tolerant binding from the detector.
            `const poison = "${variant}";`,
          ),
        /must not reference native-200% zoom/,
        `The stale-200% tripwire did not fail ${sourceName} on the reintroduced binding ${JSON.stringify(variant)}.`,
      );
    }
  }
  assert(
    staleZoomPoisonVariants.length === 11 &&
      staleZoomPoisonVariants.filter((variant) =>
        /\bzoomFactor\s*:\s*/u.test(variant),
      ).length === 5 &&
      staleZoomPoisonVariants.filter((variant) =>
        /\bsetZoomFactor\s*\(/u.test(variant),
      ).length === 3 &&
      staleZoomLiteralTokens.every((token) =>
        staleZoomPoisonVariants.includes(token),
      ),
    "The poison-variant fixture list must keep covering every detector class: three literal IDs, five zoomFactor binding spellings, and three setZoomFactor spellings.",
  );
}
// --- Error/recovery report truth and teardown diagnostics --------------------
{
  const outerCatchSlice = errorRecovery.slice(
    errorRecovery.indexOf("run().catch("),
  );
  assert(
    outerCatchSlice.includes("report.pass = false;") &&
      outerCatchSlice.includes("delete report.completedAt;") &&
      outerCatchSlice.includes("pass: false") &&
      outerCatchSlice.indexOf("await writeReport();") >
        outerCatchSlice.indexOf("report.pass = false;"),
    "The failure-path report rewrite must reset pass/completion truth before persisting so the on-disk report can never show pass:true with failure.",
  );
  assert(
    outerCatchSlice.includes(
      "Unable to persist the failed error/recovery report",
    ),
    "A failing failure-report rewrite must still be reported instead of silently swallowed.",
  );
  assert(
    errorRecovery.includes(
      "cleanupError = await cleanupDirectory(userDataDirectory);",
    ) &&
      errorRecovery.includes(
        "catch (error) {\n      cleanupError = error;\n    }",
      ),
    "A thrown cleanupDirectory error must be guarded so the final report write and postTeardownFailure computation still run.",
  );
}
process.stdout.write(
  "Job Finder production-acceptance harness static validation passed.\n",
);
