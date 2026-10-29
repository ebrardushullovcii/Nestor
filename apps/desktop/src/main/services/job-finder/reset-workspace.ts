import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { JobFinderActivityControl } from "@nestor/contracts";
import {
  RESET_IN_PROGRESS_PAUSE,
  createActivityControlStore,
  resetJobStore,
} from "@nestor/db/job-store";
import {
  getJobFinderResetIntentFilePath,
  getJobFinderResetInvalidIntentMarkerFilePath,
  getJobFinderResetTrashDirectory,
  getJobFinderResetTrashRootDirectory,
  getJobFinderUserDataDirectory,
  resolveJobFinderWorkspaceRelativePath,
} from "./paths";
import {
  JOB_FINDER_RESET_TRASH_DIRECTORY_PREFIX,
  MAX_RESET_INTENT_MARKER_BYTES,
  RESET_INTENT_MARKER_VERSION,
  isRecord,
  listResetSourceRelativePaths,
  parseResetIntentMarker,
  recordStartupResetRecoveryFact,
  type JobFinderResetIntent,
  type JobFinderResetIntentEntry,
} from "./reset-intent-marker";

export {
  getJobFinderStartupResetRecoveryFact,
  type JobFinderResetIntent,
  type JobFinderResetIntentEntry,
} from "./reset-intent-marker";
import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { discardJobSearch } from "../job-commands";
import { getJobStore } from "../job-store";

const RESET_TRASH_DIRECTORY_NAME_PATTERN =
  /^job-finder-reset-[a-zA-Z0-9-]{8,64}$/;
const RESET_MARKER_TEMP_FILE_NAME_PATTERN =
  /^job-finder-reset-intent\.json\.[a-zA-Z0-9-]{8,64}\.tmp$/;
const RESET_QUARANTINE_SIDECAR_SUFFIX = ".pending-trash.json";
const RESET_QUARANTINE_SIDECAR_VERSION = 1;
const RESET_QUARANTINE_SIDECAR_FILE_NAME_PATTERN = new RegExp(
  `^job-finder-reset-intent\\.invalid-.+\\.json${RESET_QUARANTINE_SIDECAR_SUFFIX}$`,
);
const RESET_QUARANTINE_SIDECAR_TEMP_FILE_NAME_PATTERN = new RegExp(
  `^job-finder-reset-intent\\.invalid-.+\\.json${RESET_QUARANTINE_SIDECAR_SUFFIX}\\.tmp$`,
);
const RESET_ARTIFACT_STALE_MS = 60 * 60 * 1000;

export type JobFinderResetRecoveryOutcome =
  | { status: "idle" }
  | { status: "completed"; token: string }
  | {
      status: "quarantined";
      reason: "malformed" | "oversized" | "with_pending_trash";
      quarantinedFileName: string | null;
    };

interface ResetIntentRollbackResult {
  restoredAll: boolean;
  markerRemoved: boolean;
  unrestoredSourcePaths: readonly string[];
}

export class JobFinderResetFileMoveError extends Error {
  readonly restoredAllMovedSources: boolean;
  readonly markerRemoved: boolean;
  readonly unrestoredSourcePathCount: number;

  constructor(input: {
    originalError: unknown;
    rollback: ResetIntentRollbackResult;
  }) {
    super(buildFailedResetFileMoveMessage(input), {
      cause: input.originalError,
    });
    this.name = "JobFinderResetFileMoveError";
    this.restoredAllMovedSources = input.rollback.restoredAll;
    this.markerRemoved = input.rollback.markerRemoved;
    this.unrestoredSourcePathCount =
      input.rollback.unrestoredSourcePaths.length;
  }
}

function isNodeFileSystemNotFoundError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT");
}

function isNodeFileSystemNotDirectoryError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOTDIR");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildFailedResetFileMoveMessage(input: {
  originalError: unknown;
  rollback: ResetIntentRollbackResult;
}): string {
  const restorationDetail = input.rollback.restoredAll
    ? "all moved files were restored"
    : `${input.rollback.unrestoredSourcePaths.length} moved file(s) remain in the reset trash`;
  const markerDetail = input.rollback.markerRemoved
    ? "the pending reset marker was removed, so the next launch will not reset anything"
    : "the pending reset marker was retained, so the next launch completes the reset during startup recovery";

  return `[Desktop] Job Finder workspace reset stopped before completion (${describeUnknownError(input.originalError)}); ${restorationDetail}, and ${markerDetail}.`;
}

