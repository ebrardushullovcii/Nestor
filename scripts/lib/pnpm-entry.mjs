// Shared, shell-free pnpm entry resolution for repository launchers
// (run-turbo.mjs, validate-package.mjs).
//
// Corepack stopped shipping beside Node.js in Node >= 25, and Unix layouts
// differ between bundled prefixes, Homebrew Cellar paths, and version
// managers, so nothing here may assume `<nodeDir>/node_modules/corepack`
// exists. Instead every consumer resolves a pnpm JavaScript entry point from
// the same ordered candidate list and always spawns
// `process.execPath <entry> ...` as an argument array — never a shell string,
// never a `.cmd` (Node rejects those without a shell on Windows), so paths
// containing spaces are safe by construction.
//
// Candidate order:
//   1. `npm_execpath`   — the pnpm currently executing the script (when the
//                         entry was reached through `pnpm <script>`).
//   2. vendored pnpm    — `pnpm/bin/pnpm.cjs` resolved from the repo root.
//   3. Corepack         — OPTIONAL candidate (see corepackCandidates);
//                         collectors pass an empty list to preserve their
//                         historical direct-entry-only behavior.
//   4. POSIX PATH scan  — a `pnpm` executable whose file starts with `#!`,
//                         executed under the current Node binary.
//
// Resolution alone is not authorization: launchers additionally enforce the
// `packageManager` pin (see parsePinnedPnpmSpec and
// resolveVerifiedPnpmLauncher) so an arbitrary incompatible pnpm can never be
// silently used, and every failure is fail-closed.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Reads the first two bytes of a file synchronously. Kept tiny and shared so
// the evidence collector and the launchers use one shebang heuristic.
export function defaultReadFirstBytes(filePath) {
  const buffer = Buffer.alloc(2);
  const descriptor = openSync(filePath, "r");
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function looksLikePnpmEntry(candidate) {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return (
    /(?:^|\/)pnpm(?:[./]|$)/u.test(normalized) || normalized.includes("/pnpm/")
  );
}

/**
 * Resolves a shell-free pnpm JavaScript entry point, or returns null when no
 * candidate exists. All inputs are injectable so tests can simulate Windows,
 * Linux, macOS, Corepack layouts, and hostile PATH values without spawning
 * anything.
 */
export function resolveShellFreePnpmInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  repositoryRoot = process.cwd(),
  fileExists = existsSync,
  readFirstBytes = defaultReadFirstBytes,
  resolveFromRoot = null,
  corepackCandidates = [],
} = {}) {
  // 1. npm_execpath: the pnpm that is already running us. Quoted values and
  //    relative paths (resolved against the repository root) are accepted;
  //    anything that is not a JavaScript file that plausibly is pnpm is
  //    ignored rather than trusted.
  const rawExecPath = String(environment.npm_execpath ?? "")
    .trim()
    .replace(/^"(.*)"$/, "$1");
  if (rawExecPath) {
    const candidate = path.isAbsolute(rawExecPath)
      ? rawExecPath
      : path.resolve(repositoryRoot, rawExecPath);
    if (
      /\.(?:c|m)?js$/u.test(candidate) &&
      looksLikePnpmEntry(candidate) &&
      fileExists(candidate)
    ) {
      return {
        command: nodeExecutable,
        argsPrefix: [candidate],
        entryPoint: candidate,
        source: "npm_execpath",
      };
    }
  }

  // 2. A pnpm vendored into the workspace (if the consumer supplies a
  //    resolver bound to its root package.json).
  if (typeof resolveFromRoot === "function") {
    try {
      const candidate = resolveFromRoot("pnpm/bin/pnpm.cjs");
      if (fileExists(candidate)) {
        return {
          command: nodeExecutable,
          argsPrefix: [candidate],
          entryPoint: candidate,
          source: "vendored-pnpm",
        };
      }
    } catch {
      // pnpm is not vendored in this checkout; continue resolution.
    }
  }

  // 3. Optional Corepack candidates supplied by the caller (launchers derive
  //    them from corepackEntrypointCandidates). Corepack enforces the pinned
  //    spec itself, so no version probe is needed when this wins.
  for (const candidate of corepackCandidates ?? []) {
    if (typeof candidate === "string" && candidate && fileExists(candidate)) {
      return {
        command: nodeExecutable,
        argsPrefix: [candidate],
        entryPoint: candidate,
        source: "corepack",
      };
    }
  }

  // 4. POSIX PATH scan: Homebrew, standalone installers, and corepack-less
  //    Node distributions commonly provide `pnpm` as a Node script whose
  //    first line is a shebang; running it through the current binary keeps
  //    the invocation shell-free. Windows is skipped entirely because a
  //    `.cmd`/`.exe` cannot be spawned shell-free by Node.
  if (platform !== "win32") {
    const pathVariable = String(environment.PATH ?? "");
    for (const directory of pathVariable.split(path.delimiter)) {
      if (directory.trim() === "") continue;
      const candidate = path.join(directory, "pnpm");
      if (!fileExists(candidate)) continue;
      try {
        if (!readFirstBytes(candidate).startsWith("#!")) continue;
        return {
          command: nodeExecutable,
          argsPrefix: [candidate],
          entryPoint: candidate,
          source: "path-node-script",
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Absolute paths where a Corepack entrypoint may live beside the given Node
 * directory, covering the layouts that actually occur:
 *
 * - `<nodeDir>/node_modules/corepack/dist/corepack.js` — Windows installs.
 * - `<prefix>/lib/node_modules/corepack/dist/corepack.js` — official Unix
 *   packages, nvm/fnm-style version managers, Homebrew non-Cellar prefixes,
 *   and Homebrew Cellar installs (the walk upward from
 *   `/opt/homebrew/Cellar/node/<v>/bin` reaches `/opt/homebrew/lib`).
 *
 * The list is ordered nearest-first; existence is checked by the caller.
 */
export function corepackEntrypointCandidates(nodeDir) {
  const candidates = [];
  const pushUnique = (candidate) => {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  pushUnique(
    path.join(nodeDir, "node_modules", "corepack", "dist", "corepack.js"),
  );
  let ancestor = nodeDir;
  for (;;) {
    pushUnique(
      path.join(
        ancestor,
        "lib",
        "node_modules",
        "corepack",
        "dist",
        "corepack.js",
      ),
    );
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return candidates;
}

/**
 * Parses a `packageManager` value such as `pnpm@10.8.0` or
 * `pnpm@10.8.0+sha512.<hex>` into `{ name, version, spec }`, or null when the
 * value does not pin pnpm. `version` strips any integrity suffix so it can be
 * compared against `pnpm --version` output.
 */
const pinnedPnpmPattern = /^pnpm@(\d+\.\d+\.\d+(?:[-+][^\s]+)*)$/u;

export function parsePinnedPnpmSpec(packageManager) {
  if (typeof packageManager !== "string") return null;
  const trimmed = packageManager.trim();
  const match = pinnedPnpmPattern.exec(trimmed);
  if (!match) return null;
  return {
    name: "pnpm",
    version: match[1].split("+")[0],
    spec: trimmed,
  };
}

function normalizeReportedVersion(output) {
  return String(output ?? "")
    .trim()
    .replace(/^v/u, "");
}

/**
 * Queries the resolved pnpm entry for its version by spawning
 * `<command> <entry> --version` (argument array, no shell; offline — pnpm's
 * version probe performs no network access). Throws fail-closed when the
 * entry cannot be spawned or produces no parsable version.
 */
export function readResolvedPnpmVersion({
  invocation,
  timeoutMs = 30_000,
  spawnImpl = spawnSync,
}) {
  const result = spawnImpl(
    invocation.command,
    [...invocation.argsPrefix, "--version"],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs },
  );
  if (result.error) {
    throw new Error(
      `Unable to query the resolved pnpm entry (${invocation.entryPoint}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    throw new Error(
      `The resolved pnpm entry (${invocation.entryPoint}) exited with code ${String(result.status)} while reporting its version${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const version = normalizeReportedVersion(result.stdout);
  if (!version) {
    throw new Error(
      `The resolved pnpm entry (${invocation.entryPoint}) produced no parsable version output`,
    );
  }
  return version;
}

function noCandidateMessage(pinned) {
  return [
    "no shell-free pnpm JavaScript entry point found via npm_execpath,",
    "vendored pnpm/bin/pnpm.cjs, an installed Corepack beside Node.js, or a",
    "POSIX PATH pnpm node script; refusing to spawn pnpm.cmd because Node",
    "rejects .cmd without a shell on Windows.",
    `This repository pins pnpm@${pinned.version} through packageManager — install`,
    `pnpm@${pinned.version} (for example \`npm install -g pnpm@${pinned.version}\`,`,
    "`brew install pnpm`, or enable Corepack); these launchers never fetch",
    "anything themselves and fail closed instead.",
  ].join(" ");
}

/**
 * Resolves AND authorizes a pnpm launcher against the repository pin.
 *
 * - Direct entries (npm_execpath / vendored / PATH script) are probed with
 *   `--version` and must report exactly the pinned version; a mismatch is a
 *   fail-closed error, never a silent downgrade or upgrade.
 * - A Corepack entry skips the probe (its `--version` would report Corepack
 *   itself); callers pass the full pinned spec to Corepack, which enforces
 *   the exact version (including any integrity hash) itself.
 *
 * Injectable `readVersion` lets tests stub the probe; production uses
 * readResolvedPnpmVersion. Returns one of:
 *   { kind: "direct", command, argsPrefix, entryPoint, source, pinnedVersion }
 *   { kind: "corepack", command, argsPrefix, corepackEntrypoint,
 *     packageManagerSpec, pinnedVersion }
 */
export function resolveVerifiedPnpmLauncher({
  repositoryRoot,
  packageManagerString,
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  fileExists = existsSync,
  readFirstBytes = defaultReadFirstBytes,
  resolveFromRoot = null,
  corepackCandidates = [],
  readVersion = null,
} = {}) {
  const pinned = parsePinnedPnpmSpec(packageManagerString);
  if (!pinned) {
    throw new Error(
      'Root package.json must pin pnpm through "packageManager" (for example "pnpm@10.8.0") before repository launchers can run',
    );
  }
  const invocation = resolveShellFreePnpmInvocation({
    environment,
    platform,
    nodeExecutable,
    repositoryRoot,
    fileExists,
    readFirstBytes,
    resolveFromRoot,
    corepackCandidates,
  });
  if (!invocation) {
    throw new Error(noCandidateMessage(pinned));
  }
  if (invocation.source === "corepack") {
    return {
      kind: "corepack",
      command: invocation.command,
      argsPrefix: invocation.argsPrefix,
      corepackEntrypoint: invocation.entryPoint,
      packageManagerSpec: pinned.spec,
      pinnedVersion: pinned.version,
    };
  }
  const foundVersion = normalizeReportedVersion(
    typeof readVersion === "function"
      ? readVersion({ invocation })
      : readResolvedPnpmVersion({ invocation }),
  );
  if (foundVersion !== pinned.version) {
    throw new Error(
      `The resolved pnpm entry (${invocation.entryPoint}, source ${invocation.source}) reports version ${foundVersion}, but this repository pins pnpm@${pinned.version} through packageManager; refusing to run with an incompatible pnpm. Activate pnpm@${pinned.version} (for example \`npm install -g pnpm@${pinned.version}\` or \`corepack prepare pnpm@${pinned.version} --activate\`) and rerun.`,
    );
  }
  return {
    kind: "direct",
    command: invocation.command,
    argsPrefix: invocation.argsPrefix,
    entryPoint: invocation.entryPoint,
    source: invocation.source,
    pinnedVersion: pinned.version,
  };
}

function escapeSingleQuoted(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Inside double quotes cmd.exe treats `%` specially (variable expansion); a
// literal percent must be doubled. Other metacharacters stay literal inside
// double quotes, and `"` cannot appear in Windows paths.
function escapeCmdDoubleQuoted(value) {
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * Writes a private PATH shim directory entry that forwards `pnpm ...` to the
 * verified pnpm entry through the current Node binary. Launchers prepend the
 * returned shim directory to PATH so child processes spawned by Turbo (which
 * discovers pnpm on PATH) honor the exact same verified entry instead of an
 * arbitrary global pnpm — the same guarantee Corepack shims used to provide.
 *
 * POSIX writes an executable `#!/bin/sh` trampoline with single-quoted paths
 * (safe for spaces and quotes); Windows writes a quoted `pnpm.cmd`.
 */
export function writePnpmPathShims({
  shimDir,
  nodeExecutable,
  entryPoint,
  platform = process.platform,
  writeImpl = writeFileSync,
  chmodImpl = chmodSync,
}) {
  if (platform === "win32") {
    const shimPath = path.join(shimDir, "pnpm.cmd");
    writeImpl(
      shimPath,
      [
        "@echo off",
        `${escapeCmdDoubleQuoted(nodeExecutable)} ${escapeCmdDoubleQuoted(entryPoint)} %*`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { platform: "win32", shimPath };
  }
  const shimPath = path.join(shimDir, "pnpm");
  writeImpl(
    shimPath,
    `#!/bin/sh\nexec ${escapeSingleQuoted(nodeExecutable)} ${escapeSingleQuoted(entryPoint)} "$@"\n`,
    "utf8",
  );
  chmodImpl(shimPath, 0o755);
  return { platform: "posix", shimPath };
}
