import { existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  getWorkspaceDatabaseBackupPaths,
  removeWorkspaceDatabaseBackups,
} from "./file-repository-backup";
import { openDatabaseFile, runMigrations } from "./internal/migrations";
import { hasPersistedState } from "./internal/state";

export type WorkspaceRecoveryCandidateKind = "backup" | "backup-prev";

export type WorkspaceRecoverySqliteErrorCode =
  | "SQLITE_CORRUPT"
  | "SQLITE_NOTADB";

export type WorkspaceRecoveryValidationStage =
  | "open"
  | "migrate"
  | "integrity-check"
  | "persisted-state";

export type WorkspaceDatabaseFailureClassification =
  | {
      status: "corrupt";
      evidence: "reported-error-code" | "failed-integrity-check";
      sqliteErrorCode: WorkspaceRecoverySqliteErrorCode | null;
    }
  | {
      status: "not-corruption";
      evidence: "clean-integrity-check";
      sqliteErrorCode: WorkspaceRecoverySqliteErrorCode | null;
    }
  | {
      status: "inconclusive";
      evidence: "source-missing" | "probe-unavailable";
      sqliteErrorCode: WorkspaceRecoverySqliteErrorCode | null;
    };

export type WorkspaceRecoveryCandidateStatus =
  | { kind: WorkspaceRecoveryCandidateKind; status: "missing" }
  | { kind: WorkspaceRecoveryCandidateKind; status: "valid" }
  | {
      kind: WorkspaceRecoveryCandidateKind;
      status: "invalid";
      failedStage: WorkspaceRecoveryValidationStage;
      sqliteErrorCode: WorkspaceRecoverySqliteErrorCode | null;
    };

export interface WorkspaceRecoveryLossWindowInputs {
  detectedAtIso: string;
  quarantinedDatabaseModifiedAtIso: string | null;
  restoredSnapshotModifiedAtIso: string | null;
}

export interface WorkspaceRecoveryEnvironment {
  now(): Date;
  createIncidentId(): string;
}

/**
 * Final gate run against the isolated restore temporary immediately before
 * promotion. Implementations MUST be at least as strict as candidate
 * evaluation: open `restoredTempPath` in isolation (never the live path),
 * apply migrations, run a full `PRAGMA integrity_check`, and require
 * persisted state. Candidate validation alone is not sufficient: the selected
 * snapshot can change on disk between evaluation and the restore copy, and
 * only this gate sees the exact bytes that would be promoted. Returning false
 * (or throwing) must leave the live database path untouched; the core then
 * reports `restore-failed` with quarantine and candidates retained.
 */
export type RestoredSnapshotRevalidator = (input: {
  restoredTempPath: string;
}) => Promise<boolean> | boolean;

export interface WorkspaceRecoveryValidationOverrides {
  runMigrations?: (database: DatabaseSync) => void;
  hasPersistedState?: (database: DatabaseSync) => boolean;
}

/**
 * Narrow filesystem/sqlite seams for tests. Production callers omit `io` and
 * get real node:fs and node:sqlite behavior.
 */
export interface WorkspaceRecoveryIoOverrides {
  copyFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
  chmod?: (targetPath: string, mode: number) => Promise<void>;
  openDatabase?: (databasePath: string) => DatabaseSync;
}

interface RecoveryIo {
  copyFile: (sourcePath: string, destinationPath: string) => Promise<void>;
  chmod: (targetPath: string, mode: number) => Promise<void>;
  openDatabase: (databasePath: string) => DatabaseSync;
}

function resolveRecoveryIo(
  overrides?: WorkspaceRecoveryIoOverrides,
): RecoveryIo {
  return {
    copyFile: overrides?.copyFile ?? copyFile,
    chmod: overrides?.chmod ?? chmod,
    openDatabase:
      overrides?.openDatabase ??
      ((databasePath: string) => openDatabaseFile(databasePath)),
  };
}

export interface ClassifyWorkspaceDatabaseFailureInput {
  filePath: string;
  openError: unknown;
  environment: WorkspaceRecoveryEnvironment;
  io?: WorkspaceRecoveryIoOverrides;
}

