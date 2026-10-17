import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test } from "vitest";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import {
  migrateLegacyResumeSource,
  missingResumeSourceWarning,
} from "./migrate-resume-source";

const temporaryDirectories: string[] = [];

async function createTestDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-source-migration-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createRepository(input: {
  sourcePath: string | null;
  sha256?: string | null;
}) {
  const seed = createEmptyJobFinderRepositoryState();
  seed.profile.baseResume = {
    ...seed.profile.baseResume,
    id: "resume_legacy",
    fileName: "Casey Resume.pdf",
    uploadedAt: "2026-07-01T10:00:00.000Z",
    storagePath: input.sourcePath,
    sha256: input.sha256,
    textContent: "Casey Rowan\nSenior Frontend Engineer",
    textUpdatedAt: "2026-07-01T10:00:00.000Z",
    extractionStatus: "ready",
    analysisWarnings: ["Keep this extraction note."],
  };
  return createInMemoryJobFinderRepository(seed);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("migrateLegacyResumeSource", () => {
  test("copies an existing legacy source into private app storage and records the copied bytes", async () => {
    const root = await createTestDirectory();
    const externalDirectory = path.join(root, "downloads");
    const documentsDirectory = path.join(
      root,
      "user-data",
      "documents",
      "resumes",
    );
    const sourcePath = path.join(externalDirectory, "Casey Resume.pdf");
    const bytes = Buffer.from("synthetic resume bytes");
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(sourcePath, bytes);
    const repository = createRepository({ sourcePath });

    await expect(
      migrateLegacyResumeSource({ documentsDirectory, repository }),
    ).resolves.toBe("migrated");

    const migrated = (await repository.getProfile()).baseResume;
    expect(
      path.relative(documentsDirectory, migrated.storagePath ?? ""),
    ).not.toMatch(/^\.\./);
    expect(migrated.storagePath).not.toBe(sourcePath);
    expect(await readFile(migrated.storagePath!)).toEqual(bytes);
    expect(migrated.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(migrated.analysisWarnings).toEqual(["Keep this extraction note."]);

    await expect(
      migrateLegacyResumeSource({ documentsDirectory, repository }),
    ).resolves.toBe("unchanged");
  });

  test("repairs a missing legacy digest when the private copy still exists", async () => {
    const root = await createTestDirectory();
    const documentsDirectory = path.join(root, "documents", "resumes");
    const sourcePath = path.join(documentsDirectory, "resume.pdf");
    await mkdir(documentsDirectory, { recursive: true });
    await writeFile(sourcePath, "private resume bytes");
    const repository = createRepository({ sourcePath, sha256: null });

    await expect(
      migrateLegacyResumeSource({ documentsDirectory, repository }),
    ).resolves.toBe("repaired_digest");

    const repaired = (await repository.getProfile()).baseResume;
    expect(repaired.storagePath).toBe(sourcePath);
    expect(repaired.sha256).toBe(
      createHash("sha256").update("private resume bytes").digest("hex"),
    );
  });

  test("marks a missing source unavailable without discarding extracted profile evidence", async () => {
    const root = await createTestDirectory();
    const sourcePath = path.join(root, "deleted", "resume.pdf");
    const repository = createRepository({ sourcePath, sha256: "a".repeat(64) });

    await expect(
      migrateLegacyResumeSource({
        documentsDirectory: path.join(root, "documents", "resumes"),
        repository,
      }),
    ).resolves.toBe("missing");

    const recovered = (await repository.getProfile()).baseResume;
    expect(recovered.storagePath).toBeNull();
    expect(recovered.sha256).toBeNull();
    expect(recovered.textContent).toBe("Casey Rowan\nSenior Frontend Engineer");
    expect(recovered.analysisWarnings).toEqual([
      "Keep this extraction note.",
      missingResumeSourceWarning,
    ]);
  });
  test("does not bless changed bytes when a legacy record already has an integrity digest", async () => {
    const root = await createTestDirectory();
    const documentsDirectory = path.join(root, "documents", "resumes");
    const sourcePath = path.join(documentsDirectory, "resume.pdf");
    await mkdir(documentsDirectory, { recursive: true });
    await writeFile(sourcePath, "changed resume bytes");
    const repository = createRepository({ sourcePath, sha256: "a".repeat(64) });

    await expect(
      migrateLegacyResumeSource({ documentsDirectory, repository }),
    ).resolves.toBe("missing");

    const blocked = (await repository.getProfile()).baseResume;
    expect(blocked.storagePath).toBeNull();
    expect(blocked.sha256).toBeNull();
    expect(blocked.analysisWarnings).toContain(missingResumeSourceWarning);
  });
});
