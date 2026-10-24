import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createFileJobFinderRepository,
  WorkspaceDatabaseRecoveryRequiredError,
  type WorkspaceDatabaseRestoreTelemetryEvent,
  type WorkspaceRotationReconciliationEvent,
} from "./index";
import {
  createWorkspaceDatabaseBackup,
  getWorkspaceDatabaseBackupPaths,
} from "./file-repository-backup";
import { createSeed } from "./test-fixtures";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  type FileRepository,
} from "./file-repository.test-support";

// Windows pays for every one of these tests twice: VACUUM INTO snapshots and
// rotation renames are slower there, and removing a temporary directory has to
// retry until the OS releases the last handle. Under a parallel run that
// outgrows vitest's 5s default and the suite fails on the clock rather than on
// behaviour. POSIX keeps the default, so a real hang still fails fast there.
if (process.platform === "win32") {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
}

const NOT_DATABASE_CONTENT = Buffer.from(
  "deliberately not a sqlite database",
  "utf8",
);

interface StartupTelemetryRecorder {
  rotationEvents: WorkspaceRotationReconciliationEvent[];
  restoredEvents: WorkspaceDatabaseRestoreTelemetryEvent[];
  hooks: {
    onRotationReconciled: (event: WorkspaceRotationReconciliationEvent) => void;
    onRestored: (event: WorkspaceDatabaseRestoreTelemetryEvent) => void;
  };
}

function createTelemetryRecorder(): StartupTelemetryRecorder {
  const rotationEvents: WorkspaceRotationReconciliationEvent[] = [];
  const restoredEvents: WorkspaceDatabaseRestoreTelemetryEvent[] = [];
  return {
    rotationEvents,
    restoredEvents,
    hooks: {
      onRotationReconciled: (event) => {
        rotationEvents.push(event);
      },
      onRestored: (event) => {
        restoredEvents.push(event);
      },
    },
  };
}

interface StartupFixture {
  tempDirectory: string;
  filePath: string;
  backupPath: string;
  backupPreviousPath: string;
}

async function createStartupFixture(): Promise<StartupFixture> {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-db-startup-recovery-"),
  );
  const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
  const backupPaths = getWorkspaceDatabaseBackupPaths(filePath);
  return {
    tempDirectory,
    filePath,
    backupPath: backupPaths.closeBackupPath,
    backupPreviousPath: backupPaths.closeBackupPreviousPath,
  };
}

interface OpenOptions {
  telemetry?: StartupTelemetryRecorder;
  validationRunMigrations?: (database: unknown) => void;
}

async function openRepository(
  fixture: StartupFixture,
  options: OpenOptions = {},
): Promise<FileRepository> {
  const repository = await createFileJobFinderRepository({
    filePath: fixture.filePath,
    seed: createSeed(),
    ...(options.telemetry
      ? { recoveryTelemetry: options.telemetry.hooks }
      : {}),
    ...(options.validationRunMigrations
      ? {
          recoveryValidationOverrides: {
            runMigrations: options.validationRunMigrations,
          },
        }
      : {}),
  });
  // Recovery tests explicitly create generations; production close does not.
  return {
    ...repository,
    async close() {
      await createWorkspaceDatabaseBackup({ filePath: fixture.filePath });
      await repository.close();
    },
  };
}

function quarantineBasenames(fixture: StartupFixture): string[] {
  return readdirSync(fixture.tempDirectory).filter((name) =>
    name.startsWith("job-finder-state.sqlite.quarantine-"),
  );
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => cleanupTempDirectoryWithRetry(directory)),
  );
});