export interface RecoverWorkspaceDatabaseInput {
  filePath: string;
  openError: unknown;
  environment: WorkspaceRecoveryEnvironment;
  revalidateRestoredSnapshot: RestoredSnapshotRevalidator;
  validation?: WorkspaceRecoveryValidationOverrides;
  io?: WorkspaceRecoveryIoOverrides;
}

export interface WorkspaceRecoveryCandidate {
  kind: WorkspaceRecoveryCandidateKind;
  path: string;
}

export type WorkspaceDatabaseRecoveryResult =
  | {
      outcome: "restored";
      incidentId: string;
      classification: Extract<
        WorkspaceDatabaseFailureClassification,
        { status: "corrupt" }
      >;
      candidates: WorkspaceRecoveryCandidateStatus[];
      restoredFrom: WorkspaceRecoveryCandidateKind;
      quarantinedArtifacts: string[];
      lossWindow: WorkspaceRecoveryLossWindowInputs;
    }
  | {
      outcome: "not-attempted";
      incidentId: string;
      classification: WorkspaceDatabaseFailureClassification;
      reason:
        | "source-not-corrupt"
        | "source-inconclusive"
        | "no-valid-candidate";
      candidates: WorkspaceRecoveryCandidateStatus[];
      restoredFrom: null;
      quarantinedArtifacts: [];
    }
  | {
      outcome: "restore-failed";
      incidentId: string;
      classification: Extract<
        WorkspaceDatabaseFailureClassification,
        { status: "corrupt" }
      >;
      reason:
        | "quarantine-incomplete"
        | "restore-revalidation-rejected"
        | "restore-promotion-failed";
      candidates: WorkspaceRecoveryCandidateStatus[];
      restoredFrom: null;
      quarantinedArtifacts: string[];
    };

/**
 * Automatic candidates are the two completed rotating background snapshots.
 * `<filePath>.reset-backup` is deliberately absent: it captures pre-reset
 * state whose reuse is a caller policy decision, never an automatic one.
 */
export const workspaceRecoveryCandidateKinds: readonly WorkspaceRecoveryCandidateKind[] =
  ["backup", "backup-prev"];

const corruptingSqliteErrorCodes: Readonly<
  Record<number, WorkspaceRecoverySqliteErrorCode>
> = {
  11: "SQLITE_CORRUPT",
  26: "SQLITE_NOTADB",
};

function readReportedSqliteErrorCode(
  error: unknown,
): WorkspaceRecoverySqliteErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    errcode?: unknown;
    code?: unknown;
    errstr?: unknown;
  };
  if (typeof candidate.errcode === "number") {
    // SQLite reports extended codes (e.g. SQLITE_CORRUPT_VTAB = 0x20b);
    // classification keys on primary codes only.
    const primaryCode = candidate.errcode & 0xff;
    return corruptingSqliteErrorCodes[primaryCode] ?? null;
  }
  for (const value of [candidate.code, candidate.errstr]) {
    if (value === "SQLITE_CORRUPT" || value === "SQLITE_NOTADB") {
      return value;
    }
  }
  return null;
}

function runIntegrityCheck(database: DatabaseSync): boolean {
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check?: unknown;
  }>;
  return rows.length > 0 && rows.every((row) => row.integrity_check === "ok");
}

function closeQuietly(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // A broken probe connection must never mask the classification result.
  }
}

/**
 * Removes only probe/restore temporaries created by this module. Suspect
 * databases, snapshots, and sidecars are never deleted or overwritten.
 */
async function removeRecoveryTemporaries(tempPath: string): Promise<void> {
  await Promise.all([
    rm(tempPath, { force: true }),
    rm(`${tempPath}-wal`, { force: true }),
    rm(`${tempPath}-shm`, { force: true }),
  ]).catch(() => undefined);
  // Forward migrations of an isolated validation copy can create their own
  // pre-migration snapshots. They belong to the throwaway probe too.
  await removeWorkspaceDatabaseBackups(tempPath).catch(() => undefined);
}

