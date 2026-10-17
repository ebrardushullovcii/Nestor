import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApplicationRecordSchema, SavedJobSchema } from "@nestor/contracts";

import { createFileJobFinderRepository } from "./index";
import {
  createWorkspaceResetDatabaseBackup,
  getWorkspaceDatabaseBackupPaths,
  reconcileWorkspaceBackupRotation,
} from "./file-repository-backup";
import { runMigrations } from "./internal/migrations";
import { hasPersistedState, listValues } from "./internal/state";
import { createSeed } from "./test-fixtures";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
} from "./file-repository.test-support";

async function createTempWorkspace(prefix: string) {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
  return {
    tempDirectory,
    filePath,
    ...getWorkspaceDatabaseBackupPaths(filePath),
  };
}

function createBackupFixtureJob(id: string) {
  return createSavedJob({ id, sourceJobId: `target_${id}` });
}

function listSavedJobIds(database: DatabaseSync) {
  return listValues(database, "saved_jobs", SavedJobSchema).map(
    (job) => job.id,
  );
}

function openSnapshot(snapshotPath: string) {
  // Restore requirement: every snapshot must open as a standalone migrated
  // database containing the committed workspace state it claims to hold.
  const restored = new DatabaseSync(snapshotPath);
  runMigrations(restored);
  expect(hasPersistedState(restored)).toBe(true);
  return restored;
}

// Windows pays for every one of these tests twice: VACUUM INTO snapshots and
// rotation renames are slower there, and removing a temporary directory has to
// retry until the OS releases the last handle. Under a parallel run that
// outgrows vitest's 5s default and the suite fails on the clock rather than on
// behaviour. POSIX keeps the default, so a real hang still fails fast there.
if (process.platform === "win32") {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
}

