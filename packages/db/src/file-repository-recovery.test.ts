import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";

import { createFileJobFinderRepository } from "./index";
import {
  classifyWorkspaceDatabaseFailure,
  listWorkspaceQuarantineArtifacts,
  listWorkspaceRecoveryCandidates,
  recoverWorkspaceDatabase,
  type RestoredSnapshotRevalidator,
  type WorkspaceRecoveryEnvironment,
  type WorkspaceRecoveryValidationOverrides,
} from "./file-repository-recovery";
import {
  createWorkspaceDatabaseBackup,
  getWorkspaceDatabaseBackupPaths,
} from "./file-repository-backup";
import { openDatabaseFile, runMigrations } from "./internal/migrations";
import { hasPersistedState, listValues } from "./internal/state";
import { createSeed } from "./test-fixtures";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
} from "./file-repository.test-support";

// Windows pays for every one of these tests twice: VACUUM INTO snapshots and
// rotation renames are slower there, and removing a temporary directory has to
// retry until the OS releases the last handle. Under a parallel run that
// outgrows vitest's 5s default and the suite fails on the clock rather than on
// behaviour. POSIX keeps the default, so a real hang still fails fast there.
if (process.platform === "win32") {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
}

const DETECTED_AT = new Date("2026-08-23T09:30:00.000Z");
const DETECTED_AT_ISO = "2026-08-23T09:30:00.000Z";
const INCIDENT_STAMP = "2026-08-23T09-30-00-000Z";
const DATABASE_FILE_NAME = "job-finder-state.sqlite";
const NOT_DATABASE_CONTENT = Buffer.from(
  "deliberately not a sqlite database",
  "utf8",
);

interface RecoveryFixture {
  tempDirectory: string;
  filePath: string;
  backupPath: string;
  backupPreviousPath: string;
  resetBackupPath: string;
}

function createDeterministicEnvironment(): WorkspaceRecoveryEnvironment {
  let nextId = 0;
  return {
    now: () => DETECTED_AT,
    createIncidentId: () => {
      nextId += 1;
      return `incident-${String(nextId).padStart(3, "0")}`;
    },
  };
}

async function createRecoveryFixture(): Promise<RecoveryFixture> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-db-recovery-"),
  );
  const filePath = path.join(tempDirectory, DATABASE_FILE_NAME);
  const backupPaths = getWorkspaceDatabaseBackupPaths(filePath);
  return {
    tempDirectory,
    filePath,
    backupPath: backupPaths.closeBackupPath,
    backupPreviousPath: backupPaths.closeBackupPreviousPath,
    resetBackupPath: backupPaths.resetBackupPath,
  };
}

async function appendSnapshotGeneration(
  fixture: RecoveryFixture,
  savedJobIds: string[],
): Promise<void> {
  const repository = await createFileJobFinderRepository({
    filePath: fixture.filePath,
    seed: createSeed(),
  });
  if (savedJobIds.length > 0) {
    await repository.commitSavedJobDelta({
      upserts: savedJobIds.map((id) =>
        createSavedJob({ id, sourceJobId: `target_${id}` }),
      ),
    });
  }
  await createWorkspaceDatabaseBackup({ filePath: fixture.filePath });
  await repository.close();
}

async function normalizeWorkspaceSidecars(
  fixture: RecoveryFixture,
): Promise<void> {
  await rm(`${fixture.filePath}-wal`, { force: true });
  await rm(`${fixture.filePath}-shm`, { force: true });
}

async function corruptWithNotDatabaseContent(
  targetPath: string,
): Promise<void> {
  await writeFile(targetPath, NOT_DATABASE_CONTENT);
}

function captureOpenError(databasePath: string): unknown {
  // Opened through the repository's own helper so the failed open releases
  // its handle: on Windows a leaked handle keeps the suspect file locked and
  // the recovery under test can no longer rename it aside.
  try {
    const database = openDatabaseFile(databasePath);
    try {
      database.exec("PRAGMA schema_version");
    } finally {
      database.close();
    }
  } catch (error) {
    return error;
  }
  return new Error("Simulated workspace migration failure");
}

function sortedDirectoryListing(tempDirectory: string): string[] {
  return readdirSync(tempDirectory).sort();
}

