import {
  AssistantChangeReceiptSchema,
  AssistantContextReferenceSchema,
} from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import { guardResumeEditor, resumeResultData } from "./resume-command-receipts";
import type { StoredResume } from "@nestor/contracts";
import type { AssistantTurnSession } from "./tool-kit";
import type { AssistantToolContext } from "./tool-kit";
import { undoReceipt } from "./tools/profile-tools";
import { z } from "zod";

it("blocks a chat edit or card Undo for the dirty resume without blocking another job", () => {
  const context = AssistantContextReferenceSchema.parse({
    screen: "review_queue",
    capturedAt: "2026-10-26T00:00:00.000Z",
    editor: { editor: "resume", jobId: "1", hasUnsavedEdits: true },
  });
  const session = { context } as AssistantTurnSession;
  expect(() => guardResumeEditor(1, { session })).toThrow("typing was kept");
  expect(() => guardResumeEditor(2, { session })).not.toThrow();
  context.editor = null;
  expect(() => guardResumeEditor(1, { session })).not.toThrow();
});

it("returns a blocked Undo result for unsaved typing instead of an AI service error", async () => {
  const receipt = AssistantChangeReceiptSchema.parse({
    id: "receipt-1",
    conversationId: "chat-1",
    target: "app_command",
    targetId: "1",
    summary: "Approved the saved resume.",
    fieldLabels: ["Resume approval"],
    entries: [],
    undoCommand: {
      name: "undo_resume_change",
      input: { jobId: 1, changeId: "change-1" },
    },
    createdAt: "2026-10-26T00:00:00.000Z",
  });
  const execute = vi.fn();
  const session = {
    context: AssistantContextReferenceSchema.parse({
      screen: "review_queue",
      capturedAt: "2026-10-26T00:00:00.000Z",
      editor: { editor: "resume", jobId: "1", hasUnsavedEdits: true },
    }),
    getReceipt: () => Promise.resolve(receipt),
    assertCurrent: () => undefined,
  } as unknown as AssistantTurnSession;
  const context = {
    session,
    service: {},
    ports: {
      commands: [
        {
          name: "undo_resume_change",
          effect: "local_write",
          input: z.object({ jobId: z.number(), changeId: z.string() }),
          execute,
        },
      ],
    },
  } as unknown as AssistantToolContext;
  const result = await undoReceipt(context, receipt.id);
  expect(result.message).toContain("typing was kept");
  expect(result.receipt.status).toBe("applied");
  expect(execute).not.toHaveBeenCalled();
});

it("puts the authoritative edit revision before a large draft and removes repeated provenance", () => {
  const value = {
    jobId: 1,
    draft: {
      sections: [
        {
          id: "summary",
          text: "Content",
          sourceRefs: [{ snippet: "x".repeat(15000) }],
        },
      ],
    },
    updatedAt: "revision",
    level: "light",
  } as StoredResume;
  const result = JSON.stringify(resumeResultData(value));
  expect(result.indexOf('"updatedAt"')).toBeLessThan(result.indexOf('"draft"'));
  expect(result).toContain('"text":"Content"');
  expect(result).not.toContain("sourceRefs");
  expect(result.length).toBeLessThan(500);
});