/**
 * Permissions are hardening, not correctness: a chmod failure must never
 * abort quarantine or promotion mid-move, matching the backup helper's
 * best-effort securing of snapshots.
 */
async function secureRecoveredFileBestEffort(
  io: RecoveryIo,
  targetPath: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await io.chmod(targetPath, 0o600).catch(() => undefined);
}

async function classifyWithIncidentId(input: {
  filePath: string;
  openError: unknown;
  incidentId: string;
  io: RecoveryIo;
}): Promise<WorkspaceDatabaseFailureClassification> {
  const reportedCode = readReportedSqliteErrorCode(input.openError);
  if (!existsSync(input.filePath)) {
    return {
      status: "inconclusive",
      evidence: "source-missing",
      sqliteErrorCode: reportedCode,
    };
  }

  const probePath = `${input.filePath}.recovery-integrity-${input.incidentId}.tmp`;
  try {
    try {
      await removeRecoveryTemporaries(probePath);
      await input.io.copyFile(input.filePath, probePath);
      // Stage existing sidecars under the probe basename so SQLite replays
      // the WAL/shm pair that accompanied the failing open instead of judging
      // a healthy checkpointed main file in isolation.
      const sourceWalPath = `${input.filePath}-wal`;
      const sourceShmPath = `${input.filePath}-shm`;
      if (existsSync(sourceWalPath)) {
        await input.io.copyFile(sourceWalPath, `${probePath}-wal`);
      }
      if (existsSync(sourceShmPath)) {
        await input.io.copyFile(sourceShmPath, `${probePath}-shm`);
      }
    } catch {
      return {
        status: "inconclusive",
        evidence: "probe-unavailable",
        sqliteErrorCode: reportedCode,
      };
    }

    let probe: DatabaseSync | null = null;
    let probeErrorCode: WorkspaceRecoverySqliteErrorCode | null = null;
    let integrityOk: boolean | null = null;
    try {
      probe = input.io.openDatabase(probePath);
    } catch (error) {
      probeErrorCode = readReportedSqliteErrorCode(error);
      if (probeErrorCode === null) {
        return {
          status: "inconclusive",
          evidence: "probe-unavailable",
          sqliteErrorCode: reportedCode,
        };
      }
    }
    if (probe !== null) {
      try {
        integrityOk = runIntegrityCheck(probe);
      } catch (error) {
        probeErrorCode = readReportedSqliteErrorCode(error);
      } finally {
        closeQuietly(probe);
      }
    }

    if (integrityOk === true) {
      // The safe probe set passes integrity_check, so a stale corruption code
      // is not evidence about the current files: treat migration/programming
      // errors as not-corruption and leave every file untouched.
      return {
        status: "not-corruption",
        evidence: "clean-integrity-check",
        sqliteErrorCode: reportedCode,
      };
    }
    if (integrityOk === false || probeErrorCode !== null) {
      return {
        status: "corrupt",
        evidence:
          reportedCode !== null
            ? "reported-error-code"
            : "failed-integrity-check",
        sqliteErrorCode: reportedCode ?? probeErrorCode,
      };
    }
    return {
      status: "inconclusive",
      evidence: "probe-unavailable",
      sqliteErrorCode: reportedCode,
    };
  } finally {
    await removeRecoveryTemporaries(probePath);
  }
}

/**
 * Classifies a failed workspace open without mutating any file. The source is
 * judged on a throwaway probe set: the main copy plus any existing
 * `-wal`/`-shm` sidecars staged under the probe basename, opened in isolation
 * so SQLite replays the same pair that failed, then measured with a full
 * `PRAGMA integrity_check`; the reported SQLite error code only corroborates
 * the verdict. Residual limit: SQLite validates cumulative WAL frame
 * checksums and rolls back damaged frames to the last committed transaction,
 * so WAL bit rot often replays cleanly instead of surfacing as corruption.
 * Detection of such WAL-resident damage therefore depends on replay-time
 * errors surfacing at probe open or integrity_check, which the injected `io`
 * seams exercise in tests.
 */
