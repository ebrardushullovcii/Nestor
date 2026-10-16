import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  ProfileCopilotMessageSchema,
  ResumeAssistantMessageSchema,
  ResumeDraftSchema,
  SavedJobSchema,
  type ResumeAssistantMessage,
} from "@nordri/contracts";
import {
  createAssistantRepository,
  createFileJobFinderRepository,
} from "@nordri/db";
import { expect, test, vi } from "vitest";
import { createJobFinderWorkspaceService } from "../index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";
import {
  migrateLegacyChats,
  resumeArchiveConversationId,
} from "./legacy-migration";
import type { AssistantHostPorts } from "./ports";
import { AssistantSessionHost } from "./session-host";

const at = "2026-10-13T10:00:00.000Z";
const ports: AssistantHostPorts = {
  startSearch: () => Promise.resolve({ runId: null, message: "unused" }),
  cancelSearch: () => Promise.resolve(),
  startApplications: () =>
    Promise.resolve({ startedJobIds: [], heldBack: [], runId: null }),
  sendPreparedApplications: () =>
    Promise.resolve({ sentJobIds: [], failed: [] }),
  checkSource: () => Promise.resolve(),
  listDocuments: () => Promise.resolve([]),
  readDocumentText: () => Promise.resolve(null),
  loadDocumentFile: () =>
    Promise.resolve({
      name: "unused",
      mimeType: "text/plain",
      bytes: new Uint8Array(),
    }),
  importResumeDocument: () => Promise.resolve(),
  publishWorkspaceUpdate: () => undefined,
};

test("a timer runs before a 2001-message legacy migration completes", async () => {
  const repository = createAssistantRepository({ filePath: ":memory:" });
  const profileMessages = Array.from({ length: 2001 }, (_, i) =>
    ProfileCopilotMessageSchema.parse({
      id: `liveness_profile_${i}`,
      role: "user",
      content: `Synthetic archived request ${i}.`,
      createdAt: new Date(Date.parse(at) + i * 1000).toISOString(),
    }),
  );
  let completed = false;
  let messagesAtTimer: number | null = null;
  let completedAtTimer: boolean | null = null;
  const timerFired = new Promise<void>((resolve) => {
    setTimeout(() => {
      completedAtTimer = completed;
      void repository
        .countMessages("assistant_archive_profile")
        .then((count) => {
          messagesAtTimer = count;
          resolve();
        });
    }, 0);
  });
  try {
    const result = await migrateLegacyChats({
      repository,
      profileMessages,
      resumeMessagesByJob: new Map(),
      now: at,
    });
    completed = true;
    await timerFired;
    console.info("legacy-migration-timer-liveness", {
      completedAtTimer,
      messagesAtTimer,
      migratedMessages: result.messages,
    });
    expect(completedAtTimer).toBe(false);
    expect(messagesAtTimer).toBeGreaterThan(0);
    expect(messagesAtTimer).toBeLessThan(2001);
    expect(result.messages).toBe(2001);
    expect(await repository.countMessages("assistant_archive_profile")).toBe(
      2001,
    );
  } finally {
    await timerFired;
    await repository.close();
  }
});

test("a timer runs during 1000 nonempty resume-chat migrations", async () => {
  const repository = createAssistantRepository({ filePath: ":memory:" });
  const resumeMessagesByJob = new Map(
    Array.from({ length: 1000 }, (_, i) => {
      const jobId = `liveness_job_${i}`;
      return [
        jobId,
        {
          jobTitle: `Synthetic role ${i}`,
          messages: ["user", "assistant"].map((role, index) =>
            ResumeAssistantMessageSchema.parse({
              id: `liveness_resume_${i}_${index}`,
              jobId,
              role,
              content: `Synthetic archived ${role} message ${i}.`,
              createdAt: new Date(Date.parse(at) + index * 1000).toISOString(),
            }),
          ),
        },
      ] as const;
    }),
  );
  let completed = false;
  let written = 0;
  let completedAtTimer = true;
  let messagesAtTimer = 0;
  const originalWrite = repository.upsertMessage.bind(repository);
  const writeSpy = vi
    .spyOn(repository, "upsertMessage")
    .mockImplementation(async (message) => {
      await originalWrite(message);
      written += 1;
    });
  const timerFired = new Promise<void>((resolve) => {
    setTimeout(() => {
      completedAtTimer = completed;
      messagesAtTimer = written;
      resolve();
    }, 0);
  });
  try {
    const result = await migrateLegacyChats({
      repository,
      profileMessages: [],
      resumeMessagesByJob,
      now: at,
    });
    completed = true;
    await timerFired;
    expect(completedAtTimer).toBe(false);
    expect(messagesAtTimer).toBeGreaterThan(0);
    expect(messagesAtTimer).toBeLessThan(2000);
    expect(result).toEqual({ conversations: 1000, messages: 2000 });
    expect(written).toBe(2000);
    console.info("legacy-resume-migration-timer-liveness", {
      completedAtTimer,
      messagesAtTimer,
      migratedMessages: result.messages,
    });
  } finally {
    await timerFired;
    writeSpy.mockRestore();
    await repository.close();
  }
});

