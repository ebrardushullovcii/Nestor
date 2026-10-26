import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as CryptoModule from "node:crypto";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import {
  beginJobFinderWorkspaceResetFileMoves,
  getJobFinderStartupResetRecoveryFact,
  JobFinderResetFileMoveError,
  recoverPendingJobFinderWorkspaceReset,
  sweepStaleJobFinderResetArtifacts,
  type JobFinderResetRecoveryOutcome,
} from "./reset-workspace";
import { closeJobStore } from "../job-store";

const { crashToken } = vi.hoisted(() => ({
  crashToken: "crash-sim-0001",
}));

// Recovery uses temporary user-data directories, not the Electron runtime.
vi.mock("electron", () => ({
  app: {
    getPath: () => {
      throw new Error("Recovery tests must set NESTOR_USER_DATA_DIR.");
    },
  },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  return {
    ...actual,
    randomUUID: () => crashToken,
  };
});

const temporaryDirectories: string[] = [];
const originalUserDataDirectory = process.env.NESTOR_USER_DATA_DIR;

afterEach(async () => {
  // Recovery clears the job store in the test's folder; let it go first.
  closeJobStore();
  if (originalUserDataDirectory === undefined) {
    delete process.env.NESTOR_USER_DATA_DIR;
  } else {
    process.env.NESTOR_USER_DATA_DIR = originalUserDataDirectory;
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCrashWorkspace() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "nestor-reset-crash-"),
  );
  temporaryDirectories.push(temporaryRoot);
  const userDataDirectory = path.join(temporaryRoot, "user-data");
  process.env.NESTOR_USER_DATA_DIR = userDataDirectory;

  const documentsDirectory = path.join(
    userDataDirectory,
    "documents",
    "resumes",
  );
  const generatedResumePath = path.join(
    documentsDirectory,
    "generated",
    "resume.pdf",
  );
  const browserProfileDirectory = path.join(
    userDataDirectory,
    "browser-agent",
    "default",
  );
  const browserProfileCookiePath = path.join(
    browserProfileDirectory,
    "Cookies",
  );
  const candidateAssetsPath = path.join(
    userDataDirectory,
    "documents",
    "candidate-assets",
    "headshot.png",
  );
  const applicationDocumentsPath = path.join(
    userDataDirectory,
    "documents",
    "application-documents",
    "cover-letter.pdf",
  );

  await mkdir(path.dirname(generatedResumePath), { recursive: true });
  await writeFile(generatedResumePath, "%PDF-1.4 generated resume bytes");
  await mkdir(browserProfileDirectory, { recursive: true });
  await writeFile(browserProfileCookiePath, "session-cookie-bytes");
  await mkdir(path.dirname(candidateAssetsPath), { recursive: true });
  await writeFile(candidateAssetsPath, "candidate asset bytes");
  await mkdir(path.dirname(applicationDocumentsPath), { recursive: true });
  await writeFile(applicationDocumentsPath, "application document bytes");

  return {
    temporaryRoot,
    userDataDirectory,
    documentsDirectory,
    generatedResumePath,
    browserProfileDirectory,
    browserProfileCookiePath,
    candidateAssetsPath,
    applicationDocumentsPath,
  };
}

function createSeededRepository(input: { danglingResumePath: string }) {
  const seed = createEmptyJobFinderRepositoryState();
  seed.profile.baseResume = {
    ...seed.profile.baseResume,
    id: "resume_crash_fixture",
    fileName: "Casey Resume.pdf",
    uploadedAt: "2026-08-01T10:00:00.000Z",
    storagePath: input.danglingResumePath,
    sha256: "a".repeat(64),
    textContent: "Casey Rowan\nSenior Frontend Engineer",
    textUpdatedAt: "2026-08-01T10:00:00.000Z",
    extractionStatus: "ready",
    analysisWarnings: [],
  };
  return createInMemoryJobFinderRepository(seed);
}

const resetSourceOrder = [
  "documents/resumes",
  "documents/candidate-assets",
  "documents/application-documents",
  "browser-agent/default",
] as const;

async function writeIntentMarker(input: {
  userDataDirectory: string;
  movedSourceCount: number;
}) {
  const { userDataDirectory, movedSourceCount } = input;
  const entries = resetSourceOrder.map((sourcePath) => ({
    sourcePath,
    trashPath: `trash/job-finder-reset-${crashToken}/${sourcePath}`,
  }));

  for (const [index, entry] of entries.entries()) {
    if (index >= movedSourceCount) {
      continue;
    }
    const trashDestination = path.join(userDataDirectory, entry.trashPath);
    await mkdir(path.dirname(trashDestination), { recursive: true });
    await rename(
      path.join(userDataDirectory, entry.sourcePath),
      trashDestination,
    );
  }

  const markerPath = path.join(
    userDataDirectory,
    "job-finder-reset-intent.json",
  );
  await writeFile(
    markerPath,
    `${JSON.stringify({
      version: 1,
      token: crashToken,
      createdAt: "2026-08-01T10:00:00.000Z",
      entries: entries.map(({ sourcePath, trashPath }) => ({
        sourcePath,
        trashPath,
      })),
    })}\n`,
    "utf8",
  );

  return markerPath;
}

async function expectConvergedEmptyState(input: {
  repository: ReturnType<typeof createSeededRepository>;
  outcome: JobFinderResetRecoveryOutcome;
  workspace: Awaited<ReturnType<typeof createCrashWorkspace>>;
}) {
  const { repository, outcome, workspace } = input;

  expect(outcome).toEqual({ status: "completed", token: crashToken });

  const profile = await repository.getProfile();
  expect(profile.baseResume.storagePath).toBeNull();
  expect(profile.baseResume.sha256 ?? null).toBeNull();

  await expect(stat(workspace.generatedResumePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(workspace.browserProfileCookiePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(workspace.candidateAssetsPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(workspace.applicationDocumentsPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    stat(
      path.join(workspace.userDataDirectory, "documents", "candidate-assets"),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(
      path.join(
        workspace.userDataDirectory,
        "documents",
        "application-documents",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(
      path.join(
        workspace.userDataDirectory,
        "trash",
        `job-finder-reset-${crashToken}`,
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(
      path.join(workspace.userDataDirectory, "job-finder-reset-intent.json"),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });

  await expect(
    recoverPendingJobFinderWorkspaceReset(repository),
  ).resolves.toEqual({ status: "idle" });
}

describe("recoverPendingJobFinderWorkspaceReset crash simulations", () => {
  test("recovers a crash after the intent marker was written but before any rename", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: 0,
    });
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    await expect(stat(markerPath)).resolves.toBeTruthy();

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    await expectConvergedEmptyState({ repository, outcome, workspace });
  });

  test("recovers a crash after the first rename moved only the generated resume documents", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: 1,
    });
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    await expect(stat(markerPath)).resolves.toBeTruthy();

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    await expectConvergedEmptyState({ repository, outcome, workspace });
  });

  test("recovers a crash after the expanded document scopes were partially moved aside", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: 3,
    });
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    await expect(stat(markerPath)).resolves.toBeTruthy();

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    await expectConvergedEmptyState({ repository, outcome, workspace });
  });

  test("recovers a crash after all renames completed but before the database reset", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: resetSourceOrder.length,
    });
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    await expect(stat(markerPath)).resolves.toBeTruthy();

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    await expectConvergedEmptyState({ repository, outcome, workspace });
  });

  test("recovers a crash after the database reset but before marker removal and trash cleanup", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: resetSourceOrder.length,
    });
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });
    await repository.reset(createEmptyJobFinderRepositoryState());

    await expect(stat(markerPath)).resolves.toBeTruthy();

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    await expectConvergedEmptyState({ repository, outcome, workspace });
  });
});