function buildResetIntentEntries(token: string): JobFinderResetIntentEntry[] {
  return listResetSourceRelativePaths().map((sourcePath) => ({
    sourcePath,
    trashPath: `trash/${JOB_FINDER_RESET_TRASH_DIRECTORY_PREFIX}${token}/${sourcePath}`,
  }));
}

async function syncFilePath(filePath: string) {
  // Opened for update, not for reading: Windows refuses fsync on a read-only
  // handle with EPERM, which aborted every workspace reset there before a
  // single file had been moved. POSIX is happy either way.
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryBestEffort(directoryPath: string) {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory flushing is unsupported on some platforms; the synced marker
    // file plus the atomic rename already bound the durability window.
  }
}

async function writeResetIntentMarker(intent: JobFinderResetIntent) {
  const markerPath = getJobFinderResetIntentFilePath();
  const temporaryMarkerPath = `${markerPath}.${intent.token}.tmp`;
  const markerPayload = {
    version: RESET_INTENT_MARKER_VERSION,
    token: intent.token,
    createdAt: new Date().toISOString(),
    entries: intent.entries.map((entry) => ({
      sourcePath: entry.sourcePath,
      trashPath: entry.trashPath,
    })),
  };

  await writeFile(
    temporaryMarkerPath,
    `${JSON.stringify(markerPayload)}\n`,
    "utf8",
  );
  await syncFilePath(temporaryMarkerPath);
  try {
    await rename(temporaryMarkerPath, markerPath);
  } catch (error) {
    await rm(temporaryMarkerPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(path.dirname(markerPath));
}

async function moveSingleResetIntentSourceToTrash(
  entry: JobFinderResetIntentEntry,
): Promise<boolean> {
  const sourceAbsolutePath = resolveJobFinderWorkspaceRelativePath(
    entry.sourcePath,
  );
  const trashAbsolutePath = resolveJobFinderWorkspaceRelativePath(
    entry.trashPath,
  );

  await mkdir(path.dirname(trashAbsolutePath), { recursive: true });
  try {
    await rename(sourceAbsolutePath, trashAbsolutePath);
  } catch (error) {
    if (isNodeFileSystemNotFoundError(error)) {
      return false;
    }
    throw error;
  }
  return true;
}

async function moveResetIntentSourcesToTrash(
  intent: JobFinderResetIntent,
): Promise<readonly JobFinderResetIntentEntry[]> {
  const movedEntries: JobFinderResetIntentEntry[] = [];
  for (const entry of intent.entries) {
    const moved = await moveSingleResetIntentSourceToTrash(entry);
    if (moved) {
      movedEntries.push(entry);
    }
  }
  return movedEntries;
}

async function restoreMovedResetIntentSources(
  movedEntries: readonly JobFinderResetIntentEntry[],
): Promise<Omit<ResetIntentRollbackResult, "markerRemoved">> {
  const unrestoredSourcePaths: string[] = [];

  for (const entry of [...movedEntries].reverse()) {
    try {
      await rename(
        resolveJobFinderWorkspaceRelativePath(entry.trashPath),
        resolveJobFinderWorkspaceRelativePath(entry.sourcePath),
      );
    } catch (error) {
      if (!isNodeFileSystemNotFoundError(error)) {
        unrestoredSourcePaths.push(entry.sourcePath);
      }
    }
  }

  return {
    restoredAll: unrestoredSourcePaths.length === 0,
    unrestoredSourcePaths,
  };
}

async function compensateFailedResetFileMoves(
  originalError: unknown,
  movedEntries: readonly JobFinderResetIntentEntry[],
): Promise<JobFinderResetFileMoveError> {
  const rollback = await restoreMovedResetIntentSources(movedEntries);

  let markerRemoved = false;
  if (rollback.restoredAll) {
    try {
      await removeResetIntentMarker();
      markerRemoved = true;
    } catch (markerRemovalError) {
      console.warn(
        "[Desktop] The Job Finder workspace files were restored, but the pending reset marker could not be removed; startup recovery completes the reset on the next launch.",
        markerRemovalError,
      );
    }
  } else {
    console.warn(
      `[Desktop] ${rollback.unrestoredSourcePaths.length} moved Job Finder location(s) could not be restored after a failed reset; retaining the pending reset marker so the next startup completes the reset.`,
      originalError,
    );
  }

  return new JobFinderResetFileMoveError({
    originalError,
    rollback: { ...rollback, markerRemoved },
  });
}

async function removeResetIntentMarker() {
  await rm(getJobFinderResetIntentFilePath(), { force: true });
  await syncDirectoryBestEffort(
    path.dirname(getJobFinderResetIntentFilePath()),
  );
}

async function removeResetTrashDirectory(token: string) {
  try {
    await rm(getJobFinderResetTrashDirectory(token), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.warn(
      "[Desktop] Failed to clean the Job Finder reset trash directory; the workspace reset itself already succeeded.",
      error,
    );
  }
}

async function isStaleResetArtifactPath(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath);
    return Date.now() - stats.mtimeMs >= RESET_ARTIFACT_STALE_MS;
  } catch {
    return false;
  }
}

function warnSkippedStaleResetArtifact(artifactName: string, error: unknown) {
  console.warn(
    `[Desktop] A stale Job Finder reset artifact (${artifactName}) could not be cleaned up; it is left in place and nothing else was touched.`,
    error,
  );
}

interface ResetQuarantinePendingTrashSidecar {
  version: number;
  quarantinedAt: string;
  pendingTrashDirectoryNames: readonly string[];
}

async function readProtectedResetToken(): Promise<string | null> {
  try {
    const rawMarker = await readFile(getJobFinderResetIntentFilePath(), "utf8");
    return parseResetIntentMarker(rawMarker).token;
  } catch {
    return null;
  }
}

function getQuarantinePendingTrashSidecarFilePath(quarantinedFileName: string) {
  return path.join(
    getJobFinderUserDataDirectory(),
    `${quarantinedFileName}${RESET_QUARANTINE_SIDECAR_SUFFIX}`,
  );
}

function parsePendingTrashDirectoryNames(
  rawSidecar: string,
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawSidecar);
  } catch {
    return [];
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== RESET_QUARANTINE_SIDECAR_VERSION
  ) {
    return [];
  }

  if (!Array.isArray(parsed.pendingTrashDirectoryNames)) {
    return [];
  }

  return parsed.pendingTrashDirectoryNames.filter(
    (name): name is string =>
      typeof name === "string" && RESET_TRASH_DIRECTORY_NAME_PATTERN.test(name),
  );
}

