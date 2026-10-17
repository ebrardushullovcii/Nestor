/* eslint-env node */

import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const desktopDirectory = path.resolve(scriptDirectory, "..");
export const jobFinderDemoSafeRoot = "/tmp";
export const jobFinderDemoLaunchArgs = Object.freeze(["out/main/index.cjs"]);

const builtAppFiles = [
  path.join(desktopDirectory, "out", "main", "index.cjs"),
  path.join(desktopDirectory, "out", "preload", "index.cjs"),
  path.join(desktopDirectory, "out", "renderer", "index.html"),
];

export const jobFinderDemoUsage =
  "Usage: pnpm --filter @nestor/desktop seed:job-finder-demo -- --user-data-dir /tmp/job-finder-demo";

function isPathInside(candidate, root, allowRoot = false) {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot && relative === "") ||
    (relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function parseSeedArguments(argv = process.argv.slice(2)) {
  let requestedUserDataDirectory = null;
  const parsedArguments = argv[0] === "--" ? argv.slice(1) : argv;

  for (let index = 0; index < parsedArguments.length; index += 1) {
    const argument = parsedArguments[index];
    if (argument === "--user-data-dir") {
      if (requestedUserDataDirectory !== null) {
        throw new Error(
          "The --user-data-dir option may only be provided once.",
        );
      }

      const value = parsedArguments[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          `Missing value for --user-data-dir.\n${jobFinderDemoUsage}`,
        );
      }
      requestedUserDataDirectory = value;
      index += 1;
      continue;
    }

    if (argument?.startsWith("--user-data-dir=")) {
      if (requestedUserDataDirectory !== null) {
        throw new Error(
          "The --user-data-dir option may only be provided once.",
        );
      }

      const value = argument.slice("--user-data-dir=".length);
      if (!value) {
        throw new Error(
          `Missing value for --user-data-dir.\n${jobFinderDemoUsage}`,
        );
      }
      requestedUserDataDirectory = value;
      continue;
    }

    throw new Error(
      `Unknown argument ${JSON.stringify(argument)}.\n${jobFinderDemoUsage}`,
    );
  }

  if (requestedUserDataDirectory === null) {
    throw new Error(
      `An explicit --user-data-dir is required.\n${jobFinderDemoUsage}`,
    );
  }

  return { requestedUserDataDirectory };
}