describe("recoverPendingJobFinderWorkspaceReset invalid marker handling", () => {
  test("quarantines a malformed marker, boots startup, and leaves every data path untouched", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = path.join(
      workspace.userDataDirectory,
      "job-finder-reset-intent.json",
    );
    await writeFile(markerPath, "{ not valid json", "utf8");
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    expect(outcome.status).toBe("quarantined");
    if (outcome.status !== "quarantined") {
      throw new Error("unreachable");
    }
    expect(outcome.reason).toBe("malformed");

    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    const userDataEntries = await readdir(workspace.userDataDirectory);
    const quarantinedNames = userDataEntries.filter((entryName) =>
      entryName.startsWith("job-finder-reset-intent.invalid-"),
    );
    expect(quarantinedNames).toHaveLength(1);
    const quarantinedName = quarantinedNames[0]!;
    expect(outcome.quarantinedFileName).toBe(quarantinedName);
    await expect(
      readFile(path.join(workspace.userDataDirectory, quarantinedName), "utf8"),
    ).resolves.toBe("{ not valid json");

    await expect(readFile(workspace.generatedResumePath)).resolves.toEqual(
      Buffer.from("%PDF-1.4 generated resume bytes"),
    );
    await expect(readFile(workspace.browserProfileCookiePath)).resolves.toEqual(
      Buffer.from("session-cookie-bytes"),
    );
    expect((await repository.getProfile()).baseResume.storagePath).toBe(
      path.join(workspace.documentsDirectory, "resume.pdf"),
    );

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
  });

  test("quarantines an oversized marker without reading its contents or moving data paths", async () => {
    const workspace = await createCrashWorkspace();
    const markerPath = path.join(
      workspace.userDataDirectory,
      "job-finder-reset-intent.json",
    );
    await writeFile(markerPath, "x".repeat(64 * 1024 + 1), "utf8");
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    expect(outcome.status).toBe("quarantined");
    if (outcome.status !== "quarantined") {
      throw new Error("unreachable");
    }
    expect(outcome.reason).toBe("oversized");

    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    const userDataEntries = await readdir(workspace.userDataDirectory);
    expect(
      userDataEntries.filter((entryName) =>
        entryName.startsWith("job-finder-reset-intent.invalid-"),
      ),
    ).toHaveLength(1);

    await expect(readFile(workspace.generatedResumePath)).resolves.toEqual(
      Buffer.from("%PDF-1.4 generated resume bytes"),
    );
    expect((await repository.getProfile()).baseResume.storagePath).toBe(
      path.join(workspace.documentsDirectory, "resume.pdf"),
    );
    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
  });
});

