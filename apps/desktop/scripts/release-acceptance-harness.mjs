import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const desktopDir = path.resolve(scriptDir, "..");
export const repositoryRoot = path.resolve(desktopDir, "..", "..");
export const artifactRoot = path.resolve(
  process.env.JOB_FINDER_ACCEPTANCE_ARTIFACT_ROOT ??
    path.resolve(desktopDir, "test-artifacts", "ui"),
);

const SOURCE_EXCLUDES = [
  /^node_modules(?:[\\/]|$)/,
  /^(?:out|dist|build|release|coverage|\.tmp|\.turbo)(?:[\\/]|$)/,
  /(?:^|[\\/])test-artifacts(?:[\\/]|$)/,
  /\.tsbuildinfo$/,
  /^(?:\.git)(?:[\\/]|$)/,
  // Generated evidence mirrors are collector output, not product input: they
  // become durable only through an authorized Git commit. Including them would
  // make writing docs/audits/evidence-manifests/<runId>.manifest.json change
  // the very source fingerprint the mirror evidences. Paths are normalized to
  // "/" before filtering, and the anchor is deliberately narrow so neighboring
  // human-authored files under docs/audits/ stay bound. This must match
  // sourceExcludes in scripts/collect-release-evidence.mjs; parity is enforced
  // by validate-job-finder-production-acceptance.mjs.
  /^docs\/audits\/evidence-manifests(?:\/|$)/,
];

const ARTIFACT_ROOTS = [
  "out",
  "assets",
  path.join("dist", "resume-parser-sidecar"),
];

// Non-runtime toolchain intermediates living inside a fingerprinted artifact
// root. PyInstaller's --workpath/--specpath output under the resume-parser
// sidecar embeds absolute build-host paths and is rebuilt with the binary;
// like package-manager install state it never enters an accepted-app export.
// Keys are looked up as normalizeRelative(path.relative(...)) forward-slash
// paths on every platform, so they must be written that way here too:
// path.join would emit "\" separators on Windows and silently drop the
// exclusion. Everything that does ship is still byte-scanned after export.
const ARTIFACT_ROOT_EXCLUDED_ENTRIES = new Map([
  ["dist/resume-parser-sidecar", ["build"]],
]);

const ELECTRON_APP_PACKAGE_FIELDS = [
  "name",
  "version",
  "description",
  "author",
  "private",
  "main",
];

export const ACCEPTANCE_VERSION = 1;
export const SYNTHETIC_SEED =
  "nestor-job-finder-production-acceptance-2026-08-20-v1";
export const SYNTHETIC_SEED_DIGEST = digestSeed(SYNTHETIC_SEED);
// These are release-gate values, not values supplied by a capture report. A
// report may include the values as evidence, but the wrapper must compare them
// with these constants before accepting the run.
export const CANONICAL_LATENCY_BUDGETS = Object.freeze({
  coldToUsableShellMs: 2_000,
  warmRouteSwitchMs: 500,
});

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join("/");
}

// Canonical inventory ordering for every custody fingerprint that another
// implementation recomputes byte-for-byte (the blind-persona seeder's
// currentSourcePathSetDigest/dependencyIdentity verifiers): plain UTF-16
// code-unit comparison of full paths. localeCompare would make a sealed
// inventory depend on the ambient ICU locale and diverge from the seeder's
// code-unit .sort() on mixed-case and non-ASCII paths.
function comparePathsCodeUnit(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function digestSeed(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

export function assertComponentCompletion(report, component) {
  if (!report || report.pass !== true)
    throw new Error(`${component} report must explicitly record pass=true.`);
  if (report.failure)
    throw new Error(
      `${component} report contains a failure: ${report.failure}`,
    );
  if (typeof report.completedAt !== "string" || report.completedAt.length === 0)
    throw new Error(`${component} report has no completion timestamp.`);
  const ownership = report.processOwnership;
  if (
    !ownership ||
    ownership.verified !== true ||
    !Array.isArray(ownership.trackedProcesses) ||
    ownership.trackedProcesses.length === 0 ||
    !Array.isArray(ownership.leftoverPids) ||
    ownership.leftoverPids.length !== 0
  )
    throw new Error(
      `${component} did not prove owned-process teardown: ${JSON.stringify(ownership)}`,
    );
}

// Chromium reports CSS viewport size as whole CSS pixels
// (window.innerWidth/innerHeight) while the sealed screenshot binds physical
// device pixels, so expected CSS geometry is the requested physical size
// divided by the expected native zoom, accepted within ±1 CSS px of that
// exact quotient at EVERY zoom factor — not only 1.0. This fails closed on
// physically consistent but CSS-stale zoomed evidence (for example CSS
// 1440x920 recorded while native zoom is 1.25, where the rendered content
// area is actually 1152x736).
export const VIEWPORT_CSS_TOLERANCE_PX = 1;

export function assertViewportEvidence(viewport, expected) {
  const requested = viewport?.requested;
  const expectedWidth = expected.width;
  const expectedHeight = expected.height;
  const expectedZoom = expected.zoomFactor;
  const expectedCssWidth = expectedWidth / expectedZoom;
  const expectedCssHeight = expectedHeight / expectedZoom;
  if (
    !Number.isFinite(viewport?.css?.width) ||
    !Number.isFinite(viewport?.css?.height) ||
    viewport.css.width <= 0 ||
    viewport.css.height <= 0 ||
    Math.abs(viewport.css.width - expectedCssWidth) >
      VIEWPORT_CSS_TOLERANCE_PX ||
    Math.abs(viewport.css.height - expectedCssHeight) >
      VIEWPORT_CSS_TOLERANCE_PX ||
    viewport?.physical?.width !== expectedWidth ||
    viewport?.physical?.height !== expectedHeight ||
    viewport?.nativeZoomFactor !== expectedZoom ||
    !requested ||
    requested.width !== expectedWidth ||
    requested.height !== expectedHeight ||
    requested.zoomFactor !== expectedZoom
  )
    throw new Error(
      `Observed viewport/native zoom does not match the required state: expected=${JSON.stringify(expected)} observed=${JSON.stringify(viewport)}`,
    );
  return true;
}

export function evaluateClickablePointEvidence(items) {
  const failures = (Array.isArray(items) ? items : []).filter(
    (item) => item?.required === true && item?.hit === false,
  );
  return { pass: failures.length === 0, failures };
}

export async function sha256File(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function walkFiles(root) {
  const output = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        output.push(filePath);
      } else if (entry.isSymbolicLink()) {
        // Symlinked build inputs are recorded as metadata instead of being followed.
        output.push(filePath);
      }
    }
  };
  await visit(root);
  return output;
}