async function listQuarantinePendingTrashDirents(): Promise<Dirent[]> {
  try {
    const dirents = await readdir(getJobFinderUserDataDirectory(), {
      withFileTypes: true,
    });
    return dirents.filter((dirent) =>
      RESET_QUARANTINE_SIDECAR_FILE_NAME_PATTERN.test(dirent.name),
    );
  } catch (error) {
    if (
      !isNodeFileSystemNotFoundError(error) &&
      !isNodeFileSystemNotDirectoryError(error)
    ) {
      console.warn(
        "[Desktop] Skipped reading quarantined Job Finder reset marker evidence.",
        error,
      );
    }
    return [];
  }
}

async function readProtectedResetTrashDirectoryNames(): Promise<Set<string>> {
  const protectedNames = new Set<string>();

  const protectedToken = await readProtectedResetToken();
  if (protectedToken) {
    protectedNames.add(
      `${JOB_FINDER_RESET_TRASH_DIRECTORY_PREFIX}${protectedToken}`,
    );
  }

  for (const dirent of await listQuarantinePendingTrashDirents()) {
    try {
      const rawSidecar = await readFile(
        path.join(getJobFinderUserDataDirectory(), dirent.name),
        "utf8",
      );
      for (const name of parsePendingTrashDirectoryNames(rawSidecar)) {
        protectedNames.add(name);
      }
    } catch (error) {
      console.warn(
        "[Desktop] Skipped unreadable quarantined Job Finder reset marker evidence; its listed trash stays untouched only while readable.",
        error,
      );
    }
  }

  return protectedNames;
}

