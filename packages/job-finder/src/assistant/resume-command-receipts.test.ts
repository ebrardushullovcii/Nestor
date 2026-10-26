import { AssistantContextReferenceSchema } from "@nestor/contracts";
import { expect, it } from "vitest";
import { guardResumeEditor, resumeResultData } from "./resume-command-receipts";
import type { StoredResume } from "@nestor/contracts";
import type { AssistantTurnSession } from "./tool-kit";

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
