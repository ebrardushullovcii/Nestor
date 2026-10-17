import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  defaultReadFirstBytes,
  resolveShellFreePnpmInvocation as resolveSharedShellFreePnpmInvocation,
} from "./lib/pnpm-entry.mjs";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const artifactReleaseRoot = path.join(
  repositoryRoot,
  "test-artifacts",
  "release",
);
const mirrorDirectory = path.join(
  repositoryRoot,
  "docs",
  "audits",
  "evidence-manifests",
);
const manifestKind = "nestor-release-evidence-manifest";
// Manifests recorded under earlier names (ADR 0040, ADR 0052) keep their kind.
const legacyManifestKinds = new Set([
  "unemployed-release-evidence-manifest",
  "nordri-release-evidence-manifest",
]);
const isKnownManifestKind = (kind) =>
  kind === manifestKind || legacyManifestKinds.has(kind);
const manifestSchemaVersion = 4;
const rawManifestDigestSubject = "raw_full_manifest_without_manifestSha256";
const mirrorManifestDigestSubject =
  "mirror_manifest_without_mirrorManifestSha256";
const strictHex64Pattern = /^[0-9a-f]{64}$/u;
const runIdPattern = /^release-\d{8}T\d{6}-[0-9a-f]{6}$/u;
// Named digest recipe for the source fingerprint. Records are stable-JSON
// lines (one per enumerated path, injective because the `kind` field binds
// the record shape) prefixed with this id; there is no magic digest sentinel.
// v3 binds permission bits (`mode`, 0o777) into ordinary-file and symlink
// records so chmod-only mutations can never hide behind identical bytes.
// Exported so the production-acceptance static validator can pin the exact
// recipe id and notice any silent semantic change.
export const sourceFingerprintRecipe =
  "nul-enumerated-stable-json-lines-v3:file-mode-sha256-or-contained-symlink-or-git-declared-deletion";
