import { describe, expect, test } from "vitest";
import { createAiClient } from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

function createHarnessWithSummaryRewrite(suffix: string) {
  const baseAiClient = createAiClient();
  return createWorkspaceServiceHarness({
    aiClient: {
      ...baseAiClient,
      reviseResumeDraft(input) {
        const section = input.draft.sections.find((entry) =>
          entry.text?.trim(),
        );
        if (!section) {
          throw new Error("Expected a text section.");
        }
        return Promise.resolve({
          content: "Updated one grounded section.",
          patches: [
            {
              id: "assistant_undo_patch",
              draftId: input.draft.id,
              operation: "replace_section_text" as const,
              targetSectionId: section.id,
              targetEntryId: null,
              anchorEntryId: null,
              targetBulletId: null,
              anchorBulletId: null,
              position: null,
              newText: `${section.text} ${suffix}`,
              newIncluded: null,
              newLocked: null,
              newBullets: null,
              appliedAt: new Date().toISOString(),
              origin: "assistant" as const,
              conflictReason: null,
            },
          ],
        });
      },
    },
  });
}

async function acceptAssistantEdit(
  workspaceService: ReturnType<
    typeof createWorkspaceServiceHarness
  >["workspaceService"],
) {
  const messages = await workspaceService.sendResumeAssistantMessage(
    "job_ready",
    "Make one section clearer.",
  );
  const proposal = messages.find(
    (message) => message.role === "assistant" && message.patches.length > 0,
  );
  await workspaceService.resolveResumeAssistantProposal(
    "job_ready",
    proposal!.id,
    "accept",
    [proposal!.patches[0]!.id],
  );
}

describe("undo one AI edit", () => {
  test("manual, AI, manual: Undo removes only the AI edit and keeps the later manual edit", async () => {
    const { repository, workspaceService } =
      createHarnessWithSummaryRewrite("Refined for clarity.");
    await workspaceService.generateResume("job_ready");
    const original = await workspaceService.getResumeWorkspace("job_ready");
    const summary = original.draft.sections.find((entry) => entry.text?.trim())!;

    await workspaceService.saveResumeDraft({
      ...original.draft,
      identity: { ...original.draft.identity!, headline: "First manual headline" },
    });
    await acceptAssistantEdit(workspaceService);
    const afterAi = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      afterAi.draft.sections.find((entry) => entry.id === summary.id)?.text,
    ).toContain("Refined for clarity.");
    await workspaceService.saveResumeDraft({
      ...afterAi.draft,
      identity: { ...afterAi.draft.identity!, headline: "Second manual headline" },
    });

    const aiRevision = (
      await repository.listResumeDraftRevisions(original.draft.id)
    ).find((revision) => revision.mutationKind === "assistant_patch")!;
    await workspaceService.undoResumeAssistantEdit("job_ready", aiRevision.id);

    const undone = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      undone.draft.sections.find((entry) => entry.id === summary.id)?.text,
    ).toBe(summary.text);
    expect(undone.draft.identity?.headline).toBe("Second manual headline");
    const latest = (
      await repository.listResumeDraftRevisions(original.draft.id)
    )[0];
    expect(latest).toMatchObject({
      actor: "restore",
      mutationKind: "restore",
      restoredFromRevisionId: aiRevision.id,
    });
  });

  test("a later manual rewrite of the same text wins over Undo", async () => {
    const { repository, workspaceService } =
      createHarnessWithSummaryRewrite("Refined for clarity.");
    await workspaceService.generateResume("job_ready");
    const original = await workspaceService.getResumeWorkspace("job_ready");
    const summary = original.draft.sections.find((entry) => entry.text?.trim())!;
    await acceptAssistantEdit(workspaceService);
    const afterAi = await workspaceService.getResumeWorkspace("job_ready");
    // Grounded wording from the fixture profile, so the save keeps it.
    const manualText = "Builds resilient workflow tools.";
    await workspaceService.saveResumeDraft({
      ...afterAi.draft,
      sections: afterAi.draft.sections.map((entry) =>
        entry.id === summary.id ? { ...entry, text: manualText } : entry,
      ),
    });

    const aiRevision = (
      await repository.listResumeDraftRevisions(original.draft.id)
    ).find((revision) => revision.mutationKind === "assistant_patch")!;
    await workspaceService.undoResumeAssistantEdit("job_ready", aiRevision.id);

    const undone = await workspaceService.getResumeWorkspace("job_ready");
    expect(
      undone.draft.sections.find((entry) => entry.id === summary.id)?.text,
    ).toBe(manualText);
  });

  test("refuses a revision that is not an AI edit", async () => {
    const { repository, workspaceService } =
      createHarnessWithSummaryRewrite("Refined.");
    await workspaceService.generateResume("job_ready");
    const original = await workspaceService.getResumeWorkspace("job_ready");
    await workspaceService.saveResumeDraft({
      ...original.draft,
      identity: { ...original.draft.identity!, headline: "Manual headline" },
    });
    const manualRevision = (
      await repository.listResumeDraftRevisions(original.draft.id)
    )[0]!;
    await expect(
      workspaceService.undoResumeAssistantEdit("job_ready", manualRevision.id),
    ).rejects.toThrow(/no longer in this resume's history/);
  });
});
