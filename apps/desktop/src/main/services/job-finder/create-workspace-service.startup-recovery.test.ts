import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CandidateProfileSchema,
} from "@nestor/contracts";
import { createFileJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import { createJobFinderWorkspaceServiceAsync } from "./create-workspace-service";
import {
  getJobFinderStartupResetRecoveryFact,
  sweepStaleJobFinderResetArtifacts,
} from "./reset-workspace";
import { missingResumeSourceWarning } from "./migrate-resume-source";
import { closeJobStore } from "../job-store";

// Recovery clears the job store, whose change reaches the app's windows;
// there are none here. Everything else stays as Node sees Electron: absent.
vi.mock("electron", () => {
  const windows = { BrowserWindow: { getAllWindows: () => [] } };
  return new Proxy(windows, {
    has: () => true,
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : undefined,
  });
});

const temporaryDirectories: string[] = [];
const originalEnv: Record<string, string | undefined> = {
  NESTOR_USER_DATA_DIR: process.env.NESTOR_USER_DATA_DIR,
  NESTOR_ENABLE_TEST_API: process.env.NESTOR_ENABLE_TEST_API,
  NESTOR_BROWSER_AGENT: process.env.NESTOR_BROWSER_AGENT,
};

afterEach(async () => {
  closeJobStore();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("startup reset recovery before workspace exposure", () => {
  test.each(["P13", "P14"] as const)(
    "preserves the app-owned %s returning resume across reset and startup",
    async (personaId) => {
      const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "nestor-returning-resume-startup-"),
      );
      temporaryDirectories.push(temporaryRoot);
      const userDataDirectory = path.join(temporaryRoot, "user-data");
      process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
      process.env.NESTOR_ENABLE_TEST_API = "1";
      process.env.NESTOR_BROWSER_AGENT = "0";

      const documentsDirectory = path.join(
        userDataDirectory,
        "documents",
        "resumes",
      );
      const resumePath = path.join(
        documentsDirectory,
        `${personaId.toLowerCase()}-returning.txt`,
      );
      const resumeBytes = Buffer.from(
        `${personaId} returning resume bytes\nMarketing and growth leadership\n`,
        "utf8",
      );
      const resumeSha256 = createHash("sha256")
        .update(resumeBytes)
        .digest("hex");
      await mkdir(documentsDirectory, { recursive: true });
      await writeFile(resumePath, resumeBytes);

      const seed = createEmptyJobFinderRepositoryState();
      seed.profile = CandidateProfileSchema.parse({
        ...seed.profile,
        id: `candidate_${personaId.toLowerCase()}`,
        baseResume: {
          ...seed.profile.baseResume,
          id: `resume_${personaId.toLowerCase()}`,
          fileName: `${personaId}-returning.txt`,
          uploadedAt: "2026-08-30T10:00:00.000Z",
          storagePath: resumePath,
          sha256: resumeSha256,
          textContent: resumeBytes.toString("utf8"),
          textUpdatedAt: "2026-08-30T10:00:00.000Z",
          extractionStatus: "ready",
          analysisWarnings: ["Returning-persona extraction note."],
        },
      });

      const filePath = path.join(
        userDataDirectory,
        "job-finder-workspace.sqlite",
      );
      const initialRepository = await createFileJobFinderRepository({
        filePath,
        seed: createEmptyJobFinderRepositoryState(),
      });
      await initialRepository.close();

      const firstService = await createJobFinderWorkspaceServiceAsync({
        NESTOR_USER_DATA_DIR: userDataDirectory,
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_BROWSER_AGENT: "0",
      });
      try {
        await firstService.resetWorkspace(seed);
      } finally {
        await firstService.shutdown();
      }

      const secondService = await createJobFinderWorkspaceServiceAsync({
        NESTOR_USER_DATA_DIR: userDataDirectory,
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_BROWSER_AGENT: "0",
      });
      try {
        const snapshot = await secondService.getWorkspaceSnapshot();
        const persistedResume = snapshot.profile.baseResume;
        expect(persistedResume.storagePath).toBe(resumePath);
        expect(path.isAbsolute(persistedResume.storagePath ?? "")).toBe(true);
        expect(persistedResume.sha256).toBe(resumeSha256);
        expect(await readFile(persistedResume.storagePath!)).toEqual(
          resumeBytes,
        );
        expect(persistedResume.analysisWarnings).not.toContain(
          missingResumeSourceWarning,
        );
      } finally {
        await secondService.shutdown();
      }
    },
  );

  test("clears a legacy relative returning-resume path during real startup recovery", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "nestor-returning-resume-legacy-startup-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    const relativeResumePath = "persona-assets/resume/P13-returning.txt";
    const sourcePath = path.join(userDataDirectory, relativeResumePath);
    const sourceBytes = Buffer.from("legacy returning resume bytes", "utf8");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, sourceBytes);

    const seed = createEmptyJobFinderRepositoryState();
    seed.profile = CandidateProfileSchema.parse({
      ...seed.profile,
      id: "candidate_p13",
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_p13",
        fileName: "P13-returning.txt",
        uploadedAt: "2026-08-30T10:00:00.000Z",
        storagePath: relativeResumePath,
        sha256: "13".repeat(32),
        textContent: sourceBytes.toString("utf8"),
        textUpdatedAt: "2026-08-30T10:00:00.000Z",
        extractionStatus: "ready",
      },
    });
    const filePath = path.join(
      userDataDirectory,
      "job-finder-workspace.sqlite",
    );
    const initialRepository = await createFileJobFinderRepository({
      filePath,
      seed: createEmptyJobFinderRepositoryState(),
    });
    await initialRepository.close();

    const firstService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });
    try {
      await firstService.resetWorkspace(seed);
    } finally {
      await firstService.shutdown();
    }

    const secondService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });
    try {
      const snapshot = await secondService.getWorkspaceSnapshot();
      expect(snapshot.profile.baseResume.storagePath).toBeNull();
      expect(snapshot.profile.baseResume.sha256).toBeNull();
      expect(snapshot.profile.baseResume.analysisWarnings).toContain(
        missingResumeSourceWarning,
      );
      await expect(readFile(sourcePath)).resolves.toEqual(sourceBytes);
    } finally {
      await secondService.shutdown();
    }
  });

  test("completes a pending crash-interrupted reset while creating the workspace service", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "nestor-startup-recovery-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    const documentsDirectory = path.join(
      userDataDirectory,
      "documents",
      "resumes",
    );
    await mkdir(path.join(documentsDirectory, "generated"), {
      recursive: true,
    });
    await writeFile(
      path.join(documentsDirectory, "generated", "resume.pdf"),
      "%PDF-1.4 stale generated resume",
    );
    const candidateAssetPath = path.join(
      userDataDirectory,
      "documents",
      "candidate-assets",
      "headshot.png",
    );
    await mkdir(path.dirname(candidateAssetPath), { recursive: true });
    await writeFile(candidateAssetPath, "stale candidate asset bytes");
    const applicationDocumentPath = path.join(
      userDataDirectory,
      "documents",
      "application-documents",
      "cover-letter.pdf",
    );
    await mkdir(path.dirname(applicationDocumentPath), { recursive: true });
    await writeFile(
      applicationDocumentPath,
      "stale application document bytes",
    );
    const browserProfileCookiePath = path.join(
      userDataDirectory,
      "browser-agent",
      "default",
      "Cookies",
    );
    await mkdir(path.dirname(browserProfileCookiePath), { recursive: true });
    await writeFile(browserProfileCookiePath, "stale-session-bytes");

    const crashToken = "startup-0001";
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
        entries: [
          {
            sourcePath: "documents/resumes",
            trashPath: `trash/job-finder-reset-${crashToken}/documents/resumes`,
          },
          {
            sourcePath: "documents/candidate-assets",
            trashPath: `trash/job-finder-reset-${crashToken}/documents/candidate-assets`,
          },
          {
            sourcePath: "documents/application-documents",
            trashPath: `trash/job-finder-reset-${crashToken}/documents/application-documents`,
          },
          {
            sourcePath: "browser-agent/default",
            trashPath: `trash/job-finder-reset-${crashToken}/browser-agent/default`,
          },
        ],
      })}\n`,
      "utf8",
    );

    const workspaceService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });

    try {
      const snapshot = await workspaceService.getWorkspaceSnapshot();

      expect(snapshot.profile.baseResume.storagePath).toBeNull();
      expect(snapshot.discoveryJobs).toHaveLength(0);
      expect(snapshot.discoverySessions).toHaveLength(0);

      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(path.join(userDataDirectory, "documents", "resumes")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(candidateAssetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(applicationDocumentPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(browserProfileCookiePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        stat(
          path.join(
            userDataDirectory,
            "trash",
            `job-finder-reset-${crashToken}`,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const recoveryFact = getJobFinderStartupResetRecoveryFact();
      expect(recoveryFact.status).toBe("completed");
      if (recoveryFact.status !== "completed") {
        throw new Error("unreachable");
      }
      expect(recoveryFact.token).toBe(crashToken);
      expect(recoveryFact.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await workspaceService.shutdown();
    }
  });

  test("boots with a degraded recovery fact when the pending marker is malformed and quarantines it", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "nestor-startup-recovery-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    const documentsDirectory = path.join(
      userDataDirectory,
      "documents",
      "resumes",
    );
    await mkdir(path.join(documentsDirectory, "generated"), {
      recursive: true,
    });
    await writeFile(
      path.join(documentsDirectory, "generated", "resume.pdf"),
      "%PDF-1.4 keep me",
    );
    await writeFile(
      path.join(userDataDirectory, "job-finder-reset-intent.json"),
      "{ not valid json",
      "utf8",
    );

    const workspaceService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });

    try {
      const snapshot = await workspaceService.getWorkspaceSnapshot();
      expect(snapshot.discoveryJobs).toHaveLength(0);

      expect(getJobFinderStartupResetRecoveryFact().status).toBe("degraded");
      const recoveryFact = getJobFinderStartupResetRecoveryFact();
      if (recoveryFact.status !== "degraded") {
        throw new Error("unreachable");
      }
      expect(recoveryFact.reason).toBe("marker_quarantined_malformed");
      expect(recoveryFact.quarantinedFileName).toMatch(
        /^job-finder-reset-intent\.invalid-.+\.json$/,
      );

      const userDataEntries = await readdir(userDataDirectory);
      const quarantinedNames = userDataEntries.filter((entryName) =>
        entryName.startsWith("job-finder-reset-intent.invalid-"),
      );
      expect(quarantinedNames).toHaveLength(1);

      await expect(
        stat(path.join(userDataDirectory, "job-finder-reset-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(path.join(documentsDirectory, "generated", "resume.pdf")),
      ).resolves.toBeTruthy();
    } finally {
      await workspaceService.shutdown();
    }
  });

  test("boots with a degraded recovery fact when the pending marker is oversized and never reads it as a reset intent", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "nestor-startup-recovery-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    const documentsDirectory = path.join(
      userDataDirectory,
      "documents",
      "resumes",
    );
    await mkdir(path.join(documentsDirectory, "generated"), {
      recursive: true,
    });
    await writeFile(
      path.join(documentsDirectory, "generated", "resume.pdf"),
      "%PDF-1.4 keep me too",
    );
    await writeFile(
      path.join(userDataDirectory, "job-finder-reset-intent.json"),
      "x".repeat(64 * 1024 + 1),
      "utf8",
    );

    const workspaceService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });

    try {
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_oversized",
      });

      const userDataEntries = await readdir(userDataDirectory);
      expect(
        userDataEntries.filter((entryName) =>
          entryName.startsWith("job-finder-reset-intent.invalid-"),
        ),
      ).toHaveLength(1);
      await expect(
        stat(path.join(documentsDirectory, "generated", "resume.pdf")),
      ).resolves.toBeTruthy();
    } finally {
      await workspaceService.shutdown();
    }
  });

  test("pauses recovery with retained files and durable evidence when an invalid marker coexists with set-aside reset trash", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "nestor-startup-recovery-"),
    );
    temporaryDirectories.push(temporaryRoot);
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    process.env.NESTOR_USER_DATA_DIR = userDataDirectory;
    process.env.NESTOR_ENABLE_TEST_API = "1";
    process.env.NESTOR_BROWSER_AGENT = "0";

    const documentsDirectory = path.join(
      userDataDirectory,
      "documents",
      "resumes",
    );
    await mkdir(path.join(documentsDirectory, "generated"), {
      recursive: true,
    });
    await writeFile(
      path.join(documentsDirectory, "generated", "resume.pdf"),
      "%PDF-1.4 keep me during quarantine",
    );
    const heldTrashName = "job-finder-reset-heldtoken001";
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
      "%PDF-1.4 set aside before the marker was damaged",
    );
    const staleMoment = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(heldTrashDirectory, staleMoment, staleMoment);
    await writeFile(
      path.join(userDataDirectory, "job-finder-reset-intent.json"),
      "{ not valid json",
      "utf8",
    );

    const workspaceService = await createJobFinderWorkspaceServiceAsync({
      NESTOR_USER_DATA_DIR: userDataDirectory,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_BROWSER_AGENT: "0",
    });

    try {
      expect(getJobFinderStartupResetRecoveryFact()).toMatchObject({
        status: "degraded",
        reason: "marker_quarantined_with_pending_trash",
      });
      const recoveryFact = getJobFinderStartupResetRecoveryFact();
      if (recoveryFact.status !== "degraded") {
        throw new Error("unreachable");
      }
      expect(recoveryFact.quarantinedFileName).toMatch(
        /^job-finder-reset-intent\.invalid-.+\.json$/,
      );

      const sidecarNames = (await readdir(userDataDirectory)).filter(
        (entryName) => entryName.endsWith(".pending-trash.json"),
      );
      expect(sidecarNames).toHaveLength(1);
      await expect(
        readFile(path.join(userDataDirectory, sidecarNames[0]!), "utf8"),
      ).resolves.toContain(heldTrashName);

      await sweepStaleJobFinderResetArtifacts();
      await expect(stat(heldTrashDirectory)).resolves.toBeTruthy();
      await expect(
        readFile(
          path.join(heldTrashDirectory, "documents", "resumes", "resume.pdf"),
        ),
      ).resolves.toEqual(
        Buffer.from("%PDF-1.4 set aside before the marker was damaged"),
      );
      await expect(
        stat(path.join(userDataDirectory, "documents", "candidate-assets")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await utimes(heldTrashDirectory, staleMoment, staleMoment);
      await sweepStaleJobFinderResetArtifacts();
      await expect(stat(heldTrashDirectory)).resolves.toBeTruthy();
      await expect(
        stat(path.join(documentsDirectory, "generated", "resume.pdf")),
      ).resolves.toBeTruthy();
    } finally {
      await workspaceService.shutdown();
    }
  });
});