export async function sweepStaleJobFinderResetArtifacts(): Promise<void> {
  const protectedTrashDirectoryNames =
    await readProtectedResetTrashDirectoryNames();

  let trashDirents: Dirent[] = [];
  try {
    trashDirents = await readdir(getJobFinderResetTrashRootDirectory(), {
      withFileTypes: true,
    });
  } catch (error) {
    if (
      !isNodeFileSystemNotFoundError(error) &&
      !isNodeFileSystemNotDirectoryError(error)
    ) {
      console.warn(
        "[Desktop] Skipped scanning for stale Job Finder reset trash directories.",
        error,
      );
    }
  }

  for (const dirent of trashDirents) {
    if (!RESET_TRASH_DIRECTORY_NAME_PATTERN.test(dirent.name)) {
      continue;
    }

    if (protectedTrashDirectoryNames.has(dirent.name)) {
      continue;
    }

    const trashDirectoryPath = path.join(
      getJobFinderResetTrashRootDirectory(),
      dirent.name,
    );
    if (!(await isStaleResetArtifactPath(trashDirectoryPath))) {
      continue;
    }

    try {
      await rm(trashDirectoryPath, { recursive: true, force: true });
    } catch (error) {
      warnSkippedStaleResetArtifact(dirent.name, error);
    }
  }

  let userDataDirents: Dirent[] = [];
  try {
    userDataDirents = await readdir(getJobFinderUserDataDirectory(), {
      withFileTypes: true,
    });
  } catch (error) {
    if (
      !isNodeFileSystemNotFoundError(error) &&
      !isNodeFileSystemNotDirectoryError(error)
    ) {
      console.warn(
        "[Desktop] Skipped scanning for stale Job Finder reset marker temp files.",
        error,
      );
    }
  }

  for (const dirent of userDataDirents) {
    if (
      !RESET_MARKER_TEMP_FILE_NAME_PATTERN.test(dirent.name) &&
      !RESET_QUARANTINE_SIDECAR_TEMP_FILE_NAME_PATTERN.test(dirent.name)
    ) {
      continue;
    }

    const temporaryMarkerPath = path.join(
      getJobFinderUserDataDirectory(),
      dirent.name,
    );
    if (!(await isStaleResetArtifactPath(temporaryMarkerPath))) {
      continue;
    }

    try {
      await rm(temporaryMarkerPath, { recursive: true, force: true });
    } catch (error) {
      warnSkippedStaleResetArtifact(dirent.name, error);
    }
  }
}

function buildQuarantineTimestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function listValidatedResetTrashDirectoryNames(): Promise<
  readonly string[]
> {
  let trashDirents: Dirent[];
  try {
    trashDirents = await readdir(getJobFinderResetTrashRootDirectory(), {
      withFileTypes: true,
    });
  } catch (error) {
    if (
      !isNodeFileSystemNotFoundError(error) &&
      !isNodeFileSystemNotDirectoryError(error)
    ) {
      console.warn(
        "[Desktop] Skipped enumerating Job Finder reset trash directories before quarantining an invalid marker.",
        error,
      );
    }
    return [];
  }

  return trashDirents
    .filter(
      (dirent) =>
        dirent.isDirectory() &&
        RESET_TRASH_DIRECTORY_NAME_PATTERN.test(dirent.name),
    )
    .map((dirent) => dirent.name);
}

async function retainPendingResetTrashDirectories(
  pendingTrashDirectoryNames: readonly string[],
): Promise<void> {
  for (const directoryName of pendingTrashDirectoryNames) {
    const originalPath = path.join(
      getJobFinderResetTrashRootDirectory(),
      directoryName,
    );
    const retainedPath = `${originalPath}.held`;
    try {
      await rename(originalPath, retainedPath);
    } catch (error) {
      console.warn(
        "[Desktop] Pending Job Finder reset trash could not be renamed out of the sweepable namespace; it stays in place, nothing deletes it in this session, and support should preserve it.",
        error,
      );
    }
  }
}