describe("automatic workspace database backup", () => {
  let workspace: Awaited<ReturnType<typeof createTempWorkspace>>;

  beforeEach(async () => {
    workspace = await createTempWorkspace("nestor-db-backup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirectoryWithRetry(workspace.tempDirectory);
  });

  test("writes no backup files when automatic backup is disabled", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
    });

    await repository.close();

    expect(existsSync(workspace.closeBackupPath)).toBe(false);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(false);
    expect(existsSync(workspace.resetBackupPath)).toBe(false);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);
    expect(existsSync(workspace.resetTemporaryPath)).toBe(false);
  });

  test("captures a restorable snapshot on close including WAL-resident commits", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_backup_close")],
    });

    await repository.close();

    expect(existsSync(workspace.closeBackupPath)).toBe(true);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);

    if (process.platform !== "win32") {
      const backupMode = (await stat(workspace.closeBackupPath)).mode & 0o777;
      expect(backupMode).toBe(0o600);
    }

    const restored = openSnapshot(workspace.closeBackupPath);
    try {
      expect(listSavedJobIds(restored)).toContain("job_backup_close");
    } finally {
      restored.close();
    }

    // The live database must remain fully intact after the backup.
    const reopened = new DatabaseSync(workspace.filePath);
    try {
      runMigrations(reopened);
      expect(hasPersistedState(reopened)).toBe(true);
      expect(listSavedJobIds(reopened)).toContain("job_backup_close");
    } finally {
      reopened.close();
    }
  });

  test("preserves one prior generation when the close snapshot rotates", async () => {
    const firstRepository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    await firstRepository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_generation_one")],
    });
    await firstRepository.close();

    const secondRepository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    await secondRepository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_generation_two")],
    });
    await secondRepository.close();

    const newest = openSnapshot(workspace.closeBackupPath);
    try {
      // The second session inherits the first session's committed row, so
      // the newest snapshot holds both; the rotation is proven by the
      // previous generation file below.
      expect(listSavedJobIds(newest)).toContain("job_generation_one");
      expect(listSavedJobIds(newest)).toContain("job_generation_two");
    } finally {
      newest.close();
    }

    const previous = openSnapshot(workspace.closeBackupPreviousPath);
    try {
      expect(listSavedJobIds(previous)).toContain("job_generation_one");
      expect(listSavedJobIds(previous)).not.toContain("job_generation_two");
    } finally {
      previous.close();
    }
  });

  test("reset removes every managed copy of the old workspace across restart", async () => {
    const oldSeed = createSeed();
    oldSeed.profile.email = "deleted-person@example.test";
    oldSeed.profile.baseResume.textContent = "Synthetic deleted resume text";
    oldSeed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "deleted_application",
        jobId: "job_before_reset",
        title: "Synthetic role",
        company: "Synthetic company",
        status: "submitted",
        lastActionLabel: "Applied",
        nextActionLabel: null,
        lastUpdatedAt: "2026-10-02T10:00:00.000Z",
      }),
    ];
    const first = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: oldSeed,
      automaticBackup: { onClose: true, beforeReset: true },
    });
    await first.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_before_reset")],
    });
    await first.close();
    const second = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: oldSeed,
      automaticBackup: { onClose: true, beforeReset: true },
    });
    await second.close();
    const managedPaths = Object.values({
      ...getWorkspaceDatabaseBackupPaths(workspace.filePath),
    });
    // Include leftovers from interrupted recovery and reset snapshot writes.
    const recoveryPaths = [
      `${workspace.filePath}.quarantine-2026-10-02T10-00-00-000Z-test`,
      `${workspace.filePath}-wal.quarantine-2026-10-02T10-00-00-000Z-test`,
      `${workspace.filePath}.restore-test.tmp`,
      `${workspace.filePath}.recovery-validate-backup-test.tmp`,
      `${workspace.filePath}.recovery-integrity-test.tmp-wal`,
    ];
    for (const copyPath of [
      ...managedPaths.filter((p) => !existsSync(p)),
      ...recoveryPaths,
    ]) {
      await writeFile(copyPath, await readFile(workspace.closeBackupPath));
    }
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: oldSeed,
      automaticBackup: { onClose: true, beforeReset: true },
    });
    await repository.reset(createSeed());
    for (const copyPath of [...managedPaths, ...recoveryPaths])
      expect(existsSync(copyPath)).toBe(false);
    // Deleted rows must not survive as free pages in the live database file
    // or as old frames in its WAL.
    for (const livePath of [workspace.filePath, `${workspace.filePath}-wal`]) {
      if (!existsSync(livePath)) continue;
      const liveBytes = await readFile(livePath);
      expect(
        liveBytes.includes(Buffer.from("deleted-person@example.test")),
      ).toBe(false);
      expect(
        liveBytes.includes(Buffer.from("Synthetic deleted resume text")),
      ).toBe(false);
    }
    await repository.close();
    const reopened = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true, beforeReset: true },
    });
    expect((await reopened.listSavedJobs()).map((job) => job.id)).not.toContain(
      "job_before_reset",
    );
    expect((await reopened.getProfile()).email).not.toBe(
      "deleted-person@example.test",
    );
    expect(await reopened.listApplicationRecords()).toHaveLength(0);
    await reopened.close();
    for (const snapshotPath of [
      workspace.closeBackupPath,
      workspace.closeBackupPreviousPath,
    ]) {
      const snapshot = openSnapshot(snapshotPath);
      try {
        expect(
          listValues(snapshot, "application_records", ApplicationRecordSchema),
        ).toHaveLength(0);
        expect(listSavedJobIds(snapshot)).not.toContain("job_before_reset");
      } finally {
        snapshot.close();
      }
      const bytes = await readFile(snapshotPath);
      expect(bytes.includes(Buffer.from("deleted-person@example.test"))).toBe(
        false,
      );
      expect(bytes.includes(Buffer.from("Synthetic deleted resume text"))).toBe(
        false,
      );
    }
    expect(existsSync(workspace.resetBackupPath)).toBe(false);
  });

  test("still closes the database cleanly when the backup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    // A directory at the temporary destination makes every close-snapshot
    // attempt fail without touching directory permissions, keeping the
    // failure deterministic across platforms.
    await mkdir(workspace.closeTemporaryPath);

    await expect(repository.close()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[JobFinderRepository] Skipped graceful-close database backup.",
      expect.anything(),
    );

    expect(existsSync(workspace.closeBackupPath)).toBe(false);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(false);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(true);

    const reopened = new DatabaseSync(workspace.filePath);
    try {
      runMigrations(reopened);
      expect(hasPersistedState(reopened)).toBe(true);
    } finally {
      reopened.close();
    }
  });

  test("replaces a stale interrupted temporary snapshot instead of failing", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    await writeFile(workspace.closeTemporaryPath, "interrupted-snapshot");

    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_after_stale_tmp")],
    });
    await repository.close();

    expect(existsSync(workspace.closeBackupPath)).toBe(true);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);

    const restored = openSnapshot(workspace.closeBackupPath);
    try {
      expect(listSavedJobIds(restored)).toContain("job_after_stale_tmp");
    } finally {
      restored.close();
    }
  });
});

