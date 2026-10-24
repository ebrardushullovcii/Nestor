import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceDatabaseRecoveryRequiredError } from "@nestor/db";
import {
  createJobFinderWorkspaceServiceAsync,
  dismissJobFinderStartupDatabaseRecoveryNotice,
  getJobFinderStartupDatabaseRecoveryFact,
} from "./create-workspace-service";

const temporaryDirectories: string[] = [];
const originalEnv: Record<string, string | undefined> = {
  NESTOR_USER_DATA_DIR: process.env.NESTOR_USER_DATA_DIR,
  NESTOR_ENABLE_TEST_API: process.env.NESTOR_ENABLE_TEST_API,
  NESTOR_BROWSER_AGENT: process.env.NESTOR_BROWSER_AGENT,
};

afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createUserDataDirectory(): Promise<string> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "nestor-db-recovery-disclosure-"),
  );
  temporaryDirectories.push(temporaryRoot);
  return path.join(temporaryRoot, "user-data");
}

function workspaceFilePath(userDataDirectory: string): string {
  return path.join(userDataDirectory, "job-finder-workspace.sqlite");
}

function factFilePath(userDataDirectory: string): string {
  return path.join(userDataDirectory, "job-finder-startup-db-recovery.json");
}

async function seedRecoveryPoint(userDataDirectory: string) {
  // The service is closed, so the checkpointed database is a complete snapshot.
  // ADR 0072 deliberately allows a short session to quit before its first backup.
  await copyFile(
    workspaceFilePath(userDataDirectory),
    `${workspaceFilePath(userDataDirectory)}.backup`,
  );
}

async function createWorkspaceService(userDataDirectory: string) {
  process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
  process.env.NESTOR_ENABLE_TEST_API = "1";
  process.env.NESTOR_BROWSER_AGENT = "0";
  return createJobFinderWorkspaceServiceAsync({
    NESTOR_USER_DATA_DIR: userDataDirectory,
    NESTOR_ENABLE_TEST_API: "1",
    NESTOR_BROWSER_AGENT: "0",
  });
}

async function waitForPersistedFact(
  filePath: string,
  predicate: (fact: unknown) => boolean,
): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  let lastContent = "";
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(lastContent);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { version?: unknown }).version === 1 &&
        predicate((parsed as { fact?: unknown }).fact)
      ) {
        return parsed;
      }
    } catch {
      // The atomic write may not have landed yet; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected persisted fact never matched: ${lastContent}`);
}