export async function classifyWorkspaceDatabaseFailure(
  input: ClassifyWorkspaceDatabaseFailureInput,
): Promise<WorkspaceDatabaseFailureClassification> {
  return classifyWithIncidentId({
    filePath: input.filePath,
    openError: input.openError,
    incidentId: input.environment.createIncidentId(),
    io: resolveRecoveryIo(input.io),
  });
}

export function listWorkspaceRecoveryCandidates(
  filePath: string,
): WorkspaceRecoveryCandidate[] {
  const backupPaths = getWorkspaceDatabaseBackupPaths(filePath);
  return [
    { kind: "backup", path: backupPaths.closeBackupPath },
    { kind: "backup-prev", path: backupPaths.closeBackupPreviousPath },
  ];
}

export type WorkspaceQuarantineArtifactKind = "database" | "wal" | "shm";

export interface WorkspaceQuarantineArtifact {
  kind: WorkspaceQuarantineArtifactKind;
  basename: string;
  path: string;
}

const quarantineTailPattern =
  /\.quarantine-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9._-]+(?:-r\d+)?$/u;

/**
 * Enumerates prior quarantine artifacts this module produced for `filePath`
 * so callers can detect salvageable state before deciding policy. Only
 * regular files matching the quarantine naming scheme for this database
 * (including collision-renamed `-r<n>` variants) are returned; symlinks,
 * directories, and unexpected names are skipped. The helper reads a single
 * directory listing and never modifies, deletes, or follows anything.
 */
export function listWorkspaceQuarantineArtifacts(
  filePath: string,
): WorkspaceQuarantineArtifact[] {
  const databaseBasename = basename(filePath);
  const directory = dirname(filePath);
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const databaseStem = `${databaseBasename}.quarantine-`;
  const walStem = `${databaseBasename}-wal.quarantine-`;
  const shmStem = `${databaseBasename}-shm.quarantine-`;
  const artifacts: WorkspaceQuarantineArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (
      !name.startsWith(databaseStem) &&
      !name.startsWith(walStem) &&
      !name.startsWith(shmStem)
    ) {
      continue;
    }
    const tailMatch = quarantineTailPattern.exec(name);
    if (tailMatch === null || tailMatch.index === 0) continue;
    const stem = name.slice(0, tailMatch.index);
    const kind =
      stem === databaseBasename
        ? "database"
        : stem === `${databaseBasename}-wal`
          ? "wal"
          : stem === `${databaseBasename}-shm`
            ? "shm"
            : null;
    if (kind === null) continue;
    artifacts.push({ kind, basename: name, path: join(directory, name) });
  }
  return artifacts.sort((left, right) =>
    left.basename < right.basename
      ? -1
      : left.basename > right.basename
        ? 1
        : 0,
  );
}

/** Permanent reset removes recovery copies too, including interrupted probes. */
export async function removeWorkspaceRecoveryArtifacts(
  filePath: string,
): Promise<void> {
  const databaseBasename = basename(filePath);
  const directory = dirname(filePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const temporaryTail =
    /^\.(?:recovery-integrity-|recovery-validate-(?:backup|backup-prev)-|restore-)[A-Za-z0-9._-]+\.tmp(?:(?:-wal|-shm)|\.before-(?:v\d+|discovery-progress)\.sqlite(?:-wal|-shm)?)?$/u;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const tail = entry.name.slice(databaseBasename.length);
    const isTemporary =
      entry.name.startsWith(databaseBasename) && temporaryTail.test(tail);
    const quarantine = quarantineTailPattern.exec(entry.name);
    const stem = quarantine ? entry.name.slice(0, quarantine.index) : null;
    const isQuarantine =
      stem !== null &&
      [
        databaseBasename,
        `${databaseBasename}-wal`,
        `${databaseBasename}-shm`,
      ].includes(stem);
    if (isTemporary || isQuarantine)
      await rm(join(directory, entry.name), { force: true });
  }
}

