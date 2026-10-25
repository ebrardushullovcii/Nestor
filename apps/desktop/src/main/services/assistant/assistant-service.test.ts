import { AssistantInstructionGrantSchema } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ listGrants: vi.fn() }));
vi.mock("@nestor/db", () => ({ createAssistantRepository: () => store }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("./assistant-ports", () => ({ createAssistantHostPorts: vi.fn() }));
vi.mock("../job-finder/paths", () => ({
  getJobFinderUserDataDirectory: () => "synthetic-assistant-test",
}));
import { assistantQueuePolicy } from "./assistant-service";

describe("persisted assistant queue scope", () => {
  it.each(["active", "narrowed", "revoked"] as const)(
    "rechecks the current %s grant on later runs",
    async (status) => {
      store.listGrants.mockResolvedValue([
        AssistantInstructionGrantSchema.parse({
          id: "grant",
          conversationId: "chat",
          sourceMessageId: "message",
          action: "prepare",
          jobIds: ["job"],
          status,
          createdAt: "2026-10-24T01:00:00.000Z",
          updatedAt: "2026-10-24T01:00:00.000Z",
        }),
      ]);
      const result = await assistantQueuePolicy(
        { assistantScopes: [{ conversationId: "chat", jobIds: ["job"] }] },
        ["job"],
        "autonomous_submit",
      );
      if (status === "revoked")
        expect(result.refused.map((item) => item.jobId)).toEqual(["job"]);
      else expect(result).toMatchObject({ mode: "prepare_only", refused: [] });
    },
  );
  it("refuses a queue's chat-owned jobs when that chat or its grants were deleted, without claiming UI-owned jobs", async () => {
    store.listGrants.mockResolvedValue([]);
    const result = await assistantQueuePolicy(
      {
        assistantScopes: [
          { conversationId: "deleted_chat", jobIds: ["chat_job"] },
        ],
      },
      ["chat_job", "ui_job"],
      "autonomous_submit",
    );
    expect(store.listGrants).toHaveBeenCalledWith("deleted_chat");
    expect(result.refused.map((item) => item.jobId)).toEqual(["chat_job"]);
    expect(result.boundJobIds).toEqual(["chat_job"]);
  });

  it("does not open the chat store for an ordinary UI queue", async () => {
    store.listGrants.mockClear();
    expect(
      await assistantQueuePolicy({}, ["ui_job"], "prepare_only"),
    ).toMatchObject({ mode: "prepare_only", refused: [], boundJobIds: [] });
    expect(store.listGrants).not.toHaveBeenCalled();
  });
});
