import {
  JobFinderRepositoryStateSchema,
  PersonalWorkspaceExportSchema,
  AssistantConversationSchema,
  AssistantMessageSchema,
  ApplicationRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplicationAnswerRecordSchema,
  SavedJobSchema,
  ApplyQueueSchema,
} from "@nestor/contracts";
import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
} from "@nestor/db";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  parsePersonalWorkspaceExport,
  restorePersonalWorkspace,
} from "./personal-workspace-restore";
import { buildPersonalWorkspaceExport } from "./build-diagnostic-export";
import type {
  JobFinderWorkspaceSnapshot,
  PersonalWorkspaceExport,
} from "@nestor/contracts";

vi.mock("electron", () => ({ app: { getPath: () => "/synthetic" } }));

const at = "2026-10-05T10:00:00.000Z";
const waitingQueue = ApplyQueueSchema.parse({
  id: "saved-queue",
  mode: "autonomous_submit",
  state: "waiting_for_tomorrow",
  jobIds: ["job"],
  assistantScopes: [{ conversationId: "chat", jobIds: ["job"] }],
  startedJobIds: [],
  skipped: [],
  activeRunId: null,
  pausedReason: null,
  resumesAt: "2026-10-06T00:00:00.000Z",
  createdAt: at,
  updatedAt: at,
});
function state(directory: string) {
  return JobFinderRepositoryStateSchema.parse({
    profile: {
      id: "synthetic",
      fullName: "Synthetic Example",
      yearsExperience: 2,
      baseResume: {
        id: "resume",
        fileName: "resume.txt",
        uploadedAt: at,
        storagePath: path.join(directory, "resume.txt"),
        textContent: "Synthetic resume",
      },
      answerBank: {
        customAnswers: [
          {
            id: "answer",
            label: "Hours",
            question: "Hours?",
            answer: "20",
            kind: "other",
          },
        ],
      },
    },
    searchPreferences: {
      workModes: ["remote"],
      minimumSalaryUsd: null,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
    },
    settings: {
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      preferPdfResume: true,
      keepSessionAlive: true,
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
    },
  });
}