describe("startup database recovery disclosure", () => {
  test("ignores a malformed persisted disclosure file instead of surfacing it", async () => {
    const userDataDirectory = await createUserDataDirectory();
    await mkdir(userDataDirectory, { recursive: true });
    await writeFile(
      factFilePath(userDataDirectory),
      "{ not json at all",
      "utf8",
    );

    expect(await getJobFinderStartupDatabaseRecoveryFact()).toEqual({
      status: "idle",
    });
  });

  test(
    "persists a restored incident durably, honors dismissal for it, and reveals a new incident",
    { timeout: 60_000 },
    async () => {
      const firstUserDataDirectory = await createUserDataDirectory();
      const firstService = await createWorkspaceService(firstUserDataDirectory);
      await firstService.shutdown();
      await seedRecoveryPoint(firstUserDataDirectory);
      expect(
        existsSync(`${workspaceFilePath(firstUserDataDirectory)}.backup`),
      ).toBe(true);

      await writeFile(
        workspaceFilePath(firstUserDataDirectory),
        Buffer.from("deliberately corrupt main database", "utf8"),
      );

      const secondService = await createWorkspaceService(
        firstUserDataDirectory,
      );
      let firstIncidentId = "";
      let firstDismissedAtIso = "";
      try {
        const restoredFact = await getJobFinderStartupDatabaseRecoveryFact();
        expect(restoredFact.status).toBe("restored");
        if (restoredFact.status !== "restored") {
          throw new Error("unreachable");
        }
        firstIncidentId = restoredFact.incidentId;
        expect(firstIncidentId).toMatch(/[0-9a-f-]{16,}/);
        expect(restoredFact.restoredFrom).toBe("backup");
        expect(restoredFact.dismissedAtIso).toBeNull();
        expect(typeof restoredFact.restoredAtIso).toBe("string");
        expect(Array.isArray(restoredFact.quarantinedArtifactBasenames)).toBe(
          true,
        );

        const persistedPayload = (await waitForPersistedFact(
          factFilePath(firstUserDataDirectory),
          (fact) =>
            typeof fact === "object" &&
            fact !== null &&
            (fact as { incidentId?: unknown }).incidentId === firstIncidentId,
        )) as { fact: { incidentId: string } };
        expect(persistedPayload.fact.incidentId).toBe(firstIncidentId);
        expect(JSON.stringify(persistedPayload)).not.toContain(
          firstUserDataDirectory,
        );

        const dismissedFact =
          await dismissJobFinderStartupDatabaseRecoveryNotice();
        expect(dismissedFact.status).toBe("restored");
        if (dismissedFact.status !== "restored") {
          throw new Error("unreachable");
        }
        expect(dismissedFact.incidentId).toBe(firstIncidentId);
        expect(dismissedFact.dismissedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        if (dismissedFact.dismissedAtIso === null) {
          throw new Error("unreachable");
        }
        firstDismissedAtIso = dismissedFact.dismissedAtIso;

        const dismissedOnDisk = (await waitForPersistedFact(
          factFilePath(firstUserDataDirectory),
          (fact) =>
            typeof fact === "object" &&
            fact !== null &&
            (fact as { dismissedAtIso?: unknown }).dismissedAtIso ===
              firstDismissedAtIso,
        )) as { fact: { dismissedAtIso: string } };
        expect(dismissedOnDisk.fact.dismissedAtIso).toBe(firstDismissedAtIso);

        expect(await getJobFinderStartupDatabaseRecoveryFact()).toMatchObject({
          status: "restored",
          incidentId: firstIncidentId,
          dismissedAtIso: firstDismissedAtIso,
        });
      } finally {
        await secondService.shutdown().catch(() => undefined);
      }

      // A healthy boot elsewhere leaves the prior dismissed disclosure alone:
      // normal startup neither invents nor clears restore notices.
      const secondUserDataDirectory = await createUserDataDirectory();
      const thirdService = await createWorkspaceService(
        secondUserDataDirectory,
      );
      await thirdService.shutdown();
      await seedRecoveryPoint(secondUserDataDirectory);

      expect(await getJobFinderStartupDatabaseRecoveryFact()).toMatchObject({
        status: "restored",
        incidentId: firstIncidentId,
        dismissedAtIso: firstDismissedAtIso,
      });

      await writeFile(
        workspaceFilePath(secondUserDataDirectory),
        Buffer.from("deliberately corrupt main database again", "utf8"),
      );

      const fourthService = await createWorkspaceService(
        secondUserDataDirectory,
      );
      try {
        const nextFact = await getJobFinderStartupDatabaseRecoveryFact();
        expect(nextFact.status).toBe("restored");
        if (nextFact.status !== "restored") {
          throw new Error("unreachable");
        }
        expect(nextFact.incidentId).not.toBe(firstIncidentId);
        expect(nextFact.dismissedAtIso).toBeNull();

        await waitForPersistedFact(
          factFilePath(secondUserDataDirectory),
          (fact) =>
            typeof fact === "object" &&
            fact !== null &&
            (fact as { incidentId?: unknown }).incidentId ===
              nextFact.incidentId &&
            (fact as { dismissedAtIso?: unknown }).dismissedAtIso === null,
        );
      } finally {
        await fourthService.shutdown().catch(() => undefined);
      }
    },
  );

  test("retains a typed blocked incident when automatic recovery needs manual salvage", async () => {
    const userDataDirectory = await createUserDataDirectory();
    const firstService = await createWorkspaceService(userDataDirectory);
    await firstService.shutdown();
    await seedRecoveryPoint(userDataDirectory);

    await rm(workspaceFilePath(userDataDirectory), { force: true });

    let failure: unknown = null;
    try {
      const unexpectedService = await createWorkspaceService(userDataDirectory);
      await unexpectedService.shutdown();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    const details = (failure as WorkspaceDatabaseRecoveryRequiredError).details;
    expect(details.outcome).toBe("salvage-required");
    expect(existsSync(workspaceFilePath(userDataDirectory))).toBe(false);

    const blockedFact = await getJobFinderStartupDatabaseRecoveryFact();
    expect(blockedFact.status).toBe("blocked");
    if (blockedFact.status !== "blocked") {
      throw new Error("unreachable");
    }
    expect(blockedFact.incidentId).toBe(details.incidentId);
    expect(blockedFact.outcome).toBe("salvage-required");
    expect(
      blockedFact.candidates.every(
        (candidate) =>
          candidate.kind === "backup" || candidate.kind === "backup-prev",
      ),
    ).toBe(true);
    expect(existsSync(factFilePath(userDataDirectory))).toBe(false);
  });
});