const stageKeys = ["test:correctness", "test:performance"];
const sourceExcludes = [
  /^node_modules(?:[\\/]|$)/,
  /^(?:out|dist|build|release|coverage|\.tmp|\.turbo)(?:[\\/]|$)/,
  /(?:^|[\\/])test-artifacts(?:[\\/]|$)/,
  /\.tsbuildinfo$/,
  /^(?:\.git)(?:[\\/]|$)/,
  // Generated evidence mirrors are collector output, not product input: they
  // become durable only through an authorized Git commit. Including them would
  // make writing <runId>.manifest.json change the very source fingerprint the
  // mirror evidences. Paths are normalized to "/" before filtering, and the
  // anchor is deliberately narrow so neighboring human-authored files under
  // docs/audits/ stay bound. This must match SOURCE_EXCLUDES in
  // apps/desktop/scripts/release-acceptance-harness.mjs; parity is enforced by
  // apps/desktop/scripts/validate-job-finder-production-acceptance.mjs.
  /^docs\/audits\/evidence-manifests(?:\/|$)/,
];
const reporterArguments = [
  "--reporter=default",
  "--reporter=json",
  "--reporter=junit",
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isStrictSha256Hex(value) {
  return typeof value === "string" && strictHex64Pattern.test(value);
}

function sha256HexOrThrow(text, label) {
  const digest = sha256Hex(text);
  if (!isStrictSha256Hex(digest)) {
    throw new Error(`digest for ${label} is not strict 64-char lowercase hex`);
  }
  return digest;
}

function canonicalSha256WithoutFields(value, fieldNames, label) {
  const copy = { ...stableValue(value) };
  for (const fieldName of fieldNames) delete copy[fieldName];
  return sha256HexOrThrow(stableJson(copy), label);
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function toRepoRelative(fullPath) {
  return path.relative(repositoryRoot, fullPath).split(path.sep).join("/");
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function gitLines(arguments_, cwd = repositoryRoot) {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    arguments_,
    {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join("/");
}

// Same containment rule as isInside in
// apps/desktop/scripts/release-acceptance-harness.mjs: an enumerated source
// path can never be interpreted outside the fingerprint root.
function isInsideRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

// Exported only so the production-acceptance static validator can enforce
// fingerprint-exclusion parity with the release-acceptance harness.
export function isExcludedSource(relativePath) {
  return sourceExcludes.some((pattern) => pattern.test(relativePath));
}

function assertValidRunId(runId) {
  if (typeof runId !== "string" || !runIdPattern.test(runId)) {
    throw new Error(
      `Evidence runId failed its exact release pattern: ${String(runId)}`,
    );
  }
}

async function collectGitMetadata() {
  const [headLines, statusLines] = await Promise.all([
    gitLines(["rev-parse", "HEAD"]),
    gitLines(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return {
    head: headLines[0] ?? null,
    dirty: statusLines.length > 0,
    status: statusLines,
  };
}

// Exported only so the production-acceptance static validator can prove the
// collector's fail-closed classification (vanished paths, unsupported entry
// types) against the same fixture style as the release-acceptance harness.
// Selection semantics match the harness: NUL-safe enumeration upstream,
// "/"-normalized paths, the shared exclusion table, deterministic sorted
// order, and per-path containment. Classification is explicit and kind-bound:
// ordinary files record path/mode/bytes/sha256, a contained symlink that
// resolves back to an enumerated ordinary file records target/resolvedPath/
// mode, and an ENOENT becomes an explicit `deleted` record only when the path
// appears in the Git-declared worktree deletion set — otherwise it is a named
// race failure. Directories, special entries, escaping/broken symlinks, and
// symlinks whose target falls outside the enumerated ordinary-file set all
// fail closed. The digest folds one stable-JSON line per path under the named
// recipe id; there is no magic digest sentinel anywhere in the recipe.
export async function fingerprintEnumeratedSourcePaths(
  root,
  relativePaths,
  options = {},
) {
  const declaredDeletions = new Set(
    (Array.isArray(options.declaredDeletions)
      ? options.declaredDeletions
      : []
    ).map(normalizeRelative),
  );
  const enumerated = [...new Set([...relativePaths].map(normalizeRelative))];
  const enumeratedSet = new Set(enumerated);
  for (const declaredDeletion of declaredDeletions) {
    if (!enumeratedSet.has(declaredDeletion)) {
      throw new Error(
        `Declared worktree deletion set is not a subset of enumerated source paths: ${declaredDeletion}`,
      );
    }
  }
  const files = enumerated
    .filter((relativePath) => !isExcludedSource(relativePath))
    .sort((left, right) => left.localeCompare(right));
  const classified = [];
  for (const relativePath of files) {
    const fullPath = path.resolve(root, relativePath);
    if (!isInsideRoot(root, fullPath)) {
      throw new Error(
        `Source path escaped its fingerprint root: ${relativePath}`,
      );
    }
    let info;
    try {
      info = await lstat(fullPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (declaredDeletions.has(relativePath)) {
          classified.push({ kind: "deleted", path: relativePath });
          continue;
        }
        throw new Error(
          `Source path ${relativePath} disappeared between enumeration and hashing; restore it or stage its deletion and rerun evidence collection.`,
        );
      }
      throw new Error(
        `Unable to hash source file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (info.isFile()) {
      classified.push({
        kind: "file",
        path: relativePath,
        mode: info.mode & 0o777,
        bytes: info.size,
        sha256: await sha256File(fullPath),
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      classified.push(
        await classifyEnumeratedSymlink(
          root,
          fullPath,
          relativePath,
          info.mode & 0o777,
        ),
      );
      continue;
    }
    throw new Error(
      `Unsupported source entry type for ${relativePath}; expected an ordinary file, a contained symlink, or a Git-declared worktree deletion.`,
    );
  }
  const ordinaryFilePaths = new Set(
    classified
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path),
  );
  const records = [];
  let fileCount = 0;
  let symlinkCount = 0;
  let deletedCount = 0;
  for (const entry of classified) {
    if (entry.kind === "symlink-pending") {
      if (!ordinaryFilePaths.has(entry.resolvedPath)) {
        throw new Error(
          `Source symlink ${entry.path} does not resolve to an enumerated ordinary source file: ${entry.resolvedPath}`,
        );
      }
      records.push({
        kind: "symlink",
        path: entry.path,
        target: entry.target,
        resolvedPath: entry.resolvedPath,
        mode: entry.mode,
      });
      symlinkCount += 1;
    } else if (entry.kind === "file") {
      records.push({
        kind: "file",
        path: entry.path,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
      fileCount += 1;
    } else {
      records.push({ kind: "deleted", path: entry.path });
      deletedCount += 1;
    }
  }
  const hash = createHash("sha256");
  hash.update(`${sourceFingerprintRecipe}\0`, "utf8");
  for (const record of records) {
    hash.update(`${stableJson(record)}\n`, "utf8");
  }
  return {
    algorithm: "sha256",
    recipe: sourceFingerprintRecipe,
    digest: hash.digest("hex"),
    fileCount,
    symlinkCount,
    deletedCount,
  };
}

async function classifyEnumeratedSymlink(root, fullPath, relativePath, mode) {
  const target = await readlink(fullPath);
  const resolvedTarget = path.resolve(path.dirname(fullPath), target);
  if (!isInsideRoot(root, resolvedTarget)) {
    throw new Error(
      `Source symlink ${relativePath} escapes its fingerprint root: ${target}`,
    );
  }
  let targetInfo;
  try {
    targetInfo = await stat(fullPath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(`Source symlink ${relativePath} is broken: ${target}`);
    }
    throw new Error(
      `Unable to hash source file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!targetInfo.isFile()) {
    throw new Error(
      `Source symlink ${relativePath} resolves to a non-file target: ${target}`,
    );
  }
  // Canonicalize both sides so /var-style root aliases can never masquerade as
  // an escape or hide one; membership against the enumerated ordinary-file set
  // is re-checked after classification completes.
  const canonicalRoot = await realpath(root);
  const canonicalLink = await realpath(fullPath);
  return {
    kind: "symlink-pending",
    path: relativePath,
    target,
    resolvedPath: normalizeRelative(
      path.relative(canonicalRoot, canonicalLink),
    ),
    mode,
  };
}

async function gitNullDelimitedPaths(arguments_, cwd = repositoryRoot) {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    arguments_,
    {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout.split("\0").filter(Boolean);
}

// -c keeps tracked index entries (whose unstaged worktree deletions then come
// back through the second enumeration), -o keeps untracked files honoring
// .gitignore via --exclude-standard, and -z emits raw NUL-delimited paths so
// newline-bearing or otherwise quoted filenames survive enumeration exactly.
// `ls-files -z -d` separately declares every tracked worktree deletion so the
// classifier can record it as an explicit `deleted` kind instead of failing
// as an undeclared vanish race. Nothing here stages, restores, or otherwise
// mutates the index or any user-owned path.
export async function computeSourceFingerprint(root = repositoryRoot) {
  const [enumeratedPaths, declaredDeletions] = await Promise.all([
    gitNullDelimitedPaths(
      ["ls-files", "-z", "-co", "--exclude-standard"],
      root,
    ),
    gitNullDelimitedPaths(["ls-files", "-z", "-d"], root),
  ]);
  return fingerprintEnumeratedSourcePaths(root, enumeratedPaths, {
    declaredDeletions,
  });
}

// Shell-free pnpm resolution lives in scripts/lib/pnpm-entry.mjs so the
// repository launchers (run-turbo.mjs, validate-package.mjs) share exactly
// one implementation. Corepack is deliberately NOT a candidate here so
// evidence collection keeps resolving direct pnpm JavaScript entries with the
// same precedence it has always used.
function resolvePackageManagerInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  fileExists = existsSync,
  readFirstBytes = defaultReadFirstBytes,
} = {}) {
  return resolveSharedShellFreePnpmInvocation({
    environment,
    platform,
    nodeExecutable,
    repositoryRoot,
    fileExists,
    readFirstBytes,
    resolveFromRoot: createRequire(path.join(repositoryRoot, "package.json"))
      .resolve,
    corepackCandidates: [],
  });
}

function requirePackageManagerInvocation() {
  const resolved = resolvePackageManagerInvocation();
  if (resolved) return resolved;
  throw new Error(
    "no shell-free pnpm JavaScript entry point found via npm_execpath, vendored pnpm/bin/pnpm.cjs, or a POSIX PATH pnpm node script; refusing to spawn pnpm.cmd because Node rejects .cmd without a shell on Windows",
  );
}

function tokenizeScript(script) {
  if (/[&|><;$`"']/.test(script)) {
    throw new Error(`Unsupported shell syntax in script "${script}"`);
  }
  const tokens = script.trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] !== "vitest") {
    throw new Error(`Unexpected canonical test command "${tokens[0] ?? ""}"`);
  }
  return tokens;
}

async function loadStageScripts() {
  const raw = await readFile(path.join(repositoryRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  return stageKeys.map((key) => {
    const script = parsed?.scripts?.[key];
    if (typeof script !== "string" || script.trim() === "") {
      throw new Error(`Missing package.json script "${key}"`);
    }
    return { key, script };
  });
}

function buildStagePlan(entry, runDir, invocation) {
  const tokens = tokenizeScript(entry.script);
  const id = entry.key.replace(/^test:/u, "");
  const jsonFile = `${id}.results.json`;
  const junitFile = `${id}.junit.xml`;
  const argv = [
    ...invocation.argsPrefix,
    "exec",
    ...tokens,
    ...reporterArguments,
    `--outputFile.json=${path.join(runDir, jsonFile)}`,
    `--outputFile.junit=${path.join(runDir, junitFile)}`,
  ];
  return {
    id,
    scriptKey: entry.key,
    commandLine: entry.script,
    invocationSource: invocation.source,
    argv,
    jsonFile,
    junitFile,
  };
}

function summarizeJsonResults(payload) {
  const counts = {
    totalTestSuites: numberOrZero(payload?.numTotalTestSuites),
    totalTests: numberOrZero(payload?.numTotalTests),
    passedTests: numberOrZero(payload?.numPassedTests),
    failedTests: numberOrZero(payload?.numFailedTests),
    pendingTests: numberOrZero(payload?.numPendingTests),
    todoTests: numberOrZero(payload?.numTodoTests),
  };
  const skipped = [];
  const todo = [];
  for (const suite of payload?.testResults ?? []) {
    const file = suite?.name ?? null;
    for (const assertion of suite?.assertionResults ?? []) {
      const record = {
        file,
        suite: (assertion?.ancestorTitles ?? []).join(" > "),
        title: assertion?.title ?? null,
        status: assertion?.status ?? null,
      };
      if (assertion?.status === "skipped" || assertion?.status === "pending") {
        skipped.push(record);
      } else if (assertion?.status === "todo") {
        todo.push(record);
      }
    }
  }
  return { counts, skipped, todo, success: payload?.success === true };
}

function summarizeJunitXml(xml) {
  const summary = { suites: 0, tests: 0, failures: 0, errors: 0, skipped: 0 };
  const tags = xml.match(/<testsuite\b[^>]*>/gu) ?? [];
  for (const tag of tags) {
    summary.suites += 1;
    for (const key of ["tests", "failures", "errors", "skipped"]) {
      const match = tag.match(new RegExp(`\\b${key}="(\\d+)"`, "u"));
      if (match) summary[key] += Number(match[1]);
    }
  }
  return summary;
}

async function runStage(plan, invocation, runDir) {
  const stdoutHandle = await open(
    path.join(runDir, `${plan.id}.stdout.log`),
    "w",
  );
  const stderrHandle = await open(
    path.join(runDir, `${plan.id}.stderr.log`),
    "w",
  );
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let exitCode = null;
  let signal = null;
  let spawnError = null;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, plan.argv, {
        cwd: repositoryRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
        windowsHide: true,
      });
      child.on("error", reject);
      child.on("close", (code, closeSignal) => {
        exitCode = code;
        signal = closeSignal ?? null;
        resolve();
      });
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.allSettled([stdoutHandle.close(), stderrHandle.close()]);
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode,
    signal,
    spawnError,
  };
}

async function describeRunFile(runDir, fileName) {
  try {
    const fullPath = path.join(runDir, fileName);
    const info = await stat(fullPath);
    if (!info.isFile()) return null;
    return {
      path: fileName,
      bytes: info.size,
      sha256: await sha256File(fullPath),
    };
  } catch {
    return null;
  }
}

async function buildStageEvidence(plan, invocation, execution, runDir) {
  const logs = {
    stdout: await describeRunFile(runDir, `${plan.id}.stdout.log`),
    stderr: await describeRunFile(runDir, `${plan.id}.stderr.log`),
  };
  const outputs = {
    json: await describeRunFile(runDir, plan.jsonFile),
    junit: await describeRunFile(runDir, plan.junitFile),
  };
  let parsed = null;
  let structuredParseError = null;
  if (outputs.json) {
    try {
      parsed = summarizeJsonResults(
        JSON.parse(await readFile(path.join(runDir, plan.jsonFile), "utf8")),
      );
    } catch (error) {
      structuredParseError =
        error instanceof Error ? error.message : String(error);
    }
  }
  let junitSummary = null;
  let junitParseError = null;
  if (outputs.junit) {
    try {
      junitSummary = summarizeJunitXml(
        await readFile(path.join(runDir, plan.junitFile), "utf8"),
      );
    } catch (error) {
      junitSummary = null;
      junitParseError = error instanceof Error ? error.message : String(error);
    }
  }
  const consistency =
    parsed && junitSummary
      ? {
          totalTestsMatchJunit: parsed.counts.totalTests === junitSummary.tests,
          failuresMatchJunit:
            parsed.counts.failedTests ===
            junitSummary.failures + junitSummary.errors,
          skippedMatchJunit:
            parsed.counts.pendingTests + parsed.counts.todoTests ===
            junitSummary.skipped,
        }
      : {
          totalTestsMatchJunit: null,
          failuresMatchJunit: null,
          skippedMatchJunit: null,
        };
  return {
    id: plan.id,
    scriptKey: plan.scriptKey,
    commandLine: plan.commandLine,
    argv: [invocation.command, ...plan.argv],
    invocationSource: plan.invocationSource,
    cwd: ".",
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    durationMs: execution.durationMs,
    exitCode: execution.exitCode,
    signal: execution.signal,
    spawnError: execution.spawnError,
    logs,
    outputs,
    counts: parsed ? parsed.counts : null,
    reportedSuccess: parsed ? parsed.success : null,
    explicitSkipped: parsed ? parsed.skipped : null,
    explicitTodo: parsed ? parsed.todo : null,
    structuredResultsParsed: Boolean(parsed),
    structuredParseError,
    junitSummary,
    junitParseError,
    consistency,
  };
}

function collectFailureReasons(stages, beforeFingerprint, afterFingerprint) {
  const reasons = [];
  for (const stage of stages) {
    if (stage.spawnError) {
      reasons.push(`stage ${stage.id} failed to start: ${stage.spawnError}`);
      continue;
    }
    if (stage.signal) {
      reasons.push(`stage ${stage.id} terminated by signal ${stage.signal}`);
      continue;
    }
    if (stage.exitCode !== 0) {
      reasons.push(
        `stage ${stage.id} exited with code ${stage.exitCode === null ? "unknown" : String(stage.exitCode)}`,
      );
    }
    const jsonMissing = !stage.outputs?.json;
    const junitMissing = !stage.outputs?.junit;
    if (jsonMissing) {
      reasons.push(
        `stage ${stage.id} is missing the required JSON results file`,
      );
    }
    if (junitMissing) {
      reasons.push(
        `stage ${stage.id} is missing the required JUnit report file`,
      );
    }
    if (!stage.structuredResultsParsed || !stage.counts) {
      reasons.push(`stage ${stage.id} produced no parsable structured results`);
      continue;
    }
    if (stage.reportedSuccess === false) {
      reasons.push(`stage ${stage.id} structured results report success=false`);
    }
    if ((stage.counts.failedTests ?? 0) > 0) {
      reasons.push(
        `stage ${stage.id} reports ${stage.counts.failedTests} failed test(s)`,
      );
    }
    if ((stage.counts.totalTests ?? 0) === 0) {
      reasons.push(`stage ${stage.id} reports zero total tests`);
    }
    if (junitMissing) continue;
    if (!stage.junitSummary) {
      reasons.push(
        `stage ${stage.id} produced no parsable JUnit summary${stage.junitParseError ? `: ${stage.junitParseError}` : ""}`,
      );
      continue;
    }
    const { consistency } = stage;
    if (consistency.totalTestsMatchJunit === false) {
      reasons.push(
        `stage ${stage.id} JSON totalTests ${stage.counts.totalTests} diverges from JUnit tests ${stage.junitSummary.tests}`,
      );
    }
    if (consistency.failuresMatchJunit === false) {
      reasons.push(
        `stage ${stage.id} JSON failedTests ${stage.counts.failedTests} diverges from JUnit failures+errors ${stage.junitSummary.failures + stage.junitSummary.errors}`,
      );
    }
    if (consistency.skippedMatchJunit === false) {
      reasons.push(
        `stage ${stage.id} JSON pending+todo ${stage.counts.pendingTests + stage.counts.todoTests} diverges from JUnit skipped ${stage.junitSummary.skipped}`,
      );
    }
  }
  // Only an actually-produced after fingerprint may claim "changed": an
  // unavailable one is reported through its own unverifiable reason so a
  // null/identical digest can never masquerade as a changed source.
  if (
    afterFingerprint !== null &&
    stableJson(beforeFingerprint) !== stableJson(afterFingerprint)
  ) {
    reasons.push(
      `source fingerprint changed during evidence collection (${beforeFingerprint.recipe} ${beforeFingerprint.digest} -> ${afterFingerprint.recipe} ${afterFingerprint.digest})`,
    );
  }
  return reasons;
}

async function inventoryArtifacts(runDir) {
  const entries = await readdir(runDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(runDir, entry.name);
    const info = await stat(fullPath);
    files.push({
      path: entry.name,
      bytes: info.size,
      sha256: await sha256File(fullPath),
    });
  }
  return files;
}

function hostBasics() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  };
}

function createRunId(now) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/gu, "");
  return `release-${stamp}-${randomBytes(3).toString("hex")}`;
}

function hashOnly(fileReference) {
  if (!fileReference) return null;
  return { bytes: fileReference.bytes, sha256: fileReference.sha256 };
}

function compactStage(stage) {
  return {
    id: stage.id,
    scriptKey: stage.scriptKey,
    commandLine: stage.commandLine,
    argv: stage.argv,
    invocationSource: stage.invocationSource ?? null,
    cwd: stage.cwd ?? ".",
    startedAt: stage.startedAt ?? null,
    completedAt: stage.completedAt ?? stage.endedAt ?? null,
    durationMs: stage.durationMs ?? null,
    exitCode: stage.exitCode ?? null,
    signal: stage.signal ?? null,
    spawnError: stage.spawnError ?? null,
    counts: stage.counts ?? null,
    reportedSuccess: stage.reportedSuccess ?? null,
    explicitSkipped: stage.explicitSkipped ?? null,
    explicitTodo: stage.explicitTodo ?? null,
    structuredResultsParsed: Boolean(stage.structuredResultsParsed),
    structuredParseError: stage.structuredParseError ?? null,
    junitSummary: stage.junitSummary ?? null,
    junitParseError: stage.junitParseError ?? null,
    consistency: {
      totalTestsMatchJunit: stage.consistency?.totalTestsMatchJunit ?? null,
      failuresMatchJunit: stage.consistency?.failuresMatchJunit ?? null,
      skippedMatchJunit: stage.consistency?.skippedMatchJunit ?? null,
    },
    logs: {
      stdout: hashOnly(stage.logs?.stdout),
      stderr: hashOnly(stage.logs?.stderr),
    },
    outputs: {
      json: hashOnly(stage.outputs?.json),
      junit: hashOnly(stage.outputs?.junit),
    },
  };
}

function isPlainObjectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringOrNull(value, label) {
  if (value === null || value === undefined) return null;
  return requireNonEmptyString(value, label);
}

function booleanOrThrow(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function countOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer or null`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function digestOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (!isStrictSha256Hex(value)) {
    throw new Error(`${label} must be strict 64-char lowercase hex or null`);
  }
  return value;
}

// Compact projection of one before/after fingerprint side. Legacy
// schemaVersion-3 manifests legitimately lack the kind-bound fields and
// unavailable reasons; they project with explicit nulls so a rebuilt mirror
// never invents values for point-in-time history.
function compactFingerprintSide(rawSide, label) {
  if (!isPlainObjectValue(rawSide)) {
    throw new Error(`${label} must be an object`);
  }
  const compact = {
    recipe: stringOrNull(rawSide.recipe, `${label}.recipe`),
    digest: digestOrNull(rawSide.digest, `${label}.digest`),
    fileCount: countOrNull(rawSide.fileCount, `${label}.fileCount`),
    symlinkCount: countOrNull(rawSide.symlinkCount, `${label}.symlinkCount`),
    deletedCount: countOrNull(rawSide.deletedCount, `${label}.deletedCount`),
  };
  const unavailableReason = stringOrNull(
    rawSide.unavailableReason,
    `${label}.unavailableReason`,
  );
  if (unavailableReason !== null) {
    if (compact.digest !== null) {
      throw new Error(
        `${label} carries both a digest and an unavailableReason`,
      );
    }
    compact.unavailableReason = unavailableReason;
  }
  return compact;
}

function composeCompactMirror(raw) {
  if (!isPlainObjectValue(raw)) {
    throw new Error("raw manifest must be an object");
  }
  if (!isKnownManifestKind(raw.kind)) {
    throw new Error(`unexpected manifest kind "${String(raw.kind)}"`);
  }
  if (
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1 ||
    raw.schemaVersion > manifestSchemaVersion
  ) {
    throw new Error(
      `unsupported raw manifest schemaVersion ${String(raw.schemaVersion)}`,
    );
  }
  assertValidRunId(raw.runId);
  if (raw.outcome !== "passed" && raw.outcome !== "failed") {
    throw new Error(
      `unsupported raw manifest outcome "${String(raw.outcome)}"`,
    );
  }
  if (
    !Array.isArray(raw.failureReasons) ||
    raw.failureReasons.some((reason) => typeof reason !== "string")
  ) {
    throw new Error("raw manifest failureReasons must be an array of strings");
  }
  if (!isPlainObjectValue(raw.host)) {
    throw new Error("raw manifest host must be an object");
  }
  if (!isPlainObjectValue(raw.git)) {
    throw new Error("raw manifest git must be an object");
  }
  requireNonEmptyString(raw.createdAt, "raw manifest createdAt");
  requireNonEmptyString(raw.completedAt, "raw manifest completedAt");
  if (
    !isPlainObjectValue(raw.sourceFingerprint) ||
    !isPlainObjectValue(raw.sourceFingerprint.before) ||
    !isPlainObjectValue(raw.sourceFingerprint.after)
  ) {
    throw new Error(
      "raw manifest sourceFingerprint.before/after must be objects",
    );
  }
  booleanOrThrow(
    raw.sourceFingerprint.unchanged,
    "raw manifest sourceFingerprint.unchanged",
  );
  if (!Array.isArray(raw.stages)) {
    throw new Error("raw manifest stages must be an array");
  }
  if (!isPlainObjectValue(raw.artifacts)) {
    throw new Error("raw manifest artifacts must be an object");
  }
  requireNonEmptyString(raw.artifacts.runDir, "raw manifest artifacts.runDir");
  return {
    kind: raw.kind,
    schemaVersion: raw.schemaVersion,
    runId: raw.runId,
    createdAt: raw.createdAt,
    completedAt: raw.completedAt,
    outcome: raw.outcome,
    failureReasons: raw.failureReasons,
    host: {
      platform: requireNonEmptyString(
        raw.host.platform,
        "raw manifest host.platform",
      ),
      arch: requireNonEmptyString(raw.host.arch, "raw manifest host.arch"),
      nodeVersion: requireNonEmptyString(
        raw.host.nodeVersion,
        "raw manifest host.nodeVersion",
      ),
    },
    git: {
      head: stringOrNull(raw.git.head, "raw manifest git.head"),
      dirty: booleanOrThrow(raw.git.dirty, "raw manifest git.dirty"),
      changedFileCount: requireNonNegativeInteger(
        raw.git.changedFileCount,
        "raw manifest git.changedFileCount",
      ),
    },
    sourceFingerprint: {
      before: compactFingerprintSide(
        raw.sourceFingerprint.before,
        "raw manifest sourceFingerprint.before",
      ),
      after: compactFingerprintSide(
        raw.sourceFingerprint.after,
        "raw manifest sourceFingerprint.after",
      ),
      unchanged: raw.sourceFingerprint.unchanged,
    },
    stages: raw.stages.map(compactStage),
    runDir: raw.artifacts.runDir,
  };
}

async function detectGitTrackingStatus(filePath) {
  try {
    const lines = await gitLines([
      "status",
      "--porcelain=v1",
      "--",
      toRepoRelative(filePath),
    ]);
    if (lines.length === 0) return "tracked";
    return lines.some((line) => line.startsWith("??") || line.startsWith("!!"))
      ? "untracked"
      : "tracked";
  } catch {
    return "untracked";
  }
}

// Pure destination resolution for mirror writes: containment is enforced
// before any filesystem effect so an adversarial run id can never move a
// mirror outside docs/audits/evidence-manifests, and the rule stays directly
// checkable without touching the repository.
function resolveMirrorDestination(mirrorRoot, runId) {
  const mirrorPath = path.join(mirrorRoot, `${runId}.manifest.json`);
  if (!isInsideRoot(mirrorRoot, mirrorPath)) {
    throw new Error(
      `Evidence mirror path escaped the mirror directory: ${toRepoRelative(mirrorPath)}`,
    );
  }
  return mirrorPath;
}

async function writeMirrorArtifact(composed, runId, rawManifestSha256) {
  assertValidRunId(runId);
  const mirrorPath = resolveMirrorDestination(mirrorDirectory, runId);
  await mkdir(mirrorDirectory, { recursive: true });
  await writeFile(mirrorPath, `${JSON.stringify(composed, null, 2)}\n`, "utf8");
  const gitTrackingStatus = await detectGitTrackingStatus(mirrorPath);
  const withStatus = { ...composed, gitTrackingStatus };
  const withRawDigest = rawManifestSha256
    ? {
        ...withStatus,
        rawManifestSha256,
        rawManifestSha256Subject: rawManifestDigestSubject,
      }
    : withStatus;
  const withMirrorSubject = {
    ...withRawDigest,
    mirrorManifestSha256Subject: mirrorManifestDigestSubject,
  };
  const mirrorManifestSha256 = canonicalSha256WithoutFields(
    withMirrorSubject,
    ["mirrorManifestSha256"],
    "mirror manifest",
  );
  const finalMirror = {
    ...withMirrorSubject,
    mirrorManifestSha256,
  };
  await writeFile(
    mirrorPath,
    `${JSON.stringify(finalMirror, null, 2)}\n`,
    "utf8",
  );
  return { mirrorPath, mirrorManifestSha256, gitTrackingStatus };
}

async function writeManifestAndMirror(manifest, runDir) {
  const manifestSha256 = sha256HexOrThrow(stableJson(manifest), "raw manifest");
  const withDigest = Object.freeze({
    ...manifest,
    manifestSha256,
    manifestSha256Subject: rawManifestDigestSubject,
  });
  const manifestPath = path.join(runDir, "evidence-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(withDigest, null, 2)}\n`,
    "utf8",
  );
  const composed = composeCompactMirror(withDigest);
  const writtenMirror = await writeMirrorArtifact(
    composed,
    manifest.runId,
    manifestSha256,
  );
  return {
    manifestSha256,
    manifestPath,
    ...writtenMirror,
    outcome: withDigest.outcome,
    failureReasons: withDigest.failureReasons,
  };
}

async function finalize(context, runDir, completion, collectionError) {
  const afterAvailable = completion.afterFingerprint !== null;
  const afterFingerprint = completion.afterFingerprint ?? {
    algorithm: context.beforeFingerprint.algorithm,
    recipe: null,
    digest: null,
    fileCount: null,
    symlinkCount: null,
    deletedCount: null,
    unavailableReason:
      completion.unavailableReason ??
      "source fingerprint could not be computed after the stages",
  };
  const sourceUnchanged =
    afterAvailable &&
    stableJson(context.beforeFingerprint) ===
      stableJson(completion.afterFingerprint);
  const failureReasons = collectFailureReasons(
    context.stages,
    context.beforeFingerprint,
    completion.afterFingerprint,
  );
  if (!afterAvailable) {
    failureReasons.push(
      "source fingerprint could not be verified after the stages",
    );
  }
  if (collectionError) {
    failureReasons.push(`collection error: ${collectionError}`);
  }
  const artifactFiles = await inventoryArtifacts(runDir);
  const manifest = {
    kind: manifestKind,
    schemaVersion: manifestSchemaVersion,
    runId: context.runId,
    createdAt: context.createdAt,
    completedAt: completion.completedAt,
    host: context.host,
    git: {
      head: context.git.head,
      dirty: context.git.dirty,
      changedFileCount: context.git.status.length,
      status: context.git.status,
    },
    sourceFingerprint: {
      before: context.beforeFingerprint,
      after: afterFingerprint,
      unchanged: sourceUnchanged,
    },
    gates: { budgetGate: "stage_exit_code" },
    stages: context.stages,
    outcome: failureReasons.length === 0 ? "passed" : "failed",
    failureReasons,
    artifacts: { runDir: toRepoRelative(runDir), files: artifactFiles },
  };
  return writeManifestAndMirror(manifest, runDir);
}

async function reserveRunDirectory(now) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const runId = createRunId(now);
    const runDir = path.join(artifactReleaseRoot, runId);
    if (!existsSync(runDir)) {
      await mkdir(runDir, { recursive: true });
      return { runId, runDir };
    }
  }
  throw new Error("Unable to reserve a unique release evidence run directory");
}

async function runCollection() {
  const clockStart = new Date();
  const context = {
    runId: null,
    createdAt: clockStart.toISOString(),
    host: hostBasics(),
    git: null,
    beforeFingerprint: null,
    stages: [],
  };
  let runDir = null;
  let collectionError = null;
  try {
    context.git = await collectGitMetadata();
    context.beforeFingerprint = await computeSourceFingerprint();
  } catch (error) {
    console.error(
      `[test:evidence] preflight failed before any run directory was reserved: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    const reserved = await reserveRunDirectory(clockStart);
    context.runId = reserved.runId;
    runDir = reserved.runDir;
    const stageScripts = await loadStageScripts();
    const invocation = requirePackageManagerInvocation();
    for (const entry of stageScripts) {
      const plan = buildStagePlan(entry, runDir, invocation);
      const execution = await runStage(plan, invocation, runDir);
      context.stages.push(
        await buildStageEvidence(plan, invocation, execution, runDir),
      );
      console.log(
        `[test:evidence] stage ${plan.id} exit=${execution.exitCode} duration=${execution.durationMs}ms`,
      );
    }
  } catch (error) {
    collectionError = error instanceof Error ? error.message : String(error);
    console.error(`[test:evidence] collection error: ${collectionError}`);
  }
  if (!runDir || !context.git || !context.beforeFingerprint) {
    process.exitCode = 1;
    return;
  }
  // An after-fingerprint failure must never discard completed stage evidence:
  // it is wrapped into an explicit unavailable reason so finalize can still
  // write a truthful failed manifest with after.digest=null.
  let afterFingerprint = null;
  let afterUnavailableReason = null;
  if (collectionError === null) {
    try {
      afterFingerprint = await computeSourceFingerprint();
    } catch (error) {
      afterUnavailableReason =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[test:evidence] after-fingerprint failure: ${afterUnavailableReason}`,
      );
    }
  }
  try {
    const written = await finalize(
      context,
      runDir,
      {
        afterFingerprint,
        unavailableReason: afterUnavailableReason,
        completedAt: new Date().toISOString(),
      },
      collectionError,
    );
    console.log(
      `[test:evidence] run ${context.runId} outcome=${written.outcome}`,
    );
    if (written.outcome !== "passed") {
      for (const reason of written.failureReasons) {
        console.error(`[test:evidence] failure: ${reason}`);
      }
    }
    console.log(
      `[test:evidence] manifest ${toRepoRelative(written.manifestPath)} sha256=${written.manifestSha256}`,
    );
    console.log(
      `[test:evidence] mirror ${toRepoRelative(written.mirrorPath)} sha256=${written.mirrorManifestSha256} gitTrackingStatus=${written.gitTrackingStatus}`,
    );
    process.exitCode = written.outcome === "passed" ? 0 : 1;
  } catch (error) {
    console.error(
      `[test:evidence] unable to write evidence manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function runDryPlan() {
  const stageScripts = await loadStageScripts();
  let invocation;
  try {
    invocation = requirePackageManagerInvocation();
  } catch (error) {
    invocation = null;
    console.error(
      `[test:evidence] resolution failure: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
  const placeholderDir = path.join(artifactReleaseRoot, "<runId>");
  const plan = {
    repositoryRoot: ".",
    artifactsRoot: toRepoRelative(artifactReleaseRoot),
    mirrorDirectory: toRepoRelative(mirrorDirectory),
    packageManager: invocation
      ? {
          command: invocation.command,
          entryPoint: invocation.entryPoint,
          source: invocation.source,
        }
      : null,
    stages: stageScripts.map((entry) => {
      if (!invocation) return { key: entry.key, script: entry.script };
      const prepared = buildStagePlan(entry, placeholderDir, invocation);
      return {
        key: prepared.scriptKey,
        id: prepared.id,
        script: prepared.commandLine,
        argv: prepared.argv.map((argument) =>
          argument.startsWith("--outputFile.")
            ? argument.split("=")[0]
            : argument,
        ),
        outputs: { json: prepared.jsonFile, junit: prepared.junitFile },
      };
    }),
  };
  console.log(JSON.stringify(plan, null, 2));
}

async function runSelfCheck() {
  const checks = [];
  const errorOf = (error) =>
    error instanceof Error ? error.message : String(error);
  const expect = (name, condition) => {
    checks.push({ name, ok: Boolean(condition) });
  };

  expect(
    "tokenizes a simple vitest invocation",
    JSON.stringify(tokenizeScript("vitest run --maxWorkers=1")) ===
      JSON.stringify(["vitest", "run", "--maxWorkers=1"]),
  );
  let rejectedMetacharacters = false;
  try {
    tokenizeScript('vitest run && echo "nope"');
  } catch {
    rejectedMetacharacters = true;
  }
  expect("rejects shell metacharacters", rejectedMetacharacters);
  let rejectedNonVitest = false;
  try {
    tokenizeScript("echo hello");
  } catch {
    rejectedNonVitest = true;
  }
  expect("rejects non-vitest commands", rejectedNonVitest);

  const stageScripts = await loadStageScripts().catch(() => null);
  expect("loads live canonical scripts", Array.isArray(stageScripts));
  let invocation = null;
  try {
    invocation = requirePackageManagerInvocation();
  } catch {
    invocation = null;
  }
  expect(
    "resolves a shell-free package-manager invocation",
    Boolean(invocation),
  );
  if (invocation) {
    expect(
      "invocation runs a pnpm JavaScript entry via the current node executable",
      invocation.command === process.execPath &&
        invocation.argsPrefix.length === 1,
    );
  }
  if (Array.isArray(stageScripts)) {
    expect(
      "live canonical stage keys match configuration",
      JSON.stringify(stageScripts.map((entry) => entry.key)) ===
        JSON.stringify(stageKeys),
    );
    const placeholderDir = path.join(artifactReleaseRoot, "<runId>");
    for (const entry of stageScripts) {
      const tokens = tokenizeScript(entry.script);
      expect(`live ${entry.key} still invokes vitest`, tokens[0] === "vitest");
      const plan = buildStagePlan(
        entry,
        placeholderDir,
        invocation ?? { argsPrefix: [], source: "self-check-stub" },
      );
      expect(
        `live ${plan.id} plan keeps command line plus reporters`,
        plan.commandLine === entry.script &&
          plan.argv.includes("exec") &&
          plan.argv.includes("--reporter=default") &&
          plan.argv.includes("--reporter=json") &&
          plan.argv.includes("--reporter=junit"),
      );
      expect(
        `live ${plan.id} plan pins explicit output files`,
        plan.argv.some((argument) =>
          argument.startsWith("--outputFile.json="),
        ) &&
          plan.argv.some((argument) =>
            argument.startsWith("--outputFile.junit="),
          ),
      );
    }
  }

  expect(
    "current source excludes stay enforced",
    isExcludedSource("node_modules/x/y.js") &&
      isExcludedSource("test-artifacts/release/run/log.txt") &&
      isExcludedSource(".git/config") &&
      isExcludedSource("dist/bundle.js") &&
      !isExcludedSource("scripts/collect-release-evidence.mjs"),
  );
  expect(
    "generated evidence mirrors are excluded without over-matching adjacent audits",
    isExcludedSource("docs/audits/evidence-manifests") &&
      isExcludedSource(
        "docs/audits/evidence-manifests/release-run.manifest.json",
      ) &&
      isExcludedSource(
        "docs/audits/evidence-manifests/nested/deep/run.manifest.json",
      ) &&
      !isExcludedSource("docs/TESTING.md") &&
      !isExcludedSource(
        "docs/audits/DESKTOP_APP_COMPUTER_USE_USABILITY_AUDIT_2026-08-10.md",
      ) &&
      !isExcludedSource(
        "docs/audits/assets/desktop-app-computer-use-usability-2026-08-10/screenshot.png",
      ) &&
      !isExcludedSource("docs/audits/evidence-manifests-backup/old.json"),
  );

  const jsonFixture = {
    numTotalTestSuites: 2,
    numTotalTests: 4,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 1,
    numTodoTests: 1,
    success: false,
    testResults: [
      {
        name: "suite-a.test.ts",
        assertionResults: [
          { ancestorTitles: ["A"], title: "passes", status: "passed" },
          { ancestorTitles: ["A"], title: "fails", status: "failed" },
        ],
      },
      {
        name: "suite-b.test.ts",
        assertionResults: [
          { ancestorTitles: ["B"], title: "skips", status: "skipped" },
          { ancestorTitles: [], title: "todos", status: "todo" },
        ],
      },
    ],
  };
  const summarized = summarizeJsonResults(jsonFixture);
  expect(
    "json counts",
    JSON.stringify(summarized.counts) ===
      JSON.stringify({
        totalTestSuites: 2,
        totalTests: 4,
        passedTests: 1,
        failedTests: 1,
        pendingTests: 1,
        todoTests: 1,
      }),
  );
  expect(
    "explicit skip list",
    summarized.skipped.length === 1 &&
      summarized.skipped[0].title === "skips" &&
      summarized.skipped[0].file === "suite-b.test.ts",
  );
  expect(
    "explicit todo list",
    summarized.todo.length === 1 && summarized.todo[0].title === "todos",
  );
  expect("json reports success=false verbatim", summarized.success === false);

  const junitSummary = summarizeJunitXml(
    '<testsuites><testsuite name="x" tests="4" failures="1" errors="0" skipped="2"></testsuite></testsuites>',
  );
  expect(
    "junit summary folds per-suite attributes",
    junitSummary.suites === 1 &&
      junitSummary.tests === 4 &&
      junitSummary.failures === 1 &&
      junitSummary.errors === 0 &&
      junitSummary.skipped === 2,
  );
  expect(
    "json/junit consistency mapping folds errors into failures and todo into skipped",
    summarized.counts.failedTests ===
      junitSummary.failures + junitSummary.errors &&
      summarized.counts.pendingTests + summarized.counts.todoTests ===
        junitSummary.skipped,
  );

  const healthyStage = () => ({
    id: "correctness",
    spawnError: null,
    signal: null,
    exitCode: 0,
    outputs: {
      json: { bytes: 10, sha256: "b".repeat(64) },
      junit: { bytes: 10, sha256: "c".repeat(64) },
    },
    structuredResultsParsed: true,
    counts: {
      totalTestSuites: 1,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      pendingTests: 0,
      todoTests: 0,
    },
    reportedSuccess: true,
    junitSummary: { suites: 1, tests: 2, failures: 0, errors: 0, skipped: 0 },
    junitParseError: null,
    consistency: {
      totalTestsMatchJunit: true,
      failuresMatchJunit: true,
      skippedMatchJunit: true,
    },
  });
  const fingerprintBeforeAfter = (digest) => ({
    algorithm: "sha256",
    recipe: sourceFingerprintRecipe,
    digest,
    fileCount: 2,
    symlinkCount: 0,
    deletedCount: 0,
  });
  const reasonsFor = (overrides) =>
    collectFailureReasons(
      [{ ...healthyStage(), ...overrides }],
      fingerprintBeforeAfter("a".repeat(64)),
      fingerprintBeforeAfter("a".repeat(64)),
    );
  expect(
    "healthy stage produces no failure reasons",
    reasonsFor({}).length === 0,
  );
  expect(
    "fails closed on reported success=false",
    reasonsFor({ reportedSuccess: false }).some((reason) =>
      reason.includes("success=false"),
    ),
  );
  expect(
    "fails closed on failed tests",
    reasonsFor({
      counts: { ...healthyStage().counts, failedTests: 1, passedTests: 1 },
      reportedSuccess: false,
      consistency: {
        totalTestsMatchJunit: true,
        failuresMatchJunit: false,
        skippedMatchJunit: true,
      },
    }).some((reason) => reason.includes("failed test")),
  );
  expect(
    "fails closed on zero total tests",
    reasonsFor({
      counts: { ...healthyStage().counts, totalTests: 0, passedTests: 0 },
    }).some((reason) => reason.includes("zero total tests")),
  );
  expect(
    "fails closed on missing JSON results file",
    reasonsFor({ outputs: { ...healthyStage().outputs, json: null } }).some(
      (reason) => reason.includes("missing the required JSON results file"),
    ),
  );
  expect(
    "fails closed on missing JUnit report file",
    reasonsFor({ outputs: { ...healthyStage().outputs, junit: null } }).some(
      (reason) => reason.includes("missing the required JUnit report file"),
    ),
  );
  expect(
    "fails closed on unparsable structured results",
    reasonsFor({
      structuredResultsParsed: false,
      counts: null,
      reportedSuccess: null,
      explicitSkipped: null,
      explicitTodo: null,
      junitSummary: null,
      consistency: {
        totalTestsMatchJunit: null,
        failuresMatchJunit: null,
        skippedMatchJunit: null,
      },
    }).some((reason) =>
      reason.includes("produced no parsable structured results"),
    ),
  );
  expect(
    "fails closed on unparsable JUnit report",
    reasonsFor({
      junitSummary: null,
      junitParseError: "boom",
      consistency: {
        totalTestsMatchJunit: null,
        failuresMatchJunit: null,
        skippedMatchJunit: null,
      },
    }).some((reason) => reason.includes("no parsable JUnit summary")),
  );
  expect(
    "fails closed on JSON/JUnit totals divergence",
    reasonsFor({
      consistency: {
        totalTestsMatchJunit: false,
        failuresMatchJunit: true,
        skippedMatchJunit: true,
      },
    }).some((reason) => reason.includes("totalTests 2 diverges from JUnit")),
  );
  expect(
    "fails closed on JSON/JUnit failures divergence",
    reasonsFor({
      consistency: {
        totalTestsMatchJunit: true,
        failuresMatchJunit: false,
        skippedMatchJunit: true,
      },
    }).some((reason) => reason.includes("diverges from JUnit failures+errors")),
  );
  expect(
    "fails closed on JSON/JUnit skips divergence",
    reasonsFor({
      counts: { ...healthyStage().counts, pendingTests: 1 },
      junitSummary: { suites: 1, tests: 2, failures: 0, errors: 0, skipped: 0 },
      consistency: {
        totalTestsMatchJunit: true,
        failuresMatchJunit: true,
        skippedMatchJunit: false,
      },
    }).some((reason) => reason.includes("diverges from JUnit skipped")),
  );
  expect(
    "fails closed on changed source fingerprint",
    collectFailureReasons(
      [healthyStage()],
      fingerprintBeforeAfter("a".repeat(64)),
      fingerprintBeforeAfter("d".repeat(64)),
    ).some((reason) => reason.includes("source fingerprint changed")),
  );
  expect(
    "an unavailable after fingerprint never produces an identical-digest changed reason",
    !collectFailureReasons(
      [healthyStage()],
      fingerprintBeforeAfter("a".repeat(64)),
      null,
    ).some((reason) => reason.includes("source fingerprint changed")),
  );

  expect(
    "stable json is key-order independent",
    stableJson({ b: 1, a: { d: 2, c: 3 } }) ===
      stableJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  expect(
    "raw manifest digest subject strips its own digest fields",
    canonicalSha256WithoutFields(
      { kind: "x", manifestSha256: "stale", manifestSha256Subject: "old" },
      ["manifestSha256", "manifestSha256Subject"],
      "raw manifest",
    ) === sha256Hex(stableJson({ kind: "x" })),
  );
  const sampleMirror = {
    kind: "x",
    outcome: "failed",
    failureReasons: ["stage correctness exited with code 1"],
    stages: [{ id: "correctness", commandLine: "vitest run", exitCode: 1 }],
    artifacts: {
      files: [{ path: "a.json", bytes: 3, sha256: "d".repeat(64) }],
    },
    gitTrackingStatus: "untracked",
    rawManifestSha256: "e".repeat(64),
    rawManifestSha256Subject: rawManifestDigestSubject,
    mirrorManifestSha256: "stale",
    mirrorManifestSha256Subject: mirrorManifestDigestSubject,
  };
  const mirrorDigest = (value) =>
    canonicalSha256WithoutFields(
      value,
      ["mirrorManifestSha256"],
      "mirror manifest",
    );
  const baselineMirrorDigest = mirrorDigest(sampleMirror);
  const mirroredPayload = { ...sampleMirror };
  delete mirroredPayload.mirrorManifestSha256;
  expect(
    "mirror digest strips only its own field and keeps both subjects plus the raw pointer in scope",
    baselineMirrorDigest === sha256Hex(stableJson(mirroredPayload)),
  );
  expect(
    "tampered raw manifest pointer invalidates the mirror digest",
    mirrorDigest({ ...sampleMirror, rawManifestSha256: "f".repeat(64) }) !==
      baselineMirrorDigest,
  );
  expect(
    "tampered raw manifest subject invalidates the mirror digest",
    mirrorDigest({ ...sampleMirror, rawManifestSha256Subject: "other" }) !==
      baselineMirrorDigest,
  );
  expect(
    "tampered outcome and failure reasons invalidate the mirror digest",
    mirrorDigest({ ...sampleMirror, outcome: "passed" }) !==
      baselineMirrorDigest &&
      mirrorDigest({ ...sampleMirror, failureReasons: [] }) !==
        baselineMirrorDigest,
  );
  expect(
    "tampered stage commands invalidate the mirror digest",
    mirrorDigest({
      ...sampleMirror,
      stages: [
        { id: "correctness", commandLine: "vitest run --changed", exitCode: 1 },
      ],
    }) !== baselineMirrorDigest,
  );
  expect(
    "tampered artifact hashes invalidate the mirror digest",
    mirrorDigest({
      ...sampleMirror,
      artifacts: {
        files: [{ path: "a.json", bytes: 3, sha256: "0".repeat(64) }],
      },
    }) !== baselineMirrorDigest,
  );
  expect(
    "tampered mirror subject invalidates the mirror digest",
    mirrorDigest({ ...sampleMirror, mirrorManifestSha256Subject: "other" }) !==
      baselineMirrorDigest,
  );
  expect(
    "strict hex digests accept only 64-char lowercase hex",
    isStrictSha256Hex("a".repeat(64)) &&
      !isStrictSha256Hex("a".repeat(63)) &&
      !isStrictSha256Hex("A".repeat(64)) &&
      !isStrictSha256Hex("g".repeat(64)) &&
      !isStrictSha256Hex(null) &&
      !isStrictSha256Hex(`${"a".repeat(63)} (unverified)`),
  );
  expect(
    "sha256 hex digest shape",
    /^[0-9a-f]{64}$/u.test(sha256Hex("nestor")),
  );
  expect(
    "run id shape",
    /^release-\d{8}T\d{6}-[0-9a-f]{6}$/u.test(createRunId(new Date())),
  );

  expect(
    "run ids must match the exact release pattern",
    (() => {
      for (const invalidRunId of [
        "",
        "not-a-run-id",
        "release-20260824T120000",
        "release-20260824T120000-ABCDE1",
        "release-20260824T120000-abc",
        "release-20260824T120000-abcdef0",
        "Release-20260824T120000-abcdef",
        "release-2026-08-24T12:00:00-abcdef",
      ]) {
        try {
          assertValidRunId(invalidRunId);
          return false;
        } catch (error) {
          if (!/exact release pattern/.test(errorOf(error))) return false;
        }
      }
      try {
        assertValidRunId(createRunId(new Date()));
        return true;
      } catch {
        return false;
      }
    })(),
  );

  let bothDigestAndReasonError = null;
  try {
    compactFingerprintSide(
      {
        recipe: sourceFingerprintRecipe,
        digest: "a".repeat(64),
        fileCount: 1,
        symlinkCount: 0,
        deletedCount: 0,
        unavailableReason: "must not coexist with a digest",
      },
      "fixture.before",
    );
  } catch (error) {
    bothDigestAndReasonError = errorOf(error);
  }
  expect(
    "a fingerprint side carrying both a digest and an unavailableReason fails closed",
    bothDigestAndReasonError !== null &&
      /carries both a digest and an unavailableReason/.test(
        bothDigestAndReasonError,
      ),
  );
  const unavailableProjection = compactFingerprintSide(
    { unavailableReason: "source fingerprint could not be computed" },
    "fixture.after",
  );
  const digestProjection = compactFingerprintSide(
    {
      recipe: sourceFingerprintRecipe,
      digest: "a".repeat(64),
      fileCount: 1,
      symlinkCount: 2,
      deletedCount: 3,
    },
    "fixture.digest-side",
  );
  expect(
    "unavailable and available fingerprint sides project exclusively",
    unavailableProjection.digest === null &&
      unavailableProjection.recipe === null &&
      unavailableProjection.unavailableReason ===
        "source fingerprint could not be computed" &&
      !("unavailableReason" in digestProjection) &&
      digestProjection.digest === "a".repeat(64),
  );

  const legacyComposed = composeCompactMirror({
    kind: manifestKind,
    schemaVersion: 3,
    runId: "release-20240101T000000-abcdef",
    createdAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:10:00.000Z",
    host: { platform: "darwin", arch: "arm64", nodeVersion: process.version },
    git: { head: null, dirty: true, changedFileCount: 0 },
    sourceFingerprint: {
      before: { algorithm: "sha256" },
      after: { algorithm: "sha256" },
      unchanged: true,
    },
    stages: [],
    outcome: "passed",
    failureReasons: [],
    artifacts: { runDir: "test-artifacts/release/legacy", files: [] },
  });
  expect(
    "schema-v3 legacy fingerprint sides project with explicit nulls instead of invented kind-bound values",
    legacyComposed.schemaVersion === 3 &&
      ["before", "after"].every((side) => {
        const projected = legacyComposed.sourceFingerprint[side];
        return (
          projected.recipe === null &&
          projected.digest === null &&
          projected.fileCount === null &&
          projected.symlinkCount === null &&
          projected.deletedCount === null &&
          !("unavailableReason" in projected)
        );
      }),
  );

  expect(
    "the canonical mirror destination resolves inside the contained mirror directory without writing anything",
    resolveMirrorDestination(
      mirrorDirectory,
      "release-20260824T120000-abcdef",
    ).startsWith(`${mirrorDirectory}${path.sep}`),
  );
  let containmentError = null;
  try {
    resolveMirrorDestination(mirrorDirectory, "../evidence-manifests-escape");
  } catch (error) {
    containmentError = errorOf(error);
  }
  expect(
    "an adversarial mirror name fails closed against the contained mirror directory before any write",
    containmentError !== null &&
      /escaped the mirror directory/.test(containmentError),
  );

  // Behavioral guards against a disposable Git fixture: creating or rewriting
  // a generated mirror under docs/audits/evidence-manifests must leave the
  // collector source fingerprint unchanged, an edit to a neighboring
  // human-authored audit document must still be detected, enumeration must be
  // NUL-safe for exotic filenames, contained symlinks are recorded as explicit
  // kind-bound entries while broken/escaping/non-enumerated ones fail closed,
  // Git-declared unstaged deletions fingerprint stably without any index
  // mutation, undeclared vanish races and directories/special entries fail
  // closed, and the declared deletion set must stay a defensive subset of the
  // enumerated paths.
  const approvedTempRoot = path.join(os.tmpdir(), "opencode");
  await mkdir(approvedTempRoot, { recursive: true });
  const fingerprintFixtureRoot = await mkdtemp(
    path.join(approvedTempRoot, "evidence-fingerprint-"),
  );
  const gitFixture = async (args) =>
    execFileAsync(process.platform === "win32" ? "git.exe" : "git", args, {
      cwd: fingerprintFixtureRoot,
      windowsHide: true,
    });
  try {
    await gitFixture(["init", "-q"]);
    const writeFixtureFile = async (relativePath, contents) => {
      const fullPath = path.join(fingerprintFixtureRoot, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents, "utf8");
    };
    await writeFixtureFile("src/product.ts", "export const product = 1;\n");
    await writeFixtureFile(
      "docs/audits/HUMAN_REVIEW.md",
      "# human-authored review\n",
    );
    await writeFixtureFile(
      "src/new\nline-name.txt",
      "newline-bearing filename\n",
    );
    await writeFixtureFile("src/tab\tname.txt", "tab-bearing filename\n");
    await writeFixtureFile("src/unicode-é-名前-🎯.txt", "unicode filename\n");
    const initialFingerprint = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    const initialRerun = await computeSourceFingerprint(fingerprintFixtureRoot);
    expect(
      "consecutive collector fingerprints are identical across every scalar field",
      stableJson(initialFingerprint) === stableJson(initialRerun),
    );
    expect(
      "fingerprint result carries the named recipe and kind-bound counts",
      initialFingerprint.recipe === sourceFingerprintRecipe &&
        /^[0-9a-f]{64}$/u.test(initialFingerprint.digest) &&
        initialFingerprint.fileCount === 5 &&
        initialFingerprint.symlinkCount === 0 &&
        initialFingerprint.deletedCount === 0,
    );
    if (process.platform !== "win32") {
      const chmodProbePath = path.join(
        fingerprintFixtureRoot,
        "src",
        "product.ts",
      );
      const chmodProbePriorMode = (await lstat(chmodProbePath)).mode & 0o777;
      await chmod(chmodProbePath, chmodProbePriorMode ^ 0o200);
      const afterChmodOnly = await computeSourceFingerprint(
        fingerprintFixtureRoot,
      );
      expect(
        "a chmod-only mutation changes the digest under the mode-bound recipe without moving any count",
        afterChmodOnly.digest !== initialFingerprint.digest &&
          afterChmodOnly.fileCount === initialFingerprint.fileCount &&
          afterChmodOnly.symlinkCount === 0 &&
          afterChmodOnly.deletedCount === 0 &&
          stableJson(afterChmodOnly) !== stableJson(initialFingerprint),
      );
      await chmod(chmodProbePath, chmodProbePriorMode);
      expect(
        "restoring the exact permission bits restores the exact pre-chmod fingerprint",
        stableJson(await computeSourceFingerprint(fingerprintFixtureRoot)) ===
          stableJson(initialFingerprint),
      );
    }
    await writeFixtureFile(
      "docs/audits/evidence-manifests/release-fixture.manifest.json",
      "{\n}\n",
    );
    const afterMirrorWrite = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    expect(
      "writing an evidence mirror leaves the collector source fingerprint unchanged",
      stableJson(afterMirrorWrite) === stableJson(initialFingerprint),
    );
    await writeFixtureFile(
      "docs/audits/HUMAN_REVIEW.md",
      "# human-authored review\nedited\n",
    );
    const afterAdjacentEdit = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    expect(
      "an adjacent human-authored audit edit still changes the collector source fingerprint",
      afterAdjacentEdit.digest !== initialFingerprint.digest &&
        afterAdjacentEdit.fileCount === initialFingerprint.fileCount,
    );
    const exoticBeforeEdit = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    await writeFixtureFile(
      "src/new\nline-name.txt",
      "newline-bearing filename\nedited\n",
    );
    await writeFixtureFile(
      "src/tab\tname.txt",
      "tab-bearing filename\nedited\n",
    );
    await writeFixtureFile(
      "src/unicode-é-名前-🎯.txt",
      "unicode filename\nedited\n",
    );
    const afterExoticEdits = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    expect(
      "newline-, tab-, and unicode-bearing source filenames are enumerated NUL-safely and bound byte-for-byte",
      afterExoticEdits.digest !== exoticBeforeEdit.digest &&
        afterExoticEdits.fileCount === exoticBeforeEdit.fileCount &&
        afterExoticEdits.deletedCount === 0,
    );

    if (process.platform !== "win32") {
      await symlink(
        "product.ts",
        path.join(fingerprintFixtureRoot, "src", "link.ts"),
      );
      const withLink = await computeSourceFingerprint(fingerprintFixtureRoot);
      expect(
        "a contained symlink to an enumerated ordinary file is recorded explicitly and stably",
        withLink.symlinkCount === 1 &&
          withLink.fileCount === afterExoticEdits.fileCount &&
          withLink.deletedCount === 0 &&
          withLink.digest !== afterExoticEdits.digest &&
          stableJson(withLink) ===
            stableJson(await computeSourceFingerprint(fingerprintFixtureRoot)),
      );

      await symlink(
        "../../outside-escape.txt",
        path.join(fingerprintFixtureRoot, "src", "escape-link.ts"),
      );
      let escapeError = null;
      try {
        await computeSourceFingerprint(fingerprintFixtureRoot);
      } catch (error) {
        escapeError = errorOf(error);
      }
      expect(
        "an escaping symlink fails closed",
        escapeError !== null && /escapes/.test(escapeError),
      );
      await rm(path.join(fingerprintFixtureRoot, "src", "escape-link.ts"));

      await symlink(
        "missing-target.ts",
        path.join(fingerprintFixtureRoot, "src", "broken-link.ts"),
      );
      let brokenError = null;
      try {
        await computeSourceFingerprint(fingerprintFixtureRoot);
      } catch (error) {
        brokenError = errorOf(error);
      }
      expect(
        "a broken symlink fails closed",
        brokenError !== null && /is broken/.test(brokenError),
      );
      await rm(path.join(fingerprintFixtureRoot, "src", "broken-link.ts"));

      await symlink(
        ".",
        path.join(fingerprintFixtureRoot, "src", "dir-link.ts"),
      );
      let directoryTargetError = null;
      try {
        await computeSourceFingerprint(fingerprintFixtureRoot);
      } catch (error) {
        directoryTargetError = errorOf(error);
      }
      expect(
        "a symlink to a non-file target fails closed",
        directoryTargetError !== null &&
          /non-file target/.test(directoryTargetError),
      );
      await rm(path.join(fingerprintFixtureRoot, "src", "dir-link.ts"));

      await rm(path.join(fingerprintFixtureRoot, "src", "link.ts"));
    }

    let vanishedError = null;
    try {
      await fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, [
        "src/vanished-between-enumeration-and-read.txt",
      ]);
    } catch (error) {
      vanishedError = errorOf(error);
    }
    expect(
      "a path that disappears without a Git deletion declaration fails closed as a named race",
      vanishedError !== null &&
        /disappeared between enumeration and hashing/.test(vanishedError),
    );

    let directoryError = null;
    try {
      await fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, ["src"]);
    } catch (error) {
      directoryError = errorOf(error);
    }
    expect(
      "a directory fails closed as an unsupported source entry",
      directoryError !== null &&
        /Unsupported source entry type for/.test(directoryError),
    );

    if (process.platform !== "win32") {
      const fifoFullPath = path.join(fingerprintFixtureRoot, "special.fifo");
      let fifoReady = true;
      try {
        await execFileAsync("mkfifo", [fifoFullPath]);
      } catch {
        fifoReady = false;
      }
      if (fifoReady) {
        let specialError = null;
        try {
          await fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, [
            "special.fifo",
          ]);
        } catch (error) {
          specialError = errorOf(error);
        }
        expect(
          "a special (fifo) entry fails closed as an unsupported source entry",
          specialError !== null &&
            /Unsupported source entry type for/.test(specialError),
        );
        await rm(fifoFullPath, { force: true });
      }
    }

    await gitFixture(["add", "docs/audits/HUMAN_REVIEW.md"]);
    await rm(path.join(fingerprintFixtureRoot, "docs/audits/HUMAN_REVIEW.md"));
    const deletedFirst = await computeSourceFingerprint(fingerprintFixtureRoot);
    const deletedSecond = await computeSourceFingerprint(
      fingerprintFixtureRoot,
    );
    expect(
      "a Git-declared tracked unstaged deletion fingerprints stably as an explicit deleted kind",
      deletedFirst.deletedCount === 1 &&
        deletedFirst.symlinkCount === 0 &&
        deletedFirst.fileCount === afterExoticEdits.fileCount - 1 &&
        stableJson(deletedFirst) === stableJson(deletedSecond) &&
        deletedFirst.digest !== afterExoticEdits.digest,
    );

    let undeclaredDeletedError = null;
    try {
      await fingerprintEnumeratedSourcePaths(fingerprintFixtureRoot, [
        "docs/audits/HUMAN_REVIEW.md",
      ]);
    } catch (error) {
      undeclaredDeletedError = errorOf(error);
    }
    expect(
      "the same vanished path stays a race failure when no deletion set is supplied",
      undeclaredDeletedError !== null &&
        /disappeared between enumeration and hashing/.test(
          undeclaredDeletedError,
        ),
    );

    let subsetError = null;
    try {
      await fingerprintEnumeratedSourcePaths(
        fingerprintFixtureRoot,
        ["src/product.ts"],
        { declaredDeletions: ["ghost/never-enumerated.txt"] },
      );
    } catch (error) {
      subsetError = errorOf(error);
    }
    expect(
      "a declared deletion outside the enumerated set fails closed defensively",
      subsetError !== null &&
        /not a subset of enumerated source paths/.test(subsetError),
    );
  } finally {
    await rm(fingerprintFixtureRoot, { recursive: true, force: true });
  }

  // Rebuild binding, proven against disposable temp copies only: a raw
  // manifest whose stored manifestSha256 disagrees with its recomputed subject
  // digest is tampered output and must be rejected before any mirror is
  // rebuilt, while the legacy no-stored-hash form stays rebuildable with a
  // freshly recomputed digest. Nothing under the repository mirror directory
  // is read or written here.
  const approvedRebuildTempRoot = path.join(os.tmpdir(), "opencode");
  await mkdir(approvedRebuildTempRoot, { recursive: true });
  const rebuildBindingFixtureDir = await mkdtemp(
    path.join(approvedRebuildTempRoot, "evidence-rebuild-binding-"),
  );
  try {
    const rawManifestFixture = (overrides) => ({
      kind: manifestKind,
      schemaVersion: manifestSchemaVersion,
      runId: "release-20250101T000000-1a2b3c",
      createdAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:05:00.000Z",
      host: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
      git: { head: null, dirty: false, changedFileCount: 0 },
      sourceFingerprint: {
        before: {
          recipe: sourceFingerprintRecipe,
          digest: "a".repeat(64),
          fileCount: 1,
          symlinkCount: 0,
          deletedCount: 0,
        },
        after: {
          recipe: sourceFingerprintRecipe,
          digest: "a".repeat(64),
          fileCount: 1,
          symlinkCount: 0,
          deletedCount: 0,
        },
        unchanged: true,
      },
      stages: [],
      outcome: "passed",
      failureReasons: [],
      artifacts: {
        runDir: "test-artifacts/release/release-20250101T000000-1a2b3c",
        files: [],
      },
      ...overrides,
    });
    const writeFixtureManifest = async (fileName, payload) => {
      const fixturePath = path.join(rebuildBindingFixtureDir, fileName);
      await writeFile(
        fixturePath,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      return fixturePath;
    };
    const genuineManifest = (() => {
      const manifest = rawManifestFixture();
      const manifestSha256 = canonicalSha256WithoutFields(
        manifest,
        ["manifestSha256", "manifestSha256Subject"],
        "raw manifest",
      );
      return {
        ...manifest,
        manifestSha256,
        manifestSha256Subject: rawManifestDigestSubject,
      };
    })();
    const genuinePath = await writeFixtureManifest(
      "evidence-manifest.json",
      genuineManifest,
    );
    const genuineVerified = await loadVerifiedRawManifest(genuinePath);
    expect(
      "a raw manifest matching its stored manifestSha256 verifies for rebuild",
      genuineVerified.rawManifestSha256 === genuineManifest.manifestSha256 &&
        genuineVerified.raw.runId === genuineManifest.runId &&
        genuineVerified.raw.outcome === "passed",
    );

    const tamperedPath = await writeFixtureManifest("tampered.json", {
      ...genuineManifest,
      outcome: "failed",
      failureReasons: ["rewritten after collection"],
    });
    let tamperError = null;
    try {
      await loadVerifiedRawManifest(tamperedPath);
    } catch (error) {
      tamperError = errorOf(error);
    }
    expect(
      "a tampered raw manifest fails its stored manifestSha256 binding",
      tamperError !== null &&
        /manifestSha256 binding/.test(tamperError) &&
        /tampered raw output/.test(tamperError),
    );

    const staleHashPath = await writeFixtureManifest("stale-hash.json", {
      ...genuineManifest,
      manifestSha256: "b".repeat(64),
    });
    let staleHashError = null;
    try {
      await loadVerifiedRawManifest(staleHashPath);
    } catch (error) {
      staleHashError = errorOf(error);
    }
    expect(
      "a stale stored manifestSha256 rejects the rebuild",
      staleHashError !== null && /manifestSha256 binding/.test(staleHashError),
    );

    const malformedHashPath = await writeFixtureManifest(
      "malformed-hash.json",
      { ...genuineManifest, manifestSha256: "not-a-digest" },
    );
    let malformedHashError = null;
    try {
      await loadVerifiedRawManifest(malformedHashPath);
    } catch (error) {
      malformedHashError = errorOf(error);
    }
    expect(
      "a malformed stored manifestSha256 fails closed",
      malformedHashError !== null &&
        /not strict 64-char lowercase hex/.test(malformedHashError),
    );

    const legacyManifest = rawManifestFixture({ schemaVersion: 3 });
    const legacyPath = await writeFixtureManifest(
      "legacy-no-hash.json",
      legacyManifest,
    );
    const legacyVerified = await loadVerifiedRawManifest(legacyPath);
    expect(
      "a legacy raw manifest without a stored manifestSha256 stays rebuildable with a freshly recomputed digest",
      !("manifestSha256" in legacyManifest) &&
        legacyVerified.raw.schemaVersion === 3 &&
        isStrictSha256Hex(legacyVerified.rawManifestSha256),
    );
  } finally {
    await rm(rebuildBindingFixtureDir, { recursive: true, force: true });
  }

  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

// The stored `manifestSha256` is authoritative once it exists: recomputing
// the raw subject digest and requiring exact equality proves the raw bytes
// were not altered after collection. A mismatch means tampered raw output and
// must abort the rebuild instead of rebinding durable evidence to it. Legacy
// raw manifests written before the digest field existed carry no stored hash;
// they stay rebuildable with a freshly recomputed digest (documented in
// docs/TESTING.md).
function assertStoredRawManifestSha256Matches(raw, recomputedManifestSha256) {
  const stored = raw.manifestSha256;
  if (stored === undefined || stored === null) return;
  if (!isStrictSha256Hex(stored)) {
    throw new Error(
      `stored raw manifest manifestSha256 is not strict 64-char lowercase hex: ${String(stored)}`,
    );
  }
  if (stored !== recomputedManifestSha256) {
    throw new Error(
      `raw manifest failed its stored manifestSha256 binding: recomputed ${recomputedManifestSha256} !== stored ${stored}; refusing to rebuild a mirror from tampered raw output`,
    );
  }
}

// Front half of --rebuild-mirror, separated so the self-check can prove read +
// validation + binding enforcement against disposable temp files without any
// mirror write touching the repository.
async function loadVerifiedRawManifest(rawManifestPath) {
  const resolvedPath = path.resolve(rawManifestPath);
  const raw = JSON.parse(await readFile(resolvedPath, "utf8"));
  if (!isKnownManifestKind(raw.kind)) {
    throw new Error(`unexpected manifest kind "${String(raw.kind)}"`);
  }
  if (typeof raw.runId !== "string" || typeof raw.outcome !== "string") {
    throw new Error("raw manifest is missing runId or outcome");
  }
  assertValidRunId(raw.runId);
  const rawManifestSha256 = canonicalSha256WithoutFields(
    raw,
    ["manifestSha256", "manifestSha256Subject"],
    "raw manifest",
  );
  assertStoredRawManifestSha256Matches(raw, rawManifestSha256);
  return { raw, rawManifestSha256 };
}

async function runRebuildMirror(rawManifestPath) {
  const { raw, rawManifestSha256 } =
    await loadVerifiedRawManifest(rawManifestPath);
  const composed = composeCompactMirror(raw);
  const written = await writeMirrorArtifact(
    composed,
    raw.runId,
    rawManifestSha256,
  );
  console.log(
    JSON.stringify(
      {
        runId: raw.runId,
        outcome: raw.outcome,
        failureReasons: raw.failureReasons,
        rawManifestSha256,
        rawManifestSha256Subject: rawManifestDigestSubject,
        mirrorManifestSha256: written.mirrorManifestSha256,
        mirrorManifestSha256Subject: mirrorManifestDigestSubject,
        gitTrackingStatus: written.gitTrackingStatus,
        mirror: toRepoRelative(written.mirrorPath),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const rebuildIndex = process.argv.indexOf("--rebuild-mirror");
  if (rebuildIndex !== -1) {
    const target = process.argv[rebuildIndex + 1];
    if (!target || target.startsWith("--")) {
      console.error("--rebuild-mirror requires a raw evidence-manifest path");
      process.exitCode = 1;
      return;
    }
    await runRebuildMirror(target);
    return;
  }
  if (process.argv.includes("--self-check")) {
    await runSelfCheck();
    return;
  }
  if (process.argv.includes("--dry-run")) {
    await runDryPlan();
    return;
  }
  await runCollection();
}

// Canonicalize both spellings through realpath before comparing: Node loads
// this ESM entry through its realpath while process.argv[1] keeps whatever
// spelling the caller used, so on macOS an os.tmpdir()-rooted invocation
// (/var/...) would otherwise never match (/private/var/...) and main() would
// silently exit 0. Importing the module still never triggers collection.
async function isDirectInvocation(argvValue) {
  if (!argvValue) return false;
  try {
    return (
      (await realpath(path.resolve(argvValue))) ===
      (await realpath(fileURLToPath(import.meta.url)))
    );
  } catch {
    return false;
  }
}

const invokedDirectly = await isDirectInvocation(process.argv[1]);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
