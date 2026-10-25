import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SavedJobSchema } from "@nestor/contracts";

import { createFileJobFinderRepository } from "./index";
import {
  createWorkspaceResetDatabaseBackup,
  createWorkspaceDatabaseBackup,
  scheduleWorkspaceDatabaseBackups,
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

describe("background workspace database backup", () => {
  let workspace: Awaited<ReturnType<typeof createTempWorkspace>>;
  const stops: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    workspace = await createTempWorkspace("nestor-db-backup-");
  });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    vi.restoreAllMocks();
    await cleanupTempDirectoryWithRetry(workspace.tempDirectory);
  });
  async function snapshot() {
    const result = await createWorkspaceDatabaseBackup({
      filePath: workspace.filePath,
    });
    expect(result.status).toBe("created");
  }
  async function seed() {
    return createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
    });
  }
  async function waitForBackup() {
    await vi.waitFor(
      () => expect(existsSync(workspace.closeBackupPath)).toBe(true),
      { timeout: 10000 },
    );
  }
  test("close neither starts a backup nor changes an existing recovery point", async () => {
    const repository = await seed();
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("original")],
    });
    await snapshot();
    const before = await readFile(workspace.closeBackupPath);
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("later")],
    });
    await repository.close();
    expect(await readFile(workspace.closeBackupPath)).toEqual(before);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(false);
  });
  test("an immediate close cancels scheduled work without creating any snapshot", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { inBackground: true },
    });
    await repository.close();
    expect(existsSync(workspace.closeBackupPath)).toBe(false);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);
  });
  test("a failed snapshot leaves the completed recovery point intact and close still works", async () => {
    const repository = await seed();
    await snapshot();
    const before = await readFile(workspace.closeBackupPath);
    await mkdir(workspace.closeTemporaryPath);
    expect(
      (await createWorkspaceDatabaseBackup({ filePath: workspace.filePath }))
        .status,
    ).toBe("skipped");
    await expect(repository.close()).resolves.toBeUndefined();
    expect(await readFile(workspace.closeBackupPath)).toEqual(before);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(false);
  });
  test("background snapshots include WAL commits and preserve the prior generation", async () => {
    const repository = await seed();
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("first")],
    });
    await snapshot();
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob("second")],
    });
    await snapshot();
    await repository.close();
    const newest = openSnapshot(workspace.closeBackupPath);
    const previous = openSnapshot(workspace.closeBackupPreviousPath);
    try {
      expect(listSavedJobIds(newest)).toEqual(
        expect.arrayContaining(["first", "second"]),
      );
      expect(listSavedJobIds(previous)).toContain("first");
      expect(listSavedJobIds(previous)).not.toContain("second");
    } finally {
      newest.close();
      previous.close();
    }
    if (process.platform !== "win32")
      expect((await stat(workspace.closeBackupPath)).mode & 0o777).toBe(0o600);
  });
  test("starts without waiting for quit and does not refresh a recent recovery point", async () => {
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { inBackground: true },
    });
    await waitForBackup();
    await repository.close();
    const modified = (await stat(workspace.closeBackupPath)).mtimeMs;
    const reopened = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { inBackground: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await reopened.close();
    expect((await stat(workspace.closeBackupPath)).mtimeMs).toBe(modified);
    expect(existsSync(workspace.closeBackupPreviousPath)).toBe(false);
  });
  test("refreshes an expired recovery point while open", async () => {
    const repository = await seed();
    await snapshot();
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(workspace.closeBackupPath, oldTime, oldTime);
    const db = new DatabaseSync(workspace.filePath);
    const version = Number(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
        ?.version,
    );
    db.close();
    const stop = scheduleWorkspaceDatabaseBackups({
      filePath: workspace.filePath,
      schemaVersion: version,
    });
    stops.push(stop);
    await vi.waitFor(
      () => expect(existsSync(workspace.closeBackupPreviousPath)).toBe(true),
      { timeout: 10000 },
    );
    await stop();
    await repository.close();
    expect((await stat(workspace.closeBackupPath)).mtimeMs).toBeGreaterThan(
      oldTime.getTime(),
    );
  });
  test("refreshes after a migration even if the previous recovery point is recent", async () => {
    const repository = await seed();
    await snapshot();
    const db = new DatabaseSync(workspace.filePath);
    const version = Number(
      db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
        ?.version,
    );
    db.close();
    const stop = scheduleWorkspaceDatabaseBackups({
      filePath: workspace.filePath,
      schemaVersion: version + 1,
    });
    stops.push(stop);
    await vi.waitFor(
      () => expect(existsSync(workspace.closeBackupPreviousPath)).toBe(true),
      { timeout: 10000 },
    );
    await stop();
    await repository.close();
  });
  test("an aborted snapshot preserves the completed recovery point", async () => {
    const repository = await seed();
    await snapshot();
    const before = await readFile(workspace.closeBackupPath);
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await createWorkspaceDatabaseBackup({
          filePath: workspace.filePath,
          signal: controller.signal,
        })
      ).status,
    ).toBe("skipped");
    await repository.close();
    expect(await readFile(workspace.closeBackupPath)).toEqual(before);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);
  });
  test("close cancels an active native copy and preserves the completed recovery point", async () => {
    const initial = await seed();
    await snapshot();
    await initial.close();
    const before = await readFile(workspace.closeBackupPath);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(workspace.closeBackupPath, oldTime, oldTime);
    const raw = new DatabaseSync(workspace.filePath);
    raw.exec(
      "CREATE TABLE backup_load(value BLOB); INSERT INTO backup_load VALUES(zeroblob(134217728))",
    );
    raw.close();
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: createSeed(),
      automaticBackup: { inBackground: true },
    });
    await vi.waitFor(
      () => expect(existsSync(workspace.closeTemporaryPath)).toBe(true),
      { timeout: 10000, interval: 5 },
    );
    await repository.close();
    expect(await readFile(workspace.closeBackupPath)).toEqual(before);
    expect(existsSync(workspace.closeTemporaryPath)).toBe(false);
  });
  test("reset removes rotating, migration, quarantine and interrupted recovery copies", async () => {
    const oldSeed = createSeed();
    oldSeed.profile.email = "deleted-person@example.test";
    oldSeed.profile.baseResume.textContent = "Synthetic deleted resume text";
    const repository = await createFileJobFinderRepository({
      filePath: workspace.filePath,
      seed: oldSeed,
      automaticBackup: { beforeReset: true, inBackground: true },
    });
    await waitForBackup();
    const copies = [
      workspace.closeBackupPreviousPath,
      `${workspace.filePath}.before-v26.sqlite`,
      `${workspace.filePath}.before-v29.sqlite`,
      `${workspace.filePath}.quarantine-2026-10-02T10-00-00-000Z-test`,
      `${workspace.filePath}.recovery-validate-backup-test.tmp.before-v26.sqlite`,
      `${workspace.filePath}.recovery-integrity-test.tmp-wal`,
    ];
    for (const copy of copies)
      await writeFile(copy, await readFile(workspace.closeBackupPath));
    await repository.reset(createSeed());
    await repository.close();
    for (const copy of [
      ...copies,
      ...Object.values({
        ...getWorkspaceDatabaseBackupPaths(workspace.filePath),
      }),
    ])
      expect(existsSync(copy)).toBe(false);
    const bytes = await readFile(workspace.filePath);
    expect(bytes.includes(Buffer.from("deleted-person@example.test"))).toBe(
      false,
    );
    expect(bytes.includes(Buffer.from("Synthetic deleted resume text"))).toBe(
      false,
    );
    const reopened = await seed();
    expect((await reopened.getProfile()).email).not.toBe(
      "deleted-person@example.test",
    );
    expect(await reopened.listApplicationRecords()).toEqual([]);
    await reopened.close();
  });
  test("an empty reset removes unused normalized evidence as well as its owner rows", async () => {
    const repository = await seed();
    const raw = new DatabaseSync(workspace.filePath);
    raw.exec(`INSERT INTO resume_source_texts(id, stable_key, text) VALUES(999, 'deleted', 'Synthetic deleted evidence');
      INSERT INTO resume_sources(id, stable_key, ref_id, source_kind, source_id, text_id) VALUES(999, 'deleted', 'deleted', 'profile', NULL, 999);
      INSERT INTO job_listing_texts(id, stable_key, text) VALUES(999, 'deleted', 'Synthetic deleted listing');
      INSERT INTO job_fit_assessments(id, stable_key, value) VALUES(999, 'deleted', '{}');
      INSERT INTO search_preference_sets(id, value) VALUES('deleted', '{}');
      INSERT INTO job_sources(id, source_id, value) VALUES('deleted', 'deleted', '{}');
      INSERT INTO search_preference_sources(preference_id, source_id, source_version_id, position) VALUES('deleted', 'deleted', 'deleted', 0);`);
    await repository.reset(createSeed());
    for (const table of [
      "resume_sources",
      "resume_source_texts",
      "job_listing_texts",
      "job_fit_assessments",
    ])
      expect(
        Number(
          raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        ),
      ).toBe(0);
    for (const table of ["search_preference_sets", "job_sources"])
      expect(
        Number(
          raw
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE id = 'deleted'`,
            )
            .get()?.count,
        ),
      ).toBe(0);
    raw.close();
    await repository.close();
    expect(
      (await readFile(workspace.filePath)).includes(
        Buffer.from("Synthetic deleted evidence"),
      ),
    ).toBe(false);
    expect(
      (await readFile(workspace.filePath)).includes(
        Buffer.from("Synthetic deleted listing"),
      ),
    ).toBe(false);
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
    });
    await repository.commitSavedJobDelta({
      upserts: [createBackupFixtureJob(jobId)],
    });
    await createWorkspaceDatabaseBackup({ filePath: workspace.filePath });
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
