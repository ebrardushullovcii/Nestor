import { chmod, copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";

import { openDatabaseFile } from "./internal/migrations";

export type WorkspaceDatabaseBackupStatus =
  | { status: "created"; backupPath: string }
  | { status: "skipped"; backupPath: string; reason: unknown };

export interface WorkspaceDatabaseBackupPaths {
  /**
   * Newest background database-only recovery point, rotated at most daily
   * or after a schema migration. Names are shared with existing recovery.
   */
  closeBackupPath: string;
  /** Previous generation, preserved against bad overwrites. */
  closeBackupPreviousPath: string;
  closeTemporaryPath: string;
  /**
   * Database-only snapshot taken immediately before a destructive full-state
   * reset. Removed along with all older backups when the reset succeeds.
   */
  resetBackupPath: string;
  resetTemporaryPath: string;
}

export function getWorkspaceDatabaseBackupPaths(
  filePath: string,
): WorkspaceDatabaseBackupPaths {
  return {
    closeBackupPath: `${filePath}.backup`,
    closeBackupPreviousPath: `${filePath}.backup.prev`,
    closeTemporaryPath: `${filePath}.backup.tmp`,
    resetBackupPath: `${filePath}.reset-backup`,
    resetTemporaryPath: `${filePath}.reset-backup.tmp`,
  };
}

/**
 * All snapshots produced here are DATABASE-ONLY recovery points. They never
 * include generated resume documents, candidate assets, application
 * documents, or browser profile data, so they cannot restore the full
 * workspace after a destructive reset deletes those directories. They exist
 * solely to recover the SQLite workspace database itself.
 *
 * Snapshot writers never throw: persistence callers treat backup failures
 * as non-fatal and must still close or reset the workspace afterwards.
 */

async function writeSnapshot(
  input: { database: DatabaseSync },
  temporaryPath: string,
): Promise<void> {
  // A previous attempt may have been killed between VACUUM INTO and the
  // final rename. VACUUM INTO requires a nonexistent destination file.
  await rm(temporaryPath, { force: true });
  input.database.prepare("VACUUM INTO ?").run(temporaryPath);
  if (process.platform !== "win32") {
    // Match secureDatabaseFile permissions so private profile, resume,
    // and application data never become group/world readable.
    await chmod(temporaryPath, 0o600);
  }
}

/**
 * Writes a rotating background snapshot. On success the prior
 * `<filePath>.backup` generation is preserved as `<filePath>.backup.prev`
 * so one anomalous empty or damaged session cannot destroy the last known
 * good copy.
 */
export async function createWorkspaceDatabaseBackup(input: {
  filePath: string;
  signal?: AbortSignal;
}): Promise<WorkspaceDatabaseBackupStatus> {
  const { closeBackupPath, closeBackupPreviousPath, closeTemporaryPath } =
    getWorkspaceDatabaseBackupPaths(input.filePath);

  try {
    await rm(closeTemporaryPath, { force: true });
    const abortReason = () =>
      input.signal?.reason instanceof Error
        ? input.signal.reason
        : new Error("Database backup cancelled.");
    await new Promise<void>((resolve, reject) => {
      if (input.signal?.aborted) return reject(abortReason());
      // A process can be stopped even while SQLite is inside VACUUM. A worker
      // thread cannot interrupt that native call. Compacting also avoids
      // backing up the free pages left behind by storage migrations.
      const child = spawn(
        process.execPath,
        [
          "--input-type=commonjs",
          "-e",
          `
        const { DatabaseSync } = require("node:sqlite");
        const { chmodSync } = require("node:fs");
        const source = new DatabaseSync(process.argv[1], { readOnly: true });
        try {
          source.exec("PRAGMA busy_timeout = 1000");
          source.prepare("VACUUM main INTO ?").run(process.argv[2]);
          if (process.platform !== "win32") chmodSync(process.argv[2], 0o600);
        } finally { source.close(); }
      `,
          input.filePath,
          closeTemporaryPath,
        ],
        {
          // process.execPath is Electron in the desktop and Node in package tests.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
          stdio: "ignore",
        },
      );
      if (child.pid !== undefined) {
        try {
          setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          /* Best effort on restricted hosts. */
        }
      }
      const abort = () => {
        child.kill();
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("exit", (code) => {
        input.signal?.removeEventListener("abort", abort);
        if (input.signal?.aborted) reject(abortReason());
        else if (code !== 0)
          reject(new Error(`Database backup process exited ${code}.`));
        else resolve();
      });
    });
    input.signal?.throwIfAborted();
    await rename(closeBackupPath, closeBackupPreviousPath).catch((error) => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    await rename(closeTemporaryPath, closeBackupPath);
    return { status: "created", backupPath: closeBackupPath };
  } catch (error) {
    await rm(closeTemporaryPath, { force: true }).catch(() => undefined);
    return { status: "skipped", backupPath: closeBackupPath, reason: error };
  }
}

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A single cancellable background task; quitting never starts a backup. */
export function scheduleWorkspaceDatabaseBackups(input: {
  filePath: string;
  schemaVersion: number;
}): () => Promise<void> {
  const controller = new AbortController();
  let pending: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    let delay = BACKUP_INTERVAL_MS;
    try {
      const backupPath = getWorkspaceDatabaseBackupPaths(
        input.filePath,
      ).closeBackupPath;
      let due = true;
      try {
        const age = Date.now() - (await stat(backupPath)).mtimeMs;
        delay = Math.max(1, BACKUP_INTERVAL_MS - age);
        const previous = openDatabaseFile(backupPath, { readOnly: true });
        try {
          const row = previous
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get();
          due =
            age >= BACKUP_INTERVAL_MS || row?.version !== input.schemaVersion;
        } finally {
          previous.close();
        }
      } catch {
        /* Missing or unreadable recovery point needs a refresh. */
      }
      if (due && !controller.signal.aborted) {
        const result = await createWorkspaceDatabaseBackup({
          ...input,
          signal: controller.signal,
        });
        delay =
          result.status === "created" ? BACKUP_INTERVAL_MS : 60 * 60 * 1000;
        if (result.status === "skipped" && !controller.signal.aborted)
          console.warn(
            "[JobFinderRepository] Skipped background database backup.",
            result.reason,
          );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        console.warn(
          "[JobFinderRepository] Background database backup failed.",
          error,
        );
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        pending = run();
      }, delay);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => {
    pending = run();
  }, 0);
  timer.unref?.();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
  };
}

/**
 * Writes the pre-reset snapshot to the dedicated `<filePath>.reset-backup`
 * destination. It is retained only while the reset is in progress or has failed.
 */
export async function createWorkspaceResetDatabaseBackup(input: {
  database: DatabaseSync;
  filePath: string;
}): Promise<WorkspaceDatabaseBackupStatus> {
  const { resetBackupPath, resetTemporaryPath } =
    getWorkspaceDatabaseBackupPaths(input.filePath);

  try {
    await writeSnapshot(input, resetTemporaryPath);
    await rename(resetTemporaryPath, resetBackupPath);
    return { status: "created", backupPath: resetBackupPath };
  } catch (error) {
    await rm(resetTemporaryPath, { force: true }).catch(() => undefined);
    return { status: "skipped", backupPath: resetBackupPath, reason: error };
  }
}

/** Remove every managed snapshot after a successful destructive reset.
 * Failures propagate so callers cannot report permanent deletion prematurely.
 */
export async function removeWorkspaceDatabaseBackups(
  filePath: string,
): Promise<void> {
  for (const snapshotPath of Object.values({
    ...getWorkspaceDatabaseBackupPaths(filePath),
  })) {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${snapshotPath}${suffix}`, { force: true });
    }
  }
  const fileName = basename(filePath);
  for (const entry of await readdir(dirname(filePath), {
    withFileTypes: true,
  })) {
    const suffix = entry.name.slice(fileName.length);
    if (
      entry.isFile() &&
      entry.name.startsWith(fileName) &&
      /^\.before-(?:v\d+|discovery-progress)\.sqlite(?:-wal|-shm)?$/u.test(
        suffix,
      )
    )
      await rm(join(dirname(filePath), entry.name), { force: true });
  }
}

export type WorkspaceBackupReconciliationAction =
  | {
      code: "promoted-temporary-backup";
      sourcePath: string;
      targetPath: string;
    }
  | {
      code: "restored-backup-from-previous-generation";
      sourcePath: string;
      targetPath: string;
    }
  | { code: "removed-stale-temporary-backup"; path: string };

export type WorkspaceBackupReconciliationWarning =
  | { code: "invalid-temporary-backup-retained"; path: string; reason: unknown }
  | { code: "invalid-primary-backup-retained"; path: string; reason: unknown }
  | {
      code: "invalid-previous-generation-retained";
      path: string;
      reason: unknown;
    }
  | {
      code: "reconciliation-operation-failed";
      path: string;
      reason: unknown;
    };

export interface WorkspaceBackupReconciliationResult {
  readonly actions: ReadonlyArray<WorkspaceBackupReconciliationAction>;
  readonly warnings: ReadonlyArray<WorkspaceBackupReconciliationWarning>;
}

type SqliteSnapshotValidation =
  | { valid: true }
  | { valid: false; reason: unknown };

function validateSqliteSnapshot(
  candidatePath: string,
): SqliteSnapshotValidation {
  let candidate: DatabaseSync;
  try {
    candidate = openDatabaseFile(candidatePath, { readOnly: true });
  } catch (error) {
    return { valid: false, reason: error };
  }
  try {
    const check = candidate.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: unknown }
      | undefined;
    if (check?.integrity_check !== "ok") {
      return {
        valid: false,
        reason: new Error(
          `integrity_check reported ${String(check?.integrity_check)}`,
        ),
      };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error };
  } finally {
    candidate.close();
  }
}

async function snapshotFileExists(candidatePath: string): Promise<boolean> {
  try {
    await stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function secureSnapshotFile(snapshotPath: string): Promise<void> {
  if (process.platform === "win32") {
    return Promise.resolve();
  }
  // Match writeSnapshot permissions so promoted or restored snapshots never
  // become group/world readable.
  return chmod(snapshotPath, 0o600).catch(() => undefined);
}

async function reconcileTemporarySnapshotRotation(input: {
  backupPath: string;
  temporaryPath: string;
  actions: WorkspaceBackupReconciliationAction[];
  warnings: WorkspaceBackupReconciliationWarning[];
}): Promise<void> {
  const { backupPath, temporaryPath } = input;

  if (!(await snapshotFileExists(temporaryPath))) return;

  if (!(await snapshotFileExists(backupPath))) {
    const validation = validateSqliteSnapshot(temporaryPath);
    if (!validation.valid) {
      input.warnings.push({
        code: "invalid-temporary-backup-retained",
        path: temporaryPath,
        reason: validation.reason,
      });
      return;
    }
    await rename(temporaryPath, backupPath);
    await secureSnapshotFile(backupPath);
    input.actions.push({
      code: "promoted-temporary-backup",
      sourcePath: temporaryPath,
      targetPath: backupPath,
    });
    return;
  }

  // The stale temporary is only removable while the primary it would
  // duplicate still validates; an unusable primary means the temporary may
  // be the last recoverable copy and must be retained.
  const primaryValidation = validateSqliteSnapshot(backupPath);
  if (!primaryValidation.valid) {
    input.warnings.push({
      code: "invalid-primary-backup-retained",
      path: backupPath,
      reason: primaryValidation.reason,
    });
    return;
  }
  await rm(temporaryPath, { force: true });
  input.actions.push({
    code: "removed-stale-temporary-backup",
    path: temporaryPath,
  });
}

async function reconcilePreviousGenerationFallback(input: {
  backupPath: string;
  previousPath: string;
  temporaryPath: string;
  actions: WorkspaceBackupReconciliationAction[];
  warnings: WorkspaceBackupReconciliationWarning[];
}): Promise<void> {
  const { backupPath, previousPath } = input;

  if (await snapshotFileExists(backupPath)) return;
  if (await snapshotFileExists(input.temporaryPath)) return;
  if (!(await snapshotFileExists(previousPath))) return;

  const validation = validateSqliteSnapshot(previousPath);
  if (!validation.valid) {
    input.warnings.push({
      code: "invalid-previous-generation-retained",
      path: previousPath,
      reason: validation.reason,
    });
    return;
  }
  await copyFile(previousPath, backupPath);
  await secureSnapshotFile(backupPath);
  input.actions.push({
    code: "restored-backup-from-previous-generation",
    sourcePath: previousPath,
    targetPath: backupPath,
  });
}

/**
 * Recovers background and pre-reset snapshot destinations after a
 * process was killed between the renames of a rotation. Candidates are only
 * promoted, copied, or removed once they validate as readable SQLite files;
 * anything invalid is retained in place and reported as a warning so callers
 * can emit telemetry. Healthy workspaces reconcile to a no-op, making the
 * call safe on every startup.
 */
export async function reconcileWorkspaceBackupRotation(
  filePath: string,
): Promise<WorkspaceBackupReconciliationResult> {
  const {
    closeBackupPath,
    closeBackupPreviousPath,
    closeTemporaryPath,
    resetBackupPath,
    resetTemporaryPath,
  } = getWorkspaceDatabaseBackupPaths(filePath);

  const actions: WorkspaceBackupReconciliationAction[] = [];
  const warnings: WorkspaceBackupReconciliationWarning[] = [];

  async function runStep(step: () => Promise<void>, reportedPath: string) {
    try {
      await step();
    } catch (error) {
      warnings.push({
        code: "reconciliation-operation-failed",
        path: reportedPath,
        reason: error,
      });
    }
  }

  await runStep(async () => {
    await reconcileTemporarySnapshotRotation({
      backupPath: closeBackupPath,
      temporaryPath: closeTemporaryPath,
      actions,
      warnings,
    });
    await reconcilePreviousGenerationFallback({
      backupPath: closeBackupPath,
      previousPath: closeBackupPreviousPath,
      temporaryPath: closeTemporaryPath,
      actions,
      warnings,
    });
  }, closeBackupPath);

  await runStep(async () => {
    await reconcileTemporarySnapshotRotation({
      backupPath: resetBackupPath,
      temporaryPath: resetTemporaryPath,
      actions,
      warnings,
    });
  }, resetBackupPath);

  return { actions, warnings };
}
