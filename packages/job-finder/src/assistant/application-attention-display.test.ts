import { describe, expect, test } from "vitest";
import { ApplyJobResultSchema } from "@nestor/contracts";
import {
  applyResultHasQuestionForPerson,
  getPausedQuestionText,
} from "./application-attention-display";

describe("legacy browser recovery display", () => {
  test("does not offer an unknown placeholder as an answerable form question", () => {
    const result = ApplyJobResultSchema.parse({
      id: "result",
      runId: "run",
      jobId: "job",
      state: "blocked",
      blockerReason: "required_human_input",
      summary: 'The form asks: "(unknown)"',
      detail: "Reset the browser in Safeguards.",
      startedAt: "2026-10-02T10:00:00Z",
      updatedAt: "2026-10-02T10:00:00Z",
    });
    expect(getPausedQuestionText(result)).toBeNull();
    expect(applyResultHasQuestionForPerson(result, 0, "(unknown)")).toBe(false);
  });
});
