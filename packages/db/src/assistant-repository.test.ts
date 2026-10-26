import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAssistantRepository } from "./assistant-repository";

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 27, 10, 0, seconds)).toISOString();

function conversation(id: string, lastMessageAt: string) {
  return {
    id,
    title: `Conversation ${id}`,
    status: "active" as const,
    source: "assistant" as const,
    jobId: null,
    createdAt: at(0),
    updatedAt: at(0),
    lastMessageAt,
    messageCount: 0,
  };
}

function message(
  id: string,
  conversationId: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    conversationId,
    clientMessageId: null,
    role: "user" as const,
    origin: "sidebar" as const,
    parts: [{ type: "text" as const, text: id }],
    turnId: null,
    context: null,
    contextResultSetIds: [],
    migratedFrom: null,
    createdAt,
    updatedAt: null,
    ...extra,
  };
}

describe("assistant repository", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("orders conversations by latest message and messages by time", async () => {
    const repository = createAssistantRepository({ filePath: ":memory:" });
    cleanups.push(() => repository.close());
    await repository.upsertConversation(conversation("a", at(5)));
    await repository.upsertConversation(conversation("b", at(9)));
    expect((await repository.listConversations()).map((c) => c.id)).toEqual([
      "b",
      "a",
    ]);

    await repository.upsertMessage(message("m2", "a", at(2)));
    await repository.upsertMessage(message("m1", "a", at(1)));
    await repository.upsertMessage(message("m3", "a", at(3)));
    const page = await repository.listMessages("a", { limit: 2 });
    expect(page.messages.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(page.hasOlder).toBe(true);
    const older = await repository.listMessages("a", {
      beforeMessageId: "m2",
    });
    expect(older.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(older.hasOlder).toBe(false);
  });

  it("finds a repeated send by its client id and a migrated message by its legacy id", async () => {
    const repository = createAssistantRepository({ filePath: ":memory:" });
    cleanups.push(() => repository.close());
    await repository.upsertMessage(
      message("m1", "a", at(1), { clientMessageId: "client-1" }),
    );
    await repository.upsertMessage(
      message("m2", "a", at(2), {
        origin: "migrated",
        migratedFrom: { source: "profile_copilot", legacyId: "legacy-1" },
      }),
    );
    expect((await repository.findMessageByClientId("a", "client-1"))?.id).toBe(
      "m1",
    );
    expect(await repository.findMessageByClientId("b", "client-1")).toBeNull();
    expect(
      (await repository.findMigratedMessage("profile_copilot", "legacy-1"))?.id,
    ).toBe("m2");
  });

  it("numbers events without reusing a sequence after pruning", async () => {
    const repository = createAssistantRepository({ filePath: ":memory:" });
    cleanups.push(() => repository.close());
    for (let index = 0; index < 5; index += 1) {
      await repository.appendEvent({
        conversationId: "a",
        turnId: null,
        payload: { type: "progress", text: `note ${index}` },
      });
    }
    await repository.pruneEvents("a", 2);
    const next = await repository.appendEvent({
      conversationId: "a",
      turnId: null,
      payload: { type: "progress", text: "after prune" },
    });
    expect(next.sequence).toBe(6);
    expect(
      (await repository.listEvents("a", 0)).map((event) => event.sequence),
    ).toEqual([4, 5, 6]);
    expect(await repository.getLastSequence("a")).toBe(6);
  });

  it("deletes a conversation with everything that belongs to it", async () => {
    const repository = createAssistantRepository({ filePath: ":memory:" });
    cleanups.push(() => repository.close());
    await repository.upsertConversation(conversation("a", at(1)));
    await repository.upsertConversation(conversation("b", at(1)));
    await repository.setCurrentConversationId("a");
    await repository.upsertMessage(message("m1", "a", at(1)));
    await repository.upsertMessage(message("m2", "b", at(1)));
    await repository.addPendingMessage("a", "m1");
    await repository.appendTranscript("a", "turn", [
      { role: "user", content: "hi" },
    ]);
    await repository.appendEvent({
      conversationId: "a",
      turnId: null,
      payload: { type: "progress", text: "x" },
    });
    await repository.deleteConversation("a");
    expect(await repository.getConversation("a")).toBeNull();
    expect(await repository.getMessage("m1")).toBeNull();
    expect(await repository.getMessage("m2")).not.toBeNull();
    expect(await repository.listPendingMessageIds("a")).toEqual([]);
    expect(await repository.listTranscript("a")).toEqual([]);
    expect(await repository.listEvents("a", 0)).toEqual([]);
    expect(await repository.getCurrentConversationId()).toBeNull();
  });

  it("persists across reopen of a file database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "assistant-repo-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, "assistant.sqlite");
    const first = createAssistantRepository({ filePath });
    await first.upsertConversation(conversation("a", at(1)));
    await first.appendTranscript("a", "turn-1", [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    await first.close();
    const second = createAssistantRepository({ filePath });
    cleanups.push(() => second.close());
    expect((await second.getConversation("a"))?.title).toBe("Conversation a");
    const transcript = await second.listTranscript("a");
    expect(transcript.map((item) => item.seq)).toEqual([1, 2]);
    await second.replaceTranscriptItems("a", [
      { seq: 1, message: { role: "user", content: "trimmed" } },
    ]);
    expect((await second.listTranscript("a"))[0]?.message).toEqual({
      role: "user",
      content: "trimmed",
    });
  });
});