async function gitLines(args) {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    args,
    {
      cwd: repositoryRoot,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitPaths(args, root = repositoryRoot) {
  const { stdout } = await execFileAsync(
    process.platform === "win32" ? "git.exe" : "git",
    [...args, "-z"],
    {
      cwd: root,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout.split("\0").filter(Boolean);
}

// Exported only so the production-acceptance static validator can enforce
// fingerprint-exclusion parity with the release-evidence collector.
export function isExcludedSource(relativePath) {
  return SOURCE_EXCLUDES.some((pattern) => pattern.test(relativePath));
}

export async function gitMetadata() {
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

function modeOf(fileStat) {
  return fileStat.mode & 0o777;
}

function inventoryDigest(entries) {
  return createHash("sha256")
    .update(entries.map((entry) => `${stableJson(entry)}\n`).join(""), "utf8")
    .digest("hex");
}

export async function sourceFingerprint(root = repositoryRoot) {
  const files = (
    await gitPaths(["ls-files", "-co", "--exclude-standard"], root)
  )
    .map(normalizeRelative)
    .filter((relativePath) => !isExcludedSource(relativePath))
    // Must match currentSourcePathSetDigest in
    // prepare-blind-persona-workspaces.ts: full-path code-unit order.
    .sort(comparePathsCodeUnit);
  const includedPaths = new Set(files);
  const entries = [];
  for (const relativePath of files) {
    const fullPath = path.resolve(root, relativePath);
    if (!isInside(root, fullPath))
      throw new Error(`Source path escaped the repository: ${relativePath}`);
    try {
      const fileStat = await lstat(fullPath);
      if (fileStat.isFile()) {
        entries.push({
          path: relativePath,
          kind: "file",
          mode: modeOf(fileStat),
          bytes: fileStat.size,
          sha256: await sha256File(fullPath),
        });
      } else if (fileStat.isSymbolicLink()) {
        const target = await readlink(fullPath);
        const resolvedTarget = path.resolve(path.dirname(fullPath), target);
        if (!isInside(root, resolvedTarget))
          throw new Error(
            `Source symlink escapes the repository: ${relativePath} -> ${target}`,
          );
        let canonicalTarget;
        try {
          canonicalTarget = await realpath(fullPath);
        } catch (error) {
          throw new Error(
            `Source symlink is broken: ${relativePath} -> ${target}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!isInside(root, canonicalTarget))
          throw new Error(
            `Source symlink resolves outside the repository: ${relativePath} -> ${target}`,
          );
        const targetStat = await stat(fullPath);
        const targetRelative = normalizeRelative(
          path.relative(root, canonicalTarget),
        );
        if (!targetStat.isFile() || !includedPaths.has(targetRelative))
          throw new Error(
            `Source symlink target is omitted from the captured source set: ${relativePath} -> ${target}`,
          );
        entries.push({
          path: relativePath,
          kind: "symlink",
          mode: modeOf(fileStat),
          target,
          resolvedPath: targetRelative,
        });
      } else {
        throw new Error(
          `Unsupported source entry type for ${relativePath}; only files and symlinks can be snapshotted.`,
        );
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        entries.push({
          path: relativePath,
          kind: "deleted",
          bytes: 0,
          sha256: "deleted",
          deleted: true,
        });
        continue;
      }
      throw new Error(
        `Unable to hash source file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    algorithm: "sha256",
    recipe: "stable-json-lines:path-kind-mode-bytes-sha256-or-link-target",
    digest: inventoryDigest(entries),
    pathSetDigest: digestSeed(files),
    fileCount: entries.length,
    files: entries,
  };
}

export async function materializeSourceSnapshot(
  sourceRoot,
  snapshotRoot,
  fingerprint,
) {
  await mkdir(snapshotRoot, { recursive: true });
  for (const entry of fingerprint.files) {
    const sourcePath = path.resolve(sourceRoot, entry.path);
    const snapshotPath = path.resolve(snapshotRoot, entry.path);
    if (!isInside(snapshotRoot, snapshotPath))
      throw new Error(`Snapshot path escaped its root: ${entry.path}`);
    if (entry.kind === "deleted") continue;
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    if (entry.kind === "symlink") {
      await symlink(entry.target, snapshotPath);
      continue;
    }
    await copyFile(sourcePath, snapshotPath, fsConstants.COPYFILE_FICLONE);
    await chmod(snapshotPath, entry.mode);
  }
  return fingerprintSnapshot(snapshotRoot, fingerprint.files);
}

export async function fingerprintSnapshot(snapshotRoot, sourceEntries) {
  const entries = [];
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  const includedPaths = new Set(
    sourceEntries
      .filter((entry) => entry.kind !== "deleted")
      .map((entry) => entry.path),
  );
  for (const sourceEntry of sourceEntries) {
    const snapshotPath = path.resolve(snapshotRoot, sourceEntry.path);
    if (!isInside(snapshotRoot, snapshotPath))
      throw new Error(
        `Snapshot inventory path escaped its root: ${sourceEntry.path}`,
      );
    if (sourceEntry.kind === "deleted") {
      try {
        await lstat(snapshotPath);
        throw new Error(
          `Deleted source path appeared in snapshot: ${sourceEntry.path}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      entries.push({
        path: sourceEntry.path,
        kind: "deleted",
        deleted: true,
      });
      continue;
    }
    const fileStat = await lstat(snapshotPath);
    if (sourceEntry.kind === "symlink") {
      if (!fileStat.isSymbolicLink())
        throw new Error(`Snapshot changed symlink type: ${sourceEntry.path}`);
      const target = await readlink(snapshotPath);
      if (target !== sourceEntry.target)
        throw new Error(`Snapshot changed symlink target: ${sourceEntry.path}`);
      const canonicalTarget = await realpath(snapshotPath);
      if (!isInside(canonicalSnapshotRoot, canonicalTarget))
        throw new Error(
          `Snapshot symlink escaped its root: ${sourceEntry.path}`,
        );
      const resolvedPath = normalizeRelative(
        path.relative(canonicalSnapshotRoot, canonicalTarget),
      );
      if (!includedPaths.has(resolvedPath))
        throw new Error(
          `Snapshot symlink target was omitted from its inventory: ${sourceEntry.path} -> ${target}`,
        );
      entries.push({
        path: sourceEntry.path,
        kind: "symlink",
        sourceMode: sourceEntry.mode,
        snapshotMode: modeOf(fileStat),
        target,
        resolvedPath,
      });
      continue;
    }
    if (!fileStat.isFile())
      throw new Error(`Snapshot changed file type: ${sourceEntry.path}`);
    const sha256 = await sha256File(snapshotPath);
    if (sha256 !== sourceEntry.sha256 || fileStat.size !== sourceEntry.bytes)
      throw new Error(`Snapshot content differs for ${sourceEntry.path}`);
    entries.push({
      path: sourceEntry.path,
      kind: "file",
      sourceMode: sourceEntry.mode,
      snapshotMode: modeOf(fileStat),
      bytes: fileStat.size,
      sha256,
    });
  }
  return {
    algorithm: "sha256",
    recipe:
      "stable-json-lines:snapshot-inventory-with-source-and-snapshot-mode",
    digest: inventoryDigest(entries),
    fileCount: entries.length,
    files: entries,
  };
}

export async function copyTree(
  source,
  destination,
  { omitCaches = false } = {},
) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (omitCaches && (entry.name === ".vite" || entry.name === ".cache"))
      continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, { omitCaches });
    } else if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_FICLONE);
      await chmod(destinationPath, modeOf(await lstat(sourcePath)));
    } else {
      throw new Error(`Unsupported dependency entry: ${sourcePath}`);
    }
  }
}

async function workspaceNodeModulesRoots(root) {
  const candidates = [path.join(root, "node_modules")];
  for (const workspaceGroup of ["apps", "packages"]) {
    const groupRoot = path.join(root, workspaceGroup);
    if (!existsSync(groupRoot)) continue;
    for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
      if (entry.isDirectory())
        candidates.push(path.join(groupRoot, entry.name, "node_modules"));
    }
  }
  return candidates.filter((candidate) => existsSync(candidate));
}

export async function treeFingerprint(
  root,
  excludedRoots = [],
  { omitCaches = false } = {},
) {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (omitCaches && (entry.name === ".vite" || entry.name === ".cache"))
        continue;
      const fullPath = path.join(directory, entry.name);
      if (excludedRoots.some((excluded) => path.resolve(excluded) === fullPath))
        continue;
      const relativePath = normalizeRelative(path.relative(root, fullPath));
      const fileStat = await lstat(fullPath);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isSymbolicLink())
        files.push({
          path: relativePath,
          kind: "symlink",
          mode: modeOf(fileStat),
          target: await readlink(fullPath),
        });
      else if (entry.isFile())
        files.push({
          path: relativePath,
          kind: "file",
          mode: modeOf(fileStat),
          bytes: fileStat.size,
          sha256: await sha256File(fullPath),
        });
      else throw new Error(`Unsupported tree entry: ${fullPath}`);
    }
  };
  await visit(root);
  return {
    algorithm: "sha256",
    digest: inventoryDigest(files),
    fileCount: files.length,
    files,
  };
}

async function dependencyRootsFingerprint(sourceRoot, relativeRoots) {
  const roots = [];
  const files = [];
  for (const relativeRoot of relativeRoots) {
    const fingerprint = await treeFingerprint(
      path.resolve(sourceRoot, relativeRoot),
      [],
      { omitCaches: true },
    );
    roots.push({
      path: relativeRoot,
      digest: fingerprint.digest,
      fileCount: fingerprint.fileCount,
    });
    files.push(
      ...fingerprint.files.map((entry) => ({
        ...entry,
        path: `${relativeRoot}/${entry.path}`,
      })),
    );
  }
  // One canonical inventory over ALL collected roots: full-path code-unit
  // order, matching dependencyIdentity in prepare-blind-persona-workspaces.ts.
  files.sort((left, right) => comparePathsCodeUnit(left.path, right.path));
  return {
    algorithm: "sha256",
    digest: inventoryDigest(files),
    fileCount: files.length,
    roots,
    files,
  };
}

// Exported only so the blind-persona workspace tests can prove producer/
// verifier inventory parity against the same hermetic fixture trees.
export { dependencyRootsFingerprint };

export async function materializeDependencySnapshot(
  sourceRoot,
  snapshotRoot,
  { afterCopy } = {},
) {
  const roots = await workspaceNodeModulesRoots(sourceRoot);
  const relativeRoots = roots.map((root) =>
    normalizeRelative(path.relative(sourceRoot, root)),
  );
  const originalBeforeCopy = await dependencyRootsFingerprint(
    sourceRoot,
    relativeRoots,
  );
  for (const source of roots) {
    const relativePath = path.relative(sourceRoot, source);
    await copyTree(source, path.join(snapshotRoot, relativePath), {
      omitCaches: true,
    });
  }
  if (afterCopy) await afterCopy({ roots, relativeRoots });
  const originalAfterCopy = await dependencyRootsFingerprint(
    sourceRoot,
    relativeRoots,
  );
  if (
    originalAfterCopy.digest !== originalBeforeCopy.digest ||
    originalAfterCopy.fileCount !== originalBeforeCopy.fileCount
  )
    throw new Error(
      "Original dependency roots changed while the dependency snapshot was materialized.",
    );
  return {
    strategy: "independent-copy-read-only",
    relativeRoots,
    originalBeforeCopy,
    originalAfterCopy,
  };
}

export async function dependencySnapshotFingerprint(
  snapshotRoot,
  relativeRoots,
  { sourceEntries = [], generatedRoots = [] } = {},
) {
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  const canonicalGeneratedRoots = await Promise.all(
    generatedRoots.map((root) =>
      realpath(path.isAbsolute(root) ? root : path.resolve(snapshotRoot, root)),
    ),
  );
  const roots = [];
  const files = [];
  for (const relativeRoot of relativeRoots) {
    const fingerprint = await treeFingerprint(
      path.resolve(snapshotRoot, relativeRoot),
    );
    roots.push({
      path: relativeRoot,
      digest: fingerprint.digest,
      fileCount: fingerprint.fileCount,
    });
    files.push(
      ...fingerprint.files.map((entry) => ({
        ...entry,
        path: `${relativeRoot}/${entry.path}`,
      })),
    );
  }
  // Mirrors dependencyRootsFingerprint exactly: the acceptance run asserts
  // this copied-snapshot digest equals the original roots' digest, so the
  // global full-path code-unit ordering must never diverge between the two.
  files.sort((left, right) => comparePathsCodeUnit(left.path, right.path));
  for (const entry of files) {
    if (entry.kind !== "symlink") continue;
    const linkPath = path.resolve(snapshotRoot, entry.path);
    let canonicalTarget;
    try {
      canonicalTarget = await realpath(linkPath);
    } catch (error) {
      throw new Error(
        `Dependency symlink is broken: ${entry.path} -> ${entry.target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isInside(canonicalSnapshotRoot, canonicalTarget))
      throw new Error(
        `Dependency symlink escapes the snapshot: ${entry.path} -> ${entry.target}`,
      );
    const targetRelative = normalizeRelative(
      path.relative(canonicalSnapshotRoot, canonicalTarget),
    );
    if (canonicalGeneratedRoots.some((root) => isInside(root, canonicalTarget)))
      throw new Error(
        `Dependency symlink resolves into a writable generated root: ${entry.path} -> ${entry.target}`,
      );
    const resolvesIntoCopiedPnpmStore = relativeRoots.some((root) =>
      isInside(
        path.resolve(canonicalSnapshotRoot, root, ".pnpm"),
        canonicalTarget,
      ),
    );
    const resolvesIntoCapturedSource = sourceEntries.some((sourceEntry) => {
      if (sourceEntry.kind === "deleted") return false;
      const sourcePath = normalizeRelative(sourceEntry.path);
      return (
        sourcePath === targetRelative ||
        sourcePath.startsWith(`${targetRelative}/`)
      );
    });
    if (!resolvesIntoCopiedPnpmStore && !resolvesIntoCapturedSource)
      throw new Error(
        `Dependency symlink target is not a copied .pnpm entry or inventoried immutable source: ${entry.path} -> ${entry.target}`,
      );
  }
  return {
    algorithm: "sha256",
    digest: inventoryDigest(files),
    fileCount: files.length,
    roots,
    files,
  };
}

export function assertReadOnlyInventoryTransform(before, after) {
  if (before.fileCount !== after.fileCount)
    throw new Error(
      "Read-only hardening changed the dependency inventory file count.",
    );
  const afterByPath = new Map(after.files.map((entry) => [entry.path, entry]));
  for (const beforeEntry of before.files) {
    const afterEntry = afterByPath.get(beforeEntry.path);
    if (!afterEntry || afterEntry.kind !== beforeEntry.kind)
      throw new Error(
        `Read-only hardening changed dependency entry identity: ${beforeEntry.path}`,
      );
    if (beforeEntry.kind === "file") {
      if (
        afterEntry.bytes !== beforeEntry.bytes ||
        afterEntry.sha256 !== beforeEntry.sha256 ||
        afterEntry.mode !== (beforeEntry.mode & ~0o222)
      )
        throw new Error(
          `Read-only hardening changed dependency bytes or applied an unexpected mode: ${beforeEntry.path}`,
        );
    } else if (
      afterEntry.target !== beforeEntry.target ||
      afterEntry.mode !== beforeEntry.mode
    )
      throw new Error(
        `Read-only hardening changed dependency symlink identity: ${beforeEntry.path}`,
      );
  }
}

export async function makeInventoryReadOnly(root, entries) {
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const filePath = path.resolve(root, entry.path);
    await chmod(filePath, entry.mode & ~0o222);
  }
}

// Evidence hardening must never flatten heterogeneous trees to a fixed mode:
// accepted-app payloads keep their sealed executable bits (0555 stays 0555)
// while generated docs lose only their write bits (0644 becomes 0444). Every
// listed path is containment-checked against root, lstat-classified so a
// non-ordinary entry fails closed instead of being silently skipped or
// followed, and then masked from its current mode.
export async function makeEvidenceFilesReadOnly(root, files) {
  for (const entry of files) {
    const filePath = path.resolve(root, entry.path);
    if (!isInside(root, filePath))
      throw new Error(`Evidence file escaped its root: ${entry.path}`);
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile())
      throw new Error(`Evidence entry is not an ordinary file: ${entry.path}`);
    await chmod(filePath, modeOf(fileStat) & ~0o222);
  }
}

export async function makeTreeReadOnly(root) {
  const directories = [];
  const visit = async (directory) => {
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const fileStat = await lstat(child);
        await chmod(child, modeOf(fileStat) & ~0o222);
      }
    }
  };
  await visit(root);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) {
    const fileStat = await lstat(directory);
    await chmod(directory, modeOf(fileStat) & ~0o222);
  }
}

export async function makeTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = async (directory) => {
    await chmod(directory, modeOf(await lstat(directory)) | 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile())
        await chmod(child, modeOf(await lstat(child)) | 0o600);
    }
  };
  await visit(root);
}

export async function artifactFingerprint(rootDesktopDir = desktopDir) {
  const roots = [];
  const files = [];
  for (const relativeRoot of ARTIFACT_ROOTS) {
    const root = path.resolve(rootDesktopDir, relativeRoot);
    if (!existsSync(root)) {
      roots.push({
        path: normalizeRelative(path.relative(rootDesktopDir, root)),
        exists: false,
        fileCount: 0,
      });
      continue;
    }
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink())
      throw new Error(`Build artifact root must not be a symlink: ${root}`);
    if (!rootStat.isDirectory())
      throw new Error(`Build artifact root is not a directory: ${root}`);
    const excludedPrefixes = (
      ARTIFACT_ROOT_EXCLUDED_ENTRIES.get(
        normalizeRelative(path.relative(rootDesktopDir, root)),
      ) ?? []
    ).map((entry) => `${path.join(root, entry)}${path.sep}`);
    const rootFiles = (await walkFiles(root)).filter(
      (filePath) =>
        !excludedPrefixes.some((prefix) => filePath.startsWith(prefix)),
    );
    roots.push({
      path: normalizeRelative(path.relative(rootDesktopDir, root)),
      exists: true,
      fileCount: rootFiles.length,
    });
    for (const filePath of rootFiles) {
      const relativePath = normalizeRelative(
        path.relative(rootDesktopDir, filePath),
      );
      const fileStat = await lstatSyncAsync(filePath);
      if (fileStat.isSymbolicLink()) {
        throw new Error(
          `Build artifacts must not contain symlinks: ${relativePath} -> ${await readlinkSafe(filePath)}`,
        );
      } else {
        files.push({
          path: relativePath,
          kind: "file",
          mode: modeOf(fileStat),
          bytes: fileStat.size,
          sha256: await sha256File(filePath),
        });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash("sha256")
    .update(files.map((entry) => `${stableJson(entry)}\n`).join(""), "utf8")
    .digest("hex");
  return { algorithm: "sha256", roots, fileCount: files.length, digest, files };
}

const PNPM_WORKSPACE_STATE_ENTRY_PATTERN =
  /^\.pnpm-workspace-state(?:-[^\s\\/]+)?\.json$/;

function isPackageManagerInternalEntry(name) {
  // pnpm writes install-state bookkeeping (.modules.yaml and
  // .pnpm-workspace-state.json, including concrete versioned names such as
  // .pnpm-workspace-state-v1.json) directly into node_modules roots. It is not
  // a resolvable runtime dependency and embeds machine-local absolute paths,
  // so like the internal .pnpm store and .bin shims it never enters an
  // accepted app export. The workspace-state match stays anchored to that
  // exact file family: no broad dotfile skipping. This must stay narrower than
  // the frozen dependency-snapshot inventory, which intentionally records the
  // original toolchain state.
  return (
    name === ".bin" ||
    name === ".modules.yaml" ||
    name === ".pnpm" ||
    PNPM_WORKSPACE_STATE_ENTRY_PATTERN.test(name)
  );
}

async function copyDereferencedTree(
  source,
  destination,
  boundary,
  writeBoundary,
  stack = [],
) {
  const canonicalSource = await realpath(source);
  if (!isInside(boundary, canonicalSource))
    throw new Error(
      `Accepted dependency escapes immutable snapshot: ${source}`,
    );
  if (!isInside(writeBoundary, path.resolve(destination)))
    throw new Error(
      `Accepted dependency destination escaped the accepted-app root: ${normalizeRelative(path.relative(writeBoundary, path.resolve(destination)))}`,
    );
  if (stack.includes(canonicalSource))
    throw new Error(
      `Accepted dependency cycle: ${[...stack, canonicalSource].join(" -> ")}`,
    );
  const sourceStat = await stat(canonicalSource);
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of (
      await readdir(canonicalSource, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      if (isPackageManagerInternalEntry(entry.name)) continue;
      await copyDereferencedTree(
        path.join(canonicalSource, entry.name),
        path.join(destination, entry.name),
        boundary,
        writeBoundary,
        [...stack, canonicalSource],
      );
    }
    return;
  }
  if (!sourceStat.isFile())
    throw new Error(`Accepted dependency has unsupported entry: ${source}`);
  if (existsSync(destination)) {
    const destinationStat = await lstat(destination);
    if (
      !destinationStat.isFile() ||
      destinationStat.size !== sourceStat.size ||
      (await sha256File(destination)) !== (await sha256File(canonicalSource))
    )
      throw new Error(`Accepted dependency overlay conflict: ${destination}`);
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(canonicalSource, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, modeOf(sourceStat));
}

// The accepted app must run after the immutable snapshot is deleted, so its
// node_modules export has to contain every production runtime package plus
// its full transitive closure. This list is the explicit auditable seed set:
// the electron.vite.config.ts rollup externals (the modules the bundled main
// process requires at runtime instead of bundling) plus the Electron runtime
// itself and pdfjs-dist, whose worker subpath must exist on disk. The static
// validator re-derives the externals from electron.vite.config.ts and fails
// when this list drifts from them.
export const PRODUCTION_RUNTIME_DEPENDENCY_SEEDS = Object.freeze([
  "@mozilla/readability",
  "chromium-bidi",
  "electron",
  "jsdom",
  "pdfjs-dist",
  "playwright",
  "playwright-core",
]);

// Strict npm package-name shape for closure seeds and manifest dependency
// keys. A dependency name is also a filesystem path under node_modules, so
// anything beyond the npm unscoped/scoped grammar (absolute paths, backslash
// separators, empty/dot/dotdot segments, malformed scopes, nested scopes) is
// rejected before it can influence any computed destination.
const NPM_PACKAGE_NAME_PATTERN =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$|^[a-z0-9][a-z0-9._-]*$/;

export function assertNpmPackageNameShape(name, origin) {
  if (typeof name !== "string" || name.length === 0)
    throw new Error(`${origin}: dependency name must be a non-empty string.`);
  if (name.includes("\\"))
    throw new Error(
      `${origin}: dependency name contains a backslash separator: "${name}".`,
    );
  if (path.isAbsolute(name))
    throw new Error(
      `${origin}: dependency name is an absolute path: "${name}".`,
    );
  for (const segment of name.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..")
      throw new Error(
        `${origin}: dependency name has an empty, dot, or dotdot segment: "${name}".`,
      );
  }
  if (!NPM_PACKAGE_NAME_PATTERN.test(name))
    throw new Error(
      `${origin}: dependency name is not a valid npm package name: "${name}".`,
    );
}

export const DEPENDENCY_EXPORT_STRATEGY =
  "symlink-free-dereferenced-manifest-closure-from-immutable-snapshot";

function recordKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

// Pure manifest classification for closure walking: regular dependencies and
// non-optional peers are required (missing ones fail closed), while optional
// dependencies and explicitly optional peers may be absent and are recorded
// as explicit skips instead. devDependencies are never production runtime.
function productionDependencyNamesOf(manifest) {
  const optionalDependencies = new Set(
    recordKeys(manifest.optionalDependencies),
  );
  const peerMeta = manifest.peerDependenciesMeta;
  const required = new Set(
    recordKeys(manifest.dependencies).filter(
      (name) => !optionalDependencies.has(name),
    ),
  );
  const optional = [];
  for (const name of recordKeys(manifest.peerDependencies)) {
    if (optionalDependencies.has(name)) continue;
    const optionalPeer =
      recordKeys(peerMeta).includes(name) && peerMeta[name]?.optional === true;
    if (optionalPeer) optional.push({ name, reason: "optional-peer" });
    else required.add(name);
  }
  for (const name of optionalDependencies)
    optional.push({ name, reason: "optional-dependency" });
  return {
    optional: optional.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.reason.localeCompare(right.reason),
    ),
    required: [...required].sort((left, right) => left.localeCompare(right)),
  };
}

async function readPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest is not a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(
      `Invalid package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Node-faithful physical resolution of one dependency name from a directory:
// climb candidate node_modules directories upward exactly like require does,
// staying inside the immutable snapshot boundary. Returns the realpath of the
// owning package instance so pnpm virtual-store siblings resolve through the
// same sibling layout the runtime uses.
async function resolvePackageInstance({ fromDir, name, boundary }) {
  const segments = name.split("/");
  let dir = await realpath(fromDir);
  for (;;) {
    if (!isInside(boundary, dir)) return null;
    let candidateStat = null;
    try {
      candidateStat = await stat(path.join(dir, "node_modules", ...segments));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    if (candidateStat?.isDirectory()) {
      const instance = await realpath(
        path.join(dir, "node_modules", ...segments),
      );
      if (!isInside(boundary, instance))
        throw new Error(
          `Dependency "${name}" resolves outside the immutable snapshot: ${instance}`,
        );
      return instance;
    }
    let parent = path.dirname(dir);
    while (parent !== dir && path.basename(parent) === "node_modules")
      parent = path.dirname(parent);
    if (parent === dir || !isInside(boundary, parent)) return null;
    dir = parent;
  }
}

// Destination node_modules levels visible from a placed package directory,
// topmost first. Only package/root directories contribute a level; nested
// node_modules directories themselves do not.
function collectDestinationLevels(startDir, destinationRoot) {
  const levels = [];
  let dir = path.resolve(startDir);
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      const level = path.join(dir, "node_modules");
      if (!isInside(destinationRoot, level)) break;
      levels.push(level);
    }
    if (dir === destinationRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir || !isInside(destinationRoot, parent)) break;
    dir = parent;
  }
  return levels.reverse();
}

// Deterministic manifest-driven recursive closure over the exact original
// package instances inside the immutable snapshot. Seeds resolve from the
// desktop package first, then from already-resolved instances so transitive
// externals that pnpm never links at an app root (for example playwright-core
// as a virtual-store sibling of playwright) stay reachable without any
// import scanning. Conflicting versions nest under their dependent exactly
// when a hoisting level already holds a different instance of the same name.
async function planProductionDependencyClosure({
  sourceDesktopDir,
  destinationRoot,
  boundary,
  seeds,
}) {
  const canonicalBoundary = await realpath(boundary);
  const canonicalSourceDesktopDir = await realpath(sourceDesktopDir);
  if (!isInside(canonicalBoundary, canonicalSourceDesktopDir))
    throw new Error(
      `Accepted-app dependency closure source escaped the snapshot: ${sourceDesktopDir}`,
    );
  for (const seed of seeds)
    assertNpmPackageNameShape(seed, "Dependency closure seed");
  // Exact Set-size equality: collation-based duplicate detection can disagree
  // across locales, while cardinality cannot.
  const uniqueSeeds = [...new Set(seeds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (uniqueSeeds.length !== seeds.length)
    throw new Error("Dependency closure seeds contain duplicates.");
  const destinationRootResolved = await realpath(destinationRoot);
  const ensureDestinationInside = (destination) => {
    if (!isInside(destinationRootResolved, path.resolve(destination)))
      throw new Error(
        `Dependency closure destination escaped the accepted-app root: ${normalizeRelative(path.relative(destinationRootResolved, path.resolve(destination)))}`,
      );
    return destination;
  };
  const nodeModulesRoot = ensureDestinationInside(
    path.join(destinationRootResolved, "node_modules"),
  );
  const levelMaps = new Map();
  const levelMapOf = (level) => {
    let map = levelMaps.get(level);
    if (!map) {
      map = new Map();
      levelMaps.set(level, map);
    }
    return map;
  };
  const copyTasks = [];
  const auditByInstance = new Map();
  const destinationsByInstance = new Map();
  const skippedOptional = [];
  const labelOfDest = (absolute) =>
    normalizeRelative(path.relative(destinationRootResolved, absolute)) || ".";
  const ensureAudit = (instance) => {
    let audit = auditByInstance.get(instance);
    if (!audit) {
      audit = {
        destination: null,
        name: null,
        requiredBy: new Set(),
        version: null,
      };
      auditByInstance.set(instance, audit);
    }
    return audit;
  };
  const recordPlacement = (instance, destination) => {
    ensureDestinationInside(destination);
    copyTasks.push({ destination, source: instance });
    const destinations = destinationsByInstance.get(instance) ?? new Set();
    destinations.add(destination);
    destinationsByInstance.set(instance, destinations);
    const audit = ensureAudit(instance);
    if (
      audit.destination === null ||
      normalizeRelative(
        path.relative(destinationRootResolved, destination),
      ).localeCompare(audit.destination) < 0
    )
      audit.destination = normalizeRelative(
        path.relative(destinationRootResolved, destination),
      );
  };

  const resolvedSeeds = [];
  const seedProvenance = [];
  const seedRequirerLabel =
    normalizeRelative(
      path.relative(canonicalBoundary, canonicalSourceDesktopDir),
    ) || ".";
  for (const name of uniqueSeeds) {
    let instance = await resolvePackageInstance({
      boundary: canonicalBoundary,
      fromDir: canonicalSourceDesktopDir,
      name,
    });
    let via = "source-desktop";
    if (!instance) {
      for (const known of [...resolvedSeeds].sort((left, right) =>
        left.instance.localeCompare(right.instance),
      )) {
        instance = await resolvePackageInstance({
          boundary: canonicalBoundary,
          fromDir: known.instance,
          name,
        });
        if (instance) {
          via = `resolved-seed:${known.name}`;
          break;
        }
      }
    }
    if (!instance)
      throw new Error(
        `Required production runtime dependency "${name}" is missing from the immutable snapshot (searched from ${seedRequirerLabel}${
          resolvedSeeds.length
            ? ` and ${resolvedSeeds.length} resolved package(s)`
            : ""
        }); refusing a non-self-contained accepted-app export.`,
      );
    resolvedSeeds.push({ instance, name });
    seedProvenance.push({ name, via });
    const topLevelMap = levelMapOf(nodeModulesRoot);
    if (topLevelMap.has(name))
      throw new Error(`Duplicate dependency closure seed: ${name}`);
    topLevelMap.set(name, instance);
    recordPlacement(instance, path.join(nodeModulesRoot, ...name.split("/")));
    ensureAudit(instance).requiredBy.add(seedRequirerLabel);
  }

  let queue = [...auditByInstance.keys()];
  const walked = new Set();
  while (queue.length > 0) {
    const wave = queue.sort((left, right) => left.localeCompare(right));
    queue = [];
    for (const instance of wave) {
      if (walked.has(instance)) continue;
      walked.add(instance);
      const manifest = await readPackageManifest(instance);
      const audit = ensureAudit(instance);
      audit.name =
        typeof manifest.name === "string"
          ? manifest.name
          : path.basename(instance);
      audit.version =
        typeof manifest.version === "string" ? manifest.version : null;
      const requirer = `${audit.name}${audit.version ? `@${audit.version}` : ""}`;
      const { optional, required } = productionDependencyNamesOf(manifest);
      for (const dependentDestDir of [
        ...(destinationsByInstance.get(instance) ?? []),
      ].sort((left, right) => left.localeCompare(right))) {
        for (const [names, optionalReason] of [
          [required, null],
          [optional.map((entry) => entry.name), optional],
        ]) {
          for (const name of names) {
            assertNpmPackageNameShape(
              name,
              `Manifest dependency of ${requirer}`,
            );
            const dependency = await resolvePackageInstance({
              boundary: canonicalBoundary,
              fromDir: instance,
              name,
            });
            if (!dependency) {
              const reason = optionalReason?.find(
                (entry) => entry.name === name,
              );
              if (!reason)
                throw new Error(
                  `Required dependency "${name}" of ${requirer} (${labelOfDest(dependentDestDir)}) is missing from the immutable snapshot; refusing a non-self-contained accepted-app export.`,
                );
              skippedOptional.push({
                reason: reason.reason,
                requirer,
                specifier: name,
              });
              continue;
            }
            ensureAudit(dependency).requiredBy.add(
              labelOfDest(dependentDestDir),
            );
            if (dependency === instance) continue;
            const levels = collectDestinationLevels(
              dependentDestDir,
              destinationRootResolved,
            );
            let chosen = null;
            let satisfied = false;
            for (const level of levels) {
              const mapped = levelMapOf(level).get(name);
              if (mapped === undefined) {
                chosen = level;
                break;
              }
              if (mapped === dependency) {
                satisfied = true;
                break;
              }
            }
            if (!satisfied) {
              if (!chosen)
                throw new Error(
                  `Dependency placement conflict exhausted for "${name}" required by ${requirer}.`,
                );
              levelMapOf(chosen).set(name, dependency);
              recordPlacement(
                dependency,
                path.join(chosen, ...name.split("/")),
              );
              queue.push(dependency);
            }
          }
        }
      }
    }
  }

  return {
    packages: [...auditByInstance.values()]
      .map((audit) => ({
        destination: audit.destination,
        name: audit.name,
        requiredBy: [...audit.requiredBy].sort((left, right) =>
          left.localeCompare(right),
        ),
        version: audit.version,
      }))
      .sort((left, right) =>
        (left.destination ?? "").localeCompare(right.destination ?? ""),
      ),
    seeds: uniqueSeeds,
    seedProvenance: [...seedProvenance].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    skippedOptional: skippedOptional.sort(
      (left, right) =>
        left.requirer.localeCompare(right.requirer) ||
        left.specifier.localeCompare(right.specifier) ||
        left.reason.localeCompare(right.reason),
    ),
    strategy: DEPENDENCY_EXPORT_STRATEGY,
    topLevelPlacements: [...(levelMapOf(nodeModulesRoot)?.entries() ?? [])]
      .map(([name]) => ({
        destination: ensureDestinationInside(
          path.join(nodeModulesRoot, ...name.split("/")),
        ),
        name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    copyTasks,
  };
}

async function materializeDependencyClosure(
  copyTasks,
  boundary,
  destinationRoot,
) {
  const canonicalDestinationRoot = await realpath(destinationRoot);
  const sorted = [...copyTasks].sort(
    (left, right) =>
      left.destination.localeCompare(right.destination) ||
      left.source.localeCompare(right.source),
  );
  for (const task of sorted)
    await copyDereferencedTree(
      task.source,
      task.destination,
      boundary,
      canonicalDestinationRoot,
    );
  return sorted.length;
}

// Every forbidden root is expanded to both its resolved and realpath aliases
// before scanning: on macOS the same directory answers as /var/... and
// /private/var/..., and an embedded alias must fail exactly like an embedded
// resolved path.
async function forbiddenReferenceNeedles(forbiddenRoots) {
  const aliases = new Set();
  for (const forbidden of forbiddenRoots.filter(Boolean)) {
    const resolved = path.resolve(forbidden);
    aliases.add(resolved);
    try {
      aliases.add(await realpath(resolved));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...aliases].map((alias) => Buffer.from(alias));
}

// Byte-scans every ordinary exported file — no extension allowlist and no
// .map exemption: maps, extensionless shims, and native binaries have all
// carried absolute original-root references in practice. The scan reads each
// file once, which is bounded by the same bytes the export already hashes
// twice for its inventory, so focused real-tree validation stays practical.
async function assertNoUnsafeAbsoluteReferences(root, forbiddenRoots) {
  const needles = await forbiddenReferenceNeedles(forbiddenRoots);
  for (const filePath of await walkFiles(root)) {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile()) continue;
    const bytes = await readFile(filePath);
    for (const needle of needles) {
      if (bytes.includes(needle))
        throw new Error(
          `Accepted runtime file contains an unsafe original absolute path: ${normalizeRelative(path.relative(root, filePath))}`,
        );
    }
  }
}

async function acceptedAppFingerprint(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(directory, entry.name);
      const fileStat = await lstat(filePath);
      if (fileStat.isSymbolicLink())
        throw new Error(`Accepted app must not contain symlinks: ${filePath}`);
      if (fileStat.isDirectory()) await visit(filePath);
      else if (fileStat.isFile()) {
        files.push({
          path: normalizeRelative(path.relative(root, filePath)),
          kind: "file",
          mode: modeOf(fileStat),
          bytes: fileStat.size,
          sha256: await sha256File(filePath),
        });
      } else
        throw new Error(`Accepted app contains a special entry: ${filePath}`);
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    algorithm: "sha256",
    fileCount: files.length,
    files,
    digest: createHash("sha256")
      .update(files.map((entry) => `${stableJson(entry)}\n`).join(""), "utf8")
      .digest("hex"),
  };
}

export async function exportAcceptedElectronApp({
  sourceDesktopDir,
  destinationRoot,
  artifacts,
  sourceDigest,
  snapshotRoot = path.resolve(sourceDesktopDir, "..", ".."),
  dependencySeeds = PRODUCTION_RUNTIME_DEPENDENCY_SEEDS,
}) {
  if (existsSync(destinationRoot))
    throw new Error(
      `Accepted app export destination already exists: ${destinationRoot}`,
    );
  for (const seed of dependencySeeds)
    assertNpmPackageNameShape(seed, "Accepted-app dependency closure seed");
  await mkdir(destinationRoot, { recursive: true });
  const sourcePackagePath = path.join(sourceDesktopDir, "package.json");
  const sourcePackageStat = await lstat(sourcePackagePath);
  if (!sourcePackageStat.isFile() || sourcePackageStat.isSymbolicLink())
    throw new Error("Desktop package metadata is not an ordinary file.");
  const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));
  const packageMetadata = Object.fromEntries(
    ELECTRON_APP_PACKAGE_FIELDS.filter(
      (field) => sourcePackage[field] !== undefined,
    ).map((field) => [field, sourcePackage[field]]),
  );
  if (packageMetadata.main !== "out/main/index.cjs")
    throw new Error(
      `Unsupported accepted Electron main entry: ${packageMetadata.main}`,
    );
  await writeFile(
    path.join(destinationRoot, "package.json"),
    `${stableJson(packageMetadata)}\n`,
    { flag: "wx" },
  );

  for (const entry of artifacts.files) {
    const sourcePath = path.resolve(sourceDesktopDir, entry.path);
    const destinationPath = path.resolve(destinationRoot, entry.path);
    if (
      !isInside(sourceDesktopDir, sourcePath) ||
      !isInside(destinationRoot, destinationPath)
    )
      throw new Error(`Accepted app artifact escaped its root: ${entry.path}`);
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      throw new Error(
        `Accepted app artifact is not an ordinary file: ${entry.path}`,
      );
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    const copiedStat = await lstat(destinationPath);
    if (
      copiedStat.size !== entry.bytes ||
      (await sha256File(destinationPath)) !== entry.sha256
    )
      throw new Error(
        `Accepted app artifact changed while copied: ${entry.path}`,
      );
  }

  const boundary = await realpath(snapshotRoot);
  const dependencyClosure = await planProductionDependencyClosure({
    destinationRoot,
    sourceDesktopDir,
    boundary,
    seeds: dependencySeeds,
  });
  await materializeDependencyClosure(
    dependencyClosure.copyTasks,
    boundary,
    destinationRoot,
  );
  // Post-materialization fail-closed check: every seed must resolve from the
  // exported tree at exactly its planned top-level destination.
  const canonicalDestinationRoot = await realpath(destinationRoot);
  for (const planned of dependencyClosure.topLevelPlacements) {
    const exportedInstance = await resolvePackageInstance({
      boundary: canonicalDestinationRoot,
      fromDir: canonicalDestinationRoot,
      name: planned.name,
    });
    if (
      exportedInstance === null ||
      exportedInstance !== (await realpath(planned.destination))
    )
      throw new Error(
        `Materialized accepted-app export does not contain the planned instance of "${planned.name}".`,
      );
  }
  const runtimePackages = [
    ...new Set(dependencyClosure.packages.map((entry) => entry.name)),
  ].sort((left, right) => left.localeCompare(right));
  await assertNoUnsafeAbsoluteReferences(destinationRoot, [
    repositoryRoot,
    snapshotRoot,
  ]);

  const exportedArtifacts = await artifactFingerprint(destinationRoot);
  if (stableJson(exportedArtifacts) !== stableJson(artifacts))
    throw new Error(
      "Exported accepted-app generated artifacts do not exactly match the accepted build.",
    );
  for (const required of [
    "package.json",
    "out/main/index.cjs",
    "out/preload",
    "out/renderer/index.html",
  ]) {
    if (!existsSync(path.join(destinationRoot, required)))
      throw new Error(`Accepted app is launch-incomplete: missing ${required}`);
  }
  await makeTreeReadOnly(destinationRoot);
  const inventory = await acceptedAppFingerprint(destinationRoot);
  return {
    ...inventory,
    path: normalizeRelative(path.basename(destinationRoot)),
    packageMetadata,
    sourceDigest,
    artifactDigest: artifacts.digest,
    artifactFileCount: artifacts.fileCount,
    runtimePackages,
    dependencyClosure: {
      packages: dependencyClosure.packages,
      seeds: dependencyClosure.seeds,
      seedProvenance: dependencyClosure.seedProvenance,
      skippedOptional: dependencyClosure.skippedOptional,
      strategy: dependencyClosure.strategy,
    },
    dependencyExportStrategy: DEPENDENCY_EXPORT_STRATEGY,
    launch: {
      args: ["."],
      cwd: normalizeRelative(path.basename(destinationRoot)),
      main: packageMetadata.main,
    },
    readOnly: true,
  };
}

export async function verifyAcceptedElectronApp(root, expected) {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root))
    throw new Error("Accepted app root is not canonical.");
  const actual = await acceptedAppFingerprint(canonicalRoot);
  if (
    actual.digest !== expected.digest ||
    actual.fileCount !== expected.fileCount ||
    stableJson(actual.files) !== stableJson(expected.files)
  )
    throw new Error(
      "Accepted app has extra, missing, aliased, or changed files.",
    );
  const packageMetadata = JSON.parse(
    await readFile(path.join(canonicalRoot, "package.json"), "utf8"),
  );
  if (
    stableJson(packageMetadata) !== stableJson(expected.packageMetadata) ||
    packageMetadata.main !== expected.launch?.main
  )
    throw new Error(
      "Accepted app package metadata changed or is launch-incomplete.",
    );
  if (!existsSync(path.join(canonicalRoot, packageMetadata.main)))
    throw new Error("Accepted app main entry is missing.");
  for (const entry of actual.files)
    if ((entry.mode & 0o222) !== 0)
      throw new Error(`Accepted app file is writable: ${entry.path}`);
  return actual;
}

const FINAL_SEAL_RESERVED_FIELDS = Object.freeze([
  "digestRecipe",
  "schemaVersion",
  "sealSha256",
  "threatModel",
]);

export function createFinalAcceptanceSeal(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject))
    throw new Error("Final acceptance seal subject must be a plain object.");
  const overrides = FINAL_SEAL_RESERVED_FIELDS.filter(
    (field) => field in subject,
  );
  if (overrides.length > 0)
    throw new Error(
      `Final acceptance seal subject must not override reserved fields: ${overrides.join(", ")}.`,
    );
  const seal = {
    schemaVersion: 1,
    digestRecipe: "sha256(canonical-json(final-seal-without-sealSha256))",
    threatModel:
      "Local hashes detect uncoordinated mutation. A coordinated owner rewrite of seal and subjects requires an externally custodied expectedSealSha256 or signature to detect.",
    ...subject,
  };
  return { ...seal, sealSha256: digestSeed(seal) };
}

export function verifyFinalAcceptanceSeal(seal, expectedSealSha256) {
  const subject = { ...seal };
  delete subject.sealSha256;
  const actual = digestSeed(subject);
  if (
    !/^[a-f0-9]{64}$/u.test(expectedSealSha256 ?? "") ||
    seal.sealSha256 !== expectedSealSha256 ||
    actual !== expectedSealSha256
  )
    throw new Error(
      `Final acceptance seal digest mismatch: expected=${expectedSealSha256 ?? "missing"} recorded=${seal.sealSha256 ?? "missing"} actual=${actual}`,
    );
  return true;
}

export async function verifySealedAcceptanceBootstrap({
  runDir,
  expectedSealSha256,
}) {
  const canonicalRunDir = await realpath(runDir);
  if (canonicalRunDir !== path.resolve(runDir))
    throw new Error("Acceptance bootstrap run directory is aliased.");
  const sealPath = path.join(canonicalRunDir, "acceptance-seal.json");
  const reportPath = path.join(canonicalRunDir, "acceptance-report.json");
  const [sealBytes, reportBytes] = await Promise.all([
    readFile(sealPath),
    readFile(reportPath),
  ]);
  const seal = JSON.parse(sealBytes.toString("utf8"));
  const report = JSON.parse(reportBytes.toString("utf8"));
  verifyFinalAcceptanceSeal(seal, expectedSealSha256);
  if (
    seal.runDir !== canonicalRunDir ||
    seal.finalReport?.rawSha256 !==
      createHash("sha256").update(reportBytes).digest("hex") ||
    seal.finalReport?.canonicalSha256 !== digestSeed(report)
  )
    throw new Error("Acceptance bootstrap report does not match final seal.");
  const currentSource = await sourceFingerprint();
  if (stableJson(currentSource) !== stableJson(report.source?.capturedWorktree))
    throw new Error(
      "Acceptance bootstrap current source differs from sealed source inventory.",
    );
  const dependencyRoots = report.snapshot?.dependencies?.roots;
  if (!Array.isArray(dependencyRoots))
    throw new Error("Acceptance bootstrap has no sealed dependency roots.");
  const currentDependencies = await dependencyRootsFingerprint(
    repositoryRoot,
    dependencyRoots,
  );
  if (
    stableJson(currentDependencies) !==
    stableJson(report.snapshot.dependencies.originalBeforeCopy)
  )
    throw new Error(
      "Acceptance bootstrap current dependencies differ from sealed toolchain inventory.",
    );
  const electronIdentity = seal.electron;
  if (
    !electronIdentity?.executablePath ||
    (await sha256File(electronIdentity.executablePath)) !==
      electronIdentity.sha256 ||
    (await stat(electronIdentity.executablePath)).size !==
      electronIdentity.bytes
  )
    throw new Error("Acceptance bootstrap Electron identity mismatch.");
  return { report, seal };
}

export async function assertFileInventoryUnchanged(root, inventory) {
  for (const entry of inventory.files) {
    const filePath = path.resolve(root, entry.path);
    if (!isInside(root, filePath))
      throw new Error(`Inventoried evidence escaped its root: ${entry.path}`);
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile())
      throw new Error(`Inventoried evidence changed type: ${entry.path}`);
    const digest = await sha256File(filePath);
    if (fileStat.size !== entry.bytes || digest !== entry.sha256)
      throw new Error(`Inventoried evidence changed: ${entry.path}`);
  }
  return true;
}

export async function finalizeFileEvidence({
  root,
  verifyConsistency,
  buildInventory,
}) {
  await verifyConsistency();
  const inventory = await buildInventory();
  await verifyConsistency();
  await assertFileInventoryUnchanged(root, inventory);
  return inventory;
}

async function lstatSyncAsync(filePath) {
  return lstatSync(filePath);
}

async function readlinkSafe(filePath) {
  const { readlink } = await import("node:fs/promises");
  return readlink(filePath);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is required. Run the exact-build release acceptance command.`,
    );
  return path.resolve(value);
}

export function loadAcceptanceContext(component) {
  const runDir = requireEnv("JOB_FINDER_ACCEPTANCE_RUN_DIR");
  const manifestPath = requireEnv("JOB_FINDER_ACCEPTANCE_MANIFEST");
  if (!isInside(artifactRoot, runDir))
    throw new Error(
      `Acceptance run directory escaped ${artifactRoot}: ${runDir}`,
    );
  if (!isInside(runDir, manifestPath))
    throw new Error(
      `Acceptance manifest escaped the run directory: ${manifestPath}`,
    );
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read exact-build acceptance manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.acceptanceVersion !== ACCEPTANCE_VERSION)
    throw new Error(
      `Unsupported acceptance manifest version: ${manifest.acceptanceVersion}`,
    );
  if (manifest.runDir !== runDir)
    throw new Error(
      `Acceptance manifest run directory mismatch: ${manifest.runDir} !== ${runDir}`,
    );
  const expectedManifestDigest =
    process.env.JOB_FINDER_ACCEPTANCE_MANIFEST_SHA256;
  const manifestSubject = { ...manifest };
  delete manifestSubject.manifestSha256;
  const actualManifestDigest = digestSeed(manifestSubject);
  if (
    !expectedManifestDigest ||
    manifest.manifestSha256 !== expectedManifestDigest ||
    actualManifestDigest !== expectedManifestDigest
  )
    throw new Error(
      `Acceptance manifest digest mismatch: expected=${expectedManifestDigest ?? "missing"} recorded=${manifest.manifestSha256 ?? "missing"} actual=${actualManifestDigest}`,
    );
  return {
    component,
    runDir,
    manifestPath,
    manifest,
    outputDir: path.join(runDir, component),
    seed: SYNTHETIC_SEED,
    seedDigest: SYNTHETIC_SEED_DIGEST,
  };
}

export async function verifyAcceptanceArtifacts(context) {
  const expected = context.manifest.artifacts;
  if (!expected?.files?.length)
    throw new Error("Acceptance manifest has no build artifact hashes.");
  const actual = await artifactFingerprint();
  if (
    actual.digest !== expected.digest ||
    actual.fileCount !== expected.fileCount
  ) {
    throw new Error(
      `Build artifacts changed after the exact build. expected=${expected.digest}/${expected.fileCount} actual=${actual.digest}/${actual.fileCount}`,
    );
  }
  const expectedFiles = new Map(
    expected.files.map((entry) => [entry.path, stableJson(entry)]),
  );
  const actualFiles = new Map(
    actual.files.map((entry) => [entry.path, stableJson(entry)]),
  );
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some(
      ([filePath, digest]) => actualFiles.get(filePath) !== digest,
    )
  ) {
    throw new Error(
      "Build artifact file list or hashes do not match the exact-build manifest.",
    );
  }
  return actual;
}

export async function ensureFreshOutputDir(outputDir) {
  if (!isInside(artifactRoot, outputDir))
    throw new Error(`Capture output escaped ${artifactRoot}: ${outputDir}`);
  if (existsSync(outputDir))
    throw new Error(
      `Capture output already exists; refusing stale screenshots: ${outputDir}`,
    );
  await mkdir(outputDir, { recursive: true });
}

// Acceptance runs must never reach live AI providers through ambient
// developer-shell credentials. Every Live Assistant credential variable is
// stripped by prefix/suffix so future `NESTOR_INTERVIEW_*_API_KEY`
// variants cannot leak, shared keys are stripped by exact name, and the narrow
// test-mode live-AI opt-in is removed so the enabled desktop test API always
// resolves deterministic Live Assistant providers. This literal must stay in
// sync with packages/ai-providers/src/live-assistant.ts.
const ACCEPTANCE_INTERVIEW_CREDENTIAL_PREFIX = "NESTOR_INTERVIEW_";
const ACCEPTANCE_CREDENTIAL_SUFFIX = "_API_KEY";
const LIVE_ASSISTANT_TEST_LIVE_AI_OPT_IN_ENV =
  "NESTOR_INTERVIEW_TEST_USE_LIVE_AI";
const ACCEPTANCE_SHARED_CREDENTIAL_ENV_NAMES = Object.freeze([
  "NESTOR_AI_API_KEY",
  "NESTOR_AI_VISION_API_KEY",
  "NESTOR_RESUME_VISION_API_KEY",
]);

export function acceptanceEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const name of Object.keys(env)) {
    if (
      name.startsWith(ACCEPTANCE_INTERVIEW_CREDENTIAL_PREFIX) &&
      name.endsWith(ACCEPTANCE_CREDENTIAL_SUFFIX)
    ) {
      delete env[name];
    }
  }
  for (const name of ACCEPTANCE_SHARED_CREDENTIAL_ENV_NAMES) {
    delete env[name];
  }
  delete env[LIVE_ASSISTANT_TEST_LIVE_AI_OPT_IN_ENV];
  env.NESTOR_BROWSER_AGENT = "0";
  env.NESTOR_ENABLE_TEST_API = "1";
  env.NESTOR_TEST_SYSTEM_THEME = "dark";
  return env;
}

export async function assertFileRenderer(page) {
  const href = await page.evaluate(() => window.location.href);
  if (!href.startsWith("file://"))
    throw new Error(`Release acceptance launched a non-file renderer: ${href}`);
  return href;
}

// Electron's initial loadFile() navigation can still be committing while
// Playwright resolves an ElectronApplication window handle, destroying the
// execution context the call was using ("Execution context was destroyed,
// most likely because of a navigation."). That failure is transient: the same
// page object stays usable once the navigation settles. Only these known
// transient startup failures may ever be retried; every other error must fail
// the acceptance run immediately.
const TRANSIENT_STARTUP_NAVIGATION_ERROR_PATTERNS = Object.freeze([
  /execution context was destroyed/i,
  /most likely because of a navigation/i,
]);

export function isTransientStartupNavigationError(error) {
  const candidates = [
    error,
    ...(error && Array.isArray(error.errors) ? error.errors : []),
  ];
  const messages = [];
  for (const candidate of candidates) {
    if (candidate instanceof Error && candidate.message)
      messages.push(candidate.message);
    else if (candidate && typeof candidate.message === "string")
      messages.push(candidate.message);
  }
  if (messages.length === 0) return false;
  const joined = messages.join("\n");
  return TRANSIENT_STARTUP_NAVIGATION_ERROR_PATTERNS.some((pattern) =>
    pattern.test(joined),
  );
}

// Bounded resolver for the Electron BrowserWindow handle behind a freshly
// launched window. Retries at most `attempts` times with capped exponential
// backoff, and only when the failure matches the known transient startup
// navigation/context-destruction signatures above. A closed page, a crashed
// app, or any unrelated error surfaces immediately instead of being retried.
export async function resolveStartupBrowserWindow(
  app,
  page,
  { attempts = 8, baseDelayMs = 100, maxDelayMs = 1_000 } = {},
) {
  if (!app || typeof app.browserWindow !== "function")
    throw new Error(
      "resolveStartupBrowserWindow requires an ElectronApplication instance.",
    );
  if (!page || typeof page.isClosed !== "function")
    throw new Error(
      "resolveStartupBrowserWindow requires a Playwright page handle.",
    );
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (page.isClosed())
      throw new Error(
        `Startup renderer closed before its BrowserWindow handle resolved${lastError ? `; last transient error: ${lastError.message}` : ""}.`,
      );
    try {
      return await app.browserWindow(page);
    } catch (error) {
      lastError = error;
      if (!isTransientStartupNavigationError(error)) throw error;
      if (attempt < attempts)
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)),
          ),
        );
    }
  }
  throw new Error(
    `Electron BrowserWindow handle did not resolve within ${attempts} attempts; the transient startup navigation race never settled. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// This probe is intentionally stricter than the product's application policy.
// It permits in-app navigation and other explicitly marked prepare-only
// controls, while preventing and recording external, submit, account, and
// authentication surfaces. The capture scripts fail the run when any record
// is observed, so a blocked action cannot silently become accepted evidence.
export function installPrepareOnlySafetyProbe() {
  if (window.__jobFinderAcceptanceSafetyProbeInstalled) return;
  window.__jobFinderAcceptanceSafetyProbeInstalled = true;
  const seen = new Set();
  const riskPattern =
    /\b(?:apply\s+(?:to|for|now|this\s+job)|application\s+submit|final\s+submit|submit(?:\s+application)?|external\s+write|account(?:\s+creation)?|auth(?:entication|orization)?|sign[ -]?up|sign[ -]?in|log(?:in|\s+in)|authenticate|consent|captcha|mfa|password|credential|open\s+(?:browser|external)|approve.*(?:application|external|submit)|retry.*(?:sign|login|application))\b/i;
  const getSurface = (target) =>
    target instanceof Element
      ? target.closest(
          "form,button,a,[role=button],[role=menuitem],[role=link],summary,input,textarea,select",
        )
      : null;
  const isExplicitlySafe = (control) => {
    if (!(control instanceof HTMLElement)) return false;
    if (control.closest('[data-acceptance-safe-control="true"]')) return true;
    if (control.closest('nav[aria-label="Job Finder sections"]')) return true;
    if (control.closest('[role="navigation"][aria-label="More"]')) return true;
    return control.getAttribute("aria-label") === "Notifications and actions";
  };
  const describe = (control) => {
    if (!(control instanceof HTMLElement)) return "window";
    const label =
      control.getAttribute("aria-label") ??
      control.getAttribute("title") ??
      control.textContent?.replace(/\s+/g, " ").trim() ??
      control.tagName.toLowerCase();
    return label || control.tagName.toLowerCase();
  };
  const emit = (event, control, reason, blocked = true) => {
    const label = describe(control);
    const key = `${event}:${reason}:${label}:${control?.outerHTML?.slice(0, 300) ?? "window"}`;
    if (seen.has(key)) return;
    seen.add(key);
    const record = {
      type: event,
      label,
      reason,
      blocked,
      href: control instanceof HTMLAnchorElement ? control.href : null,
      at: new Date().toISOString(),
    };
    window.__jobFinderAcceptanceSafetyEvents?.(record);
  };
  const isExternalLink = (control) =>
    control instanceof HTMLAnchorElement &&
    /^(?:https?:|mailto:|javascript:)/i.test(control.href);
  const inspect = (event) => {
    const control = getSurface(event.target);
    if (!(control instanceof HTMLElement) || isExplicitlySafe(control)) return;
    const label = describe(control);
    const risky = riskPattern.test(label);
    const external = isExternalLink(control);
    // Local form editing is prepare-only and remains allowed. The submit
    // listener below handles the actual form boundary separately.
    if (!risky && !external) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    emit(event.type, control, external ? "external-link" : "risky-control");
  };
  document.addEventListener("click", inspect, true);
  document.addEventListener("pointerdown", inspect, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") inspect(event);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || isExplicitlySafe(form)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      emit("submit", form, "form-submit");
    },
    true,
  );
  const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.requestSubmit = function (...args) {
    if (isExplicitlySafe(this)) return originalRequestSubmit.apply(this, args);
    emit("requestSubmit", this, "programmatic-form-submit");
    return undefined;
  };
  const originalSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (...args) {
    if (isExplicitlySafe(this)) return originalSubmit.apply(this, args);
    emit("submit", this, "programmatic-form-submit");
    return undefined;
  };
  const originalOpen = window.open;
  window.open = () => {
    emit("window.open", null, "new-window");
    return null;
  };
  // Keep a reference so browser tooling cannot mistake the interception for
  // an accidental replacement of the native API during diagnostics.
  window.__jobFinderAcceptanceOriginalWindowOpen = originalOpen;
}

export function attachProcessOutput(app, report) {
  const state = { stdout: [], stderr: [] };
  const processHandle = app.process();
  processHandle?.stdout?.on("data", (chunk) =>
    state.stdout.push(String(chunk)),
  );
  processHandle?.stderr?.on("data", (chunk) =>
    state.stderr.push(String(chunk)),
  );
  report.mainProcess ??= {
    pid: processHandle?.pid ?? null,
    stdout: "",
    stderr: "",
  };
  if (report.mainProcess.pid === null)
    report.mainProcess.pid = processHandle?.pid ?? null;
  return state;
}

// Benign, deterministic teardown notice from Playwright's inspector-based
// Electron transport on POSIX. playwright-core launches every Electron app
// with --inspect=0 and bootstraps app readiness over that Node inspector
// session, so the notice cannot be removed by launch env/args sanitization:
// when the main process shuts down while the driver's debugger client is
// still attached, Node prints exactly this one line on stderr (and waits
// for the driver to release it before exiting). Accept only that exact full
// line; every other stderr byte still fails the run. Defined once here so
// the static validator can fixture-test that the pattern cannot mask any
// other output.
export const PLAYWRIGHT_INSPECTOR_DISCONNECT_STDERR_PATTERN = {
  name: "playwright-inspector-disconnect-notice",
  pattern: /^Waiting for the debugger to disconnect\.\.\.\r?\n/gm,
};

// Teardown precedence for run()-style try/finally blocks: when the scenario
// body threw and process-output finalization also rejected during teardown,
// the primary scenario error must stay the thrown error and the finalization
// error is attached as its cause, so teardown noise can never mask the real
// failure. finalizeProcessOutput records stdout/stderr/unexpectedStderr into
// the report before it throws, so the report stays complete either way.
export function resolvePrimaryRunError(scenarioError, finalizationError) {
  if (!scenarioError) return finalizationError ?? null;
  if (!finalizationError) return scenarioError;
  scenarioError.cause = finalizationError;
  return scenarioError;
}

export function finalizeProcessOutput(
  state,
  report,
  { acceptedStderrPatterns = [] } = {},
) {
  report.mainProcess ??= { pid: null, stdout: "", stderr: "" };
  const stdout = state.stdout.join("");
  const stderr = state.stderr.join("");
  let unexpectedStderr = stderr.replace(
    /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `electron --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gi,
    "",
  );
  report.mainProcess.stdout += stdout;
  report.mainProcess.stderr += stderr;
  report.mainProcess.unexpectedStderr ??= "";
  report.mainProcess.acceptedWarnings ??= [];
  if (stderr !== unexpectedStderr) {
    report.mainProcess.acceptedWarnings.push("node-sqlite-experimental");
  }
  for (const accepted of acceptedStderrPatterns) {
    const before = unexpectedStderr;
    unexpectedStderr = unexpectedStderr.replace(accepted.pattern, "");
    if (before !== unexpectedStderr) {
      report.mainProcess.acceptedWarnings.push(accepted.name);
    }
  }
  report.mainProcess.unexpectedStderr += unexpectedStderr;
  if (unexpectedStderr.trim())
    throw new Error(
      `Electron main process wrote unexpected output to stderr:\n${unexpectedStderr}`,
    );
}

