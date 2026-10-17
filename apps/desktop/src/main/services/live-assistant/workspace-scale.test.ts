import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import {
  InterviewLiveSessionSchema,
  InterviewWorkspaceSnapshotSchema,
  InterviewWorkspaceViewSchema,
  type InterviewWorkspaceSnapshot,
} from "@nestor/contracts";
import { createFileLiveAssistantRepository } from "@nestor/db";
import { createLiveAssistantService } from "@nestor/live-assistant";
import {
  createStaticDesktopAudioCaptureAdapter,
  createStaticDesktopScreenshotCaptureAdapter,
  createStaticProtectedOverlaySurfaceAdapter,
} from "@nestor/os-integration";
import {
  createDeterministicInterviewCueCardProvider,
  createDeterministicInterviewScreenshotVisionProvider,
  createDeterministicInterviewSummaryProvider,
  createDeterministicInterviewTranscriptionProvider,
} from "@nestor/ai-providers";

const now = "2026-10-13T00:00:00.000Z";
const createService = (
  repository: ReturnType<typeof createFileLiveAssistantRepository>,
) =>
  createLiveAssistantService({
    repository,
    audioCaptureAdapter: createStaticDesktopAudioCaptureAdapter("win32"),
    screenshotCaptureAdapter: createStaticDesktopScreenshotCaptureAdapter({
      now: () => now,
    }),
    protectedSurfaceAdapter: createStaticProtectedOverlaySurfaceAdapter({
      platform: "win32",
      now: () => now,
    }),
    cueCardProvider: createDeterministicInterviewCueCardProvider(),
    screenshotVisionProvider:
      createDeterministicInterviewScreenshotVisionProvider(),
    transcriptionProvider: createDeterministicInterviewTranscriptionProvider(),
    summaryProvider: createDeterministicInterviewSummaryProvider(),
    now: () => now,
  });

