import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CandidateProfileSchema,
  JobFinderRepositoryStateSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  createFreshStartCandidateProfile,
  createStarterJobDiscoveryTargets,
  deriveProfileSetupState,
} from "@nestor/contracts";
import { _electron as electron } from "playwright";

import {
  buildBlindPersonaRepositoryStates,
  getBlindPersonaJobsForSession,
  loadBlindPersonaSeedData,
  parseBlindPersonaVisualReviewTemplate,
  stableBlindPersonaSerialization,
  type BlindPersonaSession,
  type BlindPersonaVisualReviewTemplate,
} from "./blind-persona-seed-data";
import { stableJson } from "./release-acceptance-harness.mjs";

type JsonRecord = Record<string, unknown>;

export interface FileInventoryEntry {
  bytes: number;
  mode?: number;
  path: string;
  sha256: string;
}

export interface BuildBinding {
  acceptanceReportPath: string;
  acceptanceVersion: number;
  artifactDigest: string;
  artifactFileCount: number;
  artifactRoot: string;
  buildManifestFileSha256: string;
  buildManifestPath: string;
  buildManifestSha256: string;
  evidenceDigest: string;
  mainEntryPath: string;
  mainEntrySha256: string;
  runDir: string;
  seedSourceDigest: string;
  sourceDigest: string;
  sourceSnapshotDigest: string;
  acceptedAppDigest: string;
  acceptedAppFiles: FileInventoryEntry[];
  electronIdentity: JsonRecord;
  finalSealPath: string;
  finalSealSha256: string;
}

export interface PreparedPersonaWorkspace {
  personaId: string;
  seedManifestPath: string;
  seedManifestSha256: string;
  userDataRoot: string;
  workspaceDigest: string;
}

export interface PrepareBlindPersonaOptions {
  acceptanceRunDir: string;
  custodyRoot: string;
  destinationRoot: string;
  dryRun?: boolean;
  personaIds?: string[];
  expectedSealSha256: string;
}

interface ElectronWindow {
  evaluate<R, A>(
    callback: (argument: A) => R | Promise<R>,
    argument: A,
  ): Promise<R>;
  waitForFunction(
    callback: () => boolean,
    argument?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(state: "domcontentloaded"): Promise<unknown>;
}

export interface ElectronSeedProcess {
  close(): Promise<void>;
  /**
   * Optional main-process evaluation channel (Playwright's
   * ElectronApplication.evaluate). The tester launcher requires it whenever
   * startup geometry was requested so the applied window truth can be
   * measured; without it such launches fail closed.
   */
  evaluateInMain?<R>(pageFunction: (electron: unknown) => R): Promise<R>;
  firstWindow(): Promise<ElectronWindow>;
  process(): {
    exitCode?: number | null;
    pid?: number;
    signalCode?: NodeJS.Signals | null;
  } | null;
}

export type LaunchSeedElectron = (input: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath?: string;
}) => Promise<ElectronSeedProcess>;

interface SeedWindowGlobal {
  nestor?: {
    jobFinder?: {
      getWorkspace?(): Promise<unknown>;
      test?: {
        resetWorkspaceState(state: unknown): Promise<unknown>;
      };
    };
  };
}

interface ProcessRow {
  command: string;
  parentPid: number;
  pid: number;
  processGroupId: number | null;
}

interface CleanupEvidence {
  closeCompleted: boolean;
  closeDurationMs: number;
  closeError: string | null;
  closeTimedOut: boolean;
  processGroupId: number | null;
  rootPid: number | null;
  survivorsAfterCleanup: number[];
  trackedProcesses: ProcessRow[];
}

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const manifestName = "blind-persona-seed-manifest.json";
const browserManagedTransientSidecarNames = ["DIPS-shm", "DIPS-wal"] as const;
const custodyName = "blind-persona-wave-custody-index.json";
const testerRecordName = "blind-persona-tester-launch-record.json";
const testerIntentName = "blind-persona-tester-launch-intent.json";
const driverCdpFlag = "--driver-cdp";
const startupWindowWidthFlag = "--window-width";
const startupWindowHeightFlag = "--window-height";
const startupZoomFactorFlag = "--zoom-factor";
const startupWindowWidthEnvName = "NESTOR_STARTUP_WINDOW_WIDTH";
const startupWindowHeightEnvName = "NESTOR_STARTUP_WINDOW_HEIGHT";
const startupZoomFactorEnvName = "NESTOR_STARTUP_ZOOM_FACTOR";
const testerSessionGeometryEnvName = "NESTOR_TESTER_SESSION_GEOMETRY";
// Sensible launcher bounds: the desktop shell clamps the applied size to at
// least 400px and the primary display work area, so requests below 400px or
// beyond plausible display sizes would make the record lie about the result.
const startupWindowMinPx = 400;
const startupWindowMaxPx = 8192;
const startupZoomMin = 1;
const startupZoomMax = 5;
const devToolsActivePortFileName = "DevToolsActivePort";
const driverBindAddress = "127.0.0.1";
const defaultDriverTimeoutMs = 10_000;
const fixedDriverPortMin = 49152;
const fixedDriverPortMax = 65535;
const zeroNetworkHostResolverArg =
  "--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost";
const zeroNetworkProxyArg = "--proxy-server=127.0.0.1:9";
const zeroNetworkLaunchArgs = [
  ".",
  zeroNetworkHostResolverArg,
  zeroNetworkProxyArg,
];
const digestPattern = /^[a-f0-9]{64}$/u;
const personaPattern = /^P(?:0[1-9]|1[0-4])$/u;
const unsafeEnvironmentName =
  /(?:AWS|AMAZON|GOOGLE|GCP|AZURE|OPENAI|ANTHROPIC|GEMINI|VERTEX|BEDROCK|CLAUDE|COHERE|MISTRAL|HUGGING|HF_|GITHUB|GITLAB|COOKIE|SESSION|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API[_-]?KEY|ACCESS[_-]?KEY|PROXY|CONFIG|PROFILE|CERT|P12|PKCS|HOME)/iu;
const authorityKeyPattern =
  /(?:submitAuthorized|finalSubmitAuthorized|accountCreationAuthorized|finalSubmitOccurred|submittedNeverOccurred)$/iu;
const credentialKeyPattern =
  /(?:credentials?|password|secret|token|cookie|sessionKey|privateKey|apiKey)$/iu;
const sourceExcludes = [
  /^node_modules(?:[\\/]|$)/u,
  /^(?:out|dist|build|release|coverage|\.tmp|\.turbo)(?:[\\/]|$)/u,
  /(?:^|[\\/])test-artifacts(?:[\\/]|$)/u,
  /\.tsbuildinfo$/u,
  /^(?:\.git)(?:[\\/]|$)/u,
  /^docs\/audits\/evidence-manifests(?:\/|$)/u,
];

// Single canonical serializer for every custody digest this module writes or
// verifies. It delegates to the acceptance harness's stableJson so the writer
// (custody index) and every cross-boundary verifier (tester CLI digestSeed
// bootstrap check, verifyAcceptedBuild seal/manifest recomputation) reduce to
// ONE canonical form. Key ordering is code-unit sort: deterministic across
// locales, ICU builds, and machines. A locale-dependent collation
// (localeCompare) would diverge on mixed-case and non-ASCII keys and turn the
// ASCII-coincidence between former duplicate implementations into false
// custody/seal rejections.
export function stableSeedSerialization(value: unknown): string {
  return stableJson(value);
}

/**
 * Compare strings by UTF-16 code unit, matching the repository's canonical
 * stableJson ordering. Custody inventories must not depend on ICU collation or
 * the host locale.
 */
export function compareCodeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

// The serialized path ARRAY is the digest subject, and arrays keep element
// order through stableSeedSerialization, so this sort is the canonical
// ordering. It must match stableJson's key ordering exactly: plain code-unit
// .sort(). localeCompare would reorder mixed-case and non-ASCII paths per
// ambient ICU locale and diverge across machines/verifiers.
export async function currentSourcePathSetDigest(
  rootDirectory: string = repositoryRoot,
): Promise<string> {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { cwd: rootDirectory, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const paths = stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.split(path.sep).join("/"))
    .filter(
      (relativePath) =>
        !sourceExcludes.some((pattern) => pattern.test(relativePath)),
    )
    .sort(compareCodeUnitOrder);
  return sha256(stableSeedSerialization(paths));
}

export async function dependencyIdentity(
  rootDirectory: string,
  relativeRoots: string[],
): Promise<{
  digest: string;
  fileCount: number;
  files: JsonRecord[];
}> {
  const files: JsonRecord[] = [];
  for (const relativeRoot of relativeRoots) {
    const root = resolveConfinedPath(rootDirectory, relativeRoot);
    const visit = async (directory: string): Promise<void> => {
      for (const entry of (
        await readdir(directory, { withFileTypes: true })
      ).sort((left, right) => compareCodeUnitOrder(left.name, right.name))) {
        if (entry.name === ".vite" || entry.name === ".cache") continue;
        const filePath = path.join(directory, entry.name);
        const fileStat = await lstat(filePath);
        const entryPath = `${relativeRoot}/${path
          .relative(root, filePath)
          .split(path.sep)
          .join("/")}`;
        if (entry.isDirectory()) await visit(filePath);
        else if (entry.isSymbolicLink())
          files.push({
            path: entryPath,
            kind: "symlink",
            mode: fileStat.mode & 0o777,
            target: await readlink(filePath),
          });
        else if (entry.isFile()) {
          const bytes = await readFile(filePath);
          files.push({
            path: entryPath,
            kind: "file",
            mode: fileStat.mode & 0o777,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
          });
        } else throw new Error(`Unsupported dependency entry: ${filePath}`);
      }
    };
    await visit(root);
  }
  // Custody parity with the acceptance harness's dependencyRootsFingerprint:
  // the inventory is ONE canonical list over all collected roots, ordered by
  // full-path UTF-16 code-unit comparison — not per-root concatenation order,
  // and never ambient-locale collation, which would diverge from the harness
  // on mixed-case and non-ASCII paths.
  files.sort((left, right) =>
    compareCodeUnitOrder(String(left.path), String(right.path)),
  );
  return {
    digest: sha256(
      files.map((entry) => `${stableSeedSerialization(entry)}\n`).join(""),
    ),
    fileCount: files.length,
    files,
  };
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function resolveConfinedPath(
  root: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(
      `Expected a canonical non-empty POSIX relative path: ${relativePath}`,
    );
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInside(root, resolved) || resolved === path.resolve(root)) {
    throw new Error(`Path escapes its owned root: ${relativePath}`);
  }
  return resolved;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function assertNoAncestorSymlink(candidate: string): Promise<void> {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Symlinked path ownership is not accepted: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function canonicalDirectory(
  directory: string,
  label: string,
): Promise<string> {
  await assertNoAncestorSymlink(directory);
  const canonical = await realpath(directory).catch(() => {
    throw new Error(`${label} does not exist: ${directory}`);
  });
  if (!(await lstat(canonical)).isDirectory())
    throw new Error(`${label} is not a directory.`);
  return canonical;
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const bytes = await readFile(filePath).catch((error: unknown) => {
    throw new Error(`Unable to read JSON ${filePath}.`, { cause: error });
  });
  try {
    return requireRecord(JSON.parse(bytes.toString("utf8")), filePath);
  } catch (error) {
    throw new Error(`Unable to parse JSON ${filePath}.`, { cause: error });
  }
}

async function readBoundVisualReviewTemplate(
  seedManifestPath: string,
): Promise<BlindPersonaVisualReviewTemplate> {
  const seedManifest = await readJson(seedManifestPath);
  const template = parseBlindPersonaVisualReviewTemplate(
    seedManifest.visualReviewTemplate,
    `${seedManifestPath}.visualReviewTemplate`,
  );
  const canonical = (await loadBlindPersonaSeedData()).manifest
    .visualReviewTemplate;
  if (
    stableBlindPersonaSerialization(template) !==
    stableBlindPersonaSerialization(canonical)
  ) {
    throw new Error(
      `Persona seed visual-review template differs from the canonical blind-persona manifest: ${seedManifestPath}`,
    );
  }
  return template;
}

async function walkFiles(
  root: string,
  excluded = new Set<string>(),
  shouldExclude?: (relativePath: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => compareCodeUnitOrder(a.name, b.name))) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path
        .relative(root, filePath)
        .split(path.sep)
        .join("/");
      if (excluded.has(relativePath) || shouldExclude?.(relativePath) === true)
        continue;
      const current = await lstat(filePath);
      if (current.isSymbolicLink())
        throw new Error(`Symlinks are not accepted: ${filePath}`);
      if (current.isDirectory()) await visit(filePath);
      else if (current.isFile()) files.push(filePath);
      else throw new Error(`Unsupported filesystem entry: ${filePath}`);
    }
  };
  await visit(root);
  return files;
}

/**
 * Chromium can create these top-level sidecars while the persona workspace is
 * being seeded. They are browser-managed transient state, not durable persona
 * payload. Keep this exact-name check narrow: the durable `DIPS` file and
 * nested/arbitrary `*-shm` files remain part of the sealed inventory.
 */
export function isBrowserManagedTransientSidecar(
  relativePath: string,
): boolean {
  return (browserManagedTransientSidecarNames as readonly string[]).includes(
    relativePath,
  );
}

export async function inventoryTree(
  root: string,
  excluded = new Set<string>(),
): Promise<{ digest: string; files: FileInventoryEntry[] }> {
  const files = await Promise.all(
    (await walkFiles(root, excluded, isBrowserManagedTransientSidecar)).map(
      async (filePath) => {
        const content = await readFile(filePath);
        return {
          bytes: content.byteLength,
          path: path.relative(root, filePath).split(path.sep).join("/"),
          sha256: sha256(content),
        };
      },
    ),
  );
  files.sort((left, right) => compareCodeUnitOrder(left.path, right.path));
  return {
    digest: sha256(
      files.map((entry) => `${stableSeedSerialization(entry)}\n`).join(""),
    ),
    files,
  };
}

function exactInventoryEntries(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} is empty.`);
  const seen = new Set<string>();
  return value.map((unknownEntry) => {
    const entry = requireRecord(unknownEntry, `${label} entry`);
    if (entry.kind !== "file" || typeof entry.path !== "string") {
      throw new Error(`${label} must contain ordinary files only.`);
    }
    resolveConfinedPath("/inventory", entry.path);
    if (seen.has(entry.path))
      throw new Error(`${label} repeats ${entry.path}.`);
    seen.add(entry.path);
    requireDigest(entry.sha256, `${label} ${entry.path}`);
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
      throw new Error(`${label} has invalid byte count for ${entry.path}.`);
    }
    return entry;
  });
}

function sourceInventoryEntries(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} is empty.`);
  const seen = new Set<string>();
  return value.map((unknownEntry) => {
    const entry = requireRecord(unknownEntry, `${label} entry`);
    if (typeof entry.path !== "string" || typeof entry.kind !== "string") {
      throw new Error(`${label} entry is missing path/kind.`);
    }
    resolveConfinedPath("/inventory", entry.path);
    if (seen.has(entry.path))
      throw new Error(`${label} repeats ${entry.path}.`);
    seen.add(entry.path);
    if (entry.kind === "file") {
      requireDigest(entry.sha256, `${label} ${entry.path}`);
      if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
        throw new Error(`${label} has invalid byte count for ${entry.path}.`);
      }
    }
    return entry;
  });
}