describe("beginJobFinderWorkspaceResetFileMoves compensation", () => {
  test("a failure before any successful rename removes the marker so the next launch wipes nothing", async () => {
    const workspace = await createCrashWorkspace();
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });
    const trashRootPath = path.join(workspace.userDataDirectory, "trash");
    await writeFile(trashRootPath, "trash root is a file, not a directory");

    let caughtError: unknown;
    try {
      await beginJobFinderWorkspaceResetFileMoves();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
    const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
    expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
    expect(resetFileMoveError.markerRemoved).toBe(true);
    expect(resetFileMoveError.unrestoredSourcePathCount).toBe(0);

    await expect(
      stat(
        path.join(workspace.userDataDirectory, "job-finder-reset-intent.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(workspace.generatedResumePath)).resolves.toBeTruthy();
    await expect(
      stat(workspace.browserProfileCookiePath),
    ).resolves.toBeTruthy();

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
    expect((await repository.getProfile()).baseResume.storagePath).toBe(
      path.join(workspace.documentsDirectory, "resume.pdf"),
    );
  });

  test("rolls back every earlier rename across the expanded scope when the final move fails mid-reset", async () => {
    const workspace = await createCrashWorkspace();
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });
    const blockedTrashProfileDirectory = path.join(
      workspace.userDataDirectory,
      "trash",
      `job-finder-reset-${crashToken}`,
      "browser-agent",
      "default",
    );
    await mkdir(blockedTrashProfileDirectory, { recursive: true });
    await writeFile(
      path.join(blockedTrashProfileDirectory, "blocker.bin"),
      "forces the final rename to fail",
    );

    let caughtError: unknown;
    try {
      await beginJobFinderWorkspaceResetFileMoves();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
    const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
    expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
    expect(resetFileMoveError.markerRemoved).toBe(true);

    await expect(readFile(workspace.generatedResumePath)).resolves.toEqual(
      Buffer.from("%PDF-1.4 generated resume bytes"),
    );
    await expect(readFile(workspace.candidateAssetsPath)).resolves.toEqual(
      Buffer.from("candidate asset bytes"),
    );
    await expect(readFile(workspace.applicationDocumentsPath)).resolves.toEqual(
      Buffer.from("application document bytes"),
    );
    await expect(
      stat(workspace.browserProfileCookiePath),
    ).resolves.toBeTruthy();
    await expect(
      stat(
        path.join(workspace.userDataDirectory, "job-finder-reset-intent.json"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
    expect((await repository.getProfile()).baseResume.storagePath).toBe(
      path.join(workspace.documentsDirectory, "resume.pdf"),
    );
  });

  test("moves symlinked sources as links without following them outside the workspace", async () => {
    const workspace = await createCrashWorkspace();
    const externalDocumentsDirectory = path.join(
      workspace.temporaryRoot,
      "outside-the-workspace",
      "resumes",
    );
    await mkdir(externalDocumentsDirectory, { recursive: true });
    await writeFile(
      path.join(externalDocumentsDirectory, "external-resume.txt"),
      "external bytes that must survive",
    );
    const externalAssetsDirectory = path.join(
      workspace.temporaryRoot,
      "outside-the-workspace",
      "assets",
    );
    await mkdir(externalAssetsDirectory, { recursive: true });
    await writeFile(
      path.join(externalAssetsDirectory, "external-asset.txt"),
      "external asset bytes that must survive",
    );

    await rm(workspace.documentsDirectory, { recursive: true, force: true });
    await symlink(
      externalDocumentsDirectory,
      workspace.documentsDirectory,
      "dir",
    );
    await rm(path.dirname(workspace.candidateAssetsPath), {
      recursive: true,
      force: true,
    });
    await symlink(
      externalAssetsDirectory,
      path.join(workspace.userDataDirectory, "documents", "candidate-assets"),
      "dir",
    );

    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    const markerPath = await writeIntentMarker({
      userDataDirectory: workspace.userDataDirectory,
      movedSourceCount: 2,
    });

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    expect(outcome).toEqual({ status: "completed", token: crashToken });
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(workspace.documentsDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(
        path.join(workspace.userDataDirectory, "documents", "candidate-assets"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      readFile(path.join(externalDocumentsDirectory, "external-resume.txt")),
    ).resolves.toEqual(Buffer.from("external bytes that must survive"));
    await expect(stat(externalDocumentsDirectory)).resolves.toBeTruthy();
    await expect(
      readFile(path.join(externalAssetsDirectory, "external-asset.txt")),
    ).resolves.toEqual(Buffer.from("external asset bytes that must survive"));
    await expect(stat(externalAssetsDirectory)).resolves.toBeTruthy();
  });

  test("restores every set-aside file and removes the marker when the database reset rejects after the moves", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const workspace = await createCrashWorkspace();
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });
    const rejectingResetRepository = {
      getProfile: () => repository.getProfile(),
      reset: vi
        .fn<ReturnType<typeof createSeededRepository>["reset"]>()
        .mockRejectedValueOnce(new Error("simulated database failure")),
    };

    try {
      await writeIntentMarker({
        userDataDirectory: workspace.userDataDirectory,
        movedSourceCount: resetSourceOrder.length,
      });

      let caughtError: unknown;
      try {
        await recoverPendingJobFinderWorkspaceReset(rejectingResetRepository);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
      const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
      expect(resetFileMoveError.restoredAllMovedSources).toBe(true);
      expect(resetFileMoveError.markerRemoved).toBe(true);
      expect(warnSpy).toHaveBeenCalled();

      await expect(readFile(workspace.generatedResumePath)).resolves.toEqual(
        Buffer.from("%PDF-1.4 generated resume bytes"),
      );
      await expect(readFile(workspace.candidateAssetsPath)).resolves.toEqual(
        Buffer.from("candidate asset bytes"),
      );
      await expect(
        readFile(workspace.applicationDocumentsPath),
      ).resolves.toEqual(Buffer.from("application document bytes"));
      await expect(
        stat(workspace.browserProfileCookiePath),
      ).resolves.toBeTruthy();
      await expect(
        stat(
          path.join(
            workspace.userDataDirectory,
            "job-finder-reset-intent.json",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "reset_recovery_failed",
        quarantinedFileName: null,
      });
      expect(rejectingResetRepository.reset).toHaveBeenCalledTimes(1);

      await expect(
        recoverPendingJobFinderWorkspaceReset(repository),
      ).resolves.toEqual({ status: "idle" });
      expect(rejectingResetRepository.reset).toHaveBeenCalledTimes(1);
      expect((await repository.getProfile()).baseResume.storagePath).toBe(
        path.join(workspace.documentsDirectory, "resume.pdf"),
      );
      await expect(readFile(workspace.candidateAssetsPath)).resolves.toEqual(
        Buffer.from("candidate asset bytes"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retains the marker with explicit guidance when compensation cannot restore a moved directory", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const workspace = await createCrashWorkspace();
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });
    const markerPath = path.join(
      workspace.userDataDirectory,
      "job-finder-reset-intent.json",
    );

    try {
      await writeIntentMarker({
        userDataDirectory: workspace.userDataDirectory,
        movedSourceCount: resetSourceOrder.length,
      });
      const unblockDocumentRestores = await blockDocumentRestores(
        workspace.userDataDirectory,
      );
      const failingRepository = {
        getProfile: () => repository.getProfile(),
        reset: vi
          .fn<ReturnType<typeof createSeededRepository>["reset"]>()
          .mockRejectedValueOnce(new Error("simulated database failure")),
      };

      let caughtError: unknown;
      try {
        await recoverPendingJobFinderWorkspaceReset(failingRepository);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(JobFinderResetFileMoveError);
      const resetFileMoveError = caughtError as JobFinderResetFileMoveError;
      expect(resetFileMoveError.restoredAllMovedSources).toBe(false);
      expect(resetFileMoveError.markerRemoved).toBe(false);
      expect(resetFileMoveError.unrestoredSourcePathCount).toBe(3);
      const warningMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        warningMessages.some(
          (message) =>
            message.includes("could not be restored") &&
            message.includes("next startup completes the reset"),
        ),
      ).toBe(true);

      await expect(stat(markerPath)).resolves.toBeTruthy();

      await unblockDocumentRestores();
      await expect(
        recoverPendingJobFinderWorkspaceReset(repository),
      ).resolves.toEqual({ status: "completed", token: crashToken });
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("retains pending trash across sweeps and restarts when an invalid marker coexists with set-aside files", async () => {
    const workspace = await createCrashWorkspace();
    const userDataDirectory = workspace.userDataDirectory;
    const heldTrashName = `job-finder-reset-${crashToken}`;
    const heldTrashDirectory = path.join(
      userDataDirectory,
      "trash",
      heldTrashName,
    );
    await mkdir(path.join(heldTrashDirectory, "documents", "resumes"), {
      recursive: true,
    });
    await writeFile(
      path.join(heldTrashDirectory, "documents", "resumes", "resume.pdf"),
      "%PDF-1.4 already set aside before the marker was damaged",
    );
    await utimes(heldTrashDirectory, epochStaleTime(), epochStaleTime());
    await writeFile(
      path.join(userDataDirectory, "job-finder-reset-intent.json"),
      "{ not valid json",
      "utf8",
    );
    const repository = createSeededRepository({
      danglingResumePath: path.join(workspace.documentsDirectory, "resume.pdf"),
    });

    const outcome = await recoverPendingJobFinderWorkspaceReset(repository);

    expect(outcome.status).toBe("quarantined");
    if (outcome.status !== "quarantined") {
      throw new Error("unreachable");
    }
    expect(outcome.reason).toBe("with_pending_trash");
    expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
      status: "degraded",
      reason: "marker_quarantined_with_pending_trash",
    });

    const sidecarNames = (await readdir(userDataDirectory)).filter(
      (entryName) => entryName.endsWith(".pending-trash.json"),
    );
    expect(sidecarNames).toHaveLength(1);
    await expect(
      readFile(path.join(userDataDirectory, sidecarNames[0]!), "utf8"),
    ).resolves.toContain(heldTrashName);

    await sweepStaleJobFinderResetArtifacts();
    await expect(readFile(workspace.generatedResumePath)).resolves.toEqual(
      Buffer.from("%PDF-1.4 generated resume bytes"),
    );
    await expect(stat(heldTrashDirectory)).resolves.toBeTruthy();

    await utimes(heldTrashDirectory, epochStaleTime(), epochStaleTime());
    await expect(
      recoverPendingJobFinderWorkspaceReset(repository),
    ).resolves.toEqual({ status: "idle" });
    await sweepStaleJobFinderResetArtifacts();
    await expect(stat(heldTrashDirectory)).resolves.toBeTruthy();
    await expect(
      readFile(
        path.join(heldTrashDirectory, "documents", "resumes", "resume.pdf"),
      ),
    ).resolves.toEqual(
      Buffer.from("%PDF-1.4 already set aside before the marker was damaged"),
    );
  });
});

/**
 * Stops compensation from putting the document directories back.
 *
 * POSIX takes the write bit off their parent. Windows has no POSIX mode bits,
 * so a read-only parent stops nothing there; occupying each restore
 * destination does, and proves the same thing — the rollback rename fails and
 * the marker has to stay for the next startup.
 */
async function blockDocumentRestores(
  userDataDirectory: string,
): Promise<() => Promise<void>> {
  const documentsDirectory = path.join(userDataDirectory, "documents");

  if (process.platform !== "win32") {
    await chmod(documentsDirectory, 0o555);
    return async () => {
      await chmod(documentsDirectory, 0o755);
    };
  }

  const heldFiles = [
    path.join(
      userDataDirectory,
      "trash",
      `job-finder-reset-${crashToken}`,
      "documents",
      "resumes",
      "generated",
      "resume.pdf",
    ),
    path.join(
      userDataDirectory,
      "trash",
      `job-finder-reset-${crashToken}`,
      "documents",
      "candidate-assets",
      "headshot.png",
    ),
    path.join(
      userDataDirectory,
      "trash",
      `job-finder-reset-${crashToken}`,
      "documents",
      "application-documents",
      "cover-letter.pdf",
    ),
  ];
  const handles = await Promise.all(heldFiles.map((file) => open(file, "r")));

  return async () => {
    await Promise.all(handles.map((handle) => handle.close()));
  };
}

function epochStaleTime() {
  return new Date(Date.now() - 2 * 60 * 60 * 1000);
}