test.each(["memory", "file"])(
  "%s export round trip restores the waiting Apply queue under the global pause, with profile, jobs, applications, answers, documents and chats",
  async (kind) => {
    const directory = await mkdtemp(path.join(tmpdir(), "restore-roundtrip-"));
    let fileRepository:
      | Awaited<ReturnType<typeof createFileJobFinderRepository>>
      | undefined;
    try {
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      await mkdir(source);
      await mkdir(target);
      await writeFile(path.join(source, "resume.txt"), "Synthetic resume");
      await writeFile(path.join(target, "old.txt"), "Current document");
      const original = state(source);
      original.savedJobs = [
        SavedJobSchema.parse({
          id: "job",
          source: "target_site",
          sourceJobId: "job",
          canonicalUrl: "https://example.test/job",
          title: "Analyst",
          company: "Synthetic",
          location: "Canada",
          discoveredAt: at,
          firstSeenAt: at,
          lastSeenAt: at,
          workMode: ["remote"],
          applyPath: "external_redirect",
          easyApplyEligible: false,
          salaryText: null,
          description: "Synthetic role",
          status: "discovered",
          matchAssessment: { score: 80 },
        }),
      ];
      original.applicationRecords = [
        ApplicationRecordSchema.parse({
          id: "app",
          jobId: "job",
          title: "Analyst",
          company: "Synthetic",
          status: "discovered",
          lastActionLabel: "Saved",
          nextActionLabel: null,
          lastUpdatedAt: at,
        }),
      ];
      original.applicationQuestionRecords = [
        ApplicationQuestionRecordSchema.parse({
          id: "question",
          runId: "run",
          jobId: "job",
          prompt: "Hours?",
          detectedAt: at,
        }),
      ];
      original.applicationAnswerRecords = [
        ApplicationAnswerRecordSchema.parse({
          id: "answer",
          questionId: "question",
          runId: "run",
          jobId: "job",
          text: "20",
          sourceKind: "user",
          createdAt: at,
        }),
      ];
      const chats = [
        {
          conversation: AssistantConversationSchema.parse({
            id: "chat",
            title: "Synthetic chat",
            createdAt: at,
            updatedAt: at,
          }),
          messages: [
            AssistantMessageSchema.parse({
              id: "message",
              conversationId: "chat",
              role: "user",
              origin: "sidebar",
              parts: [],
              createdAt: at,
            }),
          ],
        },
      ];
      const content = await buildPersonalWorkspaceExport({
        repositoryState: original,
        workspace: {
          profile: original.profile,
          applyQueue: waitingQueue,
        } as JobFinderWorkspaceSnapshot,
        directories: [{ name: "resumes", directory: source }],
        assistantHistory: chats,
        generatedAt: at,
      });
      const backup = parsePersonalWorkspaceExport(content);
      const current = state(target);
      const filePath = path.join(directory, "workspace.sqlite");
      const repository =
        kind === "file"
          ? (fileRepository = await createFileJobFinderRepository({
              filePath,
              seed: current,
            }))
          : createInMemoryJobFinderRepository(current);
      let restoredChats: PersonalWorkspaceExport["assistantHistory"] = [];
      const safety = path.join(directory, "safety.json");
      await restorePersonalWorkspace({
        backup,
        repository,
        roots: new Map([["resumes", target]]),
        safetyExportPath: safety,
        buildSafetyExport: () => Promise.resolve("current safety export"),
        readChats: () => Promise.resolve([]),
        restoreChats: (history) => {
          restoredChats = history;
          return Promise.resolve();
        },
      });
      const restored = await repository.exportState();
      expect(restored.profile.fullName).toBe(original.profile.fullName);
      expect(restored.profile.baseResume.storagePath).toBe(
        path.join(target, "resume.txt"),
      );
      expect(restored.savedJobs).toEqual(original.savedJobs);
      expect(restored.applicationRecords).toEqual(original.applicationRecords);
      expect(restored.applicationAnswerRecords).toEqual(
        original.applicationAnswerRecords,
      );
      expect(restored.profile.answerBank).toEqual(original.profile.answerBank);
      expect(restored.activityControl.paused).toBe(true);
      expect(await repository.getApplyQueue()).toEqual(waitingQueue);
      if (fileRepository) {
        await fileRepository.close();
        fileRepository = await createFileJobFinderRepository({
          filePath,
          seed: current,
        });
        expect(await fileRepository.getApplyQueue()).toEqual(waitingQueue);
        expect((await fileRepository.getActivityControl()).paused).toBe(true);
      }
      expect(restoredChats).toEqual(chats);
      expect(await readFile(path.join(target, "resume.txt"), "utf8")).toBe(
        "Synthetic resume",
      );
      expect(await readFile(safety, "utf8")).toBe("current safety export");
    } finally {
      await fileRepository?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("refuses unknown versions, older incomplete exports, traversal and damaged bytes", () => {
  expect(() => parsePersonalWorkspaceExport('{"schemaVersion":99}')).toThrow(
    "version Nestor cannot restore",
  );
  expect(() => parsePersonalWorkspaceExport('{"schemaVersion":1}')).toThrow(
    "older export",
  );
  const backup = {
    schemaVersion: 1,
    exportedAt: at,
    repositoryState: state("/synthetic"),
    fileRoots: [{ name: "resumes", directory: "/synthetic" }],
    assistantHistory: [],
    files: [
      { path: "resumes/../outside", encoding: "base64", content: "eA==" },
    ],
  };
  expect(() => parsePersonalWorkspaceExport(JSON.stringify(backup))).toThrow(
    "unsafe",
  );
  backup.files[0]!.path = "resumes/file.txt";
  backup.files[0]!.content = "invalid";
  expect(() => parsePersonalWorkspaceExport(JSON.stringify(backup))).toThrow(
    "damaged",
  );
  expect(() =>
    parsePersonalWorkspaceExport(
      JSON.stringify({
        ...backup,
        files: [],
        workspace: { applyQueue: { ...waitingQueue, jobIds: "damaged" } },
      }),
    ),
  ).toThrow("incomplete or damaged");
});

test("restoring an older export without a queue clears the current queue and stays paused", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "restore-without-queue-"),
  );
  try {
    const repository = createInMemoryJobFinderRepository(state(directory));
    await repository.saveApplyQueue(waitingQueue);
    await restorePersonalWorkspace({
      backup: parsePersonalWorkspaceExport(
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: at,
          repositoryState: await repository.exportState(),
          fileRoots: [],
          files: [],
          assistantHistory: [],
        }),
      ),
      repository,
      roots: new Map(),
      safetyExportPath: path.join(directory, "safety.json"),
      buildSafetyExport: () => Promise.resolve("backup"),
      readChats: () => Promise.resolve([]),
      restoreChats: () => Promise.resolve(),
    });
    expect(await repository.getApplyQueue()).toBeNull();
    expect((await repository.getActivityControl()).paused).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safety export failure makes no changes, and queue or chat failures roll every store back", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "restore-rollback-"));
  try {
    const target = path.join(directory, "resumes");
    await mkdir(target);
    await writeFile(path.join(target, "old.txt"), "Kept");
    const current = state(target);
    const repository = createInMemoryJobFinderRepository(current);
    const currentQueue = { ...waitingQueue, id: "current-queue" };
    await repository.saveApplyQueue(currentQueue);
    const backup = PersonalWorkspaceExportSchema.parse({
      schemaVersion: 1,
      exportedAt: at,
      repositoryState: {
        ...current,
        profile: { ...current.profile, fullName: "Replaced" },
      },
      workspace: { applyQueue: waitingQueue },
      fileRoots: [],
      files: [],
      assistantHistory: [],
    });
    const common = {
      backup,
      repository,
      roots: new Map([["resumes", target]]),
      readChats: () => Promise.resolve([]),
      restoreChats: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      restorePersonalWorkspace({
        ...common,
        safetyExportPath: path.join(directory, "missing", "safety.json"),
        buildSafetyExport: () => Promise.resolve("backup"),
      }),
    ).rejects.toThrow();
    expect(await repository.exportState()).toEqual(current);
    expect(await repository.getApplyQueue()).toEqual(currentQueue);
    expect(await readFile(path.join(target, "old.txt"), "utf8")).toBe("Kept");
    vi.spyOn(repository, "saveApplyQueue").mockRejectedValueOnce(
      new Error("Queue write failed"),
    );
    await expect(
      restorePersonalWorkspace({
        ...common,
        safetyExportPath: path.join(directory, "queue-safety.json"),
        buildSafetyExport: () => Promise.resolve("backup"),
      }),
    ).rejects.toThrow("Queue write failed");
    expect(await repository.exportState()).toEqual(current);
    expect(await repository.getApplyQueue()).toEqual(currentQueue);
    expect(await readFile(path.join(target, "old.txt"), "utf8")).toBe("Kept");
    common.restoreChats.mockRejectedValueOnce(new Error("Chat write failed"));
    await expect(
      restorePersonalWorkspace({
        ...common,
        safetyExportPath: path.join(directory, "safety.json"),
        buildSafetyExport: () => Promise.resolve("backup"),
      }),
    ).rejects.toThrow("Chat write failed");
    expect(await repository.exportState()).toEqual(current);
    expect(await repository.getApplyQueue()).toEqual(currentQueue);
    expect(await readFile(path.join(target, "old.txt"), "utf8")).toBe("Kept");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