async function findExistingAncestor(candidate, fileSystem) {
  let current = candidate;

  while (true) {
    try {
      await fileSystem.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

/**
 * Resolve and validate a user-data directory without creating or deleting it.
 * The caller may provide a new path or an existing empty directory only.
 */
export async function validateUserDataDirectory(
  requestedPath,
  {
    safeRoot = jobFinderDemoSafeRoot,
    fileSystem = { lstat, readdir, realpath, stat },
  } = {},
) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error(
      "--user-data-dir must be a non-empty absolute path under /tmp.",
    );
  }

  const trimmedPath = requestedPath.trim();
  if (!path.isAbsolute(trimmedPath)) {
    throw new Error(
      `Refusing relative --user-data-dir ${JSON.stringify(requestedPath)}; use an absolute path under /tmp.`,
    );
  }

  const resolvedRoot = path.resolve(safeRoot);
  const resolvedPath = path.resolve(trimmedPath);
  if (!isPathInside(resolvedPath, resolvedRoot)) {
    throw new Error(
      `Refusing --user-data-dir ${JSON.stringify(resolvedPath)}; it must be a child of ${resolvedRoot}.`,
    );
  }

  const canonicalRoot = await fileSystem.realpath(resolvedRoot);
  const existingPath = await findExistingAncestor(resolvedPath, fileSystem);
  if (!existingPath) {
    throw new Error(
      `Could not resolve a parent directory for ${resolvedPath}.`,
    );
  }

  const canonicalExistingPath = await fileSystem.realpath(existingPath);
  if (!isPathInside(canonicalExistingPath, canonicalRoot, true)) {
    throw new Error(
      `Refusing --user-data-dir ${JSON.stringify(resolvedPath)}; its existing path escapes ${resolvedRoot}.`,
    );
  }

  const existingPathStats = await fileSystem.stat(existingPath);
  if (!existingPathStats.isDirectory()) {
    throw new Error(
      `Refusing --user-data-dir ${JSON.stringify(resolvedPath)}; its parent is not a directory.`,
    );
  }

  let targetStats;
  try {
    targetStats = await fileSystem.lstat(resolvedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (!targetStats) {
    return resolvedPath;
  }

  if (targetStats.isSymbolicLink()) {
    throw new Error(
      `Refusing symlink --user-data-dir ${JSON.stringify(resolvedPath)}.`,
    );
  }
  if (!targetStats.isDirectory()) {
    throw new Error(
      `Refusing --user-data-dir ${JSON.stringify(resolvedPath)}; it is not a directory.`,
    );
  }

  const entries = await fileSystem.readdir(resolvedPath);
  if (entries.length > 0) {
    throw new Error(
      `Refusing non-empty --user-data-dir ${JSON.stringify(resolvedPath)}; choose a new or empty directory.`,
    );
  }

  const canonicalTarget = await fileSystem.realpath(resolvedPath);
  if (!isPathInside(canonicalTarget, canonicalRoot)) {
    throw new Error(
      `Refusing --user-data-dir ${JSON.stringify(resolvedPath)}; its target escapes ${resolvedRoot}.`,
    );
  }

  return resolvedPath;
}

export async function assertBuiltDesktopOutput(files = builtAppFiles) {
  try {
    await Promise.all(files.map((filePath) => access(filePath)));
  } catch (error) {
    throw new Error(
      `Built desktop output is missing; run the existing desktop build before seeding (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export function buildSeedLaunchEnvironment(
  userDataDirectory,
  baseEnvironment = process.env,
) {
  const environment = {
    ...baseEnvironment,
    // Keep the seed offline and deterministic even when the shell has local
    // model, renderer, browser, or tester overrides configured.
    ELECTRON_RENDERER_URL: "",
    NESTOR_BROWSER_AGENT: "0",
    NESTOR_ENABLE_TEST_API: "1",
    NESTOR_INTERVIEW_ADVANCED_SURFACES: "0",
    NESTOR_TEST_API_USE_LIVE_AI: "0",
    NESTOR_TEST_BROWSER_SESSION_STATUS: "ready",
    NESTOR_TEST_RESUME_PREVIEW: "ok",
    NESTOR_TEST_SYSTEM_THEME: "dark",
    NESTOR_USER_DATA_DIR: userDataDirectory,
  };

  delete environment.NESTOR_CHROME_DEBUG_PORT;
  delete environment.NESTOR_CHROME_PATH;
  delete environment.NESTOR_TEST_AUTHORIZE_INTERMEDIATE_ATS_WRITES;
  return environment;
}

export function buildRelaunchLaunchContract(userDataDirectory) {
  return {
    command: ["pnpm", "exec", "electron", ...jobFinderDemoLaunchArgs],
    cwd: desktopDirectory,
    env: {
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_BROWSER_AGENT: "0",
      NESTOR_ENABLE_TEST_API: "0",
      ELECTRON_RENDERER_URL: "",
    },
  };
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function summarizeDemoSnapshot(snapshot) {
  const profileName = snapshot?.profile?.fullName;
  const discoveryJobs = arrayLength(snapshot?.discoveryJobs);
  const shortlistJobs = arrayLength(snapshot?.reviewQueue);
  const applyQueueJobs = Array.isArray(snapshot?.reviewQueue)
    ? snapshot.reviewQueue.filter((item) => item?.assetStatus === "ready")
        .length
    : 0;

  if (typeof profileName !== "string" || !profileName.trim()) {
    throw new Error("Demo seed returned no profile name.");
  }
  if (discoveryJobs < 1) {
    throw new Error("Demo seed returned no catalog jobs.");
  }
  if (shortlistJobs < 1) {
    throw new Error("Demo seed returned no shortlisted jobs.");
  }
  if (applyQueueJobs < 1) {
    throw new Error("Demo seed returned no application-ready queue jobs.");
  }

  return {
    profile: { fullName: profileName.trim() },
    counts: { catalogJobs: discoveryJobs, shortlistJobs, applyQueueJobs },
  };
}

export async function loadApplyQueueDemoSnapshot(page) {
  await page.waitForFunction(
    () =>
      typeof globalThis.nestor?.jobFinder?.test?.loadApplyQueueDemo ===
      "function",
    undefined,
    { timeout: 20_000 },
  );

  return page.evaluate(async () => {
    const loader = globalThis.nestor?.jobFinder?.test?.loadApplyQueueDemo;
    if (typeof loader !== "function") {
      throw new Error("Desktop test API is unavailable in the renderer.");
    }
    return loader();
  });
}

export async function seedJobFinderDemoWorkspace(requestedUserDataDirectory) {
  const userDataDirectory = await validateUserDataDirectory(
    requestedUserDataDirectory,
  );
  await assertBuiltDesktopOutput();

  let app = null;
  try {
    app = await electron.launch({
      args: [...jobFinderDemoLaunchArgs],
      cwd: desktopDirectory,
      env: buildSeedLaunchEnvironment(userDataDirectory),
    });

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const summary = summarizeDemoSnapshot(
      await loadApplyQueueDemoSnapshot(page),
    );

    return {
      kind: "job-finder-demo-workspace",
      workspaceDir: userDataDirectory,
      launch: buildRelaunchLaunchContract(userDataDirectory),
      ...summary,
    };
  } finally {
    if (app) {
      await app.close().catch(() => undefined);
    }
  }
}

async function main() {
  const { requestedUserDataDirectory } = parseSeedArguments();
  const result = await seedJobFinderDemoWorkspace(requestedUserDataDirectory);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedScriptPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;
const currentScriptPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedScriptPath === currentScriptPath) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
