import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  InterviewLiveSessionSchema,
  InterviewWorkspaceSnapshotSchema,
} from "@nestor/contracts";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFileLiveAssistantRepository } from "./live-assistant-repository";

const temporaryDirectories: string[] = [];
const repositories: ReturnType<typeof createFileLiveAssistantRepository>[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function overlay(surfaceKind: string) {
  return {
    surfaceKind,
    mode: "compact",
    visible: false,
    interactionMode: false,
    opacity: 0.9,
    protectionState: "unknown",
    statusLabel: "Waiting",
  };
}

describe("createFileLiveAssistantRepository", () => {
  test("loads a workspace saved before the Live Assistant rename", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-live-assistant-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "live-assistant-workspace.json");
    await writeFile(
      filePath,
      JSON.stringify({
        module: "interview-helper",
        generatedAt: "2026-09-01T10:00:00.000Z",
        setup: {},
        answerOverlay: overlay("live_answer_overlay"),
        transcriptOverlay: overlay("live_transcript_overlay"),
      }),
      "utf8",
    );

    const repository = createFileLiveAssistantRepository({ filePath });
    repositories.push(repository);
    const snapshot = await repository.load();

    expect(snapshot?.module).toBe("live-assistant");
    expect(snapshot?.generatedAt).toBe("2026-09-01T10:00:00.000Z");
  });

  test("returns null when nothing was saved yet", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-live-assistant-"),
    );
    temporaryDirectories.push(directory);

    const repository = createFileLiveAssistantRepository({
      filePath: path.join(directory, "live-assistant-workspace.json"),
    });
    repositories.push(repository);
    await expect(repository.load()).resolves.toBeNull();
  });
  test("rolls back interrupted migration and import, retaining the original legacy file", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-live-assistant-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "live-assistant-workspace.json");
    const snapshot = InterviewWorkspaceSnapshotSchema.parse({
      module: "live-assistant",
      generatedAt: "2026-10-13T00:00:00.000Z",
      setup: {},
      recentSessions: Array.from({ length: 3 }, (_, index) =>
        InterviewLiveSessionSchema.parse({
          id: `archive-${index}`,
          status: "ended",
          startedAt: "2026-10-13T00:00:00.000Z",
          targetContext: {
            kind: "general_interview",
            id: "synthetic",
            label: "Synthetic interview",
          },
        }),
      ),
      answerOverlay: overlay("live_answer_overlay"),
      transcriptOverlay: overlay("live_transcript_overlay"),
    });
    const empty = createFileLiveAssistantRepository({ filePath });
    await empty.loadWorkspace();
    await empty.close();
    const original = JSON.stringify({
      ...snapshot,
      module: "interview-helper",
    });
    await writeFile(filePath, original);
    const probe = new DatabaseSync(`${filePath}.sqlite`);
    try {
      probe.exec(`CREATE TRIGGER fail_migration BEFORE INSERT ON live_sessions
        WHEN NEW.id = 'archive-1' BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END;`);
      const failed = createFileLiveAssistantRepository({ filePath });
      repositories.push(failed);
      await expect(failed.loadWorkspace()).rejects.toThrow(
        "synthetic migration failure",
      );
      expect(
        probe.prepare("SELECT COUNT(*) AS count FROM live_sessions").get()
          ?.count,
      ).toBe(0);
      expect(
        probe.prepare("SELECT COUNT(*) AS count FROM live_workspace").get()
          ?.count,
      ).toBe(0);
      expect(await readFile(filePath, "utf8")).toBe(original);
      probe.exec("DROP TRIGGER fail_migration");
      const migrated = createFileLiveAssistantRepository({ filePath });
      repositories.push(migrated);
      expect(await migrated.load()).toEqual(snapshot);
      expect(await readFile(filePath, "utf8")).toBe(original);
      // An import failure after rows have been deleted/rewritten also rolls back.
      probe.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON live_sessions
        WHEN NEW.id = 'archive-1' BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END;`);
      await expect(
        migrated.save({
          ...snapshot,
          recentSessions: snapshot.recentSessions.map((session) => ({
            ...session,
            cueSummary: "Changed import",
          })),
        }),
      ).rejects.toThrow("synthetic import failure");
      expect(await migrated.load()).toEqual(snapshot);
      probe.exec("DROP TRIGGER fail_import");
    } finally {
      probe.close();
    }
  });

  test("refuses ambiguous duplicate session ids without losing the legacy bodies", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-live-assistant-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "live-assistant-workspace.json");
    const session = {
      id: "duplicate",
      status: "ended",
      startedAt: "2026-10-13T00:00:00.000Z",
      targetContext: {
        kind: "general_interview",
        id: "synthetic",
        label: "Synthetic",
      },
    };
    const original = JSON.stringify({
      module: "live-assistant",
      generatedAt: session.startedAt,
      setup: {},
      recentSessions: [
        session,
        { ...session, cueSummary: "Different retained body" },
      ],
      answerOverlay: overlay("live_answer_overlay"),
      transcriptOverlay: overlay("live_transcript_overlay"),
    });
    await writeFile(filePath, original);
    const repository = createFileLiveAssistantRepository({ filePath });
    repositories.push(repository);
    await expect(repository.loadWorkspace()).rejects.toThrow(
      "Duplicate retained",
    );
    expect(await readFile(filePath, "utf8")).toBe(original);
  });
});
