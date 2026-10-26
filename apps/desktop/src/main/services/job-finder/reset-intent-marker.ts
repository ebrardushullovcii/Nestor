import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import path from "node:path";
import type { JobFinderStartupResetRecoveryFact } from "../../../shared/job-finder-startup-reset-recovery";
import {
  getApplicationDocumentsDirectory,
  getBrowserAgentProfileDirectory,
  getCandidateAssetsDirectory,
  getJobFinderDocumentsDirectory,
  getJobFinderResetIntentFilePath,
  getJobFinderUserDataDirectory,
  resolveJobFinderWorkspaceRelativePath,
} from "./paths";

// The reset marker and the startup fact about it, kept apart from the reset
// itself so the job store can read them before the window opens.

export const RESET_INTENT_MARKER_VERSION = 1;

export const JOB_FINDER_RESET_TRASH_DIRECTORY_PREFIX = "job-finder-reset-";

export const RESET_INTENT_TOKEN_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

const MAX_RESET_INTENT_ENTRY_PATH_LENGTH = 512;

export const MAX_RESET_INTENT_MARKER_BYTES = 64 * 1024;

export interface JobFinderResetIntentEntry {
  sourcePath: string;
  trashPath: string;
}

export interface JobFinderResetIntent {
  token: string;
  entries: readonly JobFinderResetIntentEntry[];
}

let startupResetRecoveryFact: JobFinderStartupResetRecoveryFact = {
  status: "idle",
};

export function getJobFinderStartupResetRecoveryFact(): JobFinderStartupResetRecoveryFact {
  return startupResetRecoveryFact;
}

export function recordStartupResetRecoveryFact(
  fact: JobFinderStartupResetRecoveryFact,
) {
  startupResetRecoveryFact = fact;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toPosixRelativePath(absolutePath: string): string {
  return path
    .relative(getJobFinderUserDataDirectory(), absolutePath)
    .split(path.sep)
    .join("/");
}

export function isSafeWorkspaceRelativePath(candidate: unknown): boolean {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_RESET_INTENT_ENTRY_PATH_LENGTH ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    path.isAbsolute(candidate) ||
    /^[a-zA-Z]:/.test(candidate)
  ) {
    return false;
  }

  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return false;
  }

  const resolvedDirectory = resolveJobFinderWorkspaceRelativePath(candidate);
  const containment = path.relative(
    getJobFinderUserDataDirectory(),
    resolvedDirectory,
  );

  return (
    containment.length > 0 &&
    !containment.startsWith("..") &&
    !path.isAbsolute(containment)
  );
}

export function listResetSourceRelativePaths(): readonly string[] {
  return [
    getJobFinderDocumentsDirectory(),
    getCandidateAssetsDirectory(),
    getApplicationDocumentsDirectory(),
    getBrowserAgentProfileDirectory(),
    path.join(getJobFinderUserDataDirectory(), "exports"),
  ].map((sourceDirectory) => toPosixRelativePath(sourceDirectory));
}

export function parseResetIntentMarker(
  rawMarker: string,
): JobFinderResetIntent {
  function fail(reason: string): never {
    throw new Error(
      `[Desktop] Invalid Job Finder reset intent marker (${reason}); quarantining the marker without modifying any data paths.`,
    );
  }

  let parsedMarker: unknown;
  try {
    parsedMarker = JSON.parse(rawMarker);
  } catch {
    fail("not valid JSON");
  }

  if (!isRecord(parsedMarker)) {
    fail("marker is not an object");
  }

  const marker = parsedMarker;

  if (marker.version !== RESET_INTENT_MARKER_VERSION) {
    fail(`unsupported version ${String(marker.version)}`);
  }

  if (
    typeof marker.token !== "string" ||
    !RESET_INTENT_TOKEN_PATTERN.test(marker.token)
  ) {
    fail("invalid reset token");
  }

  const token = marker.token;

  if (
    typeof marker.createdAt !== "string" ||
    Number.isNaN(Date.parse(marker.createdAt))
  ) {
    fail("invalid createdAt timestamp");
  }

  if (!Array.isArray(marker.entries) || marker.entries.length === 0) {
    fail("entries must be a non-empty array");
  }

  const allowedSourcePaths = new Set(listResetSourceRelativePaths());
  const seenSourcePaths = new Set<string>();
  const entries: JobFinderResetIntentEntry[] = [];

  for (const rawEntry of marker.entries) {
    if (!isRecord(rawEntry)) {
      fail("entry is not an object");
    }

    const sourcePath = rawEntry.sourcePath;

    if (
      typeof sourcePath !== "string" ||
      !isSafeWorkspaceRelativePath(sourcePath)
    ) {
      fail("entry source path is not a safe workspace-relative path");
    }

    if (!allowedSourcePaths.has(sourcePath)) {
      fail("entry source path is outside the managed reset allowlist");
    }

    if (seenSourcePaths.has(sourcePath)) {
      fail("duplicate entry for a source path");
    }

    const trashPath = rawEntry.trashPath;

    if (
      typeof trashPath !== "string" ||
      !isSafeWorkspaceRelativePath(trashPath)
    ) {
      fail("entry trash path is not a safe workspace-relative path");
    }

    const expectedTrashPath = `trash/${JOB_FINDER_RESET_TRASH_DIRECTORY_PREFIX}${token}/${sourcePath}`;

    if (trashPath !== expectedTrashPath) {
      fail("entry trash path does not match the tokenized trash layout");
    }

    seenSourcePaths.add(sourcePath);
    entries.push({ sourcePath, trashPath });
  }

  return {
    token,
    entries,
  };
}

export type PendingResetIntent =
  | { status: "none" }
  | { status: "readable"; intent: JobFinderResetIntent }
  | { status: "unreadable" };

/**
 * The marker a confirmed reset leaves until it is done. Only a marker that
 * reads cleanly says the person's data may be cleared.
 */
export function readPendingResetIntentSync(): PendingResetIntent {
  let fd: number;
  try {
    fd = openSync(getJobFinderResetIntentFilePath(), "r");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT")
      return { status: "none" };
    return { status: "unreadable" };
  }
  try {
    const { size } = fstatSync(fd);
    if (size > MAX_RESET_INTENT_MARKER_BYTES) return { status: "unreadable" };
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, 0);
    return {
      status: "readable",
      intent: parseResetIntentMarker(buffer.toString("utf8")),
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    closeSync(fd);
  }
}