function hashedInventoryEntries(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} is empty.`);
  const seen = new Set<string>();
  return value.map((unknownEntry) => {
    const entry = requireRecord(unknownEntry, `${label} entry`);
    if (typeof entry.path !== "string" || typeof entry.kind !== "string") {
      throw new Error(`${label} entry is missing path/kind.`);
    }
    resolveConfinedPath("/inventory", entry.path);
    if (seen.has(entry.path))
      throw new Error(`${label} repeats ${entry.path}.`);
    seen.add(entry.path);
    requireDigest(entry.sha256, `${label} ${entry.path}`);
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
      throw new Error(`${label} has invalid byte count for ${entry.path}.`);
    }
    return entry;
  });
}

async function verifyAcceptedAppInventory(
  acceptedAppRoot: string,
  expectedEntries: JsonRecord[],
): Promise<void> {
  const actualFiles = await walkFiles(acceptedAppRoot);
  const actualPaths = actualFiles.map((filePath) =>
    path.relative(acceptedAppRoot, filePath).split(path.sep).join("/"),
  );
  const expectedPaths = expectedEntries.map((entry) => String(entry.path));
  if (
    stableSeedSerialization(actualPaths.sort(compareCodeUnitOrder)) !==
    stableSeedSerialization(expectedPaths.sort(compareCodeUnitOrder))
  ) {
    throw new Error("Accepted app has extra, missing, or aliased files.");
  }
  await Promise.all(
    expectedEntries.map(async (entry) => {
      const filePath = resolveConfinedPath(acceptedAppRoot, String(entry.path));
      const canonical = await realpath(filePath);
      if (canonical !== filePath || !isPathInside(acceptedAppRoot, canonical)) {
        throw new Error(`Accepted app path is not canonical: ${entry.path}`);
      }
      const bytes = await readFile(canonical);
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new Error(`Accepted app bytes changed: ${entry.path}`);
      }
      const mode = (await lstat(canonical)).mode & 0o777;
      if (
        entry.mode !== undefined &&
        ((mode & 0o222) !== 0 || mode !== entry.mode)
      )
        throw new Error(`Accepted app read-only mode changed: ${entry.path}`);
    }),
  );
}

function assertSameDigest(
  left: unknown,
  right: unknown,
  label: string,
): string {
  const leftDigest = requireDigest(left, `${label} left digest`);
  if (leftDigest !== requireDigest(right, `${label} right digest`)) {
    throw new Error(`${label} relationship is stale or forged.`);
  }
  return leftDigest;
}

export async function verifyAcceptedBuild(input: {
  acceptanceRunDir: string;
  expectedSealSha256: string;
}): Promise<BuildBinding> {
  const runDir = await canonicalDirectory(
    input.acceptanceRunDir,
    "Acceptance run directory",
  );
  const reportPath = path.join(runDir, "acceptance-report.json");
  const manifestPath = path.join(runDir, "build-manifest.json");
  const sealPath = path.join(runDir, "acceptance-seal.json");
  await Promise.all([
    assertNoAncestorSymlink(reportPath),
    assertNoAncestorSymlink(manifestPath),
  ]);
  const [reportBytes, manifestBytes, sealBytes] = await Promise.all([
    readFile(reportPath),
    readFile(manifestPath),
    readFile(sealPath),
  ]);
  for (const finalPath of [reportPath, manifestPath, sealPath])
    if (((await lstat(finalPath)).mode & 0o222) !== 0)
      throw new Error(`Acceptance seal subject is writable: ${finalPath}`);
  const seal = requireRecord(
    JSON.parse(sealBytes.toString("utf8")),
    "Acceptance seal",
  );
  const sealSubject = { ...seal };
  delete sealSubject.sealSha256;
  const expectedSealSha256 = requireDigest(
    input.expectedSealSha256,
    "Externally custodied expected seal digest",
  );
  if (
    seal.sealSha256 !== expectedSealSha256 ||
    sha256(stableSeedSerialization(sealSubject)) !== expectedSealSha256
  )
    throw new Error("Final acceptance seal digest mismatch.");
  const report = requireRecord(
    JSON.parse(reportBytes.toString("utf8")),
    "Acceptance report",
  );
  const manifest = requireRecord(
    JSON.parse(manifestBytes.toString("utf8")),
    "Build manifest",
  );
  const sealedManifest = requireRecord(
    seal.initialBuildManifest,
    "Sealed build manifest",
  );
  const sealedReport = requireRecord(seal.finalReport, "Sealed final report");
  if (
    sealedManifest.rawSha256 !== sha256(manifestBytes) ||
    sealedManifest.canonicalSha256 !== manifest.manifestSha256 ||
    sealedReport.rawSha256 !== sha256(reportBytes) ||
    sealedReport.canonicalSha256 !== sha256(stableSeedSerialization(report)) ||
    seal.runDir !== runDir ||
    seal.runId !== path.basename(runDir)
  )
    throw new Error("Final acceptance seal subjects do not match run files.");
  if (
    report.pass !== true ||
    typeof report.completedAt !== "string" ||
    !Number.isFinite(Date.parse(report.completedAt))
  ) {
    throw new Error("Acceptance report is not pass/completed.");
  }
  if (
    !Number.isSafeInteger(report.acceptanceVersion) ||
    report.acceptanceVersion !== manifest.acceptanceVersion
  ) {
    throw new Error("Acceptance version relationship is invalid.");
  }
  if (report.runDir !== runDir || manifest.runDir !== runDir) {
    throw new Error(
      "Acceptance run ID/directory relationship is stale or forged.",
    );
  }
  const manifestSubject = { ...manifest };
  delete manifestSubject.manifestSha256;
  const manifestSha256 = requireDigest(
    manifest.manifestSha256,
    "Build manifest digest",
  );
  if (sha256(stableSeedSerialization(manifestSubject)) !== manifestSha256) {
    throw new Error("Build manifest canonical digest mismatch.");
  }
  if (
    report.initialManifestSha256 !== manifestSha256 ||
    report.initialManifestFileSha256 !== sha256(manifestBytes)
  ) {
    throw new Error(
      "Acceptance report does not bind the exact build-manifest bytes.",
    );
  }

  const reportSource = requireRecord(report.source, "Acceptance report source");
  const manifestSource = requireRecord(
    manifest.source,
    "Build manifest source",
  );
  const reportAfterBuild = requireRecord(
    reportSource.afterBuild,
    "Report after-build source",
  );
  const manifestAfterBuild = requireRecord(
    manifestSource.afterBuild,
    "Manifest after-build source",
  );
  const reportPostRun = requireRecord(
    reportSource.postRun,
    "Report post-run source",
  );
  const sourceDigest = assertSameDigest(
    reportAfterBuild.digest,
    manifestAfterBuild.digest,
    "Source build",
  );
  assertSameDigest(sourceDigest, reportPostRun.digest, "Source post-run");
  if (
    stableSeedSerialization(reportAfterBuild) !==
    stableSeedSerialization(manifestAfterBuild)
  ) {
    throw new Error(
      "Accepted source inventory changed between manifest and report.",
    );
  }
  const sourceFiles = sourceInventoryEntries(
    reportAfterBuild.files,
    "Accepted source inventory",
  );
  if (reportAfterBuild.fileCount !== sourceFiles.length)
    throw new Error("Source file count mismatch.");
  const calculatedSourceDigest = sha256(
    sourceFiles.map((entry) => `${stableSeedSerialization(entry)}\n`).join(""),
  );
  if (calculatedSourceDigest !== sourceDigest)
    throw new Error("Source inventory digest mismatch.");
  const reportBeforeBuild = requireRecord(
    reportSource.beforeBuild,
    "Report before-build source",
  );
  const manifestBeforeBuild = requireRecord(
    manifestSource.beforeBuild,
    "Manifest before-build source",
  );
  if (
    stableSeedSerialization(reportBeforeBuild) !==
      stableSeedSerialization(reportAfterBuild) ||
    stableSeedSerialization(manifestBeforeBuild) !==
      stableSeedSerialization(manifestAfterBuild)
  ) {
    throw new Error(
      "Before/after-build source inventory relationship is stale.",
    );
  }

  const reportArtifacts = requireRecord(
    report.artifacts,
    "Acceptance report artifacts",
  );
  const manifestArtifacts = requireRecord(
    manifest.artifacts,
    "Build manifest artifacts",
  );
  const postRunArtifacts = requireRecord(
    reportArtifacts.postRun,
    "Post-run artifacts",
  );
  const artifactDigest = assertSameDigest(
    reportArtifacts.digest,
    manifestArtifacts.digest,
    "Artifact build",
  );
  assertSameDigest(
    artifactDigest,
    postRunArtifacts.digest,
    "Artifact post-run",
  );
  const artifactFiles = exactInventoryEntries(
    reportArtifacts.files,
    "Accepted artifact inventory",
  );
  if (
    reportArtifacts.fileCount !== artifactFiles.length ||
    stableSeedSerialization(artifactFiles) !==
      stableSeedSerialization(manifestArtifacts.files) ||
    stableSeedSerialization(artifactFiles) !==
      stableSeedSerialization(postRunArtifacts.files)
  ) {
    throw new Error(
      "Artifact inventories or counts do not describe one exact build.",
    );
  }
  const calculatedArtifactDigest = sha256(
    artifactFiles
      .map((entry) => `${stableSeedSerialization(entry)}\n`)
      .join(""),
  );
  if (calculatedArtifactDigest !== artifactDigest)
    throw new Error("Artifact inventory digest mismatch.");

  const snapshot = requireRecord(report.snapshot, "Acceptance snapshot");
  if (snapshot.cleanedUp !== true)
    throw new Error("Acceptance snapshot cleanup is not complete.");
  const snapshotDependencies = requireRecord(
    snapshot.dependencies,
    "Acceptance dependency snapshot",
  );
  const acceptedDependencies = requireRecord(
    snapshotDependencies.originalBeforeCopy,
    "Accepted dependency identity",
  );
  const dependencyRoots = Array.isArray(snapshotDependencies.roots)
    ? snapshotDependencies.roots.map(String)
    : [];
  const currentDependencies = await dependencyIdentity(
    repositoryRoot,
    dependencyRoots,
  );
  if (
    currentDependencies.digest !== acceptedDependencies.digest ||
    currentDependencies.fileCount !== acceptedDependencies.fileCount ||
    stableSeedSerialization(currentDependencies.files) !==
      stableSeedSerialization(acceptedDependencies.files)
  )
    throw new Error(
      "Current dependency/toolchain identity differs from accepted snapshot.",
    );
  const acceptedApp = requireRecord(
    report.acceptedApp,
    "Accepted Electron app",
  );
  if (
    acceptedApp.path !== "accepted-app" ||
    acceptedApp.readOnly !== true ||
    acceptedApp.verifiedAfterSnapshotCleanup !== true
  ) {
    throw new Error("Accepted app custody contract is incomplete.");
  }
  const artifactRoot = await canonicalDirectory(
    resolveConfinedPath(runDir, String(acceptedApp.path)),
    "Accepted Electron app root",
  );
  const acceptedAppFiles = exactInventoryEntries(
    acceptedApp.files,
    "Accepted app inventory",
  );
  if (acceptedApp.fileCount !== acceptedAppFiles.length) {
    throw new Error("Accepted app file count mismatch.");
  }
  const acceptedAppDigest = requireDigest(
    acceptedApp.digest,
    "Accepted app digest",
  );
  if (
    sha256(
      acceptedAppFiles
        .map((entry) => `${stableSeedSerialization(entry)}\n`)
        .join(""),
    ) !== acceptedAppDigest
  ) {
    throw new Error("Accepted app inventory digest mismatch.");
  }
  if (
    acceptedApp.artifactDigest !== artifactDigest ||
    acceptedApp.artifactFileCount !== artifactFiles.length ||
    acceptedApp.sourceDigest !== sourceDigest
  ) {
    throw new Error("Accepted app is not bound to the accepted source/build.");
  }
  const acceptedByPath = new Map(
    acceptedAppFiles.map((entry) => [String(entry.path), entry]),
  );
  for (const artifact of artifactFiles) {
    if (
      stableSeedSerialization(acceptedByPath.get(String(artifact.path))) !==
      stableSeedSerialization(artifact)
    ) {
      throw new Error(
        `Accepted app does not contain exact build artifact: ${artifact.path}`,
      );
    }
  }
  await verifyAcceptedAppInventory(artifactRoot, acceptedAppFiles);
  for (const requiredPath of [
    "package.json",
    "out/main/index.cjs",
    "out/preload/index.cjs",
    "out/renderer/index.html",
  ]) {
    if (!acceptedByPath.has(requiredPath)) {
      throw new Error(
        `Accepted app is missing launch resource: ${requiredPath}`,
      );
    }
  }
  const packageMetadata = requireRecord(
    acceptedApp.packageMetadata,
    "Accepted app package metadata",
  );
  const packageBytes = await readFile(path.join(artifactRoot, "package.json"));
  if (
    stableSeedSerialization(JSON.parse(packageBytes.toString("utf8"))) !==
      stableSeedSerialization(packageMetadata) ||
    packageMetadata.main !== "out/main/index.cjs"
  ) {
    throw new Error("Accepted app package/main metadata is invalid.");
  }
  const launch = requireRecord(acceptedApp.launch, "Accepted app launch");
  if (
    stableSeedSerialization(launch.args) !== stableSeedSerialization(["."]) ||
    launch.cwd !== "accepted-app" ||
    launch.main !== packageMetadata.main
  ) {
    throw new Error("Accepted app launch contract is invalid.");
  }
  const evidence = requireRecord(
    report.evidence,
    "Acceptance evidence inventory",
  );
  const evidenceFiles = hashedInventoryEntries(
    evidence.files,
    "Acceptance evidence inventory",
  );
  if (evidence.fileCount !== evidenceFiles.length)
    throw new Error("Evidence file count mismatch.");
  for (const entry of evidenceFiles) {
    const evidencePath = resolveConfinedPath(runDir, String(entry.path));
    const canonicalEvidencePath = await realpath(evidencePath);
    if (
      canonicalEvidencePath !== evidencePath ||
      !isPathInside(runDir, canonicalEvidencePath) ||
      !(await lstat(evidencePath)).isFile()
    ) {
      throw new Error(`Acceptance evidence path is aliased: ${entry.path}`);
    }
    const bytes = await readFile(evidencePath);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Acceptance evidence hash mismatch: ${entry.path}`);
    }
    if (((await lstat(evidencePath)).mode & 0o222) !== 0)
      throw new Error(`Acceptance evidence is writable: ${entry.path}`);
  }
  const evidenceDigest = requireDigest(evidence.digest, "Evidence digest");
  if (sha256(stableSeedSerialization(evidenceFiles)) !== evidenceDigest) {
    throw new Error("Evidence inventory digest mismatch.");
  }
  for (const entry of acceptedAppFiles) {
    const evidenceEntry = evidenceFiles.find(
      (candidate) =>
        candidate.path === `accepted-app/${String(entry.path)}` &&
        candidate.kind === "accepted-app-file",
    );
    if (
      !evidenceEntry ||
      evidenceEntry.bytes !== entry.bytes ||
      evidenceEntry.sha256 !== entry.sha256
    ) {
      throw new Error(`Evidence omits accepted app file: ${entry.path}`);
    }
  }

  const captured = requireRecord(
    reportSource.capturedWorktree,
    "Captured source inventory",
  );
  const capturedFiles = sourceInventoryEntries(
    captured.files,
    "Captured source inventory",
  );
  const capturedDigest = requireDigest(
    captured.digest,
    "Captured source inventory digest",
  );
  if (
    requireDigest(captured.pathSetDigest, "Captured source path-set digest") !==
    (await currentSourcePathSetDigest())
  )
    throw new Error(
      "Current source path inventory differs from accepted source inventory.",
    );
  if (
    sha256(
      capturedFiles
        .map((entry) => `${stableSeedSerialization(entry)}\n`)
        .join(""),
    ) !== capturedDigest
  ) {
    throw new Error("Captured source inventory digest mismatch.");
  }
  for (const accepted of capturedFiles) {
    const relativePath = String(accepted.path);
    const localPath = resolveConfinedPath(repositoryRoot, relativePath);
    if (accepted.kind === "deleted") {
      if (await exists(localPath))
        throw new Error(`Accepted deleted source reappeared: ${relativePath}`);
      continue;
    }
    if (accepted.kind === "symlink") {
      const localStat = await lstat(localPath);
      const target = await readlink(localPath);
      const canonicalTarget = await realpath(localPath);
      if (
        !localStat.isSymbolicLink() ||
        target !== accepted.target ||
        !isPathInside(repositoryRoot, canonicalTarget)
      )
        throw new Error(`Seeder source symlink differs: ${relativePath}`);
      continue;
    }
    if (accepted.kind !== "file")
      throw new Error(
        `Seeder execution binding refuses non-file source: ${relativePath}`,
      );
    await assertNoAncestorSymlink(localPath);
    const bytes = await readFile(localPath);
    if (
      bytes.byteLength !== accepted.bytes ||
      sha256(bytes) !== accepted.sha256
    )
      throw new Error(
        `Seeder source bytes differ from accepted source: ${relativePath}`,
      );
  }

  const mainEntry = acceptedAppFiles.find(
    (entry) => entry.path === "out/main/index.cjs",
  );
  if (!mainEntry)
    throw new Error("Accepted artifacts omit out/main/index.cjs.");
  const mainEntryPath = await realpath(
    resolveConfinedPath(artifactRoot, "out/main/index.cjs"),
  );
  const mainBytes = await readFile(mainEntryPath);
  if (sha256(mainBytes) !== mainEntry.sha256)
    throw new Error("Accepted main entry hash mismatch.");
  const sourceSnapshotDigest = requireDigest(
    snapshot.digest,
    "Source snapshot digest",
  );
  if (sourceSnapshotDigest !== sourceDigest) {
    throw new Error(
      "Snapshot digest is not bound to the accepted source snapshot.",
    );
  }
  if (snapshot.finalSource) {
    const finalSource = requireRecord(
      snapshot.finalSource,
      "Final snapshot source",
    );
    assertSameDigest(sourceDigest, finalSource.digest, "Final snapshot source");
  }
  if (snapshot.capturedSourceDigest !== captured.digest) {
    throw new Error("Snapshot is not bound to the captured source inventory.");
  }
  const sealedAcceptedApp = requireRecord(
    seal.acceptedApp,
    "Sealed accepted app",
  );
  const sealedEvidence = requireRecord(seal.evidence, "Sealed evidence");
  if (
    sealedAcceptedApp.digest !== acceptedAppDigest ||
    sealedAcceptedApp.fileCount !== acceptedAppFiles.length ||
    sealedEvidence.digest !== evidenceDigest ||
    seal.sourceId !== sourceDigest ||
    seal.artifactId !== artifactDigest
  )
    throw new Error(
      "Final seal does not bind accepted app/source/artifacts/evidence.",
    );
  const electronIdentity = requireRecord(
    seal.electron,
    "Sealed Electron identity",
  );
  const executableBytes = await readFile(
    String(electronIdentity.executablePath),
  );
  if (
    executableBytes.byteLength !== electronIdentity.bytes ||
    sha256(executableBytes) !== electronIdentity.sha256
  )
    throw new Error(
      "Ambient Electron executable differs from sealed identity.",
    );
  return {
    acceptanceReportPath: reportPath,
    acceptanceVersion: Number(report.acceptanceVersion),
    artifactDigest,
    artifactFileCount: artifactFiles.length,
    artifactRoot,
    buildManifestFileSha256: sha256(manifestBytes),
    buildManifestPath: manifestPath,
    buildManifestSha256: manifestSha256,
    evidenceDigest,
    mainEntryPath,
    mainEntrySha256: String(mainEntry.sha256),
    runDir,
    seedSourceDigest: capturedDigest,
    sourceDigest,
    sourceSnapshotDigest,
    acceptedAppDigest,
    acceptedAppFiles: acceptedAppFiles as unknown as FileInventoryEntry[],
    electronIdentity,
    finalSealPath: sealPath,
    finalSealSha256: expectedSealSha256,
  };
}

