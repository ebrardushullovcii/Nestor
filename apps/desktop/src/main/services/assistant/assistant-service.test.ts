import { AssistantInstructionGrantSchema } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ listGrants: vi.fn() }));
vi.mock("@nestor/db", () => ({ createAssistantRepository: () => store }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("./assistant-ports", () => ({ createAssistantHostPorts: vi.fn() }));
vi.mock("../job-finder/paths", () => ({ getJobFinderUserDataDirectory: () => "synthetic-assistant-test" }));
import { assistantApplicationMode } from "./assistant-service";

describe("persisted application instruction", () => {
  it.each(["active", "narrowed", "revoked"] as const)("rechecks the current %s grant on later runs", async (status) => {
    store.listGrants.mockResolvedValue([AssistantInstructionGrantSchema.parse({ id: "grant", conversationId: "chat", sourceMessageId: "message", action: "prepare", jobIds: ["1"], status, createdAt: "2026-10-24T01:00:00.000Z", updatedAt: "2026-10-24T01:00:00.000Z" })]);
    const result = await assistantApplicationMode({ conversationId: "chat", jobId: 1, mode: "autonomous_submit" });
    expect(result).toBe(status === "revoked" ? null : "prepare_only");
  });
  it("refuses a deleted instruction", async () => {
    store.listGrants.mockResolvedValue([]);
    expect(await assistantApplicationMode({ conversationId: "deleted_chat", jobId: 1, mode: "autonomous_submit" })).toBeNull();
  });
  it("does not widen a captured preparation instruction", async () => {
    store.listGrants.mockResolvedValue([AssistantInstructionGrantSchema.parse({ id: "grant", conversationId: "chat", sourceMessageId: "message", action: "prepare_and_send", jobIds: ["1"], status: "active", createdAt: "2026-10-24T01:00:00.000Z", updatedAt: "2026-10-24T01:00:00.000Z" })]);
    expect(await assistantApplicationMode({ conversationId: "chat", jobId: 1, mode: "prepare_only" })).toBe("prepare_only");
  });
});