function invalidCandidateStatus(
  kind: WorkspaceRecoveryCandidateKind,
  failedStage: WorkspaceRecoveryValidationStage,
  error: unknown,
): WorkspaceRecoveryCandidateStatus {
  return {
    kind,
    status: "invalid",
    failedStage,
    sqliteErrorCode: readReportedSqliteErrorCode(error),
  };
}

async function evaluateRecoveryCandidate(input: {
  kind: WorkspaceRecoveryCandidateKind;
  candidatePath: string;
  filePath: string;
  incidentId: string;
  overrides: WorkspaceRecoveryValidationOverrides;
  io: RecoveryIo;
}): Promise<WorkspaceRecoveryCandidateStatus> {
  if (!existsSync(input.candidatePath)) {
    return { kind: input.kind, status: "missing" };
  }

  const probePath = `${input.filePath}.recovery-validate-${input.kind}-${input.incidentId}.tmp`;
  try {
    await removeRecoveryTemporaries(probePath);
    // Completed SQLite backups are self-contained single files
    // with no WAL sidecars to stage.
    await input.io.copyFile(input.candidatePath, probePath);

    let database: DatabaseSync;
    try {
      database = input.io.openDatabase(probePath);
    } catch (error) {
      return invalidCandidateStatus(input.kind, "open", error);
    }
    try {
      try {
        (input.overrides.runMigrations ?? runMigrations)(database);
      } catch (error) {
        return invalidCandidateStatus(input.kind, "migrate", error);
      }
      try {
        if (!runIntegrityCheck(database)) {
          return invalidCandidateStatus(input.kind, "integrity-check", null);
        }
      } catch (error) {
        return invalidCandidateStatus(input.kind, "integrity-check", error);
      }
      try {
        const hasState = input.overrides.hasPersistedState ?? hasPersistedState;
        if (!hasState(database)) {
          return invalidCandidateStatus(input.kind, "persisted-state", null);
        }
      } catch (error) {
        return invalidCandidateStatus(input.kind, "persisted-state", error);
      }
      return { kind: input.kind, status: "valid" };
    } finally {
      closeQuietly(database);
    }
  } finally {
    await removeRecoveryTemporaries(probePath);
  }
}

interface QuarantinedSuspectArtifact {
  originalPath: string;
  quarantinedPath: string;
  modifiedAtMs: number | null;
}

function incidentStampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function suspectWorkspacePaths(filePath: string): string[] {
  return [filePath, `${filePath}-wal`, `${filePath}-shm`];
}

async function quarantineSuspectFile(input: {
  suspectPath: string;
  incidentId: string;
  stamp: string;
  io: RecoveryIo;
}): Promise<QuarantinedSuspectArtifact | null> {
  if (!existsSync(input.suspectPath)) {
    return null;
  }
  const modifiedAtMs = (await stat(input.suspectPath)).mtimeMs;
  const directory = dirname(input.suspectPath);
  const originalName = basename(input.suspectPath);
  const stem = `${originalName}.quarantine-${input.stamp}-${input.incidentId}`;
  let quarantinedPath = join(directory, stem);
  let collisionCount = 0;
  while (existsSync(quarantinedPath)) {
    collisionCount += 1;
    quarantinedPath = join(directory, `${stem}-r${collisionCount}`);
  }
  await rename(input.suspectPath, quarantinedPath);
  await secureRecoveredFileBestEffort(input.io, quarantinedPath);
  return { originalPath: input.suspectPath, quarantinedPath, modifiedAtMs };
}

/**
 * Single-pass corruption recovery for the workspace database. Classifies the
 * failed open, validates the rotating close backups on isolated copies in
 * order, and only when one validates quarantines the suspect files and
 * promotes the snapshot. There is no fresh-start fallback and no retry loop:
 * callers own policy, dialogs, and recovery ledgers.
 */
