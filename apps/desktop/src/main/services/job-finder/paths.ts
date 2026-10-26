import { app } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveDesktopUserDataDirectory } from "../../setup/user-data-directory";

function getUserDataDirectory() {
  return resolveDesktopUserDataDirectory(app);
}

export function getJobFinderDocumentsDirectory() {
  return path.join(getUserDataDirectory(), "documents", "resumes");
}

export function getGeneratedResumeDocumentsDirectory() {
  return path.join(getJobFinderDocumentsDirectory(), "generated");
}

export function getCandidateAssetsDirectory() {
  return path.join(getUserDataDirectory(), "documents", "candidate-assets");
}

export function getApplicationDocumentsDirectory() {
  return path.join(
    getUserDataDirectory(),
    "documents",
    "application-documents",
  );
}

export function getBrowserAgentProfileDirectory() {
  return path.join(getUserDataDirectory(), "browser-agent", "default");
}

export function getJobFinderUserDataDirectory() {
  return getUserDataDirectory();
}

export function getJobFinderResetIntentFilePath() {
  return path.join(getUserDataDirectory(), "job-finder-reset-intent.json");
}

export function getJobFinderResetInvalidIntentMarkerFilePath(suffix: string) {
  return path.join(
    getUserDataDirectory(),
    `job-finder-reset-intent.invalid-${suffix}.json`,
  );
}

export function getJobFinderResetTrashRootDirectory() {
  return path.join(getUserDataDirectory(), "trash");
}

export function getJobFinderResetTrashDirectory(resetToken: string) {
  return path.join(
    getJobFinderResetTrashRootDirectory(),
    `job-finder-reset-${resetToken}`,
  );
}

export function resolveJobFinderWorkspaceRelativePath(relativePath: string) {
  return path.resolve(getUserDataDirectory(), relativePath);
}

export async function ensureJobFinderUserDataDirectory() {
  await mkdir(getUserDataDirectory(), { recursive: true });
}
