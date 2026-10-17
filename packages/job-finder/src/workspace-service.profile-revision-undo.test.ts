import type { JobFinderAiClient } from "@nestor/ai-providers";
import type {
  ProfileCopilotContext,
  ProfileCopilotPatchGroup,
  ProfileCopilotPatchOperation,
} from "@nestor/contracts";
import { ProfileCopilotPatchGroupSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * Undo used to be usable only from the top of the log: the renderer offered
 * an Undo on the newest assistant change and nothing else, so a person who
 * accepted three changes could reverse the third and was stuck with the
 * first two. Revisions carry a monotonic sequence now, undo addresses any of
 * them, and the one thing it refuses is overwriting the person's own edit.
 */

const context: ProfileCopilotContext = {
  surface: "profile",
  section: "basics",
};

function patchGroup(
  id: string,
  summary: string,
  operation: ProfileCopilotPatchOperation,
): ProfileCopilotPatchGroup {
  return ProfileCopilotPatchGroupSchema.parse({
    id,
    summary,
    applyMode: "needs_review",
    operations: [operation],
    createdAt: "2026-04-15T09:00:00.000Z",
  });
}

function createQueuedPatchAiClient(
  groups: readonly ProfileCopilotPatchGroup[],
): JobFinderAiClient {
  const fallbackClient = createAiClient();
  let index = 0;

  return {
    ...fallbackClient,
    reviseCandidateProfile() {
      const group = groups[Math.min(index, groups.length - 1)];
      index += 1;

      return Promise.resolve({
        content: "Prepared a change.",
        patchGroups: [group!],
      });
    },
  };
}

async function applyProposal(
  workspaceService: ReturnType<
    typeof createWorkspaceServiceHarness
  >["workspaceService"],
  request: string,
): Promise<string> {
  const proposal = await workspaceService.proposeProfileCopilotChange(
    request,
    context,
  );
  const assistantMessage = proposal.profileCopilotMessages.find(
    (message) => message.role === "assistant",
  );
  const storedGroupId = assistantMessage?.patchGroups[0]?.id;
  expect(typeof storedGroupId).toBe("string");
  await workspaceService.applyProfileCopilotPatchGroup(storedGroupId!);
  return storedGroupId!;
}

describe("workspaceService profile revision undo", () => {
  test("undoes an earlier assistant change, not only the most recent one", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createQueuedPatchAiClient([
        patchGroup("group_headline", "Rewrite the headline", {
          operation: "replace_identity_fields",
          value: { headline: "First assistant headline" },
        }),
        patchGroup("group_skill", "Drop React", {
          operation: "remove_profile_list_entries",
          field: "skills",
          values: ["React"],
        }),
        patchGroup("group_role", "Retarget the role", {
          operation: "replace_profile_list_fields",
          value: { targetRoles: ["Staff Systems Designer"] },
        }),
      ]),
    });

    await workspaceService.getWorkspaceSnapshot();
    const baselineHeadline = (await repository.getProfile()).headline;

    await applyProposal(workspaceService, "Rewrite my headline");
    await applyProposal(workspaceService, "Drop React from my skills");
    await applyProposal(workspaceService, "Retarget my role");

    const revisions = await repository.listProfileRevisions();
    expect(revisions).toHaveLength(3);
    // A monotonic sequence, so "undo back to here" has an order to work with.
    expect([...revisions].map((revision) => revision.sequence).sort()).toEqual([
      1, 2, 3,
    ]);
    const firstRevision = revisions.find((revision) => revision.sequence === 1);
    expect(firstRevision).toBeDefined();

    const undone = await workspaceService.undoProfileRevision(
      firstRevision!.id,
    );
    const afterUndo = await repository.getProfile();

    // Undoing the first change reaches back to the state it found, which also
    // reverses the two assistant changes recorded after it.
    expect(afterUndo.headline).toBe(baselineHeadline);
    expect(afterUndo.skills).toContain("React");
    expect(undone.profileRevisions[0]).toEqual(
      expect.objectContaining({
        trigger: "undo",
        restoredFromRevisionId: firstRevision!.id,
      }),
    );
    expect(undone.profileRevisions[0]?.reason).toContain(
      "2 later assistant changes",
    );
  });

  test("refuses an undo that would overwrite the person's own later edit, naming the field", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createQueuedPatchAiClient([
        patchGroup("group_headline", "Rewrite the headline", {
          operation: "replace_identity_fields",
          value: { headline: "Assistant headline" },
        }),
      ]),
    });

    await workspaceService.getWorkspaceSnapshot();
    await applyProposal(workspaceService, "Rewrite my headline");

    const storedProfile = await repository.getProfile();
    await repository.saveProfile({
      ...storedProfile,
      headline: "The headline I typed myself",
    });

    const revisions = await repository.listProfileRevisions();
    await expect(
      workspaceService.undoProfileRevision(revisions[0]!.id),
    ).rejects.toThrow(/headline/u);

    // Nothing was written: the person's own edit survives the refusal.
    expect((await repository.getProfile()).headline).toBe(
      "The headline I typed myself",
    );
  });
});
