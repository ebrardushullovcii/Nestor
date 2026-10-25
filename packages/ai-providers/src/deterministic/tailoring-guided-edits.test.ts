import { ResumeDraftSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import { createDeterministicJobFinderAiClient } from "../index";
import { createJobPosting } from "../test-fixtures";

describe("deterministic resume guided edits", () => {
  test("shortens the production QA summary at a complete clause without an ellipsis", async () => {
    const productionQaSummary =
      "Senior systems designer with strong workflow automation, design-system, and operations-platform experience who leads cross-functional discovery, turns complex service constraints into accessible product decisions, documents implementation tradeoffs, and helps engineering teams ship reliable customer workflows across high-volume operational environments.";
    const draft = ResumeDraftSchema.parse({
      id: "draft_guided_edits_quality",
      jobId: "job_1",
      status: "draft",
      templateId: "classic_ats",
      sections: [
        {
          id: "section_summary",
          kind: "summary",
          label: "Summary",
          text: productionQaSummary,
          origin: "user_edited",
          sortOrder: 0,
          updatedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    });

    const reply = await createDeterministicJobFinderAiClient().reviseResumeDraft({
      draft,
      job: createJobPosting(),
      request: "Shorten the summary while keeping it professional.",
    });

    expect(reply.patches).toHaveLength(1);
    expect(reply.patches[0]?.newText).toBe(
      "Senior systems designer with strong workflow automation, design-system, and operations-platform experience who leads cross-functional discovery, turns complex service constraints into accessible product decisions.",
    );
    expect(reply.patches[0]?.newText).toMatch(/[.!?]$/);
    expect(reply.patches[0]?.newText).not.toContain("...");
    expect(productionQaSummary).toContain(
      reply.patches[0]?.newText?.replace(/[.!?]$/, "") ?? "not present",
    );
  });
});
