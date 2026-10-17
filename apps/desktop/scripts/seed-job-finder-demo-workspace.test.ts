import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRelaunchLaunchContract,
  buildSeedLaunchEnvironment,
  desktopDirectory,
  jobFinderDemoSafeRoot,
  jobFinderDemoUsage,
  parseSeedArguments,
  summarizeDemoSnapshot,
  validateUserDataDirectory,
} from "./seed-job-finder-demo-workspace.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Job Finder demo workspace seed arguments", () => {
  it("requires exactly one explicit user-data directory", () => {
    expect(jobFinderDemoUsage).toBe(
      "Usage: pnpm --filter @nestor/desktop seed:job-finder-demo -- --user-data-dir /tmp/job-finder-demo",
    );
    expect(() => parseSeedArguments([])).toThrow(
      "An explicit --user-data-dir is required",
    );
    expect(() =>
      parseSeedArguments(["--user-data-dir", "/tmp/one", "--extra"]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseSeedArguments([
        "--user-data-dir",
        "/tmp/one",
        "--user-data-dir=/tmp/two",
      ]),
    ).toThrow("may only be provided once");
    expect(
      parseSeedArguments([
        "--",
        "--user-data-dir",
        "/tmp/demo-from-package-script",
      ]),
    ).toEqual({
      requestedUserDataDirectory: "/tmp/demo-from-package-script",
    });
    expect(() =>
      parseSeedArguments(["--user-data-dir", "/tmp/one", "--"]),
    ).toThrow("Unknown argument");
    expect(parseSeedArguments(["--user-data-dir=/tmp/demo"])).toEqual({
      requestedUserDataDirectory: "/tmp/demo",
    });
  });

  it("accepts a missing or empty child of /tmp and refuses unsafe targets", async () => {
    // The validator resolves before it compares, and on Windows resolving
    // "/tmp" prefixes the current drive. Resolving the same way here keeps the
    // test comparing paths rather than platform spellings.
    const safeRoot = path.resolve(jobFinderDemoSafeRoot);
    const root = await mkdtemp(
      path.join(safeRoot, "job-finder-demo-seed-test-"),
    );
    temporaryDirectories.push(root);

    const missing = path.join(root, "new-workspace");
    expect(await validateUserDataDirectory(missing)).toBe(missing);

    const empty = path.join(root, "empty-workspace");
    await mkdir(empty);
    expect(await validateUserDataDirectory(empty)).toBe(empty);

    const nonEmpty = path.join(root, "non-empty-workspace");
    await mkdir(nonEmpty);
    await writeFile(
      path.join(nonEmpty, "marker"),
      "owned by this test",
      "utf8",
    );
    await expect(validateUserDataDirectory(nonEmpty)).rejects.toThrow(
      "non-empty",
    );

    const link = path.join(root, "linked-workspace");
    await symlink(empty, link);
    await expect(validateUserDataDirectory(link)).rejects.toThrow("symlink");
    await expect(
      validateUserDataDirectory("relative-workspace"),
    ).rejects.toThrow("relative");
    await expect(
      validateUserDataDirectory(jobFinderDemoSafeRoot),
    ).rejects.toThrow(`child of ${safeRoot}`);
  });
});

describe("Job Finder demo workspace seed semantics", () => {
  it("reports the profile and application-ready queue counts", () => {
    expect(
      summarizeDemoSnapshot({
        profile: { fullName: " Alex Vanguard " },
        discoveryJobs: [{ id: "job-1" }, { id: "job-2" }],
        reviewQueue: [{ assetStatus: "ready" }, { assetStatus: "not_started" }],
      }),
    ).toEqual({
      profile: { fullName: "Alex Vanguard" },
      counts: { catalogJobs: 2, shortlistJobs: 2, applyQueueJobs: 1 },
    });
  });

  it("pins the seed to deterministic, browser-agent-disabled runtime flags", () => {
    const environment = buildSeedLaunchEnvironment("/tmp/demo-workspace", {
      PATH: "/usr/bin",
      NESTOR_BROWSER_AGENT: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "1",
      NESTOR_CHROME_DEBUG_PORT: "9222",
    });

    expect(environment).toMatchObject({
      ELECTRON_RENDERER_URL: "",
      NESTOR_BROWSER_AGENT: "0",
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "0",
      NESTOR_USER_DATA_DIR: "/tmp/demo-workspace",
    });
    expect(environment.NESTOR_CHROME_DEBUG_PORT).toBeUndefined();
  });

  it("emits a copy-paste-safe relaunch contract with the test API disabled", () => {
    const contract = buildRelaunchLaunchContract("/tmp/demo-workspace");

    expect(contract).toEqual({
      command: ["pnpm", "exec", "electron", "out/main/index.cjs"],
      cwd: desktopDirectory,
      env: {
        NESTOR_USER_DATA_DIR: "/tmp/demo-workspace",
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "0",
        ELECTRON_RENDERER_URL: "",
      },
    });
  });
});