export function createUniquePersonaRoot(
  destinationRoot: string,
  personaId: string,
  nonce: string = randomUUID(),
): string {
  if (!personaPattern.test(personaId))
    throw new Error(`Unsupported blind persona ID: ${personaId}`);
  if (!/^[a-zA-Z0-9-]+$/u.test(nonce))
    throw new Error("Workspace nonce is unsafe.");
  return resolveConfinedPath(destinationRoot, `${personaId}-${nonce}`);
}

function minimalEnvironment(
  ambient: NodeJS.ProcessEnv,
  userDataRoot: string,
  testApi: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
  ]) {
    const value = ambient[name];
    if (value && !unsafeEnvironmentName.test(name)) env[name] = value;
  }
  env.NESTOR_USER_DATA_DIR = path.resolve(userDataRoot);
  env.NESTOR_TEST_API_USE_LIVE_AI = "0";
  env.NESTOR_BROWSER_AGENT = "0";
  env.NESTOR_BROWSER_HEADLESS = "1";
  env.JOB_FINDER_PREPARE_ONLY_AUTHORIZE_INTERMEDIATE_WRITES = "0";
  env.JOB_FINDER_COMPLETE_FLOW_AUTHORIZED_WRITE_DIAGNOSTIC = "0";
  if (testApi) env.NESTOR_ENABLE_TEST_API = "1";
  return env;
}

export function hardenSeedEnvironment(
  ambient: NodeJS.ProcessEnv,
  userDataRoot: string,
): NodeJS.ProcessEnv {
  return minimalEnvironment(ambient, userDataRoot, true);
}

export function hardenTesterEnvironment(
  ambient: NodeJS.ProcessEnv,
  userDataRoot: string,
): NodeJS.ProcessEnv {
  return minimalEnvironment(ambient, userDataRoot, false);
}

export function scanSeedAuthority(value: unknown): string[] {
  const violations: string[] = [];
  const visit = (entry: unknown, parts: string[]) => {
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, [...parts, String(index)]));
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry as JsonRecord)) {
      const itemPath = [...parts, key];
      const location = itemPath.join(".");
      if (authorityKeyPattern.test(key)) {
        const required =
          key.toLowerCase() === "submittedneveroccurred" ? true : false;
        if (item !== required)
          violations.push(`${location} must be ${required}`);
      }
      if (
        credentialKeyPattern.test(key) &&
        item !== null &&
        item !== "" &&
        item !== false
      ) {
        violations.push(`${location} contains credential/session material`);
      }
      if (
        /^(?:submittedAt|externalWriteAt|accountCreatedAt)$/iu.test(key) &&
        item != null
      ) {
        violations.push(`${location} must be null`);
      }
      if (
        /^(?:externalWrites|externalWriteReceipts|submitApprovals|receipts)$/iu.test(
          key,
        ) &&
        Array.isArray(item) &&
        item.length > 0
      ) {
        violations.push(`${location} must be empty`);
      }
      if (
        ["state", "status", "outcome", "result"].includes(key) &&
        item === "submitted"
      ) {
        violations.push(`${location} must not be submitted`);
      }
      if (
        /consent/iu.test(key) &&
        ["granted", "accepted", "approved"].includes(String(item))
      ) {
        violations.push(`${location} must not grant consent`);
      }
      visit(item, itemPath);
    }
  };
  visit(value, []);
  return violations;
}

export function scanCrossPersonaPaths(
  value: unknown,
  personaId: string,
): string[] {
  // Workspace roots are named P##-<uuid>. Keep the legacy bare P## segment
  // form too: older persisted paths are still cross-persona contamination,
  // while ordinary values such as a job slug P14-manager are not paths to a
  // persona workspace and should not be rejected.
  const personaRootPattern =
    /(?:^|[\\/])(P(?:0[1-9]|1[0-4]))(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?=[\\/]|$)/giu;
  const expectedPersonaId = personaId.toUpperCase();
  const violations: string[] = [];
  const visit = (entry: unknown, parts: string[]) => {
    if (typeof entry === "string") {
      const ids = [...entry.matchAll(personaRootPattern)].map((match) =>
        String(match[1]).toUpperCase(),
      );
      if (ids.some((id) => id !== expectedPersonaId))
        violations.push(parts.join("."));
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, [...parts, String(index)]));
    } else if (entry !== null && typeof entry === "object") {
      Object.entries(entry as JsonRecord).forEach(([key, item]) =>
        visit(item, [...parts, key]),
      );
    }
  };
  visit(value, []);
  return violations;
}

function personaShortId(session: BlindPersonaSession): string {
  const id = session.id.split("/").at(-1);
  if (!id || !personaPattern.test(id))
    throw new Error(`Invalid blind persona session ID: ${session.id}`);
  return id;
}

async function buildPersonaState(
  session: BlindPersonaSession,
  resumeStoragePath: string,
  resumeSha256?: string,
): Promise<JsonRecord> {
  const personaId = personaShortId(session);
  const data = await loadBlindPersonaSeedData();
  let parsedState: JsonRecord;
  if (personaId === "P13" || personaId === "P14") {
    const states = await buildBlindPersonaRepositoryStates();
    const state = structuredClone(states[personaId]);
    state.profile.baseResume.storagePath = resumeStoragePath;
    if (resumeSha256) state.profile.baseResume.sha256 = resumeSha256;
    parsedState = JobFinderRepositoryStateSchema.parse(state) as JsonRecord;
  } else {
    parsedState = JobFinderRepositoryStateSchema.parse({
      profile: createFreshStartCandidateProfile(),
      profileSetupState: ProfileSetupStateSchema.parse({
        status: "not_started",
        currentStep: "import",
      }),
      savedJobs: getBlindPersonaJobsForSession(data, session),
      searchPreferences: JobSearchPreferencesSchema.parse({
        targetRoles: [],
        jobFamilies: [],
        locations: [],
        excludedLocations: [],
        workModes: [],
        seniorityLevels: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
        discovery: { historyLimit: 5, targets: [] },
      }),
      settings: JobFinderSettingsSchema.parse({
        resumeTemplateId: "classic_ats",
        resumeFormat: "pdf",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        keepSessionAlive: false,
        allowAutoSubmitOverride: false,
        discoveryOnly: false,
      }),
    }) as JsonRecord;
  }
  const searchPreferences = requireRecord(
    parsedState.searchPreferences,
    "Seed search preferences",
  );
  const discovery = requireRecord(
    searchPreferences.discovery,
    "Seed discovery",
  );
  if (!Array.isArray(discovery.targets) || discovery.targets.length === 0) {
    discovery.targets = createStarterJobDiscoveryTargets();
  }
  parsedState.settings = JobFinderSettingsSchema.parse({
    ...requireRecord(parsedState.settings, "Seed settings"),
    applicationCrm:
      requireRecord(parsedState.settings, "Seed settings").applicationCrm ?? {},
    resumeApplicationMode:
      requireRecord(parsedState.settings, "Seed settings")
        .resumeApplicationMode ?? "tailored_per_job",
  });
  return JobFinderRepositoryStateSchema.parse(parsedState) as JsonRecord;
}

interface PlaywrightElectronApplicationLike {
  close(): Promise<void>;
  evaluate<R>(pageFunction: (electron: unknown) => R): Promise<R>;
  firstWindow(): Promise<ElectronWindow>;
  process(): ElectronSeedProcess["process"] extends () => infer P ? P : never;
}

/**
 * Keep Playwright's per-launch, ephemeral Node inspector as the sole
 * main-process evaluation transport, but adapt its public `evaluate` method to
 * the launcher's explicit `evaluateInMain` capability. Returning the raw
 * ElectronApplication loses that capability at runtime (despite the compile
 * cast) and makes every real geometry launch fail closed. A fresh adapter is
 * created for every Playwright launch, so concurrent persona launchers never
 * share evaluation state or a fixed inspector port.
 */
export function adaptPlaywrightElectronApplication(
  application: PlaywrightElectronApplicationLike,
): ElectronSeedProcess {
  return {
    close: () => application.close(),
    evaluateInMain: (pageFunction) => application.evaluate(pageFunction),
    firstWindow: () => application.firstWindow(),
    process: () => application.process(),
  };
}

export async function launchElectronWithMainEvaluation(
  input: Parameters<LaunchSeedElectron>[0],
  launch: (options: {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    executablePath?: string;
  }) => Promise<PlaywrightElectronApplicationLike> = (options) =>
    electron.launch(
      options,
    ) as unknown as Promise<PlaywrightElectronApplicationLike>,
): Promise<ElectronSeedProcess> {
  const env = Object.fromEntries(
    Object.entries(input.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const application = await launch({
    ...input,
    env,
  });
  return adaptPlaywrightElectronApplication(application);
}

const defaultLaunch: LaunchSeedElectron = launchElectronWithMainEvaluation;

async function readProcessTable(): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    const parsed: unknown = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((unknownRow) => {
      const row = requireRecord(unknownRow, "Process row");
      return {
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        processGroupId: null,
        command: String(row.CommandLine ?? ""),
      };
    });
  }
  const { stdout } = await execFileAsync("ps", [
    "-axww",
    "-o",
    "pid=,ppid=,pgid=,command=",
  ]);
  return stdout.split("\n").flatMap((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line.trim());
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
            command: match[4] ?? "",
          },
        ]
      : [];
  });
}

