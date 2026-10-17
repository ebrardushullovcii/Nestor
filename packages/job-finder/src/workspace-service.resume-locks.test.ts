import { describe, expect, test } from "vitest";
import { ResumeDraftPatchSchema } from "@nestor/contracts";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

describe("resume section locking", () => {
  test("persists a section lock and rejects assistant changes to its wording", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const before = await workspaceService.getResumeWorkspace("job_ready");
    const section = before.draft.sections.find(
      (item) => item.kind === "summary",
    )!;
    const patch = ResumeDraftPatchSchema.parse({
      id: "lock_summary",
      draftId: before.draft.id,
      operation: "set_lock",
      targetSectionId: section.id,
      newLocked: true,
      origin: "user",
      appliedAt: new Date().toISOString(),
    });
    await workspaceService.applyResumePatch(patch, "Locked section");
    const locked = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      locked.draft.sections.find((item) => item.id === section.id)?.locked,
    ).toBe(true);
    await expect(
      workspaceService.applyResumePatch({
        ...patch,
        id: "rewrite_locked_summary",
        operation: "replace_section_text",
        origin: "assistant",
        newText: "New wording.",
        newLocked: null,
      }),
    ).rejects.toThrow(/locked resume content/);
    await workspaceService.applyResumePatch({
      ...patch,
      id: "unlock_summary",
      newLocked: false,
    });
    expect(
      (
        await workspaceService.getResumeWorkspace("job_ready")
      ).draft.sections.find((item) => item.id === section.id)?.locked,
    ).toBe(false);
  });
});