async function pngInfo(filePath) {
  const contents = await readFile(filePath);
  if (
    contents.length < 24 ||
    contents.readUInt32BE(0) !== 0x89504e47 ||
    contents.toString("ascii", 1, 4) !== "PNG"
  ) {
    throw new Error(`Screenshot is not a valid PNG: ${filePath}`);
  }
  return {
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

export async function screenshotMetadata(
  page,
  browserWindow,
  screenshotPath,
  metadata = {},
) {
  const cssViewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
  const nativeZoomFactor = browserWindow
    ? await browserWindow.evaluate((win) => win.webContents.getZoomFactor())
    : null;
  const image = await pngInfo(screenshotPath);
  const clickablePointScopeSelector =
    typeof metadata.clickablePointScopeSelector === "string"
      ? metadata.clickablePointScopeSelector
      : null;
  const clickablePointItems = await page.evaluate((scopeSelector) => {
    const selector =
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[role="button"]:not([aria-disabled="true"]),[role="menuitem"]:not([aria-disabled="true"])';
    const scope = scopeSelector
      ? document.querySelector(scopeSelector)
      : document;
    if (!scope)
      throw new Error(
        `Clickable-point evidence scope was not found: ${String(scopeSelector)}`,
      );
    return Array.from(scope.querySelectorAll(selector)).flatMap(
      (element, index) => {
        if (!(element instanceof HTMLElement)) return [];
        const closedDetails = element.closest("details:not([open])");
        const visibleSummary = closedDetails?.querySelector(":scope > summary");
        if (closedDetails && !visibleSummary?.contains(element)) return [];
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        let visibleLeft = Math.max(0, rect.left);
        let visibleTop = Math.max(0, rect.top);
        let visibleRight = Math.min(window.innerWidth, rect.right);
        let visibleBottom = Math.min(window.innerHeight, rect.bottom);
        const clippingValues = new Set(["auto", "scroll", "hidden", "clip"]);
        for (
          let ancestor = element.parentElement;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          const ancestorStyle = getComputedStyle(ancestor);
          const ancestorRect = ancestor.getBoundingClientRect();
          if (clippingValues.has(ancestorStyle.overflowX)) {
            visibleLeft = Math.max(visibleLeft, ancestorRect.left);
            visibleRight = Math.min(visibleRight, ancestorRect.right);
          }
          if (clippingValues.has(ancestorStyle.overflowY)) {
            visibleTop = Math.max(visibleTop, ancestorRect.top);
            visibleBottom = Math.min(visibleBottom, ancestorRect.bottom);
          }
        }
        const visibleWidth = visibleRight - visibleLeft;
        const visibleHeight = visibleBottom - visibleTop;
        const required =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          visibleWidth >= 2 &&
          visibleHeight >= 2;
        if (!required) return [];
        const points = [
          [visibleLeft + visibleWidth / 2, visibleTop + visibleHeight / 2],
          [
            visibleLeft + Math.min(4, visibleWidth / 2),
            visibleTop + Math.min(4, visibleHeight / 2),
          ],
          [
            visibleRight - Math.min(4, visibleWidth / 2),
            visibleBottom - Math.min(4, visibleHeight / 2),
          ],
        ];
        const hit = points.some(([x, y]) => {
          const owner = document.elementFromPoint(x, y);
          return (
            owner === element ||
            (owner instanceof Node && element.contains(owner))
          );
        });
        return [
          {
            required,
            hit,
            index,
            label:
              element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120) ??
              element.tagName.toLowerCase(),
            position: style.position,
            rect: {
              left: visibleLeft,
              top: visibleTop,
              right: visibleRight,
              bottom: visibleBottom,
            },
          },
        ];
      },
    );
  }, clickablePointScopeSelector);
  const clickablePointEvidence =
    evaluateClickablePointEvidence(clickablePointItems);
  clickablePointEvidence.scopeSelector = clickablePointScopeSelector;
  return {
    route: metadata.route ?? (await page.evaluate(() => window.location.hash)),
    seedDigest: metadata.seedDigest ?? SYNTHETIC_SEED_DIGEST,
    viewport: {
      physical: { width: image.width, height: image.height },
      css: { width: cssViewport.width, height: cssViewport.height },
      devicePixelRatio: cssViewport.devicePixelRatio,
      nativeZoomFactor,
      requested: metadata.viewport ?? null,
    },
    screenshot: image,
    clickablePointEvidence,
  };
}

export function assertPrepareOnly(workspace, observedSafetyEvents = []) {
  if (!workspace || typeof workspace !== "object")
    throw new Error("Prepare-only safety check could not read the workspace.");
  if (observedSafetyEvents.length)
    throw new Error(
      `Unexpected application, authentication, authorization, or submission event: ${JSON.stringify(observedSafetyEvents)}`,
    );
  if (!Array.isArray(workspace.userActionRequests))
    throw new Error(
      "Synthetic acceptance workspace omitted user-action safety records.",
    );
  for (const request of workspace.userActionRequests) {
    if (
      !request ||
      request.submitAuthorized !== false ||
      request.accountCreationAuthorized !== false
    )
      throw new Error(
        "Synthetic acceptance state did not explicitly retain false submit and account-creation authority.",
      );
  }
  if (!Array.isArray(workspace.campaigns))
    throw new Error(
      "Synthetic acceptance workspace omitted campaign safety records.",
    );
  for (const campaign of workspace.campaigns) {
    if (campaign?.applicationPolicy?.finalSubmitAuthorized !== false)
      throw new Error(
        "Synthetic acceptance campaign did not explicitly retain false final-submit authority.",
      );
  }
  const requiredCollections = [
    "applicationAttempts",
    "applyJobResults",
    "applicationRecords",
    "discoveryJobs",
  ];
  for (const name of requiredCollections) {
    if (!Array.isArray(workspace[name]))
      throw new Error(
        `Synthetic acceptance workspace omitted authoritative ${name} safety facts.`,
      );
  }
  const submitted = [];
  for (const attempt of workspace.applicationAttempts) {
    if (attempt?.state === "submitted" || attempt?.outcome === "submitted")
      submitted.push({ collection: "applicationAttempts", id: attempt.id });
  }
  for (const result of workspace.applyJobResults) {
    if (result?.state === "submitted")
      submitted.push({ collection: "applyJobResults", id: result.id });
  }
  for (const application of workspace.applicationRecords) {
    if (
      application?.status === "submitted" ||
      application?.lastAttemptState === "submitted"
    )
      submitted.push({ collection: "applicationRecords", id: application.id });
  }
  for (const job of workspace.discoveryJobs) {
    if (job?.status === "submitted")
      submitted.push({ collection: "discoveryJobs", id: job.id });
  }
  const receipts = workspace.applyJobResults
    .map((result) => result?.privacyReceipt)
    .filter(Boolean);
  const unsafeReceipts = receipts.filter(
    (receipt) =>
      receipt.finalSubmitOccurred === true ||
      receipt.finalSubmitAuthorized === true ||
      receipt.accountCreationAuthorized === true ||
      (Array.isArray(receipt.externalWrites) &&
        receipt.externalWrites.length > 0),
  );
  if (submitted.length > 0 || unsafeReceipts.length > 0)
    throw new Error(
      `Prepare-only persisted authoritative submitted/external-write facts: ${JSON.stringify({ submitted, unsafeReceipts })}`,
    );
  return {
    submittedCount: submitted.length,
    receiptCount: receipts.length,
    externalWriteCount: receipts.reduce(
      (count, receipt) => count + (receipt.externalWrites?.length ?? 0),
      0,
    ),
    pass: true,
  };
}

export async function readProcessTable() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      command: String(row.CommandLine ?? ""),
    }));
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,command="],
    {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split("\n")
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
      return match
        ? {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            command: match[3],
          }
        : null;
    })
    .filter(Boolean);
}