export async function recoverWorkspaceDatabase(
  input: RecoverWorkspaceDatabaseInput,
): Promise<WorkspaceDatabaseRecoveryResult> {
  const incidentId = input.environment.createIncidentId();
  const detectedAt = input.environment.now();
  const io = resolveRecoveryIo(input.io);

  const classification = await classifyWithIncidentId({
    filePath: input.filePath,
    openError: input.openError,
    incidentId,
    io,
  });

  if (classification.status !== "corrupt") {
    return {
      outcome: "not-attempted",
      incidentId,
      classification,
      reason:
        classification.status === "not-corruption"
          ? "source-not-corrupt"
          : "source-inconclusive",
      candidates: [],
      restoredFrom: null,
      quarantinedArtifacts: [],
    };
  }

  const overrides = input.validation ?? {};
  const candidates: WorkspaceRecoveryCandidateStatus[] = [];
  let selected: WorkspaceRecoveryCandidate | null = null;
  for (const candidate of listWorkspaceRecoveryCandidates(input.filePath)) {
    const status = await evaluateRecoveryCandidate({
      kind: candidate.kind,
      candidatePath: candidate.path,
      filePath: input.filePath,
      incidentId,
      overrides,
      io,
    });
    candidates.push(status);
    if (status.status === "valid" && selected === null) {
      selected = candidate;
    }
  }

  if (selected === null) {
    return {
      outcome: "not-attempted",
      incidentId,
      classification,
      reason: "no-valid-candidate",
      candidates,
      restoredFrom: null,
      quarantinedArtifacts: [],
    };
  }

  const snapshotModifiedAtMs = (await stat(selected.path)).mtimeMs;

  const stamp = incidentStampFor(detectedAt);
  const quarantined: QuarantinedSuspectArtifact[] = [];
  try {
    for (const suspectPath of suspectWorkspacePaths(input.filePath)) {
      const artifact = await quarantineSuspectFile({
        suspectPath,
        incidentId,
        stamp,
        io,
      });
      if (artifact !== null) {
        quarantined.push(artifact);
      }
    }
  } catch {
    return {
      outcome: "restore-failed",
      incidentId,
      classification,
      reason: "quarantine-incomplete",
      candidates,
      restoredFrom: null,
      quarantinedArtifacts: quarantined.map((artifact) =>
        basename(artifact.quarantinedPath),
      ),
    };
  }
  const quarantinedArtifacts = quarantined.map((artifact) =>
    basename(artifact.quarantinedPath),
  );
  const quarantinedMain =
    quarantined.find((artifact) => artifact.originalPath === input.filePath) ??
    null;

  const restoreTempPath = `${input.filePath}.restore-${incidentId}.tmp`;
  try {
    await removeRecoveryTemporaries(restoreTempPath);
    await io.copyFile(selected.path, restoreTempPath);
    await secureRecoveredFileBestEffort(io, restoreTempPath);
    let accepted = false;
    try {
      accepted =
        (await input.revalidateRestoredSnapshot({
          restoredTempPath: restoreTempPath,
        })) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      await removeRecoveryTemporaries(restoreTempPath);
      return {
        outcome: "restore-failed",
        incidentId,
        classification,
        reason: "restore-revalidation-rejected",
        candidates,
        restoredFrom: null,
        quarantinedArtifacts,
      };
    }
    await rename(restoreTempPath, input.filePath);
    await secureRecoveredFileBestEffort(io, input.filePath);
    return {
      outcome: "restored",
      incidentId,
      classification,
      candidates,
      restoredFrom: selected.kind,
      quarantinedArtifacts,
      lossWindow: {
        detectedAtIso: detectedAt.toISOString(),
        quarantinedDatabaseModifiedAtIso:
          quarantinedMain?.modifiedAtMs != null
            ? new Date(quarantinedMain.modifiedAtMs).toISOString()
            : null,
        restoredSnapshotModifiedAtIso: new Date(
          snapshotModifiedAtMs,
        ).toISOString(),
      },
    };
  } catch {
    await removeRecoveryTemporaries(restoreTempPath);
    return {
      outcome: "restore-failed",
      incidentId,
      classification,
      reason: "restore-promotion-failed",
      candidates,
      restoredFrom: null,
      quarantinedArtifacts,
    };
  }
}