describe("file repository startup recovery integration", () => {
  test("healthy workspace opens without reconciliation events and rotates close backups", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_healthy" })]);
    await first.close();

    expect(existsSync(fixture.backupPath)).toBe(true);
    expect(existsSync(fixture.backupPreviousPath)).toBe(false);

    const telemetry = createTelemetryRecorder();
    const second = await openRepository(fixture, { telemetry });
    try {
      expect((await second.listSavedJobs()).map((job) => job.id)).toEqual([
        "job_healthy",
      ]);
      expect(telemetry.rotationEvents).toEqual([]);
      expect(telemetry.restoredEvents).toEqual([]);
    } finally {
      await second.close();
    }

    expect(existsSync(fixture.backupPreviousPath)).toBe(true);
  });

  test("promotes an interrupted close-rotation temporary before opening", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_tmp" })]);
    await first.close();

    await rename(fixture.backupPath, `${fixture.backupPath}.tmp`);

    const telemetry = createTelemetryRecorder();
    const second = await openRepository(fixture, { telemetry });
    try {
      expect((await second.listSavedJobs()).map((job) => job.id)).toEqual([
        "job_tmp",
      ]);
      expect(telemetry.rotationEvents.map((event) => event.actions)).toEqual([
        [{ code: "promoted-temporary-backup" }],
      ]);
      expect(existsSync(`${fixture.backupPath}.tmp`)).toBe(false);
      expect(existsSync(fixture.backupPath)).toBe(true);
    } finally {
      await second.close();
    }
  });

  test("restores a corrupted database from the newest close backup with redacted telemetry", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_from_backup" })]);
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const telemetry = createTelemetryRecorder();
    const second = await openRepository(fixture, { telemetry });
    try {
      expect((await second.listSavedJobs()).map((job) => job.id)).toEqual([
        "job_from_backup",
      ]);
      expect(telemetry.restoredEvents).toHaveLength(1);
      expect(telemetry.restoredEvents[0]?.restoredFrom).toBe("backup");
      expect(
        telemetry.restoredEvents[0]?.quarantinedArtifactBasenames.length,
      ).toBeGreaterThan(0);
      expect(telemetry.rotationEvents).toEqual([]);

      const serialized = JSON.stringify({
        rotation: telemetry.rotationEvents,
        restored: telemetry.restoredEvents,
      });
      expect(serialized).not.toContain(fixture.tempDirectory);

      const quarantined = quarantineBasenames(fixture);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]).toContain(".quarantine-");
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  test("falls back to the previous close generation when the primary snapshot is invalid", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_generation_1" })]);
    await first.close();

    const second = await openRepository(fixture);
    await second.replaceSavedJobs([createSavedJob({ id: "job_generation_2" })]);
    await second.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);
    await writeFile(fixture.backupPath, NOT_DATABASE_CONTENT);

    const third = await openRepository(fixture);
    try {
      const jobIds = (await third.listSavedJobs()).map((job) => job.id);
      expect(jobIds).toEqual(["job_generation_1"]);
    } finally {
      await third.close().catch(() => undefined);
    }
  });

  test("surfaces the original error untouched when migrations fail on a clean-integrity database", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_inert" })]);
    await first.close();

    // Re-arm the default-campaign migration while corrupting its
    // search-preferences input, so migration fails on a database whose
    // SQLite integrity is still clean.
    const raw = new DatabaseSync(fixture.filePath);
    try {
      raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(10);
      raw
        .prepare("DELETE FROM singleton_state WHERE key = ?")
        .run("campaign_state");
      raw
        .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
        .run("not-json{", "search_preferences");
    } finally {
      raw.close();
    }

    const bytesBefore = await readFile(fixture.filePath);

    let failure: unknown = null;
    try {
      await openRepository(fixture);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    expect(quarantineBasenames(fixture)).toEqual([]);

    expect(await readFile(fixture.filePath)).toEqual(bytesBefore);
    expect(await readFile(fixture.backupPath)).not.toEqual(
      NOT_DATABASE_CONTENT,
    );
  });

  test("reports a typed recovery-required incident when no valid candidate remains", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_lost" })]);
    await first.close();

    await writeFile(fixture.filePath, Buffer.from("corrupt main", "utf8"));
    await writeFile(fixture.backupPath, Buffer.from("corrupt primary", "utf8"));
    await writeFile(
      fixture.backupPreviousPath,
      Buffer.from("corrupt previous", "utf8"),
    );

    let failure: unknown = null;
    try {
      await openRepository(fixture);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    const details = (failure as WorkspaceDatabaseRecoveryRequiredError).details;
    expect(details.outcome).toBe("no-valid-candidate");
    expect(details.failureEvidence).toBe("reported-error-code");
    expect(details.candidates.map((candidate) => candidate.status)).toEqual([
      "invalid",
      "invalid",
    ]);
    expect(JSON.stringify(failure)).not.toContain(fixture.tempDirectory);

    // No candidate was selectable, so nothing is quarantined or rewritten:
    // the suspect database and both invalid snapshots stay in place.
    expect(quarantineBasenames(fixture)).toEqual([]);
    expect(await readFile(fixture.filePath)).toEqual(
      Buffer.from("corrupt main", "utf8"),
    );
    expect(await readFile(fixture.backupPath)).toEqual(
      Buffer.from("corrupt primary", "utf8"),
    );
    expect(await readFile(fixture.backupPreviousPath)).toEqual(
      Buffer.from("corrupt previous", "utf8"),
    );
  });

  test("rejects a selected snapshot that fails final strict revalidation", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_tampered" })]);
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    let migrationCalls = 0;
    let failure: unknown = null;
    try {
      await openRepository(fixture, {
        validationRunMigrations: () => {
          migrationCalls += 1;
          if (migrationCalls > 1) {
            throw new Error("revalidation rejected the restore copy");
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    const details = (failure as WorkspaceDatabaseRecoveryRequiredError).details;
    expect(details.outcome).toBe("restore-revalidation-rejected");
    expect(details.candidates[0]).toMatchObject({
      kind: "backup",
      status: "valid",
    });
    expect(existsSync(fixture.filePath)).toBe(false);
    expect(quarantineBasenames(fixture)).toHaveLength(1);
    expect(
      readdirSync(fixture.tempDirectory).filter((name) =>
        name.includes(".restore-"),
      ),
    ).toEqual([]);
  });

  test("refuses to silently replace a missing database that still has close snapshots", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_missing" })]);
    await first.close();

    await rm(fixture.filePath, { force: true });

    let failure: unknown = null;
    try {
      await openRepository(fixture);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    const details = (failure as WorkspaceDatabaseRecoveryRequiredError).details;
    expect(details.outcome).toBe("salvage-required");
    expect(details.failureEvidence).toBe("source-missing");
    expect(JSON.stringify(failure)).not.toContain(fixture.tempDirectory);

    expect(existsSync(fixture.filePath)).toBe(false);
    expect(existsSync(fixture.backupPath)).toBe(true);
    expect(quarantineBasenames(fixture)).toEqual([]);
  });

  test("performs exactly one recovery pass per creation call", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_once" })]);
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const telemetry = createTelemetryRecorder();
    const second = await openRepository(fixture, { telemetry });
    try {
      expect(telemetry.restoredEvents).toHaveLength(1);
      expect(
        new Set(telemetry.restoredEvents.map((event) => event.incidentId)).size,
      ).toBe(1);
      expect(
        telemetry.restoredEvents.every(
          (event) =>
            typeof event.lossWindow.detectedAtIso === "string" &&
            typeof event.lossWindow.restoredSnapshotModifiedAtIso === "string",
        ),
      ).toBe(true);
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  test("profile revision compare-and-swap survives corruption recovery on migration 11", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    const baseline = await first.getProfileWithRevision();
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const telemetry = createTelemetryRecorder();
    const second = await openRepository(fixture, { telemetry });
    try {
      expect(telemetry.restoredEvents).toHaveLength(1);
      const persisted = await second.getProfileWithRevision();
      expect(persisted.revision).toBeGreaterThanOrEqual(baseline.revision);

      const applied = await second.commitProfileUpdate((current) => current, {
        expectedRevision: persisted.revision,
      });
      expect(applied.status).toBe("applied");
      expect(applied.revision).toBe(persisted.revision + 1);

      const stale = await second.commitProfileUpdate((current) => current, {
        expectedRevision: persisted.revision,
      });
      expect(stale.status).toBe("stale");
      expect(stale.revision).toBe(applied.revision);
    } finally {
      await second.close().catch(() => undefined);
    }
  });

  test("emits restore telemetry only after the restored database reopens", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_reopen_first" })]);
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const restoredEvents: WorkspaceDatabaseRestoreTelemetryEvent[] = [];
    const observations: Array<{
      integrityOk: boolean;
      restoredJobPresent: boolean;
    }> = [];

    const reopened = await createFileJobFinderRepository({
      filePath: fixture.filePath,
      seed: createSeed(),
      recoveryTelemetry: {
        onRestored: (event) => {
          const probe = new DatabaseSync(fixture.filePath);
          try {
            const integrityRows = probe
              .prepare("PRAGMA integrity_check")
              .all() as Array<{ integrity_check?: unknown }>;
            const jobRow = probe
              .prepare(
                "SELECT COUNT(*) AS count FROM saved_jobs WHERE json_extract(value, '$.id') = ?",
              )
              .get("job_reopen_first") as { count?: number } | undefined;
            observations.push({
              integrityOk:
                integrityRows.length > 0 &&
                integrityRows.every((row) => row.integrity_check === "ok"),
              restoredJobPresent: Number(jobRow?.count ?? 0) === 1,
            });
          } finally {
            probe.close();
          }
          restoredEvents.push(event);
        },
      },
    });

    // Closed before the assertions so the recovered workspace file carries no
    // open handle when the temporary directory is removed; Windows cannot
    // delete a locked file and the cleanup hook timed out.
    await reopened.close();

    expect(restoredEvents).toHaveLength(1);
    expect(restoredEvents[0]?.restoredFrom).toBe("backup");
    expect(observations).toEqual([
      { integrityOk: true, restoredJobPresent: true },
    ]);
  });

  test("withholds restore telemetry when the reopened database fails startup validation", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([createSavedJob({ id: "job_reopen_fail" })]);
    await first.close();

    // Re-arm the default-campaign migration inside the close snapshot with a
    // malformed search-preferences input: the lenient validation override
    // accepts the snapshot through candidate evaluation and final
    // revalidation, while the real reopen migration must reject it.
    const raw = new DatabaseSync(fixture.backupPath);
    try {
      raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(10);
      raw
        .prepare("DELETE FROM singleton_state WHERE key = ?")
        .run("campaign_state");
      raw
        .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
        .run("not-json{", "search_preferences");
    } finally {
      raw.close();
    }

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const telemetry = createTelemetryRecorder();
    let failure: unknown = null;
    try {
      await openRepository(fixture, {
        telemetry,
        validationRunMigrations: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WorkspaceDatabaseRecoveryRequiredError);
    const details = (failure as WorkspaceDatabaseRecoveryRequiredError).details;
    expect(details.outcome).toBe("restore-promotion-failed");
    expect(details.incidentId).toBeTruthy();
    expect(details.quarantineBasenames).toHaveLength(1);
    expect(telemetry.restoredEvents).toEqual([]);
    expect(telemetry.rotationEvents).toEqual([]);

    // Promotion itself succeeded, so the restored bytes stay live and every
    // artifact remains preserved for support.
    expect(existsSync(fixture.filePath)).toBe(true);
    expect(quarantineBasenames(fixture)).toHaveLength(1);
  });

  test("a failing restore telemetry observer cannot invalidate the reopened database", async () => {
    const fixture = await createStartupFixture();
    temporaryDirectories.push(fixture.tempDirectory);
    const first = await openRepository(fixture);
    await first.replaceSavedJobs([
      createSavedJob({ id: "job_observer_throw" }),
    ]);
    await first.close();

    await writeFile(fixture.filePath, NOT_DATABASE_CONTENT);

    const restoredEvents: WorkspaceDatabaseRestoreTelemetryEvent[] = [];
    const second = await createFileJobFinderRepository({
      filePath: fixture.filePath,
      seed: createSeed(),
      recoveryTelemetry: {
        onRestored: (event) => {
          restoredEvents.push(event);
          throw new Error("restore telemetry observer failure");
        },
      },
    });

    try {
      expect(restoredEvents).toHaveLength(1);
      expect((await second.listSavedJobs()).map((job) => job.id)).toEqual([
        "job_observer_throw",
      ]);
    } finally {
      await second.close().catch(() => undefined);
    }
  });
});