export function createOwnedProcessLedger() {
  const tracked = new Map();
  return {
    track(pid, role, command) {
      if (Number.isInteger(pid)) tracked.set(pid, { pid, role, command });
    },
    entries() {
      return [...tracked.values()];
    },
  };
}

export async function snapshotOwnedProcessTree(ledger, rootPid, role) {
  const table = await readProcessTable();
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid);
  if (!root)
    throw new Error(
      `Owned ${role} root pid ${rootPid} vanished before snapshot.`,
    );
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row)
      ledger.track(
        pid,
        pid === rootPid ? `${role}:root` : `${role}:descendant`,
        row.command,
      );
    for (const child of table)
      if (child.parentPid === pid) pending.push(child.pid);
  }
}

export async function stopAndVerifyOwnedElectron(app, ledger, label) {
  const processHandle = app?.process();
  if (!processHandle?.pid)
    throw new Error(`${label} has no owned Electron root pid.`);
  await snapshotOwnedProcessTree(ledger, processHandle.pid, label);
  if (process.platform === "win32")
    await execFileAsync("taskkill", [
      "/PID",
      String(processHandle.pid),
      "/T",
      "/F",
    ]);
  else {
    try {
      processHandle.kill("SIGTERM");
    } catch {
      // Best effort: the owned Electron root may already be gone.
    }
    await Promise.race([
      new Promise((resolve) => processHandle.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      try {
        processHandle.kill("SIGKILL");
      } catch {
        // Best effort escalation: the owned Electron root may already be gone.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const table = await readProcessTable();
  const byPid = new Map(table.map((row) => [row.pid, row.command]));
  const survivors = ledger.entries().filter((entry) => {
    const command = byPid.get(entry.pid);
    return (
      command !== undefined &&
      (entry.command === "" || command === entry.command)
    );
  });
  const verification = {
    label,
    trackedProcessCount: ledger.entries().length,
    leftoverPids: survivors.map((entry) => entry.pid),
    verified: survivors.length === 0,
  };
  if (!verification.verified)
    throw new Error(
      `${label} left owned processes alive: ${JSON.stringify(survivors)}`,
    );
  return verification;
}

export async function cleanupDirectory(directory) {
  if (!directory) return null;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 250,
        }),
      );
      return null;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return lastError;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function makeIsolatedUserDataDirectory(
  prefix = "nestor-job-finder-acceptance-",
) {
  return import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), prefix)),
  );
}