// No Electron launch, live providers, or user-data access. This exercises the
// service and real storage together with an archive larger than a normal day.
test("100 capture updates touch only the active body with 3,000 retained sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nestor-live-scale-"));
  const filePath = path.join(directory, "live-assistant-workspace.json");
  let repository = createFileLiveAssistantRepository({ filePath });
  let service = createService(repository);
  let probe: DatabaseSync | null = null;
  try {
    await service.saveSetup({
      consent: {
        microphoneCapture: true,
        meetingAudioCapture: true,
        screenshotCapture: true,
        modelTransmission: true,
        localRetention: true,
        overlayProtectionNotice: true,
        acceptedAt: now,
      },
      cueSensitivity: "manual_only",
    });
    await service.runRehearsal();
    const started = await service.startSession();
    const sessionId = started.activeSession!.id;
    await service.addTranscriptSegment({
      sessionId,
      source: "typed_question",
      text: "How do you isolate IPC?",
      engineKind: "platform_local",
    });
    await service.sendChatMessage({
      sessionId,
      conversationId: `interview_${sessionId}`,
      content: "Explain the typed boundary.",
      attachments: [],
    });
    const ended = await service.performAction({ action: "end_session" });
    const prototype = (await service.getSession(ended.recentSessions[0]!.id))!;
    const canonical = (await repository.load())!;
    await service.close();

    const archivedSessions = Array.from({ length: 3000 }, (_, index) => ({
      ...prototype,
      id: `archive-${index}`,
      transcriptSegments: Array.from({ length: 20 }, (_, segmentIndex) => ({
        ...prototype.transcriptSegments[0]!,
        id: `archive-${index}-segment-${segmentIndex}`,
        sessionId: `archive-${index}`,
        text: `Synthetic historical segment ${index}/${segmentIndex}. ${"retained words ".repeat(12).trim()}`,
      })),
    }));
    const legacySnapshot: InterviewWorkspaceSnapshot = {
      ...canonical,
      recentSessions: archivedSessions,
    };
    const legacyText = JSON.stringify({
      ...legacySnapshot,
      module: "interview-helper",
    });
    await writeFile(filePath, legacyText);
    // Use a fresh path so startup exercises the original JSON migration.
    const migratedFilePath = path.join(directory, "migrated-workspace.json");
    await writeFile(migratedFilePath, legacyText);
    repository = createFileLiveAssistantRepository({
      filePath: migratedFilePath,
    });
    service = createService(repository);
    const loaded = await service.getWorkspace();
    expect(loaded.recentSessions).toHaveLength(3000);
    expect(loaded.recentSessions[0]).not.toHaveProperty("transcriptSegments");
    expect(loaded.recentSessions[0]).not.toHaveProperty("chatConversation");
    expect(loaded.recentSessions[0]?.targetContext).not.toHaveProperty(
      "profileSnapshot",
    );
    const active = await service.startSession();
    const activeId = active.activeSession!.id;
    const archiveIndex = active.recentSessions;
    probe = new DatabaseSync(`${migratedFilePath}.sqlite`);
    probe.exec(`CREATE TABLE capture_write_audit (id TEXT, bytes INTEGER);
      CREATE TRIGGER capture_write_audit AFTER UPDATE OF value ON live_sessions
        BEGIN INSERT INTO capture_write_audit VALUES (NEW.id, length(NEW.value)); END;`);
    const canonicalLoad = vi.spyOn(repository, "load");
    const canonicalSave = vi.spyOn(repository, "save");
    const archiveLoad = vi.spyOn(repository, "loadSession");
    const canonicalParse = vi.spyOn(InterviewWorkspaceSnapshotSchema, "parse");
    const sessionParse = vi.spyOn(InterviewLiveSessionSchema, "parse");
    let latest = active;
    const began = performance.now();
    for (let index = 0; index < 100; index += 1) {
      latest = await service.addTranscriptSegment({
        sessionId: activeId,
        source: "meeting_native_transcript",
        text: `Synthetic capture segment ${index}.`,
        engineKind: "platform_local",
      });
      expect(latest.recentSessions).toBe(archiveIndex);
    }
    const elapsedMs = performance.now() - began;
    expect(latest.activeSession?.transcriptSegments).toHaveLength(100);
    expect(canonicalLoad).not.toHaveBeenCalled();
    expect(canonicalSave).not.toHaveBeenCalled();
    expect(archiveLoad).not.toHaveBeenCalled();
    expect(canonicalParse).not.toHaveBeenCalled();
    expect(
      sessionParse.mock.calls.every(
        ([input]) =>
          typeof input === "object" &&
          input !== null &&
          "id" in input &&
          input.id === activeId,
      ),
    ).toBe(true);
    const writes = probe
      .prepare(
        "SELECT id, COUNT(*) AS writes, SUM(bytes) AS bytes FROM capture_write_audit GROUP BY id",
      )
      .all();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.id).toBe(activeId);
    expect(writes[0]?.writes).toBe(100);
    const ipcBytes = Buffer.byteLength(
      JSON.stringify(InterviewWorkspaceViewSchema.parse(latest)),
    );
    const canonicalBytes = Buffer.byteLength(
      JSON.stringify({ ...latest, recentSessions: archivedSessions }),
    );
    expect(ipcBytes).toBeLessThan(canonicalBytes / 20);
    console.info("Live Assistant synthetic archive scale", {
      archivedSessions: 3000,
      activeSegments: 100,
      elapsedMs: Math.round(elapsedMs),
      archiveBodyWrites: 0,
      activeBodyWrites: writes[0]?.writes,
      totalActiveBytesWritten: writes[0]?.bytes,
      ipcBytes,
      canonicalBytes,
    });
    vi.restoreAllMocks();
    expect(await readFile(migratedFilePath, "utf8")).toBe(legacyText);
    // A read-only canonical export must not cause the next capture to rewrite
    // archived bodies by disturbing the repository's loaded-view identity.
    expect((await repository.load())?.recentSessions).toHaveLength(3000);
    probe.exec("DELETE FROM capture_write_audit");
    latest = await service.addTranscriptSegment({
      sessionId: activeId,
      source: "meeting_native_transcript",
      text: "Final recovery segment.",
      engineKind: "platform_local",
    });
    expect(
      probe.prepare("SELECT DISTINCT id FROM capture_write_audit").all(),
    ).toEqual([{ id: activeId }]);
    probe.close();
    probe = null;
    await service.close();
    repository = createFileLiveAssistantRepository({
      filePath: migratedFilePath,
    });
    service = createService(repository);
    const recovered = await service.getWorkspace();
    expect(recovered.activeSession).toBeNull();
    expect(recovered.recentSessions).toHaveLength(3001);
    expect(recovered.recentSessions[0]?.status).toBe("interrupted");
    expect((await service.getSession(activeId))?.transcriptSegments).toEqual(
      latest.activeSession?.transcriptSegments,
    );
    const retained = await service.getSession("archive-2999");
    expect(retained).toEqual(archivedSessions[2999]);
    const exported = await service.exportSession({
      sessionId: "archive-2999",
      format: "json",
    });
    expect(JSON.parse(exported.content)).toEqual(archivedSessions[2999]);
    const restored = (await repository.load())!;
    expect(restored.recentSessions.slice(1)).toEqual(archivedSessions);
    await service.addTranscriptAnnotation({
      sessionId: "archive-2999",
      transcriptSegmentId: retained!.transcriptSegments[19]!.id,
      kind: "correction",
      body: "Synthetic correction.",
    });
    expect(
      (await service.getSession("archive-2999"))?.transcriptAnnotations.at(-1)
        ?.originalText,
    ).toBe(retained!.transcriptSegments[19]!.text);
    await service.deleteSession("archive-2998");
    expect(await repository.loadSession("archive-2998")).toBeNull();
    expect(await service.getSession("archive-2999")).not.toBeNull();
  } finally {
    vi.restoreAllMocks();
    probe?.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
