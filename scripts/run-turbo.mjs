import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  corepackEntrypointCandidates,
  resolveVerifiedPnpmLauncher,
  writePnpmPathShims,
} from "./lib/pnpm-entry.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const nodeDir = path.dirname(process.execPath);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const rootManifest = JSON.parse(
  fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
);

// Resolve and authorize a shell-free pnpm entry against the repository pin.
// Corepack is only one optional candidate here: Node >= 25 no longer bundles
// it, so resolution falls through to npm_execpath, vendored pnpm, or a POSIX
// PATH pnpm node script. Every failure below is fail-closed; nothing is
// fetched and no arbitrary pnpm version is silently accepted.
let launcher;
try {
  launcher = resolveVerifiedPnpmLauncher({
    repositoryRoot: rootDir,
    packageManagerString: rootManifest.packageManager,
    corepackCandidates: corepackEntrypointCandidates(nodeDir),
    resolveFromRoot: createRequire(path.join(rootDir, "package.json")).resolve,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const turboArguments = process.argv.slice(2);
const pnpmArguments = ["exec", "turbo", ...turboArguments];
const childArguments =
  launcher.kind === "corepack"
    ? [...launcher.argsPrefix, launcher.packageManagerSpec, ...pnpmArguments]
    : [...launcher.argsPrefix, ...pnpmArguments];

const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const inheritedPath = process.env[pathKey] ?? "";

// Turbo launches package scripts through the package manager discovered on
// PATH. Put a directory that resolves `pnpm` to the exact verified entry
// first, so those child invocations honor the repository-pinned version
// instead of a globally installed pnpm — the same guarantee the Corepack shim
// directory used to provide when Corepack shipped beside Node.js.
let pathPrepend;
if (launcher.kind === "corepack") {
  const corepackShimDir = path.join(
    path.dirname(launcher.corepackEntrypoint),
    "..",
    "shims",
  );
  pathPrepend = [
    fs.existsSync(corepackShimDir) ? corepackShimDir : null,
    nodeDir,
  ];
} else {
  let shimDir;
  try {
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nestor-pnpm-shim-"));
  } catch (error) {
    fail(
      `Unable to create a private pnpm PATH shim directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.on("exit", () => {
    try {
      fs.rmSync(shimDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the private temp directory.
    }
  });
  writePnpmPathShims({
    shimDir,
    nodeExecutable: process.execPath,
    entryPoint: launcher.entryPoint,
  });
  pathPrepend = [shimDir, nodeDir];
}

const env = {
  ...process.env,
  [pathKey]: [...pathPrepend, inheritedPath]
    .filter(Boolean)
    .join(path.delimiter),
};

const result = spawnSync(process.execPath, childArguments, {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