async function writeQuarantinePendingTrashSidecar(input: {
  quarantinedFileName: string;
  pendingTrashDirectoryNames: readonly string[];
}): Promise<boolean> {
  const sidecarPath = getQuarantinePendingTrashSidecarFilePath(
    input.quarantinedFileName,
  );
  const temporarySidecarPath = `${sidecarPath}.tmp`;
  const sidecarPayload: ResetQuarantinePendingTrashSidecar = {
    version: RESET_QUARANTINE_SIDECAR_VERSION,
    quarantinedAt: new Date().toISOString(),
    pendingTrashDirectoryNames: [...input.pendingTrashDirectoryNames],
  };

  try {
    await writeFile(
      temporarySidecarPath,
      `${JSON.stringify(sidecarPayload)}\n`,
      "utf8",
    );
    await syncFilePath(temporarySidecarPath);
    try {
      await rename(temporarySidecarPath, sidecarPath);
    } catch (error) {
      await rm(temporarySidecarPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await syncDirectoryBestEffort(path.dirname(sidecarPath));
    return true;
  } catch (error) {
    console.warn(
      "[Desktop] The set-aside Job Finder reset files discovered next to an invalid marker could not be recorded durably; renaming them out of the sweepable namespace instead.",
      error,
    );
    await retainPendingResetTrashDirectories(input.pendingTrashDirectoryNames);
    return false;
  }
}

interface QuarantineInvalidResetIntentMarkerResult {
  quarantinedFileName: string | null;
  pendingTrashDirectoryNames: readonly string[];
}

async function quarantineInvalidResetIntentMarker(
  reason: "malformed" | "oversized",
): Promise<QuarantineInvalidResetIntentMarkerResult> {
  const pendingTrashDirectoryNames =
    await listValidatedResetTrashDirectoryNames();
  const hasPendingTrash = pendingTrashDirectoryNames.length > 0;
  const markerPath = getJobFinderResetIntentFilePath();
  const quarantinePath = getJobFinderResetInvalidIntentMarkerFilePath(
    buildQuarantineTimestampSuffix(),
  );

  try {
    await rename(markerPath, quarantinePath);
  } catch (error) {
    console.warn(
      `[Desktop] An invalid Job Finder reset intent marker (${reason}) could not be quarantined; startup continues without applying any reset, no data paths were modified${
        hasPendingTrash
          ? ", and any previously set-aside reset files stay retained in the reset trash"
          : ""
      }.`,
      error,
    );
    return { quarantinedFileName: null, pendingTrashDirectoryNames };
  }

  const quarantinedFileName: string | null = path.basename(quarantinePath);
  if (hasPendingTrash) {
    await writeQuarantinePendingTrashSidecar({
      quarantinedFileName,
      pendingTrashDirectoryNames,
    });
    console.warn(
      `[Desktop] Quarantined an invalid Job Finder reset intent marker (${reason}) as ${path.basename(quarantinePath)}; ${
        pendingTrashDirectoryNames.length
      } set-aside reset trash location(s) were found and are being retained. Recovery is paused, nothing will be deleted automatically, and no further reset work was applied.`,
    );
  } else {
    console.warn(
      `[Desktop] Quarantined an invalid Job Finder reset intent marker (${reason}) as ${path.basename(quarantinePath)}; startup continues without applying any reset and no data paths were modified.`,
    );
  }

  return { quarantinedFileName, pendingTrashDirectoryNames };
}

export async function beginJobFinderWorkspaceResetFileMoves(): Promise<JobFinderResetIntent> {
  const token = randomUUID();
  const intent: JobFinderResetIntent = {
    token,
    entries: buildResetIntentEntries(token),
  };

  await writeResetIntentMarker(intent);

  const movedEntries: JobFinderResetIntentEntry[] = [];
  try {
    for (const entry of intent.entries) {
      const moved = await moveSingleResetIntentSourceToTrash(entry);
      if (moved) {
        movedEntries.push(entry);
      }
    }
  } catch (error) {
    throw await compensateFailedResetFileMoves(error, movedEntries);
  }

  return intent;
}

export async function completeJobFinderWorkspaceReset(
  intent: JobFinderResetIntent,
): Promise<void> {
  await removeResetIntentMarker();
  await removeResetTrashDirectory(intent.token);
  await sweepStaleJobFinderResetArtifacts();
}

export async function recoverPendingJobFinderWorkspaceReset(): Promise<JobFinderResetRecoveryOutcome> {
  let outcome: JobFinderResetRecoveryOutcome;
  try {
    outcome = await recoverPendingJobFinderWorkspaceResetOutcome();
  } catch (error) {
    recordStartupResetRecoveryFact({
      status: "degraded",
      reason: "reset_recovery_failed",
      quarantinedFileName: null,
    });
    console.warn(
      "[Desktop] Startup could not finish a pending Job Finder workspace reset; recovery paused with workspace files retained. Contact support before removing anything.",
      error,
    );
    throw error;
  }
  recordStartupResetRecoveryOutcome(outcome);
  await sweepStaleJobFinderResetArtifacts();
  return outcome;
}

async function recoverPendingJobFinderWorkspaceResetOutcome(): Promise<JobFinderResetRecoveryOutcome> {
  const markerPath = getJobFinderResetIntentFilePath();

  let markerStats;
  try {
    markerStats = await stat(markerPath);
  } catch (error) {
    if (isNodeFileSystemNotFoundError(error)) {
      return { status: "idle" };
    }
    throw error;
  }

  if (markerStats.size > MAX_RESET_INTENT_MARKER_BYTES) {
    const { quarantinedFileName, pendingTrashDirectoryNames } =
      await quarantineInvalidResetIntentMarker("oversized");
    return {
      status: "quarantined",
      reason:
        pendingTrashDirectoryNames.length > 0
          ? "with_pending_trash"
          : "oversized",
      quarantinedFileName,
    };
  }

  let rawMarker: string;
  try {
    rawMarker = await readFile(markerPath, "utf8");
  } catch (error) {
    if (isNodeFileSystemNotFoundError(error)) {
      return { status: "idle" };
    }
    throw error;
  }

  let intent: JobFinderResetIntent;
  try {
    intent = parseResetIntentMarker(rawMarker);
  } catch {
    const { quarantinedFileName, pendingTrashDirectoryNames } =
      await quarantineInvalidResetIntentMarker("malformed");
    return {
      status: "quarantined",
      reason:
        pendingTrashDirectoryNames.length > 0
          ? "with_pending_trash"
          : "malformed",
      quarantinedFileName,
    };
  }

  await moveResetIntentSourcesToTrash(intent);

  // Like the reset itself: the job store and the Assistant's store are
  // cleared before the marker goes. A failure keeps the marker.
  clearJobStoreOrHoldPause();
  await resetAssistantStoreWithJobs();

  await removeResetIntentMarker();
  await removeResetTrashDirectory(intent.token);
  lowerPauseAfterReset();

  return { status: "completed", token: intent.token };
}

/**
 * Clears the job store. It stays paused either way: a store that could not
 * be cleared keeps its queue, and a cleared one waits for the rest of the
 * reset to finish.
 */
function clearJobStoreOrHoldPause(): void {
  const store = getJobStore();
  try {
    resetJobStore(store);
  } catch (error) {
    try {
      createActivityControlStore(store).save(RESET_IN_PROGRESS_PAUSE);
    } catch {
      // The reset's own failure is the one the person is told about.
    }
    throw error;
  }
}

function recordStartupResetRecoveryOutcome(
  outcome: JobFinderResetRecoveryOutcome,
) {
  if (outcome.status === "completed") {
    recordStartupResetRecoveryFact({
      status: "completed",
      token: outcome.token,
      completedAt: new Date().toISOString(),
    });
    console.info(
      "[Desktop] An interrupted workspace reset was completed during startup.",
    );
    return;
  }

  if (outcome.status === "quarantined") {
    recordStartupResetRecoveryFact({
      status: "degraded",
      reason:
        outcome.reason === "malformed"
          ? "marker_quarantined_malformed"
          : outcome.reason === "oversized"
            ? "marker_quarantined_oversized"
            : "marker_quarantined_with_pending_trash",
      quarantinedFileName: outcome.quarantinedFileName,
    });
    return;
  }

  recordStartupResetRecoveryFact({ status: "idle" });
}

const BROWSER_CLEAR_TIMEOUT_MS = 15_000;

async function clearBrowserSession() {
  const session = getEmbeddedBrowser().getSession();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await session.clearStorageData();
        await session.clearCache();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The browser took too long to clear. Your workspace was not deleted. Restart Nestor and try again.",
              ),
            ),
          BROWSER_CLEAR_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Conversations and the Assistant's grants go with the job store. Grants
 * name job ids, and a cleared store numbers its jobs from 1 again, so a
 * grant left behind could cover a different job.
 */
async function resetAssistantStoreWithJobs(): Promise<void> {
  const { resetAssistantStore } =
    await import("../assistant/assistant-service");
  await resetAssistantStore();
}

export async function resetJobFinderBrowser(): Promise<void> {
  const { getProfileService } = await import("./runtime");
  await (
    await getProfileService()
  ).setActivityControl({ paused: true, reason: "Browser reset" });
  const { shutdownAssistantHost } =
    await import("../assistant/assistant-service");
  await shutdownAssistantHost();
  const browser = getEmbeddedBrowser();
  await browser.close(true);
  await clearBrowserSession();
  browser.clearSavedPasswords();
  // Restore/reset replaces the old browser state, including its person-close
  // latch. Activity stays globally paused until the person resumes it.
  browser.clearPersonPause();
}

/**
 * Deletes everything Job Finder keeps: its files, the job store and the
 * Assistant's history. Job Finder's runtime stops first so no late write
 * lands in the cleared store, and starts again once the reset is done.
 */
export async function resetJobFinderWorkspace(): Promise<void> {
  const { getProfileService, shutdownJobFinderRuntime, startJobFinderRuntime } =
    await import("./runtime");
  // Stop all work before closing pages so late completions cannot
  // repopulate the store. A failed clear must never report success.
  const { shutdownAssistantHost } =
    await import("../assistant/assistant-service");
  await shutdownAssistantHost();
  await discardJobSearch();
  await (
    await getProfileService()
  ).setActivityControl({
    paused: true,
    reason: "Resetting workspace",
  });
  const browser = getEmbeddedBrowser();
  await browser.close(true);
  await clearBrowserSession();
  browser.clearSavedPasswords();
  // A resume import still reading would otherwise write its file and text
  // back into the cleared store. Stop it, and the runtime's own imports and
  // site checks, and wait for all of them first.
  const { stopDesktopResumeImports } = await import("./import-resume");
  await stopDesktopResumeImports();
  await shutdownJobFinderRuntime();
  const intent = await beginJobFinderWorkspaceResetFileMoves();

  // Before the reset is marked done, so a failure leaves the marker for the
  // next start to finish both (see `getJobStore` and the recovery below).
  try {
    clearJobStoreOrHoldPause();
  } catch (error) {
    throw new Error(
      "Your files were removed, but your saved jobs and applications could not be cleared yet. Restart Nestor to finish the reset.",
      { cause: error },
    );
  }
  try {
    await resetAssistantStoreWithJobs();
  } catch (error) {
    throw new Error(
      "Workspace data was removed, but assistant history could not be cleared yet. Restart Nestor to finish the reset.",
      { cause: error },
    );
  }
  await completeJobFinderWorkspaceReset(intent);
  browser.clearPersonPause();
  // The very last step: every earlier failure leaves work paused.
  lowerPauseAfterReset();
  void startJobFinderRuntime().catch((error: unknown) => {
    console.warn("[Desktop] Job Finder did not start after the reset.", error);
  });
}

/**
 * Lowers the pause a reset held, once the whole reset has finished. Only the
 * callers that run a reset end to end call this.
 */
export function lowerPauseAfterReset(
  control: JobFinderActivityControl = {
    paused: false,
    pausedAt: null,
    reason: null,
  },
): void {
  createActivityControlStore(getJobStore()).save(control);
}