test("shutdown at a migration yield safely closes the store and restart preserves every message once", async () => {
  const seed = createSeed();
  seed.resumeAssistantMessages = Array.from({ length: 2001 }, (_, i) =>
    ResumeAssistantMessageSchema.parse({
      id: `shutdown_legacy_${i}`,
      jobId: "job_ready",
      role: "user",
      content: `Synthetic retained request ${i}.`,
      createdAt: new Date(Date.parse(at) + i * 1000).toISOString(),
    }),
  );
  const { repository: workspaceRepository, workspaceService } =
    createWorkspaceServiceHarness({ seed });
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "nordri-migration-stop-"),
  );
  const filePath = path.join(directory, "assistant.sqlite");
  let assistantRepository = createAssistantRepository({ filePath });
  const makeHost = () =>
    new AssistantSessionHost({
      repository: assistantRepository,
      service: workspaceService,
      ports,
      resolveModel: () => {
        throw new Error("Migration must never replay old requests.");
      },
      publish: () => undefined,
    });
  let host = makeHost();
  let written = 0;
  let writesAtShutdown = 0;
  let shutdownRequested = false;
  const closing = { task: Promise.resolve() };
  const originalWrite =
    assistantRepository.upsertMessage.bind(assistantRepository);
  const writeSpy = vi
    .spyOn(assistantRepository, "upsertMessage")
    .mockImplementation(async (message) => {
      await originalWrite(message);
      written += 1;
      if (written === 5) {
        setTimeout(() => {
          shutdownRequested = true;
          closing.task = (async () => {
            await host.shutdown();
            writesAtShutdown = written;
            await assistantRepository.close();
          })();
        }, 0);
      }
    });
  try {
    const migration = host.migrateLegacyHistory();
    // Concurrent startup callers share the same migration instead of
    // racing the per-message marker lookup across cooperative yields.
    const duplicate = host.migrateLegacyHistory();
    const partial = await migration;
    expect(await duplicate).toEqual(partial);
    expect(shutdownRequested).toBe(true);
    await closing.task;
    expect(partial.messages).toBeGreaterThanOrEqual(5);
    expect(partial.messages).toBeLessThan(2001);
    expect(written).toBe(writesAtShutdown);
    expect((await host.migrateLegacyHistory()).messages).toBe(0);
    writeSpy.mockRestore();
    assistantRepository = createAssistantRepository({ filePath });
    const archiveId = resumeArchiveConversationId("job_ready");
    const savedPrefix = await assistantRepository.countMessages(archiveId);
    const partialChat = await assistantRepository.getConversation(archiveId);
    expect(savedPrefix).toBe(partial.messages);
    expect(partialChat).toMatchObject({
      messageCount: savedPrefix,
      lastMessageAt: seed.resumeAssistantMessages[savedPrefix - 1]!.createdAt,
    });
    host = makeHost();
    const resumed = await host.migrateLegacyHistory();
    expect(resumed.messages).toBe(2001 - savedPrefix);
    expect(await assistantRepository.countMessages(archiveId)).toBe(2001);
    expect(await assistantRepository.getConversation(archiveId)).toMatchObject({
      messageCount: 2001,
      lastMessageAt: seed.resumeAssistantMessages[2000]!.createdAt,
    });
    for (const legacy of seed.resumeAssistantMessages) {
      const migrated = await assistantRepository.findMigratedMessage(
        "resume_assistant",
        legacy.id,
      );
      expect(migrated?.parts[0]).toEqual({
        type: "text",
        text: legacy.content,
      });
    }
    expect((await host.migrateLegacyHistory()).messages).toBe(0);
    console.info("legacy-migration-shutdown-restart", {
      savedPrefix,
      resumedMessages: resumed.messages,
      finalMessages: 2001,
    });
  } finally {
    vi.restoreAllMocks();
    await closing.task;
    await host.shutdown();
    await assistantRepository.close();
    await workspaceRepository.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("a host closed during the history read never starts migration or reads again", async () => {
  const { repository: workspaceRepository, workspaceService } =
    createWorkspaceServiceHarness();
  const assistantRepository = createAssistantRepository({
    filePath: ":memory:",
  });
  let releaseHistory: (
    messages: readonly ResumeAssistantMessage[],
  ) => void = () => undefined;
  const pendingHistory = new Promise<readonly ResumeAssistantMessage[]>(
    (resolve) => {
      releaseHistory = resolve;
    },
  );
  const historyReads = vi
    .spyOn(workspaceService, "getResumeAssistantHistory")
    .mockReturnValue(pendingHistory);
  const conversationWrites = vi.spyOn(
    assistantRepository,
    "upsertConversation",
  );
  const host = new AssistantSessionHost({
    repository: assistantRepository,
    service: workspaceService,
    ports,
    resolveModel: () => {
      throw new Error("A closed host cannot replay requests.");
    },
    publish: () => undefined,
  });
  try {
    const migration = host.migrateLegacyHistory();
    const shutdown = host.shutdown();
    releaseHistory([
      ResumeAssistantMessageSchema.parse({
        id: "late_history",
        jobId: "job_ready",
        role: "user",
        content: "A synthetic request returned after closing.",
        createdAt: at,
      }),
    ]);
    expect(await migration).toEqual({ conversations: 0, messages: 0 });
    await shutdown;
    expect(await host.migrateLegacyHistory()).toEqual({
      conversations: 0,
      messages: 0,
    });
    expect(historyReads).toHaveBeenCalledTimes(1);
    expect(conversationWrites).not.toHaveBeenCalled();
  } finally {
    releaseHistory([]);
    await host.shutdown();
    vi.restoreAllMocks();
    await assistantRepository.close();
    await workspaceRepository.close();
  }
});

for (const hasHistory of [false, true]) {
  test(`1000 ${hasHistory ? "nonempty" : "empty"} legacy resume histories use one read-only batch, including after restart/import`, async () => {
    const seed = createSeed();
    seed.savedJobs = Array.from({ length: 3000 }, (_, i) =>
      SavedJobSchema.parse({
        ...seed.savedJobs[0],
        id: `legacy_job_${i}`,
        company: `Synthetic legacy company ${i}`,
        title: `Synthetic legacy role ${i}`,
        canonicalUrl: `https://example.test/legacy/${i}`,
        employerDomain: null,
        employerWebsiteUrl: null,
        status: i < 1000 ? "ready_for_review" : "discovered",
        provenance: [],
      }),
    );
    seed.resumeDrafts = seed.savedJobs.slice(0, 1000).map((job, i) =>
      ResumeDraftSchema.parse({
        id: `legacy_draft_${i}`,
        jobId: job.id,
        status: "needs_review",
        templateId: "classic_ats",
        sections: [],
        createdAt: at,
        updatedAt: at,
      }),
    );
    seed.tailoredAssets = seed.resumeDrafts.map((draft, i) => ({
      ...seed.tailoredAssets[0]!,
      id: `legacy_asset_${i}`,
      jobId: draft.jobId,
      contentText: "Synthetic retained resume body. ".repeat(128),
    }));
    seed.resumeAssistantMessages = hasHistory
      ? seed.resumeDrafts.flatMap((draft, i) => [
          ResumeAssistantMessageSchema.parse({
            id: `legacy_user_${i}`,
            jobId: draft.jobId,
            role: "user",
            content: `Keep this synthetic request ${i} as history only.`,
            createdAt: at,
          }),
          ResumeAssistantMessageSchema.parse({
            id: `legacy_reply_${i}`,
            jobId: draft.jobId,
            role: "assistant",
            content: `Synthetic retained reply ${i}.`,
            createdAt: "2026-10-13T10:01:00.000Z",
          }),
        ])
      : [];
    seed.profileCopilotMessages = hasHistory
      ? [
          ProfileCopilotMessageSchema.parse({
            id: "legacy_profile",
            role: "user",
            content: "Keep this synthetic profile request as history only.",
            createdAt: at,
          }),
        ]
      : [];
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nordri-legacy-scale-"),
    );
    const filePath = path.join(directory, "workspace.sqlite");
    const assistantPath = path.join(directory, "assistant.sqlite");
    let workspaceRepository = await createFileJobFinderRepository({
      filePath,
      seed,
    });
    let assistantRepository = createAssistantRepository({
      filePath: assistantPath,
    });
    let host: AssistantSessionHost | null = null;
    try {
      for (const restart of [false, true]) {
        const service = createJobFinderWorkspaceService({
          repository: workspaceRepository,
          aiClient: createAiClient(),
          browserRuntime: createBrowserRuntime(),
          documentManager: createDocumentManager(),
        });
        host = new AssistantSessionHost({
          repository: assistantRepository,
          service,
          ports,
          resolveModel: () => {
            throw new Error(
              "Migration must never run a model or replay commands.",
            );
          },
          publish: () => undefined,
        });
        // Count the old quadratic call without performing a million body
        // hydrations in the failing regression. Real SQLite backs every other read.
        const fullAssetReads = vi
          .spyOn(workspaceRepository, "listTailoredAssets")
          .mockResolvedValue([]);
        const historyReads = vi.spyOn(
          workspaceRepository,
          "listResumeAssistantMessages",
        );
        const draftReads = vi.spyOn(
          workspaceRepository,
          "getResumeDraftByJobId",
        );
        const draftWrites = vi.spyOn(workspaceRepository, "upsertResumeDraft");
        const assetWrites = vi.spyOn(
          workspaceRepository,
          "upsertTailoredAsset",
        );
        const uiGetter = vi.spyOn(service, "getResumeAssistantMessages");
        const started = performance.now();
        const migrated = await host.migrateLegacyHistory();
        console.info("legacy-migration-operations", {
          histories: 1000,
          hasHistory,
          restart,
          fullAssetReads: fullAssetReads.mock.calls.length,
          historyReads: historyReads.mock.calls.length,
          migratedMessages: migrated.messages,
          elapsedMs: +(performance.now() - started).toFixed(2),
        });
        expect(fullAssetReads.mock.calls.length).toBe(0);
        expect(uiGetter).not.toHaveBeenCalled();
        expect(draftReads).not.toHaveBeenCalled();
        expect(draftWrites).not.toHaveBeenCalled();
        expect(assetWrites).not.toHaveBeenCalled();
        expect(historyReads.mock.calls).toEqual([[]]);
        expect(migrated.messages).toBe(hasHistory && !restart ? 2001 : 0);
        if (hasHistory) {
          expect(await assistantRepository.listConversations()).toHaveLength(
            1001,
          );
          for (let i = 0; i < 1000; i++) {
            const chat = await assistantRepository.getConversation(
              resumeArchiveConversationId(`legacy_job_${i}`),
            );
            expect(chat).toMatchObject({ status: "archived", messageCount: 2 });
            const messages = await assistantRepository.listMessages(chat!.id);
            expect(
              messages.messages.map(
                (message) => message.migratedFrom?.legacyId,
              ),
            ).toEqual([`legacy_user_${i}`, `legacy_reply_${i}`]);
            expect(
              messages.messages.every(
                (message) => message.origin === "migrated",
              ),
            ).toBe(true);
            expect(
              messages.messages.map((message) => message.parts[0]),
            ).toEqual([
              {
                type: "text",
                text: `Keep this synthetic request ${i} as history only.`,
              },
              { type: "text", text: `Synthetic retained reply ${i}.` },
            ]);
          }
          expect(
            (
              await assistantRepository.findMigratedMessage(
                "profile_copilot",
                "legacy_profile",
              )
            )?.parts,
          ).toEqual([
            {
              type: "text",
              text: "Keep this synthetic profile request as history only.",
            },
          ]);
        }
        vi.restoreAllMocks();
        await host.shutdown();
        host = null;
        if (!restart) {
          await workspaceRepository.close();
          await assistantRepository.close();
          workspaceRepository = await createFileJobFinderRepository({
            filePath,
            seed: createSeed(),
          });
          assistantRepository = createAssistantRepository({
            filePath: assistantPath,
          });
        } else {
          // Imported/added legacy history is not suppressed by a global done flag.
          await workspaceRepository.upsertResumeAssistantMessage(
            ResumeAssistantMessageSchema.parse({
              id: "legacy_imported_later",
              jobId: "legacy_job_999",
              role: "user",
              content:
                "A synthetic legacy chat imported after the first migration.",
              createdAt: "2026-10-13T11:00:00.000Z",
            }),
          );
          host = new AssistantSessionHost({
            repository: assistantRepository,
            service,
            ports,
            resolveModel: () => {
              throw new Error("Migration must not replay imported requests.");
            },
            publish: () => undefined,
          });
          expect((await host.migrateLegacyHistory()).messages).toBe(1);
          expect(
            await assistantRepository.findMigratedMessage(
              "resume_assistant",
              "legacy_imported_later",
            ),
          ).not.toBeNull();
        }
      }
    } finally {
      vi.restoreAllMocks();
      await host?.shutdown();
      await workspaceRepository.close();
      await assistantRepository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}

test("migration keeps chats without a draft and retains actionable resume proposal links", async () => {
  const seed = createSeed();
  seed.resumeDrafts = [];
  seed.resumeAssistantMessages = [
    ResumeAssistantMessageSchema.parse({
      id: "legacy_pending_resume",
      jobId: "job_ready",
      role: "assistant",
      content: "A synthetic optional resume change.",
      proposalStatus: "pending",
      createdAt: at,
      patches: [
        {
          id: "legacy_pending_patch",
          draftId: "old_draft_no_longer_present",
          operation: "replace_section_text",
          targetSectionId: "old_summary",
          newText: "A synthetic replacement.",
          appliedAt: at,
          origin: "assistant",
        },
      ],
    }),
  ];
  const { repository, workspaceService } = createWorkspaceServiceHarness({
    seed,
  });
  const assistantRepository = createAssistantRepository({
    filePath: ":memory:",
  });
  const host = new AssistantSessionHost({
    repository: assistantRepository,
    service: workspaceService,
    ports,
    resolveModel: () => {
      throw new Error("Migration must not execute requests.");
    },
    publish: () => undefined,
  });
  try {
    expect((await host.migrateLegacyHistory()).messages).toBe(1);
    expect(await repository.listResumeDrafts()).toEqual([]);
    const message = await assistantRepository.findMigratedMessage(
      "resume_assistant",
      "legacy_pending_resume",
    );
    expect(message?.parts[1]).toMatchObject({
      type: "proposal",
      proposalId: "legacy_resume_legacy_pending_resume",
      status: "pending",
      targetId: "job_ready",
      source: {
        store: "resume_assistant",
        legacyMessageId: "legacy_pending_resume",
      },
      items: [{ id: "legacy_pending_patch" }],
    });
    await host.resolveProposal({
      conversationId: resumeArchiveConversationId("job_ready"),
      messageId: message!.id,
      proposalId: "legacy_resume_legacy_pending_resume",
      action: "reject",
      itemIds: [],
    });
    expect(
      (await repository.listResumeAssistantMessages("job_ready"))[0]
        ?.proposalStatus,
    ).toBe("rejected");
    expect(
      (await assistantRepository.getMessage(message!.id))?.parts[1],
    ).toMatchObject({ type: "proposal", status: "rejected" });
    expect(await repository.listResumeDrafts()).toEqual([]);
    expect((await host.migrateLegacyHistory()).messages).toBe(0);
  } finally {
    await host.shutdown();
    await assistantRepository.close();
    await repository.close();
  }
});