function ownedProcessTree(table: ProcessRow[], rootPid: number): ProcessRow[] {
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of table)
      if (owned.has(row.parentPid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const root = table.find((row) => row.pid === rootPid);
  if (root?.processGroupId === rootPid) {
    for (const row of table)
      if (row.processGroupId === rootPid) owned.add(row.pid);
  }
  return table.filter((row) => owned.has(row.pid));
}

async function alivePids(pids: number[]): Promise<number[]> {
  const present = new Set((await readProcessTable()).map((row) => row.pid));
  return pids.filter((pid) => present.has(pid));
}

async function closeOwnedProcess(
  app: ElectronSeedProcess,
  timeoutMs = 5_000,
): Promise<CleanupEvidence> {
  const rootPid = app.process()?.pid ?? null;
  let trackedProcesses: ProcessRow[] = [];
  let processGroupId: number | null = null;
  if (rootPid) {
    const table = await readProcessTable().catch(() => [] as ProcessRow[]);
    trackedProcesses = ownedProcessTree(table, rootPid);
    processGroupId =
      table.find((row) => row.pid === rootPid)?.processGroupId ?? null;
  }
  let closeCompleted = false;
  let closeError: string | null = null;
  let closeTimedOut = false;
  let closeTimer: NodeJS.Timeout | undefined;
  const closeStartedAt = Date.now();
  await Promise.race([
    app
      .close()
      .then(() => {
        closeCompleted = true;
      })
      .catch((error: unknown) => {
        closeError = error instanceof Error ? error.message : String(error);
      }),
    new Promise<void>((resolve) => {
      closeTimer = setTimeout(() => {
        closeTimedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (closeTimer) clearTimeout(closeTimer);
  const closeDurationMs = Date.now() - closeStartedAt;
  const trackedPids = trackedProcesses.map((row) => row.pid);
  let survivors = await alivePids(trackedPids).catch(() => trackedPids);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (survivors.length === 0) break;
    if (process.platform !== "win32" && rootPid && processGroupId === rootPid) {
      try {
        process.kill(-rootPid, signal);
      } catch {}
    } else {
      for (const pid of [...survivors].reverse())
        try {
          process.kill(pid, signal);
        } catch {}
    }
    await new Promise((resolve) =>
      setTimeout(resolve, signal === "SIGTERM" ? 300 : 150),
    );
    survivors = await alivePids(trackedPids).catch(() => survivors);
  }
  return {
    closeCompleted,
    closeDurationMs,
    closeError,
    closeTimedOut,
    processGroupId,
    rootPid,
    survivorsAfterCleanup: survivors,
    trackedProcesses,
  };
}

function summarizeCleanupEvidence(evidence: CleanupEvidence): string {
  return [
    `rootPid=${evidence.rootPid ?? "none"}`,
    `trackedPids=${evidence.trackedProcesses.length}`,
    `pgid=${evidence.processGroupId ?? "none"}`,
    `closeCompleted=${String(evidence.closeCompleted)}`,
    `closeTimedOut=${String(evidence.closeTimedOut)}`,
    `closeDurationMs=${evidence.closeDurationMs}`,
    `survivors=${evidence.survivorsAfterCleanup.length}`,
  ].join(" ");
}

async function assertMainEntry(binding: BuildBinding): Promise<void> {
  const canonical = await realpath(binding.mainEntryPath);
  if (
    canonical !== binding.mainEntryPath ||
    !isPathInside(binding.artifactRoot, canonical)
  ) {
    throw new Error("Accepted main entry changed canonical path.");
  }
  if (sha256(await readFile(canonical)) !== binding.mainEntrySha256) {
    throw new Error("Accepted main entry bytes changed before launch.");
  }
}

async function assertAcceptedApp(binding: BuildBinding): Promise<void> {
  await assertMainEntry(binding);
  await verifyAcceptedAppInventory(
    binding.artifactRoot,
    binding.acceptedAppFiles as unknown as JsonRecord[],
  );
  const executableBytes = await readFile(
    String(binding.electronIdentity.executablePath),
  );
  if (
    executableBytes.byteLength !== binding.electronIdentity.bytes ||
    sha256(executableBytes) !== binding.electronIdentity.sha256
  )
    throw new Error("Sealed Electron identity changed around launch.");
}

function expectedStateProjection(state: JsonRecord): JsonRecord {
  const discovery = requireRecord(state.discovery, "Seed discovery state");
  return {
    profile: state.profile,
    // Startup derives setup status/step and may materialize missing-field
    // review items with a wall-clock createdAt. Compare only the stable
    // derived fields here; restart parity below still proves that the full
    // returned state (including generated review items) is durable.
    profileSetupState: expectedProfileSetupStateProjection(state),
    searchPreferences: state.searchPreferences,
    settings: state.settings,
    sourceDebugLineage: {
      activeSourceDebugRun: discovery.activeSourceDebugRun ?? null,
      recentSourceDebugRuns: discovery.recentSourceDebugRuns ?? [],
    },
  };
}

function expectedProfileSetupStateProjection(state: JsonRecord): JsonRecord {
  const profile = CandidateProfileSchema.parse(state.profile);
  const searchPreferences = JobSearchPreferencesSchema.parse(
    state.searchPreferences,
  );
  const persistedState = ProfileSetupStateSchema.parse(state.profileSetupState);
  const derivedState = deriveProfileSetupState(profile, searchPreferences, {
    currentState: persistedState,
  });
  return {
    status: derivedState.status,
    currentStep: derivedState.currentStep,
  };
}

function savedJobIdsFromState(state: JsonRecord): string[] {
  return (Array.isArray(state.savedJobs) ? state.savedJobs : [])
    .map((entry) => requireRecord(entry, "Intended saved job").id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

function savedJobIdsFromSnapshot(snapshot: unknown): string[] {
  const value = requireRecord(snapshot, "Workspace snapshot");
  const ids = [
    ...(Array.isArray(value.discoveryJobs) ? value.discoveryJobs : []).map(
      (entry) => requireRecord(entry, "Discovery job").id,
    ),
    ...(Array.isArray(value.reviewQueue) ? value.reviewQueue : []).map(
      (entry) => requireRecord(entry, "Review queue item").jobId,
    ),
    ...(Array.isArray(value.applicationRecords)
      ? value.applicationRecords
      : []
    ).map((entry) => requireRecord(entry, "Application record").jobId),
  ].filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}

function snapshotSemanticProjection(snapshot: unknown): JsonRecord {
  const value = requireRecord(snapshot, "Workspace snapshot");
  return {
    profile: value.profile,
    profileSetupState: value.profileSetupState,
    searchPreferences: value.searchPreferences,
    settings: value.settings,
    activeSourceDebugRun: value.activeSourceDebugRun ?? null,
    recentSourceDebugRuns: value.recentSourceDebugRuns ?? [],
    // This is the complete durable restart projection. Keep intelligence here
    // so P13 outcome events and batch safeguards cannot disappear between the
    // reset and production restart unnoticed. It intentionally stays out of
    // resetIntentSnapshotProjection, whose contract is the relaxed reset
    // intent rather than every startup-derived/durable field.
    intelligence: value.intelligence ?? {},
    applicationAttempts: value.applicationAttempts ?? [],
    applicationRecords: value.applicationRecords ?? [],
    applyJobResults: value.applyJobResults ?? [],
    applyRuns: value.applyRuns ?? [],
    campaignNotifications: value.campaignNotifications ?? [],
    campaigns: value.campaigns ?? [],
    discoveryJobs: value.discoveryJobs ?? [],
    resumeDrafts: value.resumeDrafts ?? [],
    resumeExportArtifacts: value.resumeExportArtifacts ?? [],
    tailoredAssets: value.tailoredAssets ?? [],
    userActionEvents: value.userActionEvents ?? [],
    userActionRequests: value.userActionRequests ?? [],
  };
}

function resetIntentSnapshotProjection(snapshot: unknown): JsonRecord {
  const value = requireRecord(snapshot, "Workspace snapshot");
  const profileSetupState = ProfileSetupStateSchema.parse(
    value.profileSetupState,
  );
  return {
    profile: value.profile,
    // The setup review list is derived by getWorkspaceSnapshot() and its
    // generated timestamps are intentionally not part of reset intent.
    profileSetupState: {
      status: profileSetupState.status,
      currentStep: profileSetupState.currentStep,
    },
    searchPreferences: value.searchPreferences,
    settings: value.settings,
    sourceDebugLineage: {
      activeSourceDebugRun: value.activeSourceDebugRun ?? null,
      recentSourceDebugRuns: value.recentSourceDebugRuns ?? [],
    },
  };
}

async function openAndLoad(app: ElectronSeedProcess): Promise<{
  snapshot: unknown;
  testApiPresent: boolean;
}> {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () =>
      Boolean(
        (globalThis as unknown as SeedWindowGlobal).nestor?.jobFinder
          ?.getWorkspace,
      ),
    undefined,
    { timeout: 30_000 },
  );
  return page.evaluate(async () => {
    const api = (globalThis as unknown as SeedWindowGlobal).nestor?.jobFinder;
    if (!api?.getWorkspace)
      throw new Error("Normal workspace API is unavailable.");
    return {
      snapshot: await api.getWorkspace(),
      testApiPresent: Boolean(api.test),
    };
  }, undefined);
}

async function seedPersona(
  options: PrepareBlindPersonaOptions,
  binding: BuildBinding,
  session: BlindPersonaSession,
  launch: LaunchSeedElectron,
): Promise<PreparedPersonaWorkspace> {
  const personaId = personaShortId(session);
  const userDataRoot = createUniquePersonaRoot(
    options.destinationRoot,
    personaId,
  );
  await assertNoAncestorSymlink(userDataRoot);
  if (await exists(userDataRoot))
    throw new Error(`Refusing existing seed destination: ${userDataRoot}`);
  await mkdir(userDataRoot, { recursive: false });
  try {
    const assetsRoot = path.join(userDataRoot, "persona-assets");
    await mkdir(assetsRoot);
    const sourceResume = resolveConfinedPath(
      desktopRoot,
      session.resumeInput.path,
    );
    await assertNoAncestorSymlink(sourceResume);
    const resumeDestination = resolveConfinedPath(
      assetsRoot,
      `resume/${path.basename(sourceResume)}`,
    );
    await mkdir(path.dirname(resumeDestination), { recursive: true });
    await copyFile(sourceResume, resumeDestination);
    let resumeStoragePath = path
      .relative(userDataRoot, resumeDestination)
      .split(path.sep)
      .join("/");
    let resumeSha256: string | undefined;
    if (personaId === "P13" || personaId === "P14") {
      resumeSha256 = sha256(await readFile(resumeDestination));
      // The persona input is retained for custody/debugging, but production
      // startup validates persisted original-CV paths against the app-owned
      // documents directory. Materialize that same byte content there and
      // bind the returning-persona state to its real digest so restart
      // validation is a truthful no-op rather than a missing/changed-source
      // recovery. Fresh personas intentionally keep only their import input.
      const appOwnedResumeDirectory = path.join(
        userDataRoot,
        "documents",
        "resumes",
      );
      const appOwnedResumePath = path.join(
        appOwnedResumeDirectory,
        path.basename(sourceResume),
      );
      await mkdir(appOwnedResumeDirectory, { recursive: true });
      await copyFile(resumeDestination, appOwnedResumePath);
      if (sha256(await readFile(appOwnedResumePath)) !== resumeSha256) {
        throw new Error(
          "Materialized persona resume bytes failed integrity verification.",
        );
      }
      resumeStoragePath = appOwnedResumePath;
    }
    const seedData = await loadBlindPersonaSeedData();
    const seededJobs = getBlindPersonaJobsForSession(seedData, session);
    const jobsDestination = resolveConfinedPath(assetsRoot, "jobs.json");
    await writeFile(
      jobsDestination,
      `${stableBlindPersonaSerialization(seededJobs)}\n`,
      "utf8",
    );
    const state = await buildPersonaState(
      session,
      resumeStoragePath,
      resumeSha256,
    );
    const authorityViolations = scanSeedAuthority(state);
    const crossPersonaPaths = scanCrossPersonaPaths(state, personaId);
    if (authorityViolations.length || crossPersonaPaths.length) {
      throw new Error(
        `Persona state failed safety scan: ${JSON.stringify({ authorityViolations, crossPersonaPaths })}`,
      );
    }

    await assertAcceptedApp(binding);
    let seedApp: ElectronSeedProcess | undefined;
    let seedCleanup: CleanupEvidence | undefined;
    let resetSnapshot: unknown;
    try {
      seedApp = await launch({
        args: zeroNetworkLaunchArgs,
        cwd: binding.artifactRoot,
        executablePath: String(binding.electronIdentity.executablePath),
        env: hardenSeedEnvironment(process.env, userDataRoot),
      });
      const page = await seedApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(
        () =>
          Boolean(
            (globalThis as unknown as SeedWindowGlobal).nestor?.jobFinder?.test
              ?.resetWorkspaceState,
          ),
        undefined,
        { timeout: 30_000 },
      );
      resetSnapshot = await page.evaluate(async (repositoryState) => {
        const jobFinder = (globalThis as unknown as SeedWindowGlobal).nestor
          ?.jobFinder;
        const workspaceApi = jobFinder?.getWorkspace;
        if (!workspaceApi)
          throw new Error("Job Finder workspace API is unavailable.");
        await workspaceApi();
        const resetApi = jobFinder?.test?.resetWorkspaceState;
        if (!resetApi)
          throw new Error("Seed-only desktop test API is unavailable.");
        return resetApi(repositoryState);
      }, state);
      if (
        stableSeedSerialization(expectedStateProjection(state)) !==
        stableSeedSerialization(resetIntentSnapshotProjection(resetSnapshot))
      ) {
        throw new Error(
          "Reset-returned workspace does not match intended semantic state.",
        );
      }
      if (
        stableSeedSerialization(savedJobIdsFromState(state)) !==
        stableSeedSerialization(savedJobIdsFromSnapshot(resetSnapshot))
      ) {
        throw new Error(
          "Reset-returned workspace does not contain the intended saved jobs.",
        );
      }
    } finally {
      if (seedApp) seedCleanup = await closeOwnedProcess(seedApp);
    }
    if (!seedCleanup || seedCleanup.survivorsAfterCleanup.length > 0) {
      throw new Error(`Seed process tree did not terminate for ${personaId}.`);
    }
    await assertAcceptedApp(binding);

    let restartApp: ElectronSeedProcess | undefined;
    let restartCleanup: CleanupEvidence | undefined;
    let restartSnapshot: unknown;
    try {
      restartApp = await launch({
        args: zeroNetworkLaunchArgs,
        cwd: binding.artifactRoot,
        executablePath: String(binding.electronIdentity.executablePath),
        env: hardenTesterEnvironment(process.env, userDataRoot),
      });
      const loaded = await openAndLoad(restartApp);
      if (loaded.testApiPresent)
        throw new Error("Production restart exposed the test preload/API.");
      restartSnapshot = loaded.snapshot;
      if (
        stableSeedSerialization(snapshotSemanticProjection(resetSnapshot)) !==
        stableSeedSerialization(snapshotSemanticProjection(restartSnapshot))
      ) {
        throw new Error(
          "Workspace semantic state changed after production restart/recovery/default adoption.",
        );
      }
    } finally {
      if (restartApp) restartCleanup = await closeOwnedProcess(restartApp);
    }
    if (!restartCleanup || restartCleanup.survivorsAfterCleanup.length > 0) {
      throw new Error(
        `Restart process tree did not terminate for ${personaId}.`,
      );
    }
    await assertAcceptedApp(binding);

    const payload = await inventoryTree(userDataRoot, new Set([manifestName]));
    const seedManifest = {
      schemaVersion: 2,
      personaId,
      blindPersonaDigest: seedData.digestSha256,
      build: binding,
      visualReviewTemplate: seedData.manifest.visualReviewTemplate,
      input: {
        importRequired: session.resumeInput.importRequired,
        presentation: session.resumeInput.presentation,
        resumePath: path
          .relative(userDataRoot, resumeDestination)
          .split(path.sep)
          .join("/"),
        starterSources: session.workspace.starterSources,
      },
      state: {
        intendedDigest: sha256(stableBlindPersonaSerialization(state)),
        semanticDigest: sha256(
          stableSeedSerialization(snapshotSemanticProjection(restartSnapshot)),
        ),
        profileSetupStatus: personaId <= "P12" ? "not_started" : "materialized",
      },
      processOwnership: {
        launchCount: 2,
        resetCount: 1,
        seed: seedCleanup,
        restart: restartCleanup,
      },
      environmentIntent: {
        aiCalls: 0,
        browserAgent: false,
        externalWrites: 0,
        networkCalls: 0,
        socketTelemetryAvailable: false,
      },
      payloadInventory: payload,
      contaminationProof: {
        excludedFiles: [manifestName, ...browserManagedTransientSidecarNames],
        verification: "exact raw-byte inventory plus external custody digest",
      },
    };
    const seedManifestSha256 = sha256(stableSeedSerialization(seedManifest));
    const finalManifest = { ...seedManifest, seedManifestSha256 };
    const seedManifestPath = path.join(userDataRoot, manifestName);
    await writeFile(
      seedManifestPath,
      `${JSON.stringify(finalManifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o444 },
    );
    await chmod(seedManifestPath, 0o444);
    return {
      personaId,
      seedManifestPath,
      seedManifestSha256,
      userDataRoot,
      workspaceDigest: payload.digest,
    };
  } catch (error) {
    const quarantine = `${userDataRoot}.incomplete`;
    try {
      await rename(userDataRoot, quarantine);
    } catch {
      await rm(userDataRoot, { force: true, recursive: true });
    }
    throw new Error(
      `Persona ${personaId} preparation failed; incomplete root quarantined or removed: ${userDataRoot}`,
      { cause: error },
    );
  }
}

async function writeCustodyIndex(
  custodyRoot: string,
  binding: BuildBinding,
  prepared: PreparedPersonaWorkspace[],
  waveComplete: boolean,
): Promise<string> {
  await mkdir(custodyRoot, { recursive: true });
  const canonicalCustody = await canonicalDirectory(
    custodyRoot,
    "Custody root",
  );
  if (
    prepared.some((entry) => isPathInside(entry.userDataRoot, canonicalCustody))
  ) {
    throw new Error("Custody index must be outside all persona roots.");
  }
  const subject = {
    schemaVersion: 1,
    threatBoundary:
      "The external custody index detects persona-root payload and manifest tampering; an attacker who can also rewrite this custody index remains outside this local integrity boundary.",
    waveComplete,
    build: binding,
    personas: prepared.map((entry) => ({
      personaId: entry.personaId,
      seedManifestPath: entry.seedManifestPath,
      seedManifestSha256: entry.seedManifestSha256,
      userDataRoot: entry.userDataRoot,
      workspaceDigest: entry.workspaceDigest,
    })),
  };
  const finalIndex = {
    ...subject,
    custodyIndexSha256: sha256(stableSeedSerialization(subject)),
  };
  const custodyPath = path.join(canonicalCustody, custodyName);
  await writeFile(custodyPath, `${JSON.stringify(finalIndex, null, 2)}\n`, {
    flag: "wx",
    mode: 0o444,
  });
  await chmod(custodyPath, 0o444);
  return custodyPath;
}

interface LoadedCustodyIndex {
  binding: BuildBinding;
  indexPath: string;
  personas: JsonRecord[];
  waveComplete: boolean;
}

async function loadCustodyIndex(
  custodyIndexPath: string,
): Promise<LoadedCustodyIndex> {
  await assertNoAncestorSymlink(custodyIndexPath);
  const index = await readJson(custodyIndexPath);
  const subject = { ...index };
  delete subject.custodyIndexSha256;
  if (sha256(stableSeedSerialization(subject)) !== index.custodyIndexSha256)
    throw new Error("Custody index digest mismatch.");
  const personas = (Array.isArray(index.personas) ? index.personas : []).map(
    (item) => requireRecord(item, "Custody persona"),
  );
  return {
    binding: requireRecord(
      index.build,
      "Custody build",
    ) as unknown as BuildBinding,
    indexPath: path.resolve(custodyIndexPath),
    personas,
    waveComplete: index.waveComplete === true,
  };
}

async function loadCustodyEntry(
  custodyIndexPath: string,
  personaId: string,
): Promise<{
  binding: BuildBinding;
  entry: JsonRecord;
  waveComplete: boolean;
}> {
  const loaded = await loadCustodyIndex(custodyIndexPath);
  const entry = loaded.personas.find((item) => item.personaId === personaId);
  if (!entry)
    throw new Error(`Custody index does not own persona ${personaId}.`);
  return {
    binding: loaded.binding,
    entry,
    waveComplete: loaded.waveComplete,
  };
}

export interface WorkspaceVolatileSpecialEntry {
  kind: string;
  path: string;
}

export interface PreparedWorkspaceVerification {
  decidedBy: string | null;
  manifestSha256: string;
  mode: "strict" | "consumed";
  personaId: string;
  runtimeVolatileFileCount: number;
  runtimeVolatileFiles: string[];
  runtimeVolatileSpecialEntries: WorkspaceVolatileSpecialEntry[];
  sealedEntryCount: number;
  sealedPayloadDigest: string;
  userDataRoot: string;
}

function specialDirentKind(entry: NodeJS.Dirent): string | null {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isSocket()) return "socket";
  if (entry.isFIFO()) return "fifo";
  if (entry.isBlockDevice()) return "block-device";
  if (entry.isCharacterDevice()) return "character-device";
  return null;
}

function sealedInventoryEntries(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`${label} is empty.`);
  const seen = new Set<string>();
  return value.map((unknownEntry) => {
    const entry = requireRecord(unknownEntry, `${label} entry`);
    if (typeof entry.path !== "string")
      throw new Error(`${label} entry is missing path.`);
    resolveConfinedPath("/inventory", entry.path);
    if (seen.has(entry.path))
      throw new Error(`${label} repeats ${entry.path}.`);
    seen.add(entry.path);
    requireDigest(entry.sha256, `${label} ${entry.path}`);
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0)
      throw new Error(`${label} has invalid byte count for ${entry.path}.`);
    return entry;
  });
}

async function classifyWorkspaceTree(
  root: string,
  sealedPaths: ReadonlySet<string>,
  options: { hashSealed: boolean },
): Promise<{
  runtimeVolatileFiles: string[];
  runtimeVolatileSpecialEntries: WorkspaceVolatileSpecialEntry[];
  sealedReads: Map<string, Buffer | null>;
}> {
  const runtimeVolatileFiles: string[] = [];
  const runtimeVolatileSpecialEntries: WorkspaceVolatileSpecialEntry[] = [];
  const sealedReads = new Map<string, Buffer | null>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => compareCodeUnitOrder(left.name, right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filePath = path.join(directory, entry.name);
      if (relativePath === manifestName) continue;
      if (entry.isDirectory()) {
        await visit(filePath, relativePath);
        continue;
      }
      if (sealedPaths.has(relativePath)) {
        // Sealed entries must still be ordinary readable files; a symlink or
        // any other non-regular replacement stays fail-closed in both modes.
        if (!(await lstat(filePath)).isFile()) {
          throw new Error(
            `Sealed workspace entry is not a regular file: ${filePath}`,
          );
        }
        sealedReads.set(
          relativePath,
          options.hashSealed ? await readFile(filePath) : null,
        );
        continue;
      }
      const specialKind = specialDirentKind(entry);
      if (specialKind !== null) {
        // Runtime-volatile specials are recorded, never followed, and never
        // hashed.
        runtimeVolatileSpecialEntries.push({
          kind: specialKind,
          path: relativePath,
        });
      } else if (entry.isFile()) {
        runtimeVolatileFiles.push(relativePath);
      } else {
        runtimeVolatileSpecialEntries.push({
          kind: "unknown",
          path: relativePath,
        });
      }
    }
  };
  await visit(root, "");
  return { runtimeVolatileFiles, runtimeVolatileSpecialEntries, sealedReads };
}

function archivedLaunchRecordPattern(personaId: string): RegExp {
  const escapedPersona = personaId.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const recordBase = testerRecordName.replace(/\.json$/u, "");
  return new RegExp(
    `^${escapedPersona}-${recordBase}(?:-attempt-([1-9][0-9]*))?\\.json$`,
  );
}

function archivedLaunchIntentPattern(personaId: string): RegExp {
  const escapedPersona = personaId.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const intentBase = testerIntentName.replace(/\.json$/u, "");
  return new RegExp(
    `^${escapedPersona}-${intentBase}(?:-attempt-([1-9][0-9]*))?\\.json$`,
  );
}

// An archived intent only relaxes strict verification when it is authentic:
// self-digest intact, same persona, attempt-consistent file name, bound to the
// same custody index and sealed build. Forged/tampered/cross-persona intents
// fail verification instead of relaxing anything.
async function validateArchivedLaunchIntent(
  filePath: string,
  expected: {
    custodyIndexPath?: string;
    expectedSealSha256?: string;
    personaId: string;
  },
): Promise<JsonRecord> {
  let intent: JsonRecord;
  try {
    intent = requireRecord(
      JSON.parse((await readFile(filePath)).toString("utf8")),
      filePath,
    );
  } catch (error) {
    throw new Error(
      `Archived tester launch intent is unreadable: ${filePath}`,
      {
        cause: error,
      },
    );
  }
  const subject = { ...intent };
  delete subject.intentSha256;
  if (
    typeof intent.intentSha256 !== "string" ||
    sha256(stableSeedSerialization(subject)) !== intent.intentSha256
  ) {
    throw new Error(
      `Archived tester launch intent failed its self-digest check: ${filePath}`,
    );
  }
  if (intent.kind !== "blind-persona-tester-launch-intent") {
    throw new Error(
      `Archived tester launch intent has an unexpected kind: ${filePath}`,
    );
  }
  if (intent.personaId !== expected.personaId) {
    throw new Error(
      `Archived tester launch intent belongs to persona ${String(intent.personaId)}, not ${expected.personaId}: ${filePath}`,
    );
  }
  const fileName = path.basename(filePath);
  const match = archivedLaunchIntentPattern(expected.personaId).exec(fileName);
  const fileAttempt = Number(match?.[1] ?? 1);
  if (intent.attempt !== fileAttempt) {
    throw new Error(
      `Archived tester launch intent attempt ${String(intent.attempt)} does not match its file name ${fileName}.`,
    );
  }
  if (
    expected.custodyIndexPath !== undefined &&
    intent.custodyIndexPath !== path.resolve(expected.custodyIndexPath)
  ) {
    throw new Error(
      `Archived tester launch intent is bound to a different custody index: ${filePath}`,
    );
  }
  if (
    expected.expectedSealSha256 !== undefined &&
    (!intent.build ||
      typeof intent.build !== "object" ||
      (intent.build as JsonRecord).finalSealSha256 !==
        expected.expectedSealSha256)
  ) {
    throw new Error(
      `Archived tester launch intent is not bound to the sealed custody build: ${filePath}`,
    );
  }
  return intent;
}

async function resolveVerificationMode(input: {
  custodyIndexPath: string | null;
  knownAttempt?: number;
  personaId: string;
}): Promise<{ decidedBy: string | null; mode: "strict" | "consumed" }> {
  if (input.custodyIndexPath === null)
    return { decidedBy: null, mode: "strict" };
  // Always the caller-provided canonical index path: renamed or relocated
  // custody indexes stay first-class, never a hardcoded file name.
  const custodyDirectory = path.dirname(input.custodyIndexPath);
  const recordPattern = archivedLaunchRecordPattern(input.personaId);
  const archived = (await readdir(custodyDirectory))
    .flatMap((name) => {
      const match = recordPattern.exec(name);
      return match ? [{ attempt: Number(match[1] ?? 1), name }] : [];
    })
    .sort((left, right) => left.attempt - right.attempt)
    .map((entry) => path.join(custodyDirectory, entry.name));
  if (archived.length > 0)
    return { decidedBy: archived[0] as string, mode: "consumed" };
  // A spawned-but-failed launch writes its immutable intent before any process
  // exists; a valid archived intent counts as launch evidence for relaunch.
  const intentPattern = archivedLaunchIntentPattern(input.personaId);
  const archivedIntents = (await readdir(custodyDirectory))
    .flatMap((name) => {
      const match = intentPattern.exec(name);
      return match ? [{ attempt: Number(match[1] ?? 1), name }] : [];
    })
    .sort((left, right) => left.attempt - right.attempt)
    .map((entry) => path.join(custodyDirectory, entry.name));
  if (archivedIntents.length > 0) {
    const loadedCustody = await loadCustodyIndex(input.custodyIndexPath).catch(
      (error: unknown) => {
        throw new Error(
          `Cannot validate archived tester launch intents without a readable custody index at ${input.custodyIndexPath}`,
          { cause: error },
        );
      },
    );
    for (const intentPath of archivedIntents) {
      await validateArchivedLaunchIntent(intentPath, {
        custodyIndexPath: loadedCustody.indexPath,
        expectedSealSha256: loadedCustody.binding.finalSealSha256,
        personaId: input.personaId,
      });
    }
    return { decidedBy: archivedIntents[0] as string, mode: "consumed" };
  }
  if ((input.knownAttempt ?? 1) >= 2) {
    throw new Error(
      `Tester attempt ${input.knownAttempt} claims a prior launch, but no archived launch record or valid launch intent for ${input.personaId} exists under ${custodyDirectory}; refusing to relax verification.`,
    );
  }
  return { decidedBy: null, mode: "strict" };
}

export async function verifyPreparedPersonaWorkspace(
  userDataRoot: string,
  custodyIndexPath?: string,
  options?: { knownAttempt?: number },
): Promise<PreparedWorkspaceVerification> {
  const canonicalRoot = await canonicalDirectory(userDataRoot, "Persona root");
  const manifestPath = path.join(canonicalRoot, manifestName);
  const manifest = await readJson(manifestPath);
  const recordedManifestDigest = manifest.seedManifestSha256;
  const manifestSubject = { ...manifest };
  delete manifestSubject.seedManifestSha256;
  if (
    typeof recordedManifestDigest !== "string" ||
    sha256(stableSeedSerialization(manifestSubject)) !== recordedManifestDigest
  ) {
    throw new Error(`Persona seed manifest digest mismatch: ${manifestPath}`);
  }
  const payloadInventory = requireRecord(
    manifest.payloadInventory,
    "Sealed payload inventory",
  );
  const sealedFiles = sealedInventoryEntries(
    payloadInventory.files,
    "Sealed payload inventory",
  );
  const recordedPayloadDigest = requireDigest(
    payloadInventory.digest,
    "Sealed payload inventory digest",
  );
  const sealedDigestFromEntries = sha256(
    sealedFiles.map((entry) => `${stableSeedSerialization(entry)}\n`).join(""),
  );
  if (sealedDigestFromEntries !== recordedPayloadDigest)
    throw new Error(
      `Sealed payload inventory digest mismatch: ${manifestPath}`,
    );
  const personaId = String(manifest.personaId ?? "");
  const { decidedBy, mode } = await resolveVerificationMode({
    custodyIndexPath: custodyIndexPath ? path.resolve(custodyIndexPath) : null,
    knownAttempt: options?.knownAttempt,
    personaId,
  });
  const classified = await classifyWorkspaceTree(
    canonicalRoot,
    new Set(sealedFiles.map((entry) => String(entry.path))),
    { hashSealed: mode === "strict" },
  );
  for (const entry of sealedFiles) {
    const bytes = classified.sealedReads.get(String(entry.path));
    // Missing (or shadowed behind a non-traversable intermediate) sealed
    // entries fail closed in both modes.
    if (bytes === undefined) {
      throw new Error(
        `Sealed workspace entry is missing or shadowed: ${canonicalRoot} :: ${String(entry.path)}`,
      );
    }
    // Consumed mode preserves presence/special checks but tolerates byte
    // drift from already-launched sessions.
    if (
      mode === "strict" &&
      (bytes === null ||
        bytes.byteLength !== Number(entry.bytes) ||
        sha256(bytes) !== String(entry.sha256))
    ) {
      throw new Error(
        `Sealed workspace entry changed: ${canonicalRoot} :: ${String(entry.path)}`,
      );
    }
  }
  const sealedPayloadDigest = sealedDigestFromEntries;
  const runtimeVolatileFiles = [...classified.runtimeVolatileFiles].sort(
    compareCodeUnitOrder,
  );
  const runtimeVolatileSpecialEntries = [
    ...classified.runtimeVolatileSpecialEntries,
  ].sort((left, right) => compareCodeUnitOrder(left.path, right.path));
  if (custodyIndexPath) {
    const custody = await loadCustodyEntry(custodyIndexPath, personaId);
    if (
      custody.entry.userDataRoot !== canonicalRoot ||
      custody.entry.seedManifestPath !== manifestPath ||
      custody.entry.seedManifestSha256 !== recordedManifestDigest ||
      custody.entry.workspaceDigest !== sealedPayloadDigest
    )
      throw new Error(
        "Persona payload/manifest does not match external custody index.",
      );
  }
  return {
    decidedBy,
    manifestSha256: recordedManifestDigest,
    mode,
    personaId,
    runtimeVolatileFileCount: runtimeVolatileFiles.length,
    runtimeVolatileFiles,
    runtimeVolatileSpecialEntries,
    sealedEntryCount: sealedFiles.length,
    sealedPayloadDigest,
    userDataRoot: canonicalRoot,
  };
}

export interface VerifyAllPersonaResult {
  error: string | null;
  mode: "strict" | "consumed" | null;
  ok: boolean;
  personaId: string;
  runtimeVolatileFileCount: number | null;
  runtimeVolatileSpecialEntryCount: number | null;
}

export interface VerifyAllPreparedWorkspacesOutcome {
  custodyIndexPath: string;
  failures: number;
  ok: number;
  results: VerifyAllPersonaResult[];
  total: number;
  waveComplete: boolean;
}

export async function verifyAllPreparedPersonaWorkspaces(input: {
  custodyIndexPath: string;
}): Promise<VerifyAllPreparedWorkspacesOutcome> {
  const loaded = await loadCustodyIndex(path.resolve(input.custodyIndexPath));
  if (loaded.personas.length === 0)
    throw new Error("Custody index records no prepared personas to verify.");
  const results: VerifyAllPersonaResult[] = [];
  for (const entry of loaded.personas) {
    const personaId = String(entry.personaId ?? "");
    try {
      const verification = await verifyPreparedPersonaWorkspace(
        String(entry.userDataRoot ?? ""),
        loaded.indexPath,
      );
      results.push({
        error: null,
        mode: verification.mode,
        ok: true,
        personaId,
        runtimeVolatileFileCount: verification.runtimeVolatileFileCount,
        runtimeVolatileSpecialEntryCount:
          verification.runtimeVolatileSpecialEntries.length,
      });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        mode: null,
        ok: false,
        personaId,
        runtimeVolatileFileCount: null,
        runtimeVolatileSpecialEntryCount: null,
      });
    }
  }
  const failures = results.filter((row) => !row.ok).length;
  return {
    custodyIndexPath: loaded.indexPath,
    failures,
    ok: results.length - failures,
    results,
    total: results.length,
    waveComplete: loaded.waveComplete,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoExceptionCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

const CUSTODY_INDEX_EXISTS_GUIDANCE =
  "custody index already exists in this root; use a fresh --custody-root per preparation invocation";

export async function prepareBlindPersonaWorkspaces(
  options: PrepareBlindPersonaOptions,
  dependencies: { launch?: LaunchSeedElectron } = {},
): Promise<{
  binding: BuildBinding;
  custodyIndexPath: string | null;
  dryRun: boolean;
  prepared: PreparedPersonaWorkspace[];
}> {
  await mkdir(options.destinationRoot, { recursive: true });
  const [destinationRoot] = await Promise.all([
    canonicalDirectory(options.destinationRoot, "Destination root"),
    assertNoAncestorSymlink(options.custodyRoot),
  ]);
  // Persona roots and custody entries are built only from the canonicalized
  // destination root (mirroring the custody-root handling).
  const canonicalOptions: PrepareBlindPersonaOptions = {
    ...options,
    destinationRoot,
  };
  const binding = await verifyAcceptedBuild({
    acceptanceRunDir: options.acceptanceRunDir,
    expectedSealSha256: options.expectedSealSha256,
  });
  const seedData = await loadBlindPersonaSeedData();
  const requested =
    options.personaIds ?? seedData.manifest.sessions.map(personaShortId);
  if (new Set(requested).size !== requested.length)
    throw new Error("Duplicate persona IDs are not allowed.");
  const sessions = requested.map((personaId) => {
    const session = seedData.manifest.sessions.find(
      (item) => personaShortId(item) === personaId,
    );
    if (!session) throw new Error(`Unknown blind persona: ${personaId}`);
    return session;
  });
  if (options.dryRun)
    return { binding, custodyIndexPath: null, dryRun: true, prepared: [] };
  const prepared: PreparedPersonaWorkspace[] = [];
  for (const session of sessions) {
    try {
      prepared.push(
        await seedPersona(
          canonicalOptions,
          binding,
          session,
          dependencies.launch ?? defaultLaunch,
        ),
      );
    } catch (error) {
      let preservedNote = "";
      if (prepared.length > 0) {
        try {
          const partialCustodyPath = await writeCustodyIndex(
            options.custodyRoot,
            binding,
            prepared,
            false,
          );
          preservedNote = ` Successful sealed roots were preserved in incomplete-wave custody ${partialCustodyPath}.`;
        } catch (custodyError) {
          if (!isErrnoExceptionCode(custodyError, "EEXIST")) {
            // Non-EEXIST custody failures must not mask the original wave
            // failure either; keep {cause} parity with the aggregated throw.
            throw new Error(
              `${errorText(error)}; additionally, incomplete-wave custody write failed: ${errorText(custodyError)}`,
              { cause: error },
            );
          }
          preservedNote = `; additionally, ${CUSTODY_INDEX_EXISTS_GUIDANCE} (${errorText(custodyError)})`;
        }
      }
      throw new Error(`${errorText(error)}${preservedNote}`, { cause: error });
    }
  }
  let custodyIndexPath: string;
  try {
    custodyIndexPath = await writeCustodyIndex(
      options.custodyRoot,
      binding,
      prepared,
      true,
    );
  } catch (custodyError) {
    if (!isErrnoExceptionCode(custodyError, "EEXIST")) throw custodyError;
    throw new Error(
      `Blind-persona ${CUSTODY_INDEX_EXISTS_GUIDANCE} (${errorText(custodyError)}).`,
      { cause: custodyError },
    );
  }
  return { binding, custodyIndexPath, dryRun: false, prepared };
}

export function testerLaunchRecordName(
  personaId: string,
  attempt: number = 1,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(
      `Tester attempt must be an integer >= 1: ${String(attempt)}`,
    );
  }
  const baseName = `${personaId}-${testerRecordName}`;
  return attempt === 1
    ? baseName
    : baseName.replace(/\.json$/u, `-attempt-${attempt}.json`);
}

export function testerLaunchIntentName(
  personaId: string,
  attempt: number = 1,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(
      `Tester attempt must be an integer >= 1: ${String(attempt)}`,
    );
  }
  const baseName = `${personaId}-${testerIntentName}`;
  return attempt === 1
    ? baseName
    : baseName.replace(/\.json$/u, `-attempt-${attempt}.json`);
}

export interface DriverChannelDisabledRecord {
  enabled: false;
}

export interface DriverChannelEnabledRecord {
  bindAddress: string;
  enabled: true;
  flag: "--driver-cdp";
  networkBlockingIntact: boolean;
  port: number;
  requestedPortArg: string;
  resolution:
    | "ephemeral-port-zero-devtools-active-port-file"
    | "fixed-high-random-port-devtools-active-port-file"
    | "fixed-high-random-port-http-json-version-probe";
  transport: "chrome-devtools-protocol";
  url: string;
}

export type DriverChannelRecord =
  | DriverChannelDisabledRecord
  | DriverChannelEnabledRecord;

function parseDevToolsActivePortFile(contents: string): number | null {
  const firstLine = (contents.split(/\r?\n/u, 1)[0] ?? "").trim();
  if (!/^\d{1,5}$/u.test(firstLine)) return null;
  const port = Number(firstLine);
  return port >= 1 && port <= 65535 ? port : null;
}

type DriverPortFileState =
  | { status: "invalid" }
  | { status: "missing" }
  | { port: number; status: "valid" };

async function readDriverPortFileStateOnce(
  userDataRoot: string,
): Promise<DriverPortFileState> {
  const contents = await readFile(
    path.join(userDataRoot, devToolsActivePortFileName),
    "utf8",
  ).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    return undefined;
  });
  if (contents === null) return { status: "missing" };
  if (contents === undefined) return { status: "invalid" };
  const port = parseDevToolsActivePortFile(contents);
  return port === null ? { status: "invalid" } : { port, status: "valid" };
}

async function waitForEphemeralDriverPort(
  userDataRoot: string,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const fileState = await readDriverPortFileStateOnce(userDataRoot);
    if (fileState.status === "valid") return fileState.port;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function cdpVersionUrl(port: number): string {
  return `http://${driverBindAddress}:${port}/json/version`;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255,
    )
  );
}

function isVerifiedCdpWebSocketUrl(
  value: unknown,
  expectedPort: number,
): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const endpoint = new URL(value);
    const port = Number(endpoint.port);
    return (
      (endpoint.protocol === "ws:" || endpoint.protocol === "wss:") &&
      isLoopbackHostname(endpoint.hostname) &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      port === expectedPort
    );
  } catch {
    return false;
  }
}

async function cdpEndpointHasRequiredKeys(
  url: string,
  expectedPort: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response.ok) return false;
    const parsed: unknown = await response.json();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return (
      typeof record.Browser === "string" &&
      record.Browser.trim() !== "" &&
      isVerifiedCdpWebSocketUrl(record.webSocketDebuggerUrl, expectedPort)
    );
  } catch {
    return false;
  }
}

async function confirmFixedDriverPort(input: {
  port: number;
  timeoutMs: number;
  userDataRoot: string;
}): Promise<"devtools-active-port-file" | "http-json-version-probe" | null> {
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const fileState = await readDriverPortFileStateOnce(input.userDataRoot);
    const fileMatches =
      fileState.status === "valid" && fileState.port === input.port;
    // A DevToolsActivePort file that disagrees with the requested fixed port
    // never succeeds; keep polling until the deadline in case the file is
    // still settling (fail-safe direction preserved).
    if (
      await cdpEndpointHasRequiredKeys(
        cdpVersionUrl(input.port),
        input.port,
        Math.min(750, remaining),
      )
    ) {
      if (fileMatches) return "devtools-active-port-file";
      if (fileState.status === "missing") return "http-json-version-probe";
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function randomFixedDriverPort(): number {
  const span = fixedDriverPortMax - fixedDriverPortMin + 1;
  return fixedDriverPortMin + Math.floor(Math.random() * span);
}

interface DriverChannelLaunchPlan {
  baseArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  launch: LaunchSeedElectron;
  timeoutMs: number;
  userDataRoot: string;
}

async function establishDriverCdpChannel(
  plan: DriverChannelLaunchPlan,
): Promise<{ app: ElectronSeedProcess; record: DriverChannelEnabledRecord }> {
  const networkBlockingIntact =
    plan.baseArgs.includes(zeroNetworkHostResolverArg) &&
    plan.baseArgs.includes(zeroNetworkProxyArg);
  const addressArg = `--remote-debugging-address=${driverBindAddress}`;
  // Hygiene only: resolution correctness comes from the liveness proof below,
  // so a stale DevToolsActivePort file from a crashed prior launch cannot
  // satisfy an ephemeral read on its own.
  await rm(path.join(plan.userDataRoot, devToolsActivePortFileName), {
    force: true,
  }).catch(() => undefined);
  const requestedPortArg = "--remote-debugging-port=0";
  const ephemeralApp = await plan.launch({
    args: [...plan.baseArgs, addressArg, requestedPortArg],
    cwd: plan.cwd,
    env: plan.env,
    executablePath: plan.executablePath,
  });
  const ephemeralPort = await waitForEphemeralDriverPort(
    plan.userDataRoot,
    plan.timeoutMs,
  );
  // One bounded /json/version liveness check with the same required-key rule
  // as the fixed port: a read port that does not answer is unresolved and
  // falls through to the cleanup + fixed-port fallback (fail closed).
  const ephemeralConfirmed =
    ephemeralPort !== null &&
    (await cdpEndpointHasRequiredKeys(
      cdpVersionUrl(ephemeralPort),
      ephemeralPort,
      Math.min(750, Math.max(1, plan.timeoutMs)),
    ));
  if (ephemeralPort !== null && ephemeralConfirmed) {
    return {
      app: ephemeralApp,
      record: {
        bindAddress: driverBindAddress,
        enabled: true,
        flag: driverCdpFlag,
        networkBlockingIntact,
        port: ephemeralPort,
        requestedPortArg,
        resolution: "ephemeral-port-zero-devtools-active-port-file",
        transport: "chrome-devtools-protocol",
        url: `http://${driverBindAddress}:${ephemeralPort}`,
      },
    };
  }
  const ephemeralCleanup = await closeOwnedProcess(ephemeralApp);
  if (ephemeralCleanup.survivorsAfterCleanup.length > 0) {
    throw new Error(
      `Driver CDP ephemeral-port attempt left surviving processes; refusing to continue (cleanup ${summarizeCleanupEvidence(ephemeralCleanup)}).`,
    );
  }
  const fixedPort = randomFixedDriverPort();
  const fixedRequestedPortArg = `--remote-debugging-port=${fixedPort}`;
  const fixedApp = await plan.launch({
    args: [...plan.baseArgs, addressArg, fixedRequestedPortArg],
    cwd: plan.cwd,
    env: plan.env,
    executablePath: plan.executablePath,
  });
  const proof = await confirmFixedDriverPort({
    port: fixedPort,
    timeoutMs: plan.timeoutMs,
    userDataRoot: plan.userDataRoot,
  });
  if (proof === null) {
    const fixedCleanup = await closeOwnedProcess(fixedApp);
    throw new Error(
      `Unable to resolve the ${driverCdpFlag} remote-debugging port reliably (ephemeral and fixed high-port attempts failed; cleanup ${summarizeCleanupEvidence(fixedCleanup)}); failing closed instead of guessing.`,
    );
  }
  return {
    app: fixedApp,
    record: {
      bindAddress: driverBindAddress,
      enabled: true,
      flag: driverCdpFlag,
      networkBlockingIntact,
      port: fixedPort,
      requestedPortArg: fixedRequestedPortArg,
      resolution:
        proof === "devtools-active-port-file"
          ? "fixed-high-random-port-devtools-active-port-file"
          : "fixed-high-random-port-http-json-version-probe",
      transport: "chrome-devtools-protocol",
      url: `http://${driverBindAddress}:${fixedPort}`,
    },
  };
}

export interface TesterStartupGeometryRequested {
  windowHeight?: number;
  windowWidth?: number;
  zoomFactor?: number;
}

export interface TesterAppliedGeometryProbe {
  contentBounds?: JsonRecord | null;
  displayMode?: string | null;
  outerBounds?: JsonRecord | null;
  zoomFactor?: number | null;
}

export interface TesterStartupGeometryApplied {
  contentBounds: JsonRecord | null;
  contentBoundsMatchRequest: boolean | null;
  displayMode: string | null;
  divergences: string[];
  outerBounds: JsonRecord | null;
  outerBoundsMatchRequest: boolean | null;
  zoomFactor: number | null;
  /**
   * Null when no zoom factor was requested (nothing to compare); a boolean
   * exact-match verdict only for zoom-bearing requests.
   */
  zoomFactorMatchesRequest: boolean | null;
}

export interface TesterStartupGeometryRecord {
  applied?: TesterStartupGeometryApplied;
  injected: boolean;
  requested?: TesterStartupGeometryRequested;
}

interface TesterStartupGeometryInput {
  startupWindowHeight?: number;
  startupWindowWidth?: number;
  startupZoomFactor?: number;
}

function boundsDimensions(bounds: JsonRecord): {
  height: number | null;
  width: number | null;
} {
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  return {
    height: Number.isFinite(height) ? height : null,
    width: Number.isFinite(width) ? width : null,
  };
}

// Applied truth is measured, never assumed: exact-match booleans compare the
// live probe against the raw request, and divergences state observed
// differences factually (clamps happen inside the desktop shell and are not
// re-derived here) so the record never calls a requested value "applied".
export function summarizeTesterStartupGeometryApplied(
  requested: TesterStartupGeometryRequested,
  probe: TesterAppliedGeometryProbe,
): TesterStartupGeometryApplied {
  const divergences: string[] = [];
  const outer = probe.outerBounds ?? null;
  const content = probe.contentBounds ?? null;
  if (probe.outerBounds == null)
    divergences.push("outer bounds were not queryable");
  if (probe.contentBounds == null)
    divergences.push("content bounds were not queryable");
  if (
    typeof probe.zoomFactor !== "number" ||
    !Number.isFinite(probe.zoomFactor)
  )
    divergences.push("zoom factor was not queryable");

  const dimensionRequested =
    requested.windowWidth !== undefined || requested.windowHeight !== undefined;

  const matchDimensions = (
    bounds: JsonRecord | null,
    label: string,
  ): boolean => {
    if (bounds === null) return !dimensionRequested;
    const dimensions = boundsDimensions(bounds);
    let matches = true;
    for (const [requestedValue, measuredValue, name] of [
      [requested.windowWidth, dimensions.width, "width"],
      [requested.windowHeight, dimensions.height, "height"],
    ] as const) {
      if (requestedValue === undefined) continue;
      if (measuredValue === null) {
        matches = false;
        divergences.push(`${label} ${name} was not queryable`);
      } else if (measuredValue !== requestedValue) {
        matches = false;
        divergences.push(
          `applied ${label} ${name} ${measuredValue} differs from requested ${requestedValue}`,
        );
      }
    }
    return matches;
  };

  const outerBoundsMatchRequest = matchDimensions(outer, "outer");
  const contentBoundsMatchRequest = matchDimensions(content, "content");

  const measuredZoom =
    typeof probe.zoomFactor === "number" && Number.isFinite(probe.zoomFactor)
      ? probe.zoomFactor
      : null;
  // No zoom request means there is nothing to compare: the verdict is null,
  // never a fabricated false.
  const zoomFactorMatchesRequest =
    requested.zoomFactor === undefined
      ? null
      : measuredZoom !== null &&
        Math.abs(measuredZoom - requested.zoomFactor) < 1e-6;
  if (
    requested.zoomFactor !== undefined &&
    zoomFactorMatchesRequest === false &&
    measuredZoom !== null
  ) {
    divergences.push(
      `applied zoom factor ${measuredZoom} differs from requested ${requested.zoomFactor}`,
    );
  }

  return {
    contentBounds: content as JsonRecord | null,
    contentBoundsMatchRequest,
    displayMode:
      typeof probe.displayMode === "string" ? probe.displayMode : null,
    divergences,
    outerBounds: outer as JsonRecord | null,
    outerBoundsMatchRequest,
    zoomFactor: measuredZoom,
    zoomFactorMatchesRequest,
  };
}

function assertTesterStartupWindowDimension(
  value: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < startupWindowMinPx ||
    value > startupWindowMaxPx
  ) {
    throw new Error(
      `${label} must be an integer between ${startupWindowMinPx} and ${startupWindowMaxPx}: ${String(value)}`,
    );
  }
  return value;
}

function assertTesterStartupZoomFactor(value: number, label: string): number {
  if (
    !Number.isFinite(value) ||
    value < startupZoomMin ||
    value > startupZoomMax
  ) {
    throw new Error(
      `${label} must be a finite number between ${startupZoomMin} and ${startupZoomMax}: ${String(value)}`,
    );
  }
  return value;
}

// Ambient NESTOR_STARTUP_* / marker values are stripped defensively (the
// allowlisted hardening already excludes them), then re-added strictly from
// the validated flags together with the tester session marker. The desktop
// shell ignores startup-geometry variables entirely without the marker.
function applyTesterStartupGeometry(
  env: NodeJS.ProcessEnv,
  input: TesterStartupGeometryInput,
): TesterStartupGeometryRecord {
  for (const name of [
    startupWindowWidthEnvName,
    startupWindowHeightEnvName,
    startupZoomFactorEnvName,
    testerSessionGeometryEnvName,
  ]) {
    delete env[name];
  }
  const hasWindowPair =
    input.startupWindowWidth !== undefined &&
    input.startupWindowHeight !== undefined;
  if (hasWindowPair) {
    env[startupWindowWidthEnvName] = String(input.startupWindowWidth);
    env[startupWindowHeightEnvName] = String(input.startupWindowHeight);
  } else if (
    input.startupWindowWidth !== undefined ||
    input.startupWindowHeight !== undefined
  ) {
    throw new Error(
      `${startupWindowWidthEnvName} and ${startupWindowHeightEnvName} must be provided together.`,
    );
  }
  if (input.startupZoomFactor !== undefined) {
    env[startupZoomFactorEnvName] = String(input.startupZoomFactor);
  }
  if (!hasWindowPair && input.startupZoomFactor === undefined) {
    return { injected: false };
  }
  env[testerSessionGeometryEnvName] = "1";
  return {
    injected: true,
    requested: {
      ...(input.startupWindowWidth === undefined
        ? {}
        : { windowWidth: input.startupWindowWidth }),
      ...(input.startupWindowHeight === undefined
        ? {}
        : { windowHeight: input.startupWindowHeight }),
      ...(input.startupZoomFactor === undefined
        ? {}
        : { zoomFactor: input.startupZoomFactor }),
    },
  };
}

interface MainElectronWindowLike {
  getContentBounds(): unknown;
  getBounds(): unknown;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  isMaximized(): boolean;
  webContents: { getZoomFactor(): number };
}

function asBoundsRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

// Measures the live BrowserWindow after the page/window opened: outer bounds,
// content bounds, applied display mode, and the native zoom factor. Any
// failure propagates so the launch fails closed instead of guessing.
async function measureAppliedTesterGeometry(
  app: ElectronSeedProcess,
): Promise<TesterAppliedGeometryProbe> {
  if (!app.evaluateInMain) {
    throw new Error(
      "Tester launch cannot verify applied startup geometry without a main-process evaluation channel.",
    );
  }
  const probed: unknown = await app.evaluateInMain((electronUnknown) => {
    const electron = electronUnknown as {
      BrowserWindow: { getAllWindows(): MainElectronWindowLike[] };
    };
    const win = electron.BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return null;
    return {
      contentBounds: win.getContentBounds(),
      displayMode: win.isFullScreen()
        ? "fullscreen"
        : win.isMaximized()
          ? "maximized"
          : "normal",
      outerBounds: win.getBounds(),
      zoomFactor: win.webContents.getZoomFactor(),
    };
  });
  if (!probed || typeof probed !== "object") {
    throw new Error(
      "Tester applied-geometry probe found no live BrowserWindow to measure.",
    );
  }
  const record = requireRecord(probed, "Applied geometry probe");
  return {
    contentBounds: asBoundsRecord(record.contentBounds),
    displayMode:
      typeof record.displayMode === "string" ? record.displayMode : null,
    outerBounds: asBoundsRecord(record.outerBounds),
    zoomFactor:
      typeof record.zoomFactor === "number" &&
      Number.isFinite(record.zoomFactor)
        ? record.zoomFactor
        : null,
  };
}

export const BLIND_PERSONA_TESTER_BRIEF_SCHEMA_VERSION = 1 as const;

export interface BlindPersonaTesterBrief {
  checklist: BlindPersonaVisualReviewTemplate;
  kind: "blind-persona-tester-brief";
  postJourneyCheckpoint: string;
  routeFreedom: "outcome_only";
  schemaVersion: typeof BLIND_PERSONA_TESTER_BRIEF_SCHEMA_VERSION;
}

const testerPostJourneyCheckpoint =
  "POST-JOURNEY OPTIONAL CHECKPOINT - after the primary outcome is complete or safely blocked, if Profile Copilot is reachable, open it once and judge its discoverability, prompt wrapping, keyboard/focus behavior, form/Save overlap, conversation continuity, and proposal status clarity. Keep this checkpoint separate from your chosen route.";

function buildTesterBrief(
  visualReviewTemplate: BlindPersonaVisualReviewTemplate,
): BlindPersonaTesterBrief {
  return {
    checklist: visualReviewTemplate,
    kind: "blind-persona-tester-brief",
    postJourneyCheckpoint: testerPostJourneyCheckpoint,
    routeFreedom: "outcome_only",
    schemaVersion: BLIND_PERSONA_TESTER_BRIEF_SCHEMA_VERSION,
  };
}

export interface TesterSession {
  attempt: number;
  close(): Promise<CleanupEvidence>;
  driverChannel: DriverChannelRecord;
  launchRecordPath: string;
  pid: number | null;
  testerBrief: BlindPersonaTesterBrief;
}

export async function launchBlindPersonaTester(
  input: {
    attempt?: number;
    custodyIndexPath: string;
    driverCdp?: boolean;
    personaId: string;
    startupWindowHeight?: number;
    startupWindowWidth?: number;
    startupZoomFactor?: number;
  },
  dependencies: { driverTimeoutMs?: number; launch?: LaunchSeedElectron } = {},
): Promise<TesterSession> {
  if (!personaPattern.test(input.personaId))
    throw new Error(`Unsupported blind persona ID: ${input.personaId}`);
  const attempt = input.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error(
      `Tester attempt must be an integer >= 1: ${String(input.attempt)}`,
    );
  }
  // Validate startup geometry before any IO or process launch so bad requests
  // fail closed without touching custody state.
  const startupWindowWidth =
    input.startupWindowWidth === undefined
      ? undefined
      : assertTesterStartupWindowDimension(
          input.startupWindowWidth,
          "Tester startup window width",
        );
  const startupWindowHeight =
    input.startupWindowHeight === undefined
      ? undefined
      : assertTesterStartupWindowDimension(
          input.startupWindowHeight,
          "Tester startup window height",
        );
  const startupZoomFactor =
    input.startupZoomFactor === undefined
      ? undefined
      : assertTesterStartupZoomFactor(
          input.startupZoomFactor,
          "Tester startup zoom factor",
        );
  if (
    (startupWindowWidth === undefined) !==
    (startupWindowHeight === undefined)
  ) {
    throw new Error(
      `${startupWindowWidthEnvName} and ${startupWindowHeightEnvName} must be provided together.`,
    );
  }
  const custody = await loadCustodyEntry(
    path.resolve(input.custodyIndexPath),
    input.personaId,
  );
  if (!custody.waveComplete)
    throw new Error(
      "Tester launch refuses an incomplete blind-persona wave custody index.",
    );
  const userDataRoot = String(custody.entry.userDataRoot);
  await verifyPreparedPersonaWorkspace(
    userDataRoot,
    path.resolve(input.custodyIndexPath),
    { knownAttempt: attempt },
  );
  const currentBinding = await verifyAcceptedBuild({
    acceptanceRunDir: custody.binding.runDir,
    expectedSealSha256: custody.binding.finalSealSha256,
  });
  if (
    stableSeedSerialization(currentBinding) !==
    stableSeedSerialization(custody.binding)
  ) {
    throw new Error(
      "Tester launch build differs from custody-bound accepted build.",
    );
  }
  await assertAcceptedApp(currentBinding);
  const visualReviewTemplate = await readBoundVisualReviewTemplate(
    custody.entry.seedManifestPath,
  );
  const testerBrief = buildTesterBrief(visualReviewTemplate);
  const env = hardenTesterEnvironment(process.env, userDataRoot);
  const startupGeometry = applyTesterStartupGeometry(env, {
    ...(startupWindowHeight === undefined ? {} : { startupWindowHeight }),
    ...(startupWindowWidth === undefined ? {} : { startupWindowWidth }),
    ...(startupZoomFactor === undefined ? {} : { startupZoomFactor }),
  });
  const custodyDirectory = path.dirname(path.resolve(input.custodyIndexPath));
  // Immutable launch intent, written after every verification passed and
  // immediately before the first process spawn: a spawned-but-failed launch
  // that persists window state must still count as launch evidence for
  // relaunch instead of bricking consumed-mode verification.
  const intentPayload: JsonRecord = {
    schemaVersion: 1,
    kind: "blind-persona-tester-launch-intent",
    personaId: input.personaId,
    attempt,
    createdAtUtc: new Date().toISOString(),
    custodyIndexPath: path.resolve(input.custodyIndexPath),
    build: currentBinding,
    seed: {
      manifestPath: custody.entry.seedManifestPath,
      manifestFileSha256: sha256(
        await readFile(String(custody.entry.seedManifestPath)),
      ),
      manifestSha256: custody.entry.seedManifestSha256,
      workspaceDigest: custody.entry.workspaceDigest,
    },
    visualReviewTemplate,
    testerBrief,
    driverCdp: input.driverCdp === true,
    zeroNetwork: {
      hostResolverArg: zeroNetworkHostResolverArg,
      proxyArg: zeroNetworkProxyArg,
    },
    requestedGeometry:
      startupGeometry.injected && startupGeometry.requested
        ? startupGeometry.requested
        : null,
  };
  intentPayload.intentSha256 = sha256(stableSeedSerialization(intentPayload));
  const launchIntentPath = path.join(
    custodyDirectory,
    testerLaunchIntentName(input.personaId, attempt),
  );
  try {
    await writeFile(
      launchIntentPath,
      `${JSON.stringify(intentPayload, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
  } catch (error) {
    if (!isErrnoExceptionCode(error, "EEXIST")) throw error;
    // Immutable per-attempt evidence: never overwrite or delete; relaunches
    // must continue with the next attempt instead.
    throw new Error(
      `Immutable tester launch intent already exists for ${input.personaId} attempt ${attempt}: preserve ${launchIntentPath} and increment --attempt.`,
      { cause: error },
    );
  }
  const launch = dependencies.launch ?? defaultLaunch;
  let app: ElectronSeedProcess | undefined;
  let driverChannel: DriverChannelRecord = { enabled: false };
  try {
    if (input.driverCdp === true) {
      const established = await establishDriverCdpChannel({
        baseArgs: zeroNetworkLaunchArgs,
        cwd: currentBinding.artifactRoot,
        env,
        executablePath: String(currentBinding.electronIdentity.executablePath),
        launch,
        timeoutMs: dependencies.driverTimeoutMs ?? defaultDriverTimeoutMs,
        userDataRoot,
      });
      app = established.app;
      driverChannel = established.record;
    } else {
      app = await launch({
        args: zeroNetworkLaunchArgs,
        cwd: currentBinding.artifactRoot,
        executablePath: String(currentBinding.electronIdentity.executablePath),
        env,
      });
    }
    const loaded = await openAndLoad(app);
    if (loaded.testApiPresent)
      throw new Error("Tester launch exposed the test preload/API.");
    if (startupGeometry.injected) {
      // Applied truth: measure the live window; failure here fails closed.
      startupGeometry.applied = summarizeTesterStartupGeometryApplied(
        startupGeometry.requested ?? {},
        await measureAppliedTesterGeometry(app),
      );
    }
    const pid = app.process()?.pid ?? null;
    const launchRecord = {
      schemaVersion: 1,
      attempt,
      personaId: input.personaId,
      pid,
      build: currentBinding,
      electronLaunchIdentity: currentBinding.electronIdentity,
      driverChannel,
      startupGeometry,
      launchIntent: {
        path: launchIntentPath,
        sha256: intentPayload.intentSha256,
      },
      seed: {
        manifestPath: custody.entry.seedManifestPath,
        manifestFileSha256: sha256(
          await readFile(String(custody.entry.seedManifestPath)),
        ),
        manifestSha256: custody.entry.seedManifestSha256,
        workspaceDigest: custody.entry.workspaceDigest,
      },
      visualReviewTemplate,
      testerBrief,
      environment: env,
      intent: {
        aiCalls: 0,
        browserAgent: false,
        externalWrites: 0,
        networkCalls: 0,
        socketTelemetryAvailable: false,
      },
      custodyIndexPath: path.resolve(input.custodyIndexPath),
    };
    const launchRecordPath = path.join(
      custodyDirectory,
      testerLaunchRecordName(input.personaId, attempt),
    );
    await writeFile(
      launchRecordPath,
      `${JSON.stringify(launchRecord, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    return {
      attempt,
      driverChannel,
      launchRecordPath,
      pid,
      testerBrief,
      close: async () => {
        if (!app) throw new Error("Tester app ownership was lost.");
        const evidence = await closeOwnedProcess(app);
        await assertAcceptedApp(currentBinding);
        if (evidence.survivorsAfterCleanup.length > 0)
          throw new Error("Tester process descendants survived cleanup.");
        return evidence;
      },
    };
  } catch (error) {
    if (!app) throw error;
    const cleanup = await closeOwnedProcess(app);
    const integrityProblems: string[] = [];
    if (cleanup.survivorsAfterCleanup.length > 0)
      integrityProblems.push(
        `process descendants survived tester failure cleanup (${summarizeCleanupEvidence(cleanup)})`,
      );
    try {
      await assertAcceptedApp(currentBinding);
    } catch (integrityError) {
      integrityProblems.push(
        `accepted-app re-check failed: ${errorText(integrityError)}`,
      );
    }
    if (integrityProblems.length === 0) throw error;
    throw new Error(
      `${errorText(error)}; tester failure cleanup reported: ${integrityProblems.join("; ")}`,
      { cause: error },
    );
  }
}

export const BLIND_PERSONA_SEED_HELP = `Usage:
  node apps/desktop/scripts/prepare-blind-persona-workspaces-cli.mjs \\
    --acceptance-run-dir <production-acceptance-run> \\
    --destination-root <empty-parent> --custody-root <separate-directory> \\
    [--persona P01|all] [--dry-run]

The command independently verifies acceptance-report.json, build-manifest.json,
accepted evidence/source/artifact inventories, performs exactly one test-only reset,
then proves normal production restart durability before sealing external custody.
Use a fresh --custody-root per preparation invocation: when the custody index
already exists in the target root, the command aborts with the original cause
preserved in the error. Unknown flags or stray positional arguments are rejected.

Read-only re-check of an already-sealed wave (no launch, no mutation):
  node apps/desktop/scripts/prepare-blind-persona-workspaces-cli.mjs \\
    --verify-all --custody-index <blind-persona-wave-custody-index.json>`;

export const BLIND_PERSONA_VERIFY_ALL_HELP = `Usage:
  node apps/desktop/scripts/prepare-blind-persona-workspaces-cli.mjs \\
    --verify-all --custody-index <blind-persona-wave-custody-index.json>

Loads the existing external custody index (verifying its self-digest), then runs
the exact verifyPreparedPersonaWorkspace path for every recorded persona entry:
seed-manifest digest, sealed payload checks, and external custody binding.
Prints one ok/FAIL line per persona (with its verification mode) plus a JSON
summary and exits nonzero when any entry fails. Nothing is launched and no
state is mutated. Two-mode integrity boundary: with no archived tester launch
record (or valid archived tester launch intent) for a persona,
verification is STRICT and every seeded sealed entry
must stay byte-for-byte identical; once any launch record exists for that
persona, verification runs CONSUMED, meaning sealed entries must still exist
as regular files (deletion or symlink/special replacement fails closed) while
consumed-session byte drift is tolerated, so reseeding is not required for
relaunch. Files created after sealing are runtime-volatile (for example
DevToolsActivePort): they are listed with their count, never hashed, and never
fail verification. An empty custody index refuses verification. An incomplete
wave (waveComplete:false) may still report ok:true per-row, but tester launches
refuse such waves. Sealed-build re-verification is intentionally outside this
read-only pass.`;

export const BLIND_PERSONA_TESTER_HELP = `Usage:
  node apps/desktop/scripts/launch-blind-persona-tester-cli.mjs \\
    --custody-index <blind-persona-wave-custody-index.json> --persona <P01..P14> \\
    [--attempt <n>] [--driver-cdp]

--attempt <n> accepts integers >= 1 (default 1). Attempt 1 keeps the launch
record name P##-blind-persona-tester-launch-record.json; higher attempts write
P##-...-launch-record-attempt-<n>.json so interrupted relaunches (for example
P06) and retests never hit EEXIST and every prior attempt remains archived
evidence. An immutable P##-blind-persona-tester-launch-intent(-attempt-<n>)
record is written after all verification passed and immediately before the
first process spawns, binding persona, attempt, build/seed custody, requested
geometry, driver flag, zero-network intent, and an inspectable testerBrief
containing the bound visual checklist plus a clearly labeled post-journey
Profile Copilot checkpoint; the final launch record and CLI stdout expose the
same brief and reference its intent digest and path. Verification follows this launch evidence:
strict before any archived launch record exists (tamper-before-first-launch
fully enforced), consumed afterward (presence and special-entry checks
preserved; byte drift tolerated so reseeding is not required for relaunch);
a VALID archived launch intent counts as launch evidence
for relaunch after a spawned-but-failed attempt, while unreadable, forged,
cross-persona, or tampered intents fail verification instead of relaxing it;
runtime-volatile files (for example DevToolsActivePort) stay listed and
never hashed.

--driver-cdp is the opt-in parent-side automation channel: the sealed app is
launched with --remote-debugging-address=127.0.0.1 and an ephemeral
--remote-debugging-port=0, the resolved port is read from the workspace
DevToolsActivePort file and confirmed live via one bounded /json/version check
requiring Browser and webSocketDebuggerUrl keys; one verified fixed-high-random-
port fallback exists, and the resolved URL/port plus flag provenance are
recorded in the launch record JSON and stdout. If the port cannot be determined
reliably the launch fails closed instead of guessing. This channel belongs to
the parent process only; it grants no tester authority, and the zero-network
launch arguments (--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost and
--proxy-server=127.0.0.1:9) stay intact.

--window-width <n> together with --window-height <n> requests one complete
tester window size (integers ${startupWindowMinPx}..${startupWindowMaxPx}; both flags are required
together) and --zoom-factor <n> requests native renderer zoom (finite
${startupZoomMin}..${startupZoomMax}, applied by the desktop shell via webContents.setZoomFactor
after the document is ready; never CSS zoom or a --force-device-scale-factor
override). The values are injected as NESTOR_STARTUP_WINDOW_WIDTH,
NESTOR_STARTUP_WINDOW_HEIGHT, and NESTOR_STARTUP_ZOOM_FACTOR together
with the NESTOR_TESTER_SESSION_GEOMETRY=1 session marker only after
allowlisted environment hardening (any ambient copies of these keys are
stripped first), recorded under startupGeometry in the launch record with the
requested request separated from the measured applied window truth, and
enforced fail-closed end to end: invalid or partial values abort the launch,
the desktop shell ignores these variables without the marker, and it clamps
the applied size to at least 400px and the primary display work area while
suppressing restored maximize/fullscreen for that tester launch only.`;

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`Missing required ${name}.`);
  return value;
}

function assertKnownCliArgs(
  args: string[],
  valuedFlags: string[],
  booleanFlags: string[],
): void {
  const allowed = new Set([...valuedFlags, ...booleanFlags, "--help", "-h"]);
  const seenValued = new Set<string>();
  const seenBoolean = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!allowed.has(token)) {
      if (token.startsWith("-")) {
        throw new Error(`Unknown blind-persona CLI argument: ${token}`);
      }
      throw new Error(
        `Unexpected blind-persona CLI positional: ${token} (flag values must follow their flag)`,
      );
    }
    if (valuedFlags.includes(token)) {
      if (seenValued.has(token)) {
        throw new Error(`Duplicate blind-persona CLI argument: ${token}`);
      }
      seenValued.add(token);
      index += 1;
    } else if (booleanFlags.includes(token)) {
      if (seenBoolean.has(token)) {
        throw new Error(`Duplicate blind-persona CLI argument: ${token}`);
      }
      seenBoolean.add(token);
    }
  }
}

// Canonical numeric syntax shared with the desktop shell parser: no
// whitespace padding, signs, exponents, or trailing units.
// Canonical numeric syntax shared with the desktop shell parser: no
// whitespace padding, signs, decimals, or exponent notation. Leading zeros
// stay tolerated exactly like the NESTOR_STARTUP_* dimension syntax.
function canonicalTesterAttempt(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `--attempt must be a canonical positive integer without whitespace, signs, decimals, or exponent notation: ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

function canonicalTesterWindowDimension(
  value: string,
  flagName: string,
): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `${flagName} must be a canonical positive integer without whitespace, signs, or exponent notation: ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

function canonicalTesterZoomFactor(value: string, flagName: string): number {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(
      `${flagName} must be a canonical decimal number without whitespace, signs, or exponent notation: ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

export function parseBlindPersonaSeedCli(
  args: string[],
): PrepareBlindPersonaOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  assertKnownCliArgs(
    args,
    [
      "--acceptance-run-dir",
      "--expected-seal-sha256",
      "--custody-root",
      "--destination-root",
      "--persona",
    ],
    ["--dry-run"],
  );
  const persona = args.includes("--persona")
    ? optionValue(args, "--persona")
    : "all";
  return {
    acceptanceRunDir: path.resolve(optionValue(args, "--acceptance-run-dir")),
    expectedSealSha256: optionValue(args, "--expected-seal-sha256"),
    custodyRoot: path.resolve(optionValue(args, "--custody-root")),
    destinationRoot: path.resolve(optionValue(args, "--destination-root")),
    dryRun: args.includes("--dry-run"),
    ...(persona === "all" ? {} : { personaIds: [persona] }),
  };
}

export function parseBlindPersonaTesterCli(args: string[]): {
  attempt?: number;
  custodyIndexPath: string;
  driverCdp?: boolean;
  personaId: string;
  startupWindowHeight?: number;
  startupWindowWidth?: number;
  startupZoomFactor?: number;
} | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  assertKnownCliArgs(
    args,
    [
      "--attempt",
      "--custody-index",
      "--persona",
      startupWindowWidthFlag,
      startupWindowHeightFlag,
      startupZoomFactorFlag,
    ],
    ["--driver-cdp"],
  );
  let attempt: number | undefined;
  if (args.includes("--attempt")) {
    const requested = optionValue(args, "--attempt");
    const parsed = canonicalTesterAttempt(requested);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`--attempt must be an integer >= 1: ${requested}`);
    }
    attempt = parsed;
  }
  let startupWindowWidth: number | undefined;
  let startupWindowHeight: number | undefined;
  if (
    args.includes(startupWindowWidthFlag) ||
    args.includes(startupWindowHeightFlag)
  ) {
    if (
      !args.includes(startupWindowWidthFlag) ||
      !args.includes(startupWindowHeightFlag)
    ) {
      throw new Error(
        `${startupWindowWidthFlag} and ${startupWindowHeightFlag} must be provided together.`,
      );
    }
    startupWindowWidth = assertTesterStartupWindowDimension(
      canonicalTesterWindowDimension(
        optionValue(args, startupWindowWidthFlag),
        startupWindowWidthFlag,
      ),
      startupWindowWidthFlag,
    );
    startupWindowHeight = assertTesterStartupWindowDimension(
      canonicalTesterWindowDimension(
        optionValue(args, startupWindowHeightFlag),
        startupWindowHeightFlag,
      ),
      startupWindowHeightFlag,
    );
  }
  let startupZoomFactor: number | undefined;
  if (args.includes(startupZoomFactorFlag)) {
    startupZoomFactor = assertTesterStartupZoomFactor(
      canonicalTesterZoomFactor(
        optionValue(args, startupZoomFactorFlag),
        startupZoomFactorFlag,
      ),
      startupZoomFactorFlag,
    );
  }
  return {
    custodyIndexPath: path.resolve(optionValue(args, "--custody-index")),
    personaId: optionValue(args, "--persona"),
    ...(attempt === undefined ? {} : { attempt }),
    ...(args.includes(driverCdpFlag) ? { driverCdp: true } : {}),
    ...(startupWindowWidth === undefined ? {} : { startupWindowWidth }),
    ...(startupWindowHeight === undefined ? {} : { startupWindowHeight }),
    ...(startupZoomFactor === undefined ? {} : { startupZoomFactor }),
  };
}

export function parseBlindPersonaVerifyAllCli(args: string[]): {
  custodyIndexPath: string;
} | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  assertKnownCliArgs(args, ["--custody-index"], ["--verify-all"]);
  return {
    custodyIndexPath: path.resolve(optionValue(args, "--custody-index")),
  };
}