async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function posixModeOf(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

function readSavedJobIds(databasePath: string): string[] {
  const database = new DatabaseSync(databasePath);
  try {
    runMigrations(database);
    return listValues(database, "saved_jobs", SavedJobSchema).map(
      (job) => job.id,
    );
  } finally {
    database.close();
  }
}

function quarantineBasenameFor(fileName: string, incidentId: string): string {
  return `${fileName}.quarantine-${INCIDENT_STAMP}-${incidentId}`;
}

function runFullIntegrityCheck(database: DatabaseSync): boolean {
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check?: unknown;
  }>;
  return rows.length > 0 && rows.every((row) => row.integrity_check === "ok");
}

/**
 * Reference implementation of the RestoredSnapshotRevalidator contract:
 * isolated open, migrations, full PRAGMA integrity_check, persisted state.
 */
function createStrictSnapshotRevalidator(): RestoredSnapshotRevalidator {
  return ({ restoredTempPath }) => {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(restoredTempPath);
    } catch {
      return false;
    }
    try {
      runMigrations(database);
      if (!runFullIntegrityCheck(database)) {
        return false;
      }
      return hasPersistedState(database);
    } catch {
      return false;
    } finally {
      database.close();
    }
  };
}

describe("workspace database corruption recovery core", () => {
  let fixture: RecoveryFixture;

  afterEach(async () => {
    await cleanupTempDirectoryWithRetry(fixture.tempDirectory);
  });

  test("restores the newest validated close backup when the main database is not a database", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    await writeFile(`${fixture.filePath}-wal`, Buffer.from("stale-wal"));
    await writeFile(`${fixture.filePath}-shm`, Buffer.from("stale-shm"));

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result.outcome).toBe("restored");
    if (result.outcome !== "restored") return;
    expect(result.incidentId).toBe("incident-001");
    expect(result.classification).toEqual({
      status: "corrupt",
      evidence: "reported-error-code",
      sqliteErrorCode: "SQLITE_NOTADB",
    });
    expect(result.candidates).toEqual([
      { kind: "backup", status: "valid" },
      { kind: "backup-prev", status: "valid" },
    ]);
    expect(result.restoredFrom).toBe("backup");
    expect(readSavedJobIds(fixture.filePath)).toEqual(["job_1", "job_2"]);
    expect(result.quarantinedArtifacts).toEqual([
      quarantineBasenameFor(DATABASE_FILE_NAME, "incident-001"),
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-wal`, "incident-001"),
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-shm`, "incident-001"),
    ]);
    for (const artifactName of result.quarantinedArtifacts) {
      expect(existsSync(path.join(fixture.tempDirectory, artifactName))).toBe(
        true,
      );
    }
    expect(existsSync(`${fixture.filePath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.filePath}-shm`)).toBe(false);
    expect(result.lossWindow.detectedAtIso).toBe(DETECTED_AT_ISO);
    expect(
      Number.isNaN(
        new Date(
          result.lossWindow.quarantinedDatabaseModifiedAtIso ?? "",
        ).getTime(),
      ),
    ).toBe(false);
    expect(
      Number.isNaN(
        new Date(
          result.lossWindow.restoredSnapshotModifiedAtIso ?? "",
        ).getTime(),
      ),
    ).toBe(false);
  });

  test("falls back to the previous close backup when the newest candidate is invalid", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.backupPath);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result.outcome).toBe("restored");
    if (result.outcome !== "restored") return;
    expect(result.candidates).toEqual([
      {
        kind: "backup",
        status: "invalid",
        failedStage: "migrate",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
      { kind: "backup-prev", status: "valid" },
    ]);
    expect(result.restoredFrom).toBe("backup-prev");
    expect(readSavedJobIds(fixture.filePath)).toEqual(["job_1"]);
  });

  test("returns no restore and preserves every file when no candidate validates", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    await corruptWithNotDatabaseContent(fixture.backupPath);
    await corruptWithNotDatabaseContent(fixture.backupPreviousPath);
    const digestsBefore = await Promise.all([
      sha256OfFile(fixture.filePath),
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    const listingBefore = sortedDirectoryListing(fixture.tempDirectory);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError: new Error("Simulated workspace migration failure"),
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result).toMatchObject({
      outcome: "not-attempted",
      incidentId: "incident-001",
      reason: "no-valid-candidate",
      restoredFrom: null,
      quarantinedArtifacts: [],
      classification: {
        status: "corrupt",
        evidence: "failed-integrity-check",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
    });
    expect(result.candidates).toEqual([
      {
        kind: "backup",
        status: "invalid",
        failedStage: "migrate",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
      {
        kind: "backup-prev",
        status: "invalid",
        failedStage: "migrate",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
    ]);
    const digestsAfter = await Promise.all([
      sha256OfFile(fixture.filePath),
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    expect(digestsAfter).toEqual(digestsBefore);
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBefore,
    );
  });

  test("reports not-corruption without mutating files on a clean integrity check", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    const digestsBefore = await Promise.all([
      sha256OfFile(fixture.filePath),
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    const listingBefore = sortedDirectoryListing(fixture.tempDirectory);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError: new Error("Migration exploded for programming reasons"),
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result).toMatchObject({
      outcome: "not-attempted",
      reason: "source-not-corrupt",
      restoredFrom: null,
      quarantinedArtifacts: [],
      classification: {
        status: "not-corruption",
        evidence: "clean-integrity-check",
        sqliteErrorCode: null,
      },
    });
    expect(result.candidates).toEqual([]);
    const digestsAfter = await Promise.all([
      sha256OfFile(fixture.filePath),
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    expect(digestsAfter).toEqual(digestsBefore);
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBefore,
    );
  });

  test("never selects or touches the reset backup", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await copyFile(fixture.backupPath, fixture.resetBackupPath);
    await corruptWithNotDatabaseContent(fixture.filePath);
    await corruptWithNotDatabaseContent(fixture.backupPath);
    await corruptWithNotDatabaseContent(fixture.backupPreviousPath);
    const resetDigestBefore = await sha256OfFile(fixture.resetBackupPath);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError: new Error("Simulated workspace migration failure"),
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result.outcome).toBe("not-attempted");
    if (result.outcome !== "not-attempted") return;
    expect(result.reason).toBe("no-valid-candidate");
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      "backup",
      "backup-prev",
    ]);
    expect(await sha256OfFile(fixture.resetBackupPath)).toBe(resetDigestBefore);
    expect(existsSync(fixture.resetBackupPath)).toBe(true);
  });

  test("quarantines wal and shm sidecars byte-for-byte alongside the main database", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    // Sidecars are staged after the failed open because opening a workspace
    // can itself initialize -shm; recovery never opens the suspect main file.
    const walJunk = Buffer.from("stale-wal-bytes");
    const shmJunk = Buffer.from("stale-shm-bytes");
    await writeFile(`${fixture.filePath}-wal`, walJunk);
    await writeFile(`${fixture.filePath}-shm`, shmJunk);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });

    expect(result.outcome).toBe("restored");
    const quarantinedWalPath = path.join(
      fixture.tempDirectory,
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-wal`, "incident-001"),
    );
    const quarantinedShmPath = path.join(
      fixture.tempDirectory,
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-shm`, "incident-001"),
    );
    expect(await readFile(quarantinedWalPath)).toEqual(walJunk);
    expect(await readFile(quarantinedShmPath)).toEqual(shmJunk);
    expect(existsSync(`${fixture.filePath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.filePath}-shm`)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "quarantined and restored files carry 0600 permissions",
    async () => {
      fixture = await createRecoveryFixture();
      await appendSnapshotGeneration(fixture, ["job_1"]);
      await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
      await normalizeWorkspaceSidecars(fixture);
      await corruptWithNotDatabaseContent(fixture.filePath);
      const openError = captureOpenError(fixture.filePath);
      await writeFile(`${fixture.filePath}-wal`, Buffer.from("stale-wal"));

      const result = await recoverWorkspaceDatabase({
        filePath: fixture.filePath,
        openError,
        environment: createDeterministicEnvironment(),
        revalidateRestoredSnapshot: () => true,
      });

      expect(result.outcome).toBe("restored");
      expect(await posixModeOf(fixture.filePath)).toBe(0o600);
      for (const artifactName of result.quarantinedArtifacts) {
        expect(
          await posixModeOf(path.join(fixture.tempDirectory, artifactName)),
        ).toBe(0o600);
      }
      expect(await posixModeOf(fixture.backupPath)).toBe(0o600);
      expect(await posixModeOf(fixture.backupPreviousPath)).toBe(0o600);
    },
  );

  test("a strict revalidator satisfying the documented contract promotes an intact snapshot", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: createStrictSnapshotRevalidator(),
    });

    expect(result.outcome).toBe("restored");
    if (result.outcome !== "restored") return;
    expect(result.restoredFrom).toBe("backup");
    expect(readSavedJobIds(fixture.filePath)).toEqual(["job_1", "job_2"]);
  });

  test("rejects promotion when the selected snapshot changes between candidate validation and the restore copy", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    // Sidecars are staged after the failed open so quarantine covers them.
    await writeFile(`${fixture.filePath}-wal`, Buffer.from("stale-wal"));
    await writeFile(`${fixture.filePath}-shm`, Buffer.from("stale-shm"));
    const previousDigestBefore = await sha256OfFile(fixture.backupPreviousPath);
    let evaluatedCandidateCount = 0;

    const result = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: createStrictSnapshotRevalidator(),
      validation: {
        hasPersistedState: () => {
          evaluatedCandidateCount += 1;
          if (evaluatedCandidateCount === 1) {
            // The newest candidate already validated on its isolated probe
            // copy; simulate its source changing on disk before the restore
            // copy reads it.
            writeFileSync(
              fixture.backupPath,
              Buffer.from("rotated-after-validation"),
            );
          }
          return true;
        },
      },
    });

    expect(evaluatedCandidateCount).toBe(2);
    expect(result).toMatchObject({
      outcome: "restore-failed",
      incidentId: "incident-001",
      reason: "restore-revalidation-rejected",
      restoredFrom: null,
      candidates: [
        { kind: "backup", status: "valid" },
        { kind: "backup-prev", status: "valid" },
      ],
    });
    expect(existsSync(fixture.filePath)).toBe(false);
    expect(existsSync(`${fixture.filePath}.restore-incident-001.tmp`)).toBe(
      false,
    );
    for (const artifactName of [
      quarantineBasenameFor(DATABASE_FILE_NAME, "incident-001"),
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-wal`, "incident-001"),
      quarantineBasenameFor(`${DATABASE_FILE_NAME}-shm`, "incident-001"),
    ]) {
      expect(existsSync(path.join(fixture.tempDirectory, artifactName))).toBe(
        true,
      );
    }
    expect(await sha256OfFile(fixture.backupPreviousPath)).toBe(
      previousDigestBefore,
    );
  });

  test("classification stages source sidecars onto the probe and treats WAL-resident corruption as corrupt", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    await writeFile(`${fixture.filePath}-wal`, Buffer.from("live-wal"));
    await writeFile(`${fixture.filePath}-shm`, Buffer.from("live-shm"));
    const observedProbeBasenames: string[] = [];
    const observedProbeSidecarsPresent: boolean[] = [];

    // Residual limit: SQLite validates cumulative WAL frame checksums and
    // rolls damaged frames back to the last committed transaction, so WAL bit
    // rot usually replays cleanly instead of surfacing as corruption. A
    // deterministic healthy-main-plus-corrupting-WAL fixture is therefore not
    // portable; replay failure is injected at the probe-open seam while real
    // node:fs copies prove sidecar staging.
    const classification = await classifyWorkspaceDatabaseFailure({
      filePath: fixture.filePath,
      openError: new Error("disk I/O error during WAL replay"),
      environment: createDeterministicEnvironment(),
      io: {
        openDatabase: (databasePath) => {
          observedProbeBasenames.push(path.basename(databasePath));
          observedProbeSidecarsPresent.push(
            existsSync(`${databasePath}-wal`) &&
              existsSync(`${databasePath}-shm`),
          );
          throw Object.assign(new Error("database disk image is malformed"), {
            errcode: 11,
          });
        },
      },
    });

    expect(observedProbeBasenames).toEqual([
      `${DATABASE_FILE_NAME}.recovery-integrity-incident-001.tmp`,
    ]);
    expect(observedProbeSidecarsPresent).toEqual([true]);
    expect(classification).toEqual({
      status: "corrupt",
      evidence: "failed-integrity-check",
      sqliteErrorCode: "SQLITE_CORRUPT",
    });
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual([
      DATABASE_FILE_NAME,
      `${DATABASE_FILE_NAME}-shm`,
      `${DATABASE_FILE_NAME}-wal`,
      `${DATABASE_FILE_NAME}.backup`,
      // From the fixture's clean close; the leftover log makes the next open
      // ignore and remove it.
      `${DATABASE_FILE_NAME}.clean-close`,
    ]);
  });

  test("extended SQLite errcode values mask down to their primary codes", async () => {
    fixture = await createRecoveryFixture();
    const missingPath = path.join(fixture.tempDirectory, "absent.sqlite");

    const extendedCorrupt = await classifyWorkspaceDatabaseFailure({
      filePath: missingPath,
      openError: { errcode: 0x20b },
      environment: createDeterministicEnvironment(),
    });
    expect(extendedCorrupt.sqliteErrorCode).toBe("SQLITE_CORRUPT");

    const extendedNotADatabase = await classifyWorkspaceDatabaseFailure({
      filePath: missingPath,
      openError: { errcode: 0x100 | 26 },
      environment: createDeterministicEnvironment(),
    });
    expect(extendedNotADatabase.sqliteErrorCode).toBe("SQLITE_NOTADB");

    const extendedNonCorrupting = await classifyWorkspaceDatabaseFailure({
      filePath: missingPath,
      openError: { errcode: 0x108 },
      environment: createDeterministicEnvironment(),
    });
    expect(extendedNonCorrupting).toEqual({
      status: "inconclusive",
      evidence: "source-missing",
      sqliteErrorCode: null,
    });

    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    const staleCodeOnHealthySource = await classifyWorkspaceDatabaseFailure({
      filePath: fixture.filePath,
      openError: { errcode: 0x20b },
      environment: createDeterministicEnvironment(),
    });
    expect(staleCodeOnHealthySource).toEqual({
      status: "not-corruption",
      evidence: "clean-integrity-check",
      sqliteErrorCode: "SQLITE_CORRUPT",
    });
  });

  test.skipIf(process.platform === "win32")(
    "a failing chmod never aborts quarantine or promotion",
    async () => {
      fixture = await createRecoveryFixture();
      await appendSnapshotGeneration(fixture, ["job_1"]);
      await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
      await normalizeWorkspaceSidecars(fixture);
      await corruptWithNotDatabaseContent(fixture.filePath);
      const openError = captureOpenError(fixture.filePath);
      await writeFile(`${fixture.filePath}-wal`, Buffer.from("stale-wal"));
      const chmodTargets: string[] = [];

      const result = await recoverWorkspaceDatabase({
        filePath: fixture.filePath,
        openError,
        environment: createDeterministicEnvironment(),
        revalidateRestoredSnapshot: () => true,
        io: {
          chmod: (targetPath: string) => {
            chmodTargets.push(targetPath);
            return Promise.reject(new Error("injected chmod failure"));
          },
        },
      });

      expect(result.outcome).toBe("restored");
      if (result.outcome !== "restored") return;
      expect(readSavedJobIds(fixture.filePath)).toEqual(["job_1", "job_2"]);
      expect(chmodTargets.length).toBeGreaterThanOrEqual(3);
      expect(chmodTargets).toContain(fixture.filePath);
      expect(existsSync(`${fixture.filePath}-wal`)).toBe(false);
      for (const artifactName of result.quarantinedArtifacts) {
        expect(existsSync(path.join(fixture.tempDirectory, artifactName))).toBe(
          true,
        );
      }
    },
  );

  test("lists prior quarantine artifacts for caller salvage detection without touching them", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    await writeFile(`${fixture.filePath}-wal`, Buffer.from("stale-wal"));

    const restored = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
    });
    expect(restored.outcome).toBe("restored");

    const artifacts = listWorkspaceQuarantineArtifacts(fixture.filePath);
    expect(
      new Set(
        artifacts.map((artifact) => `${artifact.kind}:${artifact.basename}`),
      ),
    ).toEqual(
      new Set([
        `database:${quarantineBasenameFor(DATABASE_FILE_NAME, "incident-001")}`,
        `wal:${quarantineBasenameFor(`${DATABASE_FILE_NAME}-wal`, "incident-001")}`,
      ]),
    );
    for (const artifact of artifacts) {
      expect(artifact.path.startsWith(fixture.tempDirectory)).toBe(true);
      expect(existsSync(artifact.path)).toBe(true);
    }

    symlinkSync(
      fixture.backupPath,
      path.join(
        fixture.tempDirectory,
        quarantineBasenameFor(DATABASE_FILE_NAME, "incident-999"),
      ),
    );
    writeFileSync(
      path.join(
        fixture.tempDirectory,
        `${DATABASE_FILE_NAME}.quarantine-not-a-stamp`,
      ),
      "unexpected",
    );
    writeFileSync(
      path.join(
        fixture.tempDirectory,
        `${DATABASE_FILE_NAME}-shm.quarantine-${INCIDENT_STAMP}-incident-003-r1`,
      ),
      "collision-renamed",
    );

    const listingBeforeEnumeration = sortedDirectoryListing(
      fixture.tempDirectory,
    );
    const after = listWorkspaceQuarantineArtifacts(fixture.filePath);
    expect(after.map((artifact) => artifact.kind).sort()).toEqual(
      ["database", "shm", "wal"].sort(),
    );
    expect(after.some((artifact) => artifact.basename.endsWith("-r1"))).toBe(
      true,
    );
    expect(
      after.every((artifact) =>
        listingBeforeEnumeration.includes(artifact.basename),
      ),
    ).toBe(true);
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBeforeEnumeration,
    );
    expect(
      listWorkspaceQuarantineArtifacts(
        path.join(fixture.tempDirectory, "missing-dir", "x.sqlite"),
      ),
    ).toEqual([]);
  });

  test("keeps quarantine and candidates when revalidation rejects and a second call changes nothing", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    const environment = createDeterministicEnvironment();
    const revalidatedTempPaths: string[] = [];

    const firstResult = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment,
      revalidateRestoredSnapshot: ({ restoredTempPath }) => {
        revalidatedTempPaths.push(restoredTempPath);
        return Promise.resolve(false);
      },
    });

    expect(firstResult).toMatchObject({
      outcome: "restore-failed",
      incidentId: "incident-001",
      reason: "restore-revalidation-rejected",
      restoredFrom: null,
      quarantinedArtifacts: [
        quarantineBasenameFor(DATABASE_FILE_NAME, "incident-001"),
      ],
    });
    expect(
      revalidatedTempPaths.map((tempPath) => path.basename(tempPath)),
    ).toEqual([`${DATABASE_FILE_NAME}.restore-incident-001.tmp`]);
    expect(existsSync(fixture.filePath)).toBe(false);
    expect(
      existsSync(
        path.join(
          fixture.tempDirectory,
          quarantineBasenameFor(DATABASE_FILE_NAME, "incident-001"),
        ),
      ),
    ).toBe(true);
    const candidateDigestsBefore = await Promise.all([
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    const listingBeforeSecondCall = sortedDirectoryListing(
      fixture.tempDirectory,
    );

    const secondResult = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment,
      revalidateRestoredSnapshot: () => true,
    });

    expect(secondResult).toMatchObject({
      outcome: "not-attempted",
      incidentId: "incident-002",
      reason: "source-inconclusive",
      restoredFrom: null,
      quarantinedArtifacts: [],
      classification: {
        status: "inconclusive",
        evidence: "source-missing",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
    });
    expect(secondResult.candidates).toEqual([]);
    const candidateDigestsAfter = await Promise.all([
      sha256OfFile(fixture.backupPath),
      sha256OfFile(fixture.backupPreviousPath),
    ]);
    expect(candidateDigestsAfter).toEqual(candidateDigestsBefore);
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBeforeSecondCall,
    );
  });

  test("is inert when called again after a successful restore", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const openError = captureOpenError(fixture.filePath);
    const environment = createDeterministicEnvironment();

    const firstResult = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment,
      revalidateRestoredSnapshot: () => true,
    });
    expect(firstResult.outcome).toBe("restored");

    const listingBeforeSecondCall = sortedDirectoryListing(
      fixture.tempDirectory,
    );
    const secondResult = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError,
      environment,
      revalidateRestoredSnapshot: () => true,
    });

    expect(secondResult).toMatchObject({
      outcome: "not-attempted",
      incidentId: "incident-002",
      reason: "source-not-corrupt",
      restoredFrom: null,
      quarantinedArtifacts: [],
      classification: {
        status: "not-corruption",
        evidence: "clean-integrity-check",
        sqliteErrorCode: "SQLITE_NOTADB",
      },
    });
    expect(readSavedJobIds(fixture.filePath)).toEqual(["job_1", "job_2"]);
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBeforeSecondCall,
    );
  });

  test("injected validation callbacks decide candidate verdicts without mutating anything", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await appendSnapshotGeneration(fixture, ["job_1", "job_2"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const mainDigestBefore = await sha256OfFile(fixture.filePath);
    const failingMigrations: WorkspaceRecoveryValidationOverrides = {
      runMigrations: () => {
        throw new Error("Injected migration failure");
      },
    };

    const migrationFailure = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError: new Error("Simulated workspace migration failure"),
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
      validation: failingMigrations,
    });

    expect(migrationFailure).toMatchObject({
      outcome: "not-attempted",
      reason: "no-valid-candidate",
    });
    expect(migrationFailure.candidates).toEqual([
      {
        kind: "backup",
        status: "invalid",
        failedStage: "migrate",
        sqliteErrorCode: null,
      },
      {
        kind: "backup-prev",
        status: "invalid",
        failedStage: "migrate",
        sqliteErrorCode: null,
      },
    ]);

    const statelessOverride: WorkspaceRecoveryValidationOverrides = {
      hasPersistedState: () => false,
    };
    const statelessFailure = await recoverWorkspaceDatabase({
      filePath: fixture.filePath,
      openError: new Error("Simulated workspace migration failure"),
      environment: createDeterministicEnvironment(),
      revalidateRestoredSnapshot: () => true,
      validation: statelessOverride,
    });

    expect(statelessFailure).toMatchObject({
      outcome: "not-attempted",
      reason: "no-valid-candidate",
    });
    expect(statelessFailure.candidates).toEqual([
      {
        kind: "backup",
        status: "invalid",
        failedStage: "persisted-state",
        sqliteErrorCode: null,
      },
      {
        kind: "backup-prev",
        status: "invalid",
        failedStage: "persisted-state",
        sqliteErrorCode: null,
      },
    ]);
    expect(await sha256OfFile(fixture.filePath)).toBe(mainDigestBefore);
  });

  test("classification API reports corruption codes without mutating files", async () => {
    fixture = await createRecoveryFixture();
    await appendSnapshotGeneration(fixture, ["job_1"]);
    await normalizeWorkspaceSidecars(fixture);
    await corruptWithNotDatabaseContent(fixture.filePath);
    const listingBefore = sortedDirectoryListing(fixture.tempDirectory);

    const corruptClassification = await classifyWorkspaceDatabaseFailure({
      filePath: fixture.filePath,
      openError: captureOpenError(fixture.filePath),
      environment: createDeterministicEnvironment(),
    });
    expect(corruptClassification).toEqual({
      status: "corrupt",
      evidence: "reported-error-code",
      sqliteErrorCode: "SQLITE_NOTADB",
    });
    expect(sortedDirectoryListing(fixture.tempDirectory)).toEqual(
      listingBefore,
    );

    const cleanClassification = await classifyWorkspaceDatabaseFailure({
      filePath: fixture.backupPath,
      openError: new Error("Unrelated failure"),
      environment: createDeterministicEnvironment(),
    });
    expect(cleanClassification).toEqual({
      status: "not-corruption",
      evidence: "clean-integrity-check",
      sqliteErrorCode: null,
    });
    expect(listWorkspaceRecoveryCandidates(fixture.filePath)).toEqual([
      { kind: "backup", path: fixture.backupPath },
      { kind: "backup-prev", path: fixture.backupPreviousPath },
    ]);
  });
});
