import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { JobFinderRepository } from "@nestor/db";

export const missingResumeSourceWarning =
  "The saved original CV file is unavailable. Re-import it before using the original CV for an application.";

function isPathInside(parentDirectory: string, candidatePath: string): boolean {
  const relativePath = path.relative(
    path.resolve(parentDirectory),
    path.resolve(candidatePath),
  );
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function sanitizeFilePart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80) || "resume"
  );
}

async function readFileSha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function withWarning(warnings: readonly string[], warning: string): string[] {
  return [
    ...new Set([
      ...warnings.filter((entry) => entry !== missingResumeSourceWarning),
      warning,
    ]),
  ];
}

/**
 * Moves legacy resume references into the app-owned documents directory before
 * the workspace service can expose them as application-ready. Missing files are
 * made explicitly unavailable while preserving extracted profile evidence.
 */
export async function migrateLegacyResumeSource(input: {
  documentsDirectory: string;
  repository: JobFinderRepository;
}): Promise<"migrated" | "repaired_digest" | "missing" | "unchanged"> {
  const profile = await input.repository.getProfile();
  const source = profile.baseResume;
  const sourcePath = source.storagePath?.trim() ?? "";

  const markUnavailable = async () => {
    await input.repository.saveProfile({
      ...profile,
      baseResume: {
        ...source,
        storagePath: null,
        sha256: null,
        analysisWarnings: withWarning(
          source.analysisWarnings,
          missingResumeSourceWarning,
        ),
      },
    });
    return "missing" as const;
  };

  if (!sourcePath || !(await fileExists(sourcePath))) {
    return sourcePath || source.textContent?.trim()
      ? markUnavailable()
      : "unchanged";
  }

  let sourceSha256: string;
  try {
    sourceSha256 = await readFileSha256(sourcePath);
  } catch {
    return markUnavailable();
  }

  if (source.sha256 && source.sha256.toLowerCase() !== sourceSha256) {
    return markUnavailable();
  }

  if (isPathInside(input.documentsDirectory, sourcePath)) {
    if (source.sha256) {
      return "unchanged";
    }

    await input.repository.saveProfile({
      ...profile,
      baseResume: {
        ...source,
        sha256: sourceSha256,
        analysisWarnings: source.analysisWarnings.filter(
          (warning) => warning !== missingResumeSourceWarning,
        ),
      },
    });
    return "repaired_digest";
  }

  await mkdir(input.documentsDirectory, { recursive: true });
  const targetFileName = `${sanitizeFilePart(source.id)}-${sourceSha256.slice(0, 12)}-${sanitizeFilePart(
    source.fileName || path.basename(sourcePath),
  )}`;
  const targetPath = path.join(input.documentsDirectory, targetFileName);

  if (!(await fileExists(targetPath))) {
    await copyFile(sourcePath, targetPath);
  }

  const copiedSha256 = await readFileSha256(targetPath);
  if (copiedSha256 !== sourceSha256) {
    throw new Error(
      "The private resume copy did not match the selected source file.",
    );
  }

  await input.repository.saveProfile({
    ...profile,
    baseResume: {
      ...source,
      storagePath: targetPath,
      sha256: copiedSha256,
      analysisWarnings: source.analysisWarnings.filter(
        (warning) => warning !== missingResumeSourceWarning,
      ),
    },
  });
  return "migrated";
}