describe("workspace backup rotation reconciliation", () => {
  let workspace: Awaited<ReturnType<typeof createTempWorkspace>>;

  beforeEach(async () => {
    workspace = await createTempWorkspace("nestor-db-backup-reconcile-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirectoryWithRetry(workspace.tempDirectory);
  });

  async function createClosedWorkspaceWithJob(jobId: string) {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { onClose: true },
    });
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob(jobId)],
    });
    await repository.close();
  }

  async function readSnapshotBytes(snapshotPath: string) {
    return readFile(snapshotPath);
  }

  function expectWarning(
    result: Awaited<ReturnType<typeof reconcileWorkspaceBackupRotation>>,
    warning: {
      code:
        | "invalid-temporary-backup-retained"
        | "invalid-primary-backup-retained"
        | "invalid-previous-generation-retained";
      path: string;
    },
  ) {
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe(warning.code);
    expect(result.warnings[0]?.path).toBe(warning.path);
    expect(result.warnings[0]?.reason).toBeDefined();
  }

  test("promotes an interrupted temporary snapshot into a missing close backup", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_promote");
    // Killed between VACUUM INTO and the final rename leaves exactly this
    // shape: fresh temporary present, destination absent.
    await rename(workspace.closeBackupPath, workspace.closeTemporaryPath);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.warnings).toEqual([]);
    expect(result.actions).toEqual([
      {
        code: "promoted-temporary-backup",
        sourcePath: workspace.closeTemporaryPath,
        targetPath: workspace.closeBackupPath,
      },
    ]);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);

    const restored = openSnapshot(workspace.closeBackupPath);
    try {
      expect(listSavedJobIds(restored)).toContain("job_reconcile_promote");
    } finally {
      restored.close();
    }

    if (process.platform !== "win32") {
      const promotedMode = (await stat(workspace.closeBackupPath)).mode & 0o777;
      expect(promotedMode).toBe(0o600);
    }
  });

  test("restores the close backup from the previous generation while retaining it", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_prev_restore");
    // Killed right after the rotate rename: the previous generation is in
    // place but the primary destination was never replaced.
    await rename(workspace.closeBackupPath, workspace.closeBackupPreviousPath);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.warnings).toEqual([]);
    expect(result.actions).toEqual([
      {
        code: "restored-backup-from-previous-generation",
        sourcePath: workspace.closeBackupPreviousPath,
        targetPath: workspace.closeBackupPath,
      },
    ]);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(true);

    const restored = openSnapshot(workspace.closeBackupPath);
    try {
      expect(listSavedJobIds(restored)).toContain("job_reconcile_prev_restore");
    } finally {
      restored.close();
    }
  });

  test("retains an invalid interrupted temporary snapshot and reports a warning", async () => {
    const corrupted = Buffer.from("corrupted-not-a-sqlite-snapshot");
    await writeFile(workspace.closeTemporaryPath, corrupted);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.actions).toEqual([]);
    expectWarning(result, {
      code: "invalid-temporary-backup-retained",
      path: workspace.closeTemporaryPath,
    });
    expect(await readSnapshotBytes(workspace.closeTemporaryPath)).toEqual(
      corrupted,
    );
    expect(existsSync(workspace.closeBackupPath)).toBe(false);
  });

  test("retains an invalid previous generation instead of restoring it", async () => {
    const corrupted = Buffer.from("corrupted-previous-generation");
    await writeFile(workspace.closeBackupPreviousPath, corrupted);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.actions).toEqual([]);
    expectWarning(result, {
      code: "invalid-previous-generation-retained",
      path: workspace.closeBackupPreviousPath,
    });
    expect(await readSnapshotBytes(workspace.closeBackupPreviousPath)).toEqual(
      corrupted,
    );
    expect(existsSync(workspace.closeBackupPath)).toBe(false);
  });

  test("does not fall back to the previous generation while an unusable temporary occupies the rotation", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_tmp_blocks_prev");
    await rename(workspace.closeBackupPath, workspace.closeBackupPreviousPath);
    await writeFile(workspace.closeTemporaryPath, "corrupted-close-tmp");

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.actions).toEqual([]);
    expectWarning(result, {
      code: "invalid-temporary-backup-retained",
      path: workspace.closeTemporaryPath,
    });
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(true);
    expect(existsSync(workspace.closeBackupPath)).toBe(false);
  });

  test("removes a stale temporary snapshot only while the primary validates", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_stale_tmp");
    await writeFile(workspace.closeTemporaryPath, "stale-close-tmp");
    const primaryBefore = await readSnapshotBytes(workspace.closeBackupPath);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.warnings).toEqual([]);
    expect(result.actions).toEqual([
      {
        code: "removed-stale-temporary-backup",
        path: workspace.closeTemporaryPath,
      },
    ]);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);
    expect(await readSnapshotBytes(workspace.closeBackupPath)).toEqual(
      primaryBefore,
    );
  });

  test("keeps the temporary snapshot when the primary backup fails validation", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_bad_primary");
    await writeFile(workspace.closeBackupPath, "corrupted-primary-backup");
    await writeFile(workspace.closeTemporaryPath, "stale-close-tmp");

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.actions).toEqual([]);
    expectWarning(result, {
      code: "invalid-primary-backup-retained",
      path: workspace.closeBackupPath,
    });
    expect(existsSync(workspace.closeBackupPath)).toBe(true);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(true);
  });

  test("treats a fully rotated healthy workspace as a no-op", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_healthy_first");
    await rename(workspace.closeBackupPath, workspace.closeBackupPreviousPath);
    await createClosedWorkspaceWithJob("job_reconcile_healthy_second");

    const backupBefore = await readSnapshotBytes(workspace.closeBackupPath);
    const previousBefore = await readSnapshotBytes(
      workspace.closeBackupPreviousPath,
    );

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result).toEqual({ actions: [], warnings: [] });
    expect(await readSnapshotBytes(workspace.closeBackupPath)).toEqual(
      backupBefore,
    );
    expect(await readSnapshotBytes(workspace.closeBackupPreviousPath)).toEqual(
      previousBefore,
    );
  });

  test("is idempotent across repeated startup reconciliation", async () => {
    await createClosedWorkspaceWithJob("job_reconcile_idempotent");
    await rename(workspace.closeBackupPath, workspace.closeTemporaryPath);

    const firstRun = await reconcileWorkspaceBackupRotation(workspace.filePath);
    expect(firstRun.actions).toEqual([
      {
        code: "promoted-temporary-backup",
        sourcePath: workspace.closeTemporaryPath,
        targetPath: workspace.closeBackupPath,
      },
    ]);

    const secondRun = await reconcileWorkspaceBackupRotation(
      workspace.filePath,
    );
    expect(secondRun).toEqual({ actions: [], warnings: [] });
  });

  test("promotes an interrupted reset temporary into a missing pre-reset backup", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { beforeReset: true },
    });
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_reconcile_reset_promote")],
    });
    // Closed before the reconciliation so the workspace file carries no open
    // handle: Windows refuses to remove a locked file, which stranded the
    // temporary directory in cleanup.
    await repository.close();
    const raw = new DatabaseSync(workspace.filePath);
    try {
      await createWorkspaceResetDatabaseBackup({
        database: raw,
        filePath: workspace.filePath,
      });
    } finally {
      raw.close();
    }
    // Interrupted between VACUUM INTO and the final reset-snapshot rename.
    await rename(workspace.resetBackupPath, workspace.resetTemporaryPath);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.warnings).toEqual([]);
    expect(result.actions).toEqual([
      {
        code: "promoted-temporary-backup",
        sourcePath: workspace.resetTemporaryPath,
        targetPath: workspace.resetBackupPath,
      },
    ]);
    expect(existsSync(workspace.resetTemporaryPath)).toBe(false);

    const restored = openSnapshot(workspace.resetBackupPath);
    try {
      expect(listSavedJobIds(restored)).toContain(
        "job_reconcile_reset_promote",
      );
    } finally {
      restored.close();
    }
  });

  test("retains an invalid reset temporary and reports a warning", async () => {
    const corrupted = Buffer.from("corrupted-reset-temporary");
    await writeFile(workspace.resetTemporaryPath, corrupted);

    const result = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(result.actions).toEqual([]);
    expectWarning(result, {
      code: "invalid-temporary-backup-retained",
      path: workspace.resetTemporaryPath,
    });
    expect(await readSnapshotBytes(workspace.resetTemporaryPath)).toEqual(
      corrupted,
    );
    expect(existsSync(workspace.resetBackupPath)).toBe(false);
  });

  test("removes a stale reset temporary after validating the pre-reset backup and stays idempotent", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { beforeReset: true },
    });
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("job_reconcile_reset_stale")],
    });
    await repository.close();
    const raw = new DatabaseSync(workspace.filePath);
    try {
      await createWorkspaceResetDatabaseBackup({
        database: raw,
        filePath: workspace.filePath,
      });
    } finally {
      raw.close();
    }
    await writeFile(workspace.resetTemporaryPath, "stale-reset-tmp");
    const resetBackupBefore = await readSnapshotBytes(
      workspace.resetBackupPath,
    );

    const firstRun = await reconcileWorkspaceBackupRotation(workspace.filePath);

    expect(firstRun.warnings).toEqual([]);
    expect(firstRun.actions).toEqual([
      {
        code: "removed-stale-temporary-backup",
        path: workspace.resetTemporaryPath,
      },
    ]);
    expect(existsSync(workspace.resetTemporaryPath)).toBe(false);
    expect(await readSnapshotBytes(workspace.resetBackupPath)).toEqual(
      resetBackupBefore,
    );

    const secondRun = await reconcileWorkspaceBackupRotation(
      workspace.filePath,
    );
    expect(secondRun).toEqual({ actions: [], warnings: [] });
  });
});
