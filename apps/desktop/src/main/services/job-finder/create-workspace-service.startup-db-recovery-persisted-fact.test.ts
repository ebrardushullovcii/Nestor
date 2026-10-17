import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

// Each scenario needs pristine module state because the startup recovery
// disclosure hydrates at most once per module instance.
async function loadServiceModule(): Promise<{
  getJobFinderStartupDatabaseRecoveryFact: () => Promise<unknown>;
}> {
  vi.resetModules();
  return import("./create-workspace-service");
}

const temporaryDirectories: string[] = [];
const originalUserDataDirectory = process.env.NESTOR_USER_DATA_DIR;

afterEach(async () => {
  if (originalUserDataDirectory === undefined) {
    delete process.env.NESTOR_USER_DATA_DIR;
  } else {
    process.env.NESTOR_USER_DATA_DIR = originalUserDataDirectory;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createUserDataDirectory(): Promise<string> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "nestor-db-recovery-persisted-fact-"),
  );
  temporaryDirectories.push(temporaryRoot);
  const userDataDirectory = path.join(temporaryRoot, "user-data");
  await mkdir(userDataDirectory, { recursive: true });
  process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
  return userDataDirectory;
}

function factFilePath(userDataDirectory: string): string {
  return path.join(userDataDirectory, "job-finder-startup-db-recovery.json");
}

const legacyRestoredFact = {
  status: "restored",
  incidentId: "incident-1",
  restoredFrom: "backup-prev",
  lossWindow: {
    detectedAtIso: "2026-08-20T10:00:00.000Z",
    quarantinedDatabaseModifiedAtIso: null,
    restoredSnapshotModifiedAtIso: "2026-08-19T10:00:00.000Z",
  },
  quarantinedArtifactBasenames: ["job-finder-workspace.sqlite.quarantine-a"],
  restoredAtIso: "2026-08-20T10:05:00.000Z",
  dismissedAtIso: null,
};

describe("persisted startup database recovery fact compatibility", () => {
  test(
    "surfaces a previously stored restored fact through the shared contract schema",
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await createUserDataDirectory();
      await writeFile(
        factFilePath(userDataDirectory),
        `${JSON.stringify({ version: 1, fact: legacyRestoredFact })}\n`,
        "utf8",
      );

      const { getJobFinderStartupDatabaseRecoveryFact } =
        await loadServiceModule();

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual(
        legacyRestoredFact,
      );
    },
  );

  test(
    "normalizes a stored candidate that omitted failedStage instead of discarding the incident",
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await createUserDataDirectory();
      await writeFile(
        factFilePath(userDataDirectory),
        JSON.stringify({
          version: 1,
          fact: {
            status: "blocked",
            incidentId: "incident-2",
            outcome: "no-valid-candidate",
            candidates: [{ kind: "backup", status: "missing" }],
            quarantineBasenames: [],
          },
        }),
        "utf8",
      );

      const { getJobFinderStartupDatabaseRecoveryFact } =
        await loadServiceModule();

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual({
        status: "blocked",
        incidentId: "incident-2",
        outcome: "no-valid-candidate",
        candidates: [{ kind: "backup", status: "missing", failedStage: null }],
        quarantineBasenames: [],
      });
    },
  );

  test(
    "stays idle when the disclosure file is not valid JSON",
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await createUserDataDirectory();
      await writeFile(
        factFilePath(userDataDirectory),
        "{ not json at all",
        "utf8",
      );

      const { getJobFinderStartupDatabaseRecoveryFact } =
        await loadServiceModule();

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual({
        status: "idle",
      });
    },
  );

  test(
    "stays idle when the embedded fact violates the contract schema",
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await createUserDataDirectory();
      await writeFile(
        factFilePath(userDataDirectory),
        JSON.stringify({
          version: 1,
          fact: { ...legacyRestoredFact, restoredFrom: "nowhere" },
        }),
        "utf8",
      );

      const { getJobFinderStartupDatabaseRecoveryFact } =
        await loadServiceModule();

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual({
        status: "idle",
      });
    },
  );

  test(
    "stays idle when the disclosure envelope version is unknown",
    { timeout: 30_000 },
    async () => {
      const userDataDirectory = await createUserDataDirectory();
      await writeFile(
        factFilePath(userDataDirectory),
        JSON.stringify({ version: 99, fact: legacyRestoredFact }),
        "utf8",
      );

      const { getJobFinderStartupDatabaseRecoveryFact } =
        await loadServiceModule();

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual({
        status: "idle",
      });
    },
  );
});
